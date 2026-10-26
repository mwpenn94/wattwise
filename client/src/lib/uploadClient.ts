/**
 * Oct 25 — shared transport for large uploads (single-site and bulk setup).
 *
 * Non-batched httpLink so one large workbook never shares a request with other
 * calls, plus a fetch wrapper: a proxy/instance hiccup answers with plain-text
 * "Service Unavailable", which must never surface as a raw JSON parse error.
 * Such responses become TransientServerError (retryable, plain language).
 */
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { COOKIE_NAME } from "@shared/const";
import { MAX_UPLOAD_BYTES, RAW_UPLOAD_PART_BYTES } from "@shared/wattwise";

export class TransientServerError extends Error {
  readonly transient = true;
}
function authHeaders(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem("manus-cookie");
    const pair = raw?.split(";").find((s) => s.trim().startsWith(`${COOKIE_NAME}=`));
    const token = pair?.trim().slice(COOKIE_NAME.length + 1);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
export const uploadClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpLink({
      url: "/api/trpc",
      transformer: superjson,
      headers: authHeaders,
      fetch: async (input, init) => {
        let res: Response;
        try {
          res = await fetch(input, { ...init, credentials: "include" });
        } catch {
          throw new TransientServerError("We couldn't reach the server. Check your connection; we'll keep trying.");
        }
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          if (res.status === 413) throw new Error("This file is too large to upload in one piece. The limit is 50 MiB per file.");
          throw new TransientServerError("The server was briefly unavailable. We'll retry automatically — your progress is saved.");
        }
        return res;
      },
    }),
  ],
});

