/**
 * Oct 25 — request-sliced single-site workbook ingestion (server/singleIngest.ts).
 * Synthetic workbooks only (no live rate sources, no real customer data).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { intervals, meters, uploads, users } from "../drizzle/schema";

const sources = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storagePut: vi.fn(async (key: string, data: Buffer) => { sources.set(key, data); return { key, url: `/manus-storage/${key}` }; }),
  storageGetSignedUrl: vi.fn(async (key: string) => `data:application/octet-stream;base64,${sources.get(key)!.toString("base64")}`),
}));
vi.mock("./places", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./places")>()),
  geocodeAddress: vi.fn(async () => null),
}));

const openId = `single-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId = 0;
function ctxFor(): TrpcContext {
  return {
    user: { id: userId, openId, email: `${openId}@fe-fixture.invalid`, name: openId, loginMethod: "test", role: "user", tier: "pro", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
const caller = () => appRouter.createCaller(ctxFor());

interface Sheet { name: string; address: string; days?: number; kwh?: number; corruptRow?: boolean }
function rowsFor(s: Sheet): unknown[][] {
  const rows: unknown[][] = [
    ["ACCT NUMBER", "", "", `ACCT-${s.name}`],
    ["SERVICE AGREEMENT ID", "", "", `SA-${s.name}`],
    ["SERVICE POINT ID", "", "", `SP-${s.name}`],
    ["RATE SCHEDULE", "", "", "EGSGS"],
    ["Address", "", "", s.address],
    ["", "DATE", "TIME", "KWH_DEL", "KW"],
  ];
  const days = s.days ?? 2;
  for (let d = 0; d < days; d++) {
    for (let m = 0; m < 24 * 60; m += 15) rows.push(["", 20261020 + d, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, s.kwh ?? 1.5, 6]);
  }
  return rows;
}
function workbook(sheets: Sheet[]): string {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rowsFor(s)), s.name);
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}
async function newSite(name: string) {
  const r = await caller().sites.create({ name, address: "100 Test Ave", city: "Kingman", state: "AZ", zip: "86401", buildingType: "school" } as Parameters<ReturnType<typeof caller>["sites"]["create"]>[0]);
  return (typeof r === "number" ? r : (r as { id: number }).id);
}
async function pointsFor(uploadId: number) {
  const d = (await getDb())!;
  const [c] = await d.select({ n: sql<number>`COUNT(*)` }).from(intervals).where(eq(intervals.uploadId, uploadId));
  return Number(c.n);
}
async function uploadRow(uploadId: number) {
  const d = (await getDb())!;
  const [u] = await d.select().from(uploads).where(eq(uploads.id, uploadId));
  return u!;
}

beforeAll(async () => {
  const d = (await getDb())!;
  await d.insert(users).values({ openId, name: openId, email: `${openId}@fe-fixture.invalid`, loginMethod: "test", tier: "pro" });
  const [u] = await d.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u!.id;
});
afterAll(async () => {
  const d = await getDb();
  if (!d || !userId) return;
  for (const s of await h.listSites(userId)) await h.deleteSite(s.id, userId);
  await d.delete(uploads).where(eq(uploads.userId, userId));
  await d.delete(users).where(eq(users.id, userId));
  delete process.env.SINGLE_INGEST_SLICE_MS;
});

describe("single-site sliced workbook ingest", () => {
  it("imports a small multi-sheet workbook in one call with the prior result shape", async () => {
    const siteId = await newSite("One call");
    const b64 = workbook([{ name: "Main", address: "100 Test Ave, Kingman" }, { name: "Annex", address: "100 Test Ave, Unit B, Kingman" }]);
    const r = await caller().uploads.ingest({ siteId, filename: "small.xlsx", format: "xlsx", contentBase64: b64, timestampBasis: "start" });
    expect(r.more).toBe(false);
    expect(r.duplicate).toBe(false);
    expect(r.meters.map((m) => m.label).sort()).toEqual(["Annex", "Main"]);
    expect(r.totalPoints).toBe(2 * 2 * 96);
    expect(r.validations).toHaveLength(2);
    const u = await uploadRow(r.uploadId);
    expect(u.status).toBe("parsed");
    expect(u.ingestState).toBeNull();
    expect(u.rowsIngested).toBe(2 * 2 * 96);
    expect(u.sheetsFound).toBe(2);
    expect(await pointsFor(r.uploadId)).toBe(2 * 2 * 96);
    // same campus (Unit B descriptor) → no multi-address question even when asked
    const again = await caller().uploads.ingest({ siteId, filename: "small.xlsx", format: "xlsx", contentBase64: b64, askOnMultiAddress: true });
    expect(again.duplicate).toBe(true);
    // bill rate code reconciled onto the meter
    const ms = await h.listMeters(siteId, userId);
    expect(ms.every((m) => m.rateScheduleCode === "EGSGS")).toBe(true);
  }, 60_000);

  it("slices large work across requests, reports progress, and resumes to exact totals", async () => {
    process.env.SINGLE_INGEST_SLICE_MS = "1"; // stop after every sheet
    try {
      const siteId = await newSite("Sliced");
      const sheets = ["S1", "S2", "S3"].map((name) => ({ name, address: "100 Test Ave, Kingman" }));
      let r = await caller().uploads.ingest({ siteId, filename: "sliced.xlsx", format: "xlsx", contentBase64: workbook(sheets) });
      expect(r.more).toBe(true);
      const seen: number[] = [];
      let calls = 1;
      // analysis is refused while a sliced upload is unfinished on the site
      await expect(caller().analysis.run({ siteId })).rejects.toThrow(/still importing/);
      const listed = (await caller().uploads.list()).find((u) => u.id === r.uploadId)!;
      expect(listed.progress?.sheetsTotal).toBe(3);
      expect("ingestState" in listed).toBe(false);
      while (r.more) {
        seen.push(r.progress!.sheetsDone);
        r = await caller().uploads.ingestContinue({ uploadId: r.uploadId });
        if (++calls > 20) throw new Error("did not finish");
      }
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(r.progress).toEqual({ sheetsDone: 3, sheetsTotal: 3, pointsWritten: 3 * 2 * 96 });
      expect(r.totalPoints).toBe(3 * 2 * 96);
      expect(await pointsFor(r.uploadId)).toBe(3 * 2 * 96);
      const u = await uploadRow(r.uploadId);
      expect(u.status).toBe("parsed");
      expect(u.ingestState).toBeNull();
      // continuing a finished upload is harmless and reports the final record
      const done = await caller().uploads.ingestContinue({ uploadId: r.uploadId });
      expect(done.more).toBe(false);
      expect(done.totalPoints).toBe(3 * 2 * 96);
    } finally {
      delete process.env.SINGLE_INGEST_SLICE_MS;
    }
  }, 90_000);

  it("re-sending the same file after a dropped connection resumes the pending upload", async () => {
    process.env.SINGLE_INGEST_SLICE_MS = "1";
    try {
      const siteId = await newSite("Resume by resend");
      const b64 = workbook(["R1", "R2"].map((name) => ({ name, address: "100 Test Ave, Kingman" })));
      const first = await caller().uploads.ingest({ siteId, filename: "resume.xlsx", format: "xlsx", contentBase64: b64 });
      expect(first.more).toBe(true);
      delete process.env.SINGLE_INGEST_SLICE_MS;
      const second = await caller().uploads.ingest({ siteId, filename: "resume.xlsx", format: "xlsx", contentBase64: b64 });
      expect(second.uploadId).toBe(first.uploadId);
      expect(second.more).toBe(false);
      expect(await pointsFor(first.uploadId)).toBe(2 * 2 * 96);
      const d = (await getDb())!;
      const rows = await d.select().from(uploads).where(and(eq(uploads.userId, userId), eq(uploads.siteId, siteId)));
      expect(rows).toHaveLength(1);
    } finally {
      delete process.env.SINGLE_INGEST_SLICE_MS;
    }
  }, 60_000);

  it("a large file is only stored and header-read by the request that carries it; sheets run in follow-up requests", async () => {
    process.env.SINGLE_INGEST_HANDOFF_BYTES = "1"; // every workbook counts as large
    try {
      const siteId = await newSite("Hand-off");
      const b64 = workbook(["H1", "H2"].map((name) => ({ name, address: "100 Test Ave, Kingman" })));
      const first = await caller().uploads.ingest({ siteId, filename: "handoff.xlsx", format: "xlsx", contentBase64: b64 });
      expect(first.more).toBe(true);
      expect(first.progress).toEqual({ sheetsDone: 0, sheetsTotal: 2, pointsWritten: 0 });
      expect(await pointsFor(first.uploadId)).toBe(0);
      // re-sending the same large file also hands off instead of parsing in the big request
      const resent = await caller().uploads.ingest({ siteId, filename: "handoff.xlsx", format: "xlsx", contentBase64: b64 });
      expect(resent.uploadId).toBe(first.uploadId);
      expect(resent.more).toBe(true);
      expect(await pointsFor(first.uploadId)).toBe(0);
      let r = await caller().uploads.ingestContinue({ uploadId: first.uploadId });
      for (let n = 0; r.more && n < 10; n++) r = await caller().uploads.ingestContinue({ uploadId: first.uploadId });
      expect(r.more).toBe(false);
      expect(r.totalPoints).toBe(2 * 2 * 96);
      expect(await pointsFor(first.uploadId)).toBe(2 * 2 * 96);
      expect((await uploadRow(first.uploadId)).status).toBe("parsed");
    } finally {
      delete process.env.SINGLE_INGEST_HANDOFF_BYTES;
    }
  }, 60_000);

  it("asks before importing a workbook that lists several service addresses, writing nothing until confirmed", async () => {
    const siteId = await newSite("Multi-address");
    const b64 = workbook([{ name: "North", address: "500 Maple St, Kingman" }, { name: "South", address: "3033 McDonald Ave, Kingman" }]);
    const r = await caller().uploads.ingest({ siteId, filename: "district.xlsx", format: "xlsx", contentBase64: b64, askOnMultiAddress: true });
    expect(r.more).toBe(false);
    expect(r.needsChoice).toMatchObject({ addresses: 2, sheets: 2 });
    expect(await pointsFor(r.uploadId)).toBe(0);
    expect(await h.listMeters(siteId, userId)).toHaveLength(0);
    // without confirmation, continuing keeps asking
    const still = await caller().uploads.ingestContinue({ uploadId: r.uploadId });
    expect(still.needsChoice?.addresses).toBe(2);
    const listed = (await caller().uploads.list()).find((u) => u.id === r.uploadId)!;
    expect(listed.progress?.awaitingChoice).toBe(true);
    // the user chose "add every sheet to this site"
    const ok = await caller().uploads.ingestContinue({ uploadId: r.uploadId, confirmMultiAddress: true });
    expect(ok.more).toBe(false);
    expect(ok.meters).toHaveLength(2);
    expect(await pointsFor(r.uploadId)).toBe(2 * 2 * 96);
  }, 60_000);

  it("a declined multi-address upload can be deleted with nothing left behind", async () => {
    const siteId = await newSite("Declined");
    const b64 = workbook([{ name: "A", address: "1 First St, Kingman" }, { name: "B", address: "2 Second St, Kingman" }]);
    const r = await caller().uploads.ingest({ siteId, filename: "declined.xlsx", format: "xlsx", contentBase64: b64, askOnMultiAddress: true });
    expect(r.needsChoice).toBeTruthy();
    await caller().uploads.delete({ uploadId: r.uploadId });
    const d = (await getDb())!;
    expect(await d.select().from(uploads).where(eq(uploads.id, r.uploadId))).toHaveLength(0);
    expect(await h.listMeters(siteId, userId)).toHaveLength(0);
  }, 60_000);

  it("a failing sheet rolls back every reading and meter from that file (no silent partial import)", async () => {
    const siteId = await newSite("Rollback");
    const writer = await import("./ingest/writer");
    const real = writer.writeIntervals;
    let n = 0;
    const spy = vi.spyOn(writer, "writeIntervals").mockImplementation(async (...args: Parameters<typeof real>) => {
      if (++n === 2) throw new Error("simulated database outage");
      return real(...args);
    });
    try {
      const b64 = workbook(["F1", "F2", "F3"].map((name) => ({ name, address: "100 Test Ave, Kingman" })));
      await expect(caller().uploads.ingest({ siteId, filename: "fail.xlsx", format: "xlsx", contentBase64: b64 })).rejects.toThrow(/Nothing from this file was kept/);
    } finally {
      spy.mockRestore();
    }
    const d = (await getDb())!;
    const [u] = await d.select().from(uploads).where(and(eq(uploads.userId, userId), eq(uploads.filename, "fail.xlsx")));
    expect(u.status).toBe("failed");
    expect(u.ingestState).toBeNull();
    expect(await pointsFor(u.id)).toBe(0);
    expect(await h.listMeters(siteId, userId)).toHaveLength(0);
  }, 60_000);

  it("keeps an existing meter (and its earlier readings) when a later file fails", async () => {
    const siteId = await newSite("Keep existing");
    const ok = await caller().uploads.ingest({ siteId, filename: "jan.xlsx", format: "xlsx", contentBase64: workbook([{ name: "Main", address: "100 Test Ave, Kingman" }]) });
    expect(ok.more).toBe(false);
    const before = await h.listMeters(siteId, userId);
    const writer = await import("./ingest/writer");
    const spy = vi.spyOn(writer, "writeIntervals").mockRejectedValueOnce(new Error("simulated outage"));
    try {
      await expect(caller().uploads.ingest({ siteId, filename: "feb.xlsx", format: "xlsx", contentBase64: workbook([{ name: "Main", address: "100 Test Ave, Kingman", kwh: 2 }]) })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    const after = await h.listMeters(siteId, userId);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(await pointsFor(ok.uploadId)).toBe(2 * 96);
  }, 60_000);

  it("strangers can neither continue nor see another user's upload", async () => {
    const siteId = await newSite("Private");
    process.env.SINGLE_INGEST_SLICE_MS = "1";
    let uploadId = 0;
    try {
      const r = await caller().uploads.ingest({ siteId, filename: "private.xlsx", format: "xlsx", contentBase64: workbook(["P1", "P2"].map((name) => ({ name, address: "100 Test Ave, Kingman" }))) });
      uploadId = r.uploadId;
    } finally {
      delete process.env.SINGLE_INGEST_SLICE_MS;
    }
    const stranger = appRouter.createCaller({ ...ctxFor(), user: { ...ctxFor().user!, id: -987654321, openId: "stranger" } } as TrpcContext);
    await expect(stranger.uploads.ingestContinue({ uploadId })).rejects.toThrow(/not found/i);
    const r = await caller().uploads.ingestContinue({ uploadId });
    expect(r.more).toBe(false);
  }, 60_000);
});

describe("cleanup sanity", () => {
  it("leaves no orphan meters for the fixture", async () => {
    const d = (await getDb())!;
    const siteIds = (await h.listSites(userId)).map((s) => s.id);
    if (siteIds.length === 0) return;
    const ms = await d.select().from(meters).where(inArray(meters.siteId, siteIds));
    for (const m of ms) expect(m.userId).toBe(userId);
  });
});
