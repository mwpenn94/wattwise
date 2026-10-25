/**
 * Oct 25 — binary upload transport for large interval workbooks.
 *
 * Measured under the real 512 MiB / 1 vCPU production envelope: a base64 JSON
 * upload is held 5–6 times at once (raw body, JSON string, parsed object, the
 * tRPC adapter's JSON.stringify(req.body) re-serialization, the decoded
 * Buffer and the storage Blob). A 37 MiB workbook pushed the receiving
 * request to 505 MiB; a 50 MiB one would OOM-kill the container — the plain
 * "503 Service Unavailable" users saw.
 *
 * POST /api/uploads/raw streams the request body straight to storage while
 * hashing it (constant memory), and returns a short signed `sourceRef`. The
 * import procedures accept that ref instead of base64 and load the stored
 * bytes exactly once into a preallocated buffer.
 */
import type { Request, Response } from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { TRPCError } from "@trpc/server";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import { storageGetSignedUrl, storagePutStream } from "./storage";
import { MAX_UPLOAD_BYTES } from "../shared/wattwise";

const REF_TTL_MS = 6 * 3600_000;
const MAX_IN_FLIGHT = 3;
let inFlight = 0;

type RefPayload = { v: 1; u: number; k: string; s: string; b: number; e: number };
const b64u = (b: Buffer) => b.toString("base64url");
function secret(): string {
  if (!ENV.cookieSecret) throw new Error("Upload signing secret is not configured");
  return ENV.cookieSecret;
}
const sign = (body: string) => b64u(createHmac("sha256", secret()).update(`raw-upload:v1:${body}`).digest());

export function signSourceRef(p: Omit<RefPayload, "v" | "e">, now = Date.now()): string {
  const body = b64u(Buffer.from(JSON.stringify({ v: 1, ...p, e: now + REF_TTL_MS } satisfies RefPayload)));
  return `${body}.${sign(body)}`;
}

/** Verify a sourceRef for this user. Throws plain-language TRPC errors. */
export function verifySourceRef(userId: number, ref: string, now = Date.now()): RefPayload {
  const bad = () => new TRPCError({ code: "BAD_REQUEST", message: "This file reference is not valid. Choose the file again." });
  const [body, sig, extra] = ref.split(".");
  if (!body || !sig || extra !== undefined) throw bad();
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad();
  let p: RefPayload;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RefPayload; } catch { throw bad(); }
  if (p.v !== 1 || p.u !== userId || typeof p.k !== "string" || !p.k.startsWith(`raw-uploads/${userId}/`) || !/^[0-9a-f]{64}$/.test(p.s) || !Number.isSafeInteger(p.b) || p.b <= 0 || p.b > MAX_UPLOAD_BYTES) throw bad();
  if (!(p.e > now)) throw new TRPCError({ code: "BAD_REQUEST", message: "This upload expired before it was imported. Choose the file again." });
  return p;
}

/** Load a verified stored upload into one exact-size buffer (no concat copy); size and checksum re-checked. */
export async function loadSourceRef(userId: number, ref: string): Promise<{ buf: Buffer; key: string; sha256: string }> {
  const p = verifySourceRef(userId, ref);
  const unavailable = (why: string) => new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `The uploaded file is temporarily unavailable (${why}). Please try again in a moment.` });
  let resp: globalThis.Response;
  try { resp = await fetch(await storageGetSignedUrl(p.k), { signal: AbortSignal.timeout(60_000) }); }
  catch (e) { throw unavailable(e instanceof Error ? e.message : "storage error"); }
  if (!resp.ok || !resp.body) throw unavailable(`status ${resp.status}`);
  const buf = Buffer.allocUnsafe(p.b);
  const hash = createHash("sha256");
  let off = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > p.b) throw new TRPCError({ code: "BAD_REQUEST", message: "The stored file does not match what was uploaded. Choose the file again." });
      buf.set(value, off); off += value.length; hash.update(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e instanceof TRPCError ? e : unavailable(e instanceof Error ? e.message : "read error"); }
  if (off !== p.b || hash.digest("hex") !== p.s) throw new TRPCError({ code: "BAD_REQUEST", message: "The stored file does not match what was uploaded. Choose the file again." });
  return { buf, key: p.k, sha256: p.s };
}

function json(res: Response, status: number, body: Record<string, unknown>) {
  if (!res.headersSent) res.status(status).json(body);
}

/** POST /api/uploads/raw — body: the file bytes (application/octet-stream). */
export async function rawUploadHandler(req: Request, res: Response) {
  let user: { id: number; isCron?: boolean };
  try { user = await sdk.authenticateRequest(req); } catch { req.resume(); return json(res, 401, { error: "Your session has expired. Sign in again, then choose the file again." }); }
  if (user.isCron) { req.resume(); return json(res, 403, { error: "Not available for scheduled tasks." }); }
  const declared = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(declared) || declared <= 0) { req.resume(); return json(res, 411, { error: "The upload did not include its size. Please try again." }); }
  if (declared > MAX_UPLOAD_BYTES) { req.resume(); return json(res, 413, { error: "This file is larger than the 50 MiB limit. Split it into smaller files (for example by date range) and upload again." }); }
  if (inFlight >= MAX_IN_FLIGHT) { req.resume(); res.setHeader("Retry-After", "3"); return json(res, 503, { error: "The server is receiving other files. Retrying shortly.", retryable: true }); }
  inFlight++;
  try {
    const hash = createHash("sha256");
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > declared) return cb(new Error("Upload is larger than its declared size"));
        hash.update(chunk); cb(null, chunk);
      },
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 170_000);
    req.on("aborted", () => ac.abort());
    req.pipe(meter);
    meter.on("error", () => ac.abort());
    const key = `raw-uploads/${user.id}/${randomUUID()}.bin`;
    try {
      await storagePutStream(key, Readable.toWeb(meter) as ReadableStream<Uint8Array>, declared, "application/octet-stream", ac.signal);
    } finally { clearTimeout(timer); }
    if (seen !== declared) return json(res, 400, { error: "The upload was interrupted. Please try again.", retryable: true });
    const sha256 = hash.digest("hex");
    return json(res, 200, { sourceRef: signSourceRef({ u: user.id, k: key, s: sha256, b: declared }), sha256, bytes: declared });
  } catch (e) {
    console.error("[rawUpload] failed", e instanceof Error ? e.message : e);
    req.unpipe(); req.resume();
    return json(res, 503, { error: "The file could not be saved just now. Retrying shortly.", retryable: true });
  } finally {
    inFlight--;
  }
}