export function isTransient(e: unknown): boolean {
  if (e instanceof TransientServerError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /Unexpected token|not valid JSON|Failed to fetch|NetworkError|Load failed|unexpected 50[234]|Service Unavailable|Bad Gateway|Gateway Time|ETIMEDOUT|ECONNRESET|ECONNREFUSED|PROTOCOL_CONNECTION_LOST|Connection lost|Too many connections/i.test(m);
}

/** Plain-language message for anything the user sees in a toast. */
export function plainError(e: unknown, fallback: string): string {
  if (isTransient(e)) return "The server was briefly unavailable. Please try again in a moment — anything already saved is kept.";
  return e instanceof Error && e.message ? e.message : fallback;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Oct 25 — send the file's bytes as-is (no base64, no FileReader copy). The
 * server streams them to storage and returns a signed reference that
 * `uploads.ingest` / `bulkImport.stageFile` accept as `sourceRef`.
 *
 * Oct 26 — files larger than one part upload in RAW_UPLOAD_PART_BYTES parts.
 * A dropped connection or busy server only re-sends the part in flight; parts
 * already received are kept (also across a page reload for 6 hours, keyed by
 * file name, size and modified time). `onRetry` shows a calm note and
 * `onProgress` reports bytes received.
 */
type RawResult = { sourceRef: string; sha256: string; bytes: number };
type UploadNote = (attempt: number, max: number) => void;
type Progress = (sentBytes: number, totalBytes: number) => void;
type Json = Record<string, unknown> & { error?: string; retryable?: boolean; restart?: boolean };
async function postJson(url: string, body: BodyInit, contentType: string, extra: Record<string, string> = {}): Promise<{ res: Response | null; body: Json | null }> {
  let res: Response | null = null;
  try {
    res = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": contentType, ...authHeaders(), ...extra }, body });
  } catch {
    return { res: null, body: null };
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { res, body: isJson ? ((await res.json().catch(() => null)) as Json | null) : null };
}
const retryableOf = (r: { res: Response | null; body: Json | null }) => !r.res || !r.body || r.res.status >= 500 || r.body.retryable === true;
const backoff = (attempt: number) => sleep(Math.min(20_000, 1500 * attempt * attempt));

async function uploadSingle(file: File, onRetry?: UploadNote, onProgress?: Progress): Promise<RawResult> {
  const MAX = 5;
  for (let attempt = 1; ; attempt++) {
    const r = await postJson(`/api/uploads/raw?filename=${encodeURIComponent(file.name.slice(0, 200))}`, file, "application/octet-stream");
    const body = r.body as { sourceRef?: string; sha256?: string; bytes?: number; error?: string } | null;
    if (r.res?.ok && body?.sourceRef) { onProgress?.(file.size, file.size); return { sourceRef: body.sourceRef, sha256: body.sha256 ?? "", bytes: body.bytes ?? file.size }; }
    if (r.res?.status === 413) throw new Error(body?.error ?? "This file is larger than the 50 MiB limit. Split it into smaller files and upload again.");
    if (!retryableOf(r)) throw new Error(body?.error ?? `The file could not be uploaded (${r.res!.status}).`);
    if (attempt >= MAX) throw new TransientServerError("We couldn't upload the file after several tries. Check your connection and try again — nothing was imported.");
    onRetry?.(attempt, MAX - 1);
    await backoff(attempt);
  }
}

type Resume = { session: string; parts: number; partBytes: number; expiresAt: number; receipts: (string | null)[] };
const resumeKey = (f: File) => `meterly-upload:${f.name}|${f.size}|${f.lastModified}`;
function loadResume(f: File): Resume | null {
  try {
    const r = JSON.parse(localStorage.getItem(resumeKey(f)) ?? "null") as Resume | null;
    if (!r || !(r.expiresAt > Date.now() + 10 * 60_000) || !Array.isArray(r.receipts) || r.receipts.length !== r.parts) return null;
    return r;
  } catch { return null; }
}
function saveResume(f: File, r: Resume | null) {
  try { if (r) localStorage.setItem(resumeKey(f), JSON.stringify(r)); else localStorage.removeItem(resumeKey(f)); } catch { /* storage full or disabled: resume within this page only */ }
}
async function startSession(file: File, onRetry?: UploadNote): Promise<Resume> {
  const MAX = 5;
  for (let attempt = 1; ; attempt++) {
    const r = await postJson("/api/uploads/raw/start", JSON.stringify({ bytes: file.size, filename: file.name.slice(0, 200) }), "application/json");
    const b = r.body as { session?: string; parts?: number; partBytes?: number; expiresAt?: number; error?: string } | null;
    if (r.res?.ok && b?.session && b.parts && b.partBytes && b.expiresAt) return { session: b.session, parts: b.parts, partBytes: b.partBytes, expiresAt: b.expiresAt, receipts: Array(b.parts).fill(null) };
    if (r.res?.status === 413) throw new Error(b?.error ?? "This file is larger than the 50 MiB limit. Split it into smaller files and upload again.");
    if (!retryableOf(r)) throw new Error(b?.error ?? `The file could not be uploaded (${r.res!.status}).`);
    if (attempt >= MAX) throw new TransientServerError("We couldn't start the upload after several tries. Check your connection and try again — nothing was imported.");
    onRetry?.(attempt, MAX - 1);
    await backoff(attempt);
  }
}
class RestartUpload extends Error {}

/** Parts are sent one at a time; each part retries on its own, so progress is never lost. */
async function uploadInParts(file: File, onRetry?: UploadNote, onProgress?: Progress): Promise<RawResult> {
  // A single part may need many tries on a poor connection; give up only after
  // a long run of consecutive failures with no progress at all.
  const MAX_STALLED = 8;
  let keep: Resume | null = null; // survives a "missing parts" retry even if localStorage is unavailable
  for (let restarts = 0; ; restarts++) {
    const st: Resume = keep ?? loadResume(file) ?? (await startSession(file, onRetry));
    keep = null;
    saveResume(file, st);
    try {
      const sentBytes = (): number => st.receipts.reduce<number>((a, r, n) => a + (r ? Math.min(st.partBytes, file.size - n * st.partBytes) : 0), 0);
      onProgress?.(sentBytes(), file.size);
      for (let n = 0; n < st.parts; n++) {
        if (st.receipts[n]) continue;
        const blob = file.slice(n * st.partBytes, Math.min(file.size, (n + 1) * st.partBytes));
        for (let stalled = 1; ; stalled++) {
          const r = await postJson(`/api/uploads/raw/part?n=${n}`, blob, "application/octet-stream", { "X-Upload-Session": st.session });
          const b = r.body as { receipt?: string } | null;
          if (r.res?.ok && b?.receipt) { st.receipts[n] = b.receipt; saveResume(file, st); onProgress?.(sentBytes(), file.size); break; }
          if (r.body?.restart) throw new RestartUpload(String(r.body.error ?? "restart"));
          if (!retryableOf(r)) throw new Error(r.body?.error ?? `The file could not be uploaded (${r.res!.status}).`);
          if (stalled >= MAX_STALLED) throw new TransientServerError(`The connection keeps dropping. ${Math.floor((100 * sentBytes()) / file.size)}% of the file is saved — choose the same file again to continue from there.`);
          onRetry?.(stalled, MAX_STALLED - 1);
          await backoff(Math.min(stalled, 4));
        }
      }
      for (let attempt = 1; ; attempt++) {
        const r = await postJson("/api/uploads/raw/complete", JSON.stringify({ session: st.session, receipts: st.receipts }), "application/json");
        const b = r.body as { sourceRef?: string; sha256?: string; bytes?: number; missing?: number[] } | null;
        if (r.res?.ok && b?.sourceRef) { saveResume(file, null); return { sourceRef: b.sourceRef, sha256: b.sha256 ?? "", bytes: b.bytes ?? file.size }; }
        if (r.body?.restart) throw new RestartUpload(String(r.body.error ?? "restart"));
        if (Array.isArray(b?.missing) && b!.missing!.length) {
          // Some receipts were not accepted; resend just those parts.
          for (const n of b!.missing!) st.receipts[n] = null;
          saveResume(file, st); keep = st;
          throw new RestartUpload("missing parts");
        }
        if (!retryableOf(r)) throw new Error(r.body?.error ?? `The file could not be uploaded (${r.res!.status}).`);
        if (attempt >= 5) throw new TransientServerError("All parts arrived, but the file could not be finished just now. Choose the same file again to finish — nothing needs to be re-sent.");
        onRetry?.(attempt, 4);
        await backoff(attempt);
      }
    } catch (e) {
      if (!(e instanceof RestartUpload) || restarts >= 2) throw e instanceof RestartUpload ? new TransientServerError("The upload could not be completed. Please choose the file again.") : e;
      if (e.message !== "missing parts") saveResume(file, null); // invalid/expired session or changed part: start a fresh session
    }
  }
}

export async function uploadRaw(file: File, onRetry?: UploadNote, onProgress?: Progress): Promise<RawResult> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("This file is larger than the 50 MiB limit. Split it into smaller files and upload again.");
  return file.size > RAW_UPLOAD_PART_BYTES ? uploadInParts(file, onRetry, onProgress) : uploadSingle(file, onRetry, onProgress);
}
