/**
 * Oct 25 — binary upload transport (server/rawUpload.ts): signed source
 * references, the streaming route's limits, and ingest/staging via sourceRef.
 * Synthetic workbooks only; storage is an in-memory map.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { eq, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { importBatches, importBatchFiles, importBatchSheets, intervals, uploads, users } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import * as storage from "./storage";
import { loadSourceRef, rawUploadHandler, signSourceRef, verifySourceRef } from "./rawUpload";

const sources = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storagePut: vi.fn(async (key: string, data: Buffer) => { sources.set(key, Buffer.from(data)); return { key, url: `/manus-storage/${key}` }; }),
  storagePutStream: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
    const parts: Buffer[] = [];
    for await (const c of body as unknown as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c));
    sources.set(key, Buffer.concat(parts));
    return { key, url: `/manus-storage/${key}` };
  }),
  storageGetSignedUrl: vi.fn(async (key: string) => `data:application/octet-stream;base64,${sources.get(key)!.toString("base64")}`),
}));
vi.mock("./places", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./places")>()),
  geocodeAddress: vi.fn(async () => null),
}));

const openId = `raw-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId = 0;
function ctxFor(): TrpcContext {
  return {
    user: { id: userId, openId, email: `${openId}@fe-fixture.invalid`, name: openId, loginMethod: "test", role: "user", tier: "pro", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
const caller = () => appRouter.createCaller(ctxFor());

function workbookBuf(name: string, address: string): Buffer {
  const rows: unknown[][] = [
    ["ACCT NUMBER", "", "", `ACCT-${name}`], ["SERVICE AGREEMENT ID", "", "", `SA-${name}`], ["SERVICE POINT ID", "", "", `SP-${name}`],
    ["RATE SCHEDULE", "", "", "EGSGS"], ["Address", "", "", address], ["", "DATE", "TIME", "KWH_DEL", "KW"],
  ];
  for (let d = 0; d < 2; d++) for (let m = 0; m < 1440; m += 15) rows.push(["", 20261020 + d, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, 1.5, 6]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Minimal Express-like req/res pair for the streaming route. */
function call(body: Buffer, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([body]), { headers, query: {} });
  return new Promise<{ status: number; json: Record<string, unknown> }>((resolve) => {
    let status = 200;
    const res = {
      headersSent: false,
      setHeader: () => res,
      status(s: number) { status = s; return res; },
      json(j: Record<string, unknown>) { res.headersSent = true; resolve({ status, json: j }); return res; },
    };
    void rawUploadHandler(req as never, res as never);
  });
}
const asUser = () => vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: userId } as never);

beforeAll(async () => {
  const d = (await getDb())!;
  await d.insert(users).values({ openId, name: openId, email: `${openId}@fe-fixture.invalid`, loginMethod: "test", tier: "pro" });
  const [u] = await d.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u!.id;
});
afterAll(async () => {
  vi.restoreAllMocks();
  const d = await getDb();
  if (!d || !userId) return;
  for (const s of await h.listSites(userId)) await h.deleteSite(s.id, userId);
  await d.delete(intervals).where(sql`${intervals.uploadId} IN (SELECT id FROM uploads WHERE userId = ${userId})`);
  await d.delete(uploads).where(eq(uploads.userId, userId));
  await d.delete(importBatchSheets).where(eq(importBatchSheets.userId, userId));
  await d.delete(importBatchFiles).where(eq(importBatchFiles.userId, userId));
  await d.delete(importBatches).where(eq(importBatches.userId, userId));
  await d.delete(users).where(eq(users.id, userId));
}, 120_000); // the uploadId cleanup scans the shared intervals table (no uploadId index)

describe("signed source references", () => {
  const sha = "a".repeat(64);
  it("round-trips for the owning user only", () => {
    const ref = signSourceRef({ u: userId, k: `raw-uploads/${userId}/x.bin`, s: sha, b: 10 });
    expect(verifySourceRef(userId, ref)).toMatchObject({ u: userId, b: 10, s: sha });
    expect(() => verifySourceRef(userId + 1, ref)).toThrow(/not valid/);
  });
  it("rejects tampering, foreign storage keys and expiry", () => {
    const ref = signSourceRef({ u: userId, k: `raw-uploads/${userId}/x.bin`, s: sha, b: 10 });
    const [body, sig] = ref.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), b: 11 })).toString("base64url");
    expect(() => verifySourceRef(userId, `${forged}.${sig}`)).toThrow(/not valid/);
    expect(() => verifySourceRef(userId, signSourceRef({ u: userId, k: `uploads/${userId}/x.bin`, s: sha, b: 10 }))).toThrow(/not valid/);
    expect(() => verifySourceRef(userId, ref, Date.now() + 7 * 3600_000)).toThrow(/expired/);
  });
});

