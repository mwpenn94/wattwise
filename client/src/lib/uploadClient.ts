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
  return /Unexpected token|not valid JSON|Failed to fetch|NetworkError|Load failed|unexpected 50[234]|Service Unavailable|Bad Gateway|Gateway Time/i.test(m);
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
 * `uploads.ingest` / `bulkImport.stageFile` accept as `sourceRef`. Transient
 * failures (busy server, proxy 5xx, dropped connection) retry with backoff;
 * `onRetry` lets the caller show a calm progress note.
 */
export async function uploadRaw(file: File, onRetry?: (attempt: number, max: number) => void): Promise<{ sourceRef: string; sha256: string; bytes: number }> {
  const MAX = 5;
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`/api/uploads/raw?filename=${encodeURIComponent(file.name.slice(0, 200))}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream", ...authHeaders() },
        body: file,
      });
    } catch {
      res = null;
    }
    const isJson = (res?.headers.get("content-type") ?? "").includes("application/json");
    const body = isJson ? ((await res!.json().catch(() => null)) as { sourceRef?: string; sha256?: string; bytes?: number; error?: string; retryable?: boolean } | null) : null;
    if (res?.ok && body?.sourceRef) return { sourceRef: body.sourceRef, sha256: body.sha256 ?? "", bytes: body.bytes ?? file.size };
    if (res?.status === 413) throw new Error(body?.error ?? "This file is larger than the 50 MiB limit. Split it into smaller files and upload again.");
    const retryable = !res || !isJson || res.status >= 500 || body?.retryable === true;
    if (!retryable) throw new Error(body?.error ?? `The file could not be uploaded (${res!.status}).`);
    if (attempt >= MAX) throw new TransientServerError("We couldn't upload the file after several tries. Check your connection and try again — nothing was imported.");
    onRetry?.(attempt, MAX - 1);
    await sleep(Math.min(20_000, 1500 * attempt * attempt));
  }
}