describe("POST /api/uploads/raw", () => {
  it("requires a session", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValueOnce(new Error("no session"));
    const r = await call(Buffer.from("x"), { "content-length": "1" });
    expect(r.status).toBe(401);
  });
  it("refuses missing or oversized declared sizes before reading the body", async () => {
    asUser();
    expect((await call(Buffer.from("x"), {})).status).toBe(411);
    const big = await call(Buffer.from("x"), { "content-length": String(51 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect(String(big.json.error)).toMatch(/50 MiB/);
  });
  it("rejects a body that does not match its declared size", async () => {
    asUser();
    const r = await call(Buffer.from("abc"), { "content-length": "10" });
    expect(r.status).toBe(400);
    expect(r.json.retryable).toBe(true);
  });
  it("streams bytes to storage and returns a verifiable reference", async () => {
    asUser();
    const buf = workbookBuf("Main", "100 Test Ave, Kingman");
    const r = await call(buf, { "content-length": String(buf.length) });
    expect(r.status).toBe(200);
    expect(r.json.sha256).toBe(createHash("sha256").update(buf).digest("hex"));
    expect(vi.mocked(storage.storagePut)).not.toHaveBeenCalledWith(expect.stringMatching(/^raw-uploads\//), expect.anything(), expect.anything());
    const loaded = await loadSourceRef(userId, String(r.json.sourceRef));
    expect(loaded.buf.equals(buf)).toBe(true);
  });
  it("detects stored bytes that changed after upload", async () => {
    asUser();
    const buf = workbookBuf("Tamper", "100 Test Ave, Kingman");
    const r = await call(buf, { "content-length": String(buf.length) });
    const key = verifySourceRef(userId, String(r.json.sourceRef)).k;
    const altered = Buffer.from(sources.get(key)!); altered[altered.length - 1] ^= 0xff; sources.set(key, altered);
    await expect(loadSourceRef(userId, String(r.json.sourceRef))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("imports via sourceRef", () => {
  async function upload(buf: Buffer) {
    asUser();
    const r = await call(buf, { "content-length": String(buf.length) });
    expect(r.status).toBe(200);
    return String(r.json.sourceRef);
  }
  it("single-site ingest reads the stored file and keeps it as the durable source", async () => {
    const created = await caller().sites.create({ name: "Raw ingest", address: "100 Test Ave", city: "Kingman", state: "AZ", zip: "86401", buildingType: "school" } as never);
    const siteId = typeof created === "number" ? created : (created as { id: number }).id;
    const sourceRef = await upload(workbookBuf("Main", "100 Test Ave, Kingman"));
    vi.mocked(storage.storagePut).mockClear();
    const res = await caller().uploads.ingest({ siteId, filename: "main.xlsx", format: "xlsx", sourceRef });
    expect(res.more).toBe(false);
    expect(res.totalPoints).toBe(192);
    expect(vi.mocked(storage.storagePut)).not.toHaveBeenCalled();
    const d = (await getDb())!;
    const [u] = await d.select().from(uploads).where(eq(uploads.id, res.uploadId));
    expect(u!.fileKey).toBe(verifySourceRef(userId, sourceRef).k);
    expect(u!.status).toBe("parsed");
  }, 30_000);
  it("bulk staging accepts a sourceRef and reuses the stored copy", async () => {
    const sourceRef = await upload(workbookBuf("North", "200 North St, Kingman, AZ 86401"));
    vi.mocked(storage.storagePut).mockClear();
    const staged = await caller().bulkImport.stageFile({ filename: "north.xlsx", sourceRef });
    expect(staged.sheets).toBe(1);
    expect(vi.mocked(storage.storagePut)).not.toHaveBeenCalled();
    const d = (await getDb())!;
    const [f] = await d.select().from(importBatchFiles).where(eq(importBatchFiles.id, staged.fileId));
    expect(f!.fileKey).toBe(verifySourceRef(userId, sourceRef).k);
  }, 30_000);
  it("requires exactly one file input", async () => {
    await expect(caller().bulkImport.stageFile({ filename: "none.xlsx" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().bulkImport.stageFile({ filename: "both.xlsx", sourceRef: "x.y", contentBase64: "AA==" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("refuses another user's reference", async () => {
    const foreign = signSourceRef({ u: userId + 999_999, k: `raw-uploads/${userId + 999_999}/x.bin`, s: "b".repeat(64), b: 10 });
    await expect(caller().bulkImport.stageFile({ filename: "foreign.xlsx", sourceRef: foreign })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
