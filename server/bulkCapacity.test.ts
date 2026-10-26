/**
 * OPEN-4 (Oct 26) — bulk import on limited plans.
 *
 * The interim F8 rule refused every bulk import on a plan with a site limit.
 * Bulk now shares the owner's capacity lock with the legacy site routes, so a
 * limited plan may bulk import whenever the sites still to be created fit:
 *  - an import that fits completes; re-importing it at the cap adds nothing;
 *  - an import that does not fit is refused before anything is written;
 *  - a site created elsewhere mid-import is honored: the next bulk site is
 *    refused, the owner never exceeds the plan, and Resume finishes once
 *    capacity is freed (Resume while still full is refused up front);
 *  - bulk and legacy creations racing freely never exceed the plan;
 *  - the owner's users row is not held while a sheet is parsed or written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { billingAccounts, entities, importBatchFiles, importBatches, importBatchSheets, importSiteGroups, sites, uploads, users } from "../drizzle/schema";
import { FREE_TIER_MAX_SITES } from "../shared/wattwise";

vi.mock("./places", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./places")>()),
  geocodeAddress: vi.fn(async (address: string) => ({ kind: "precise" as const, lat: 35.1894, lng: -114.053, formattedAddress: `${address}, AZ, USA`, city: "Kingman", state: "AZ", zip: "86401" })),
}));
const sources = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storagePut: vi.fn(async (key: string, data: Buffer) => { sources.set(key, data); return { key, url: `/manus-storage/${key}` }; }),
  storageGetSignedUrl: vi.fn(async (key: string) => `data:application/octet-stream;base64,${sources.get(key)!.toString("base64")}`),
}));
/** Holds the first per-sheet parse of a commit so a test can act mid-import
 *  (the bulk worker is between transactions at that point). */
const gate = vi.hoisted(() => ({ armed: false, hit: null as string | null, onHit: () => {}, wait: Promise.resolve() }));
vi.mock("./ingest/hardening", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ingest/hardening")>();
  return {
    ...real,
    parseWorkbookInWorker: async (buf: Buffer, sheetName?: string, timeoutMs?: number) => {
      if (sheetName && gate.armed && !gate.hit) { gate.hit = sheetName; gate.onHit(); await gate.wait; }
      return real.parseWorkbookInWorker(buf, sheetName, timeoutMs);
    },
  };
});

const openId = `bulk-capacity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function ctx(): TrpcContext {
  return {
    user: { id: userId, openId, email: `${openId}@fe-fixture.invalid`, name: openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
const caller = () => appRouter.createCaller(ctx());

function workbook(tags: string[]): string {
  const wb = XLSX.utils.book_new();
  for (const tag of tags) {
    const rows: unknown[][] = [
      ["ACCT NUMBER", "", "", `AC-${tag}`],
      ["SERVICE AGREEMENT ID", "", "", `SA-${tag}`],
      ["SERVICE POINT ID", "", "", `SP-${tag}`],
      ["RATE SCHEDULE", "", "", "EGSGS"],
      ["Address", "", "", `400 ${tag} Ave, Kingman, AZ`],
      ["", "DATE", "TIME", "KWH_DEL", "KW"],
    ];
    for (const date of [20261020, 20261021]) for (let m = 0; m < 24 * 60; m += 15) rows.push(["", date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, 1.25, 5]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), tag.slice(0, 31));
  }
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}
async function prepared(tags: string[]) {
  const c = caller();
  const staged = await c.bulkImport.stageFile({ filename: `${tags[0]}.xlsx`, contentBase64: workbook(tags) });
  const preview = await c.bulkImport.preview({ batchId: staged.batchId, groupingMode: "campus", timeZone: "America/Phoenix", timestampBasis: "start" });
  return { c, staged, preview };
}
const commit = (fx: Awaited<ReturnType<typeof prepared>>) => fx.c.bulkImport.commit({ batchId: fx.staged.batchId, planVersion: fx.preview.planVersion, clockConfirmed: true, runAnalysis: false });
async function settle(fx: Awaited<ReturnType<typeof prepared>>) {
  const deadline = Date.now() + 60_000;
  let st = await fx.c.bulkImport.status({ batchId: fx.staged.batchId });
  while (Date.now() < deadline) {
    st = await fx.c.bulkImport.status({ batchId: fx.staged.batchId });
    if (!st.running && st.batch.status !== "committing") return st;
    if (st.paused) { await fx.c.bulkImport.commit({ batchId: fx.staged.batchId, planVersion: st.batch.planVersion }); continue; }
    await sleep(100);
  }
  throw new Error(`bulk import ${fx.staged.batchId} did not settle: ${st.batch.status}`);
}
async function siteCount() {
  const [r] = await (await getDb())!.select({ n: sql<number>`COUNT(*)` }).from(sites).where(eq(sites.userId, userId));
  return Number(r.n);
}
async function clearSites() { for (const s of await h.listSites(userId)) await h.deleteSite(s.id, userId); }
const legacySite = (name: string) => caller().sites.create({ name, state: "AZ", zip: "86401", climateZone: "3B" });

beforeAll(async () => {
  const d = (await getDb())!;
  await d.insert(users).values({ openId, name: openId, email: `${openId}@fe-fixture.invalid`, loginMethod: "test", tier: "free" });
  const [u] = await d.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u!.id;
  await d.insert(billingAccounts).values({ userId, plan: "free", entitlementTier: "free", status: "active" });
});
afterAll(async () => {
  const d = await getDb();
  if (!d || !userId) return;
  gate.armed = false;
  await clearSites();
  const batchIds = (await d.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.userId, userId))).map((b) => b.id);
  if (batchIds.length) {
    await d.delete(importBatchSheets).where(inArray(importBatchSheets.batchId, batchIds));
    await d.delete(importBatchFiles).where(inArray(importBatchFiles.batchId, batchIds));
    await d.delete(importBatches).where(inArray(importBatches.id, batchIds));
  }
  await d.delete(importSiteGroups).where(eq(importSiteGroups.userId, userId));
  await d.delete(entities).where(eq(entities.userId, userId));
  await d.delete(uploads).where(eq(uploads.userId, userId));
  await d.delete(billingAccounts).where(eq(billingAccounts.userId, userId));
  await d.delete(users).where(eq(users.id, userId));
});

describe("bulk import on a limited plan (free: 2 sites)", () => {
  it("imports when the new sites fit, and re-importing at the cap adds nothing", async () => {
    expect(FREE_TIER_MAX_SITES).toBe(2);
    const fx = await prepared(["CapA", "CapB"]);
    expect(fx.preview.planLimit).toMatchObject({ ok: true, limit: 2, currentSites: 0, newSites: 2 });
    expect((await commit(fx)).started).toBe(true);
    const done = await settle(fx);
    expect(done.batch.status).toBe("complete");
    expect(done.batch.summary).toMatchObject({ sitesCreated: 2, sheetsImported: 2 });
    expect(await siteCount()).toBe(2);
    // Same workbook again at the cap: every group maps to an existing site.
    const again = await prepared(["CapA", "CapB"]);
    expect(again.preview.planLimit).toMatchObject({ ok: true, newSites: 0, currentSites: 2 });
    await commit(again);
    expect((await settle(again)).batch.status).toBe("complete");
    expect(await siteCount()).toBe(2);
  }, 60_000);

  it("refuses an import that does not fit before writing anything", async () => {
    const fx = await prepared(["CapC"]);
    expect(fx.preview.planLimit).toMatchObject({ ok: false, limit: 2, currentSites: 2, newSites: 1 });
    await expect(commit(fx)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/would add 1 new site, and your plan allows 2 sites \(2 in use\).*Nothing was imported/) });
    const d = (await getDb())!;
    const [batch] = await d.select().from(importBatches).where(eq(importBatches.id, fx.staged.batchId));
    expect(batch.status).toBe("previewed");
    expect(batch.workerToken).toBeNull();
    const [file] = await d.select().from(importBatchFiles).where(eq(importBatchFiles.batchId, fx.staged.batchId));
    expect(file.uploadId).toBeNull();
    const sheets = await d.select().from(importBatchSheets).where(eq(importBatchSheets.batchId, fx.staged.batchId));
    expect(sheets.every((s) => s.siteId == null && s.pointsWritten === 0)).toBe(true);
    expect(await siteCount()).toBe(2);
  }, 60_000);

  it("honors a site created mid-import, never exceeds the plan, and resumes once capacity is freed", async () => {
    await clearSites();
    const fx = await prepared(["RaceA", "RaceB"]);
    expect(fx.preview.planLimit).toMatchObject({ ok: true, currentSites: 0, newSites: 2 });
    let release!: () => void;
    let hit!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    Object.assign(gate, { armed: true, hit: null, onHit: () => hit(), wait: new Promise<void>((r) => (release = r)) });
    const running = commit(fx);
    try {
      await reached; // first bulk site exists; the worker is parsing its sheet
      expect(await siteCount()).toBe(1);
      // The worker holds no transaction now: a legacy create proceeds at once.
      const t0 = Date.now();
      const extra = await legacySite("Created during import");
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(extra.id).toBeGreaterThan(0);
    } finally {
      gate.armed = false;
      release();
    }
    await running;
    const first = await settle(fx);
    expect(["partial", "failed"]).toContain(first.batch.status);
    expect(first.sheets.find((s) => s.status === "failed")?.detail).toMatch(/Site capacity exhausted: your plan allows 2 sites and 2 are in use/);
    expect(await siteCount()).toBe(2);
    // Resume while still full is refused up front, with nothing written.
    await expect(commit(fx)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/would add 1 new site/) });
    expect(await siteCount()).toBe(2);
    // Free one site, then Resume finishes the remaining sheet.
    const extraSite = (await h.listSites(userId)).find((s) => s.name === "Created during import")!;
    await h.deleteSite(extraSite.id, userId);
    await commit(fx);
    const done = await settle(fx);
    expect(done.batch.status).toBe("complete");
    expect(done.sheets.every((s) => s.status === "imported")).toBe(true);
    expect(await siteCount()).toBe(2);
  }, 90_000);

  it("bulk and legacy site creations racing freely never exceed the plan", async () => {
    await clearSites();
    const fx = await prepared(["FreeA", "FreeB"]);
    const outcomes = await Promise.allSettled([commit(fx), legacySite("Racer 1"), legacySite("Racer 2")]);
    for (const o of outcomes) if (o.status === "rejected") expect(String(o.reason?.message)).toMatch(/Free tier is limited to 2 sites|would add \d+ new sites?/);
    if (outcomes[0].status === "fulfilled") await settle(fx);
    expect(await siteCount()).toBe(2);
    const st = await fx.c.bulkImport.status({ batchId: fx.staged.batchId });
    for (const s of st.sheets.filter((x) => x.status === "failed")) expect(s.detail).toMatch(/Site capacity exhausted/);
  }, 90_000);

  it("deleting an imported site lets a re-import create it again within the plan", async () => {
    await clearSites();
    const fx = await prepared(["GoneA"]);
    await commit(fx);
    expect((await settle(fx)).batch.status).toBe("complete");
    const [site] = await h.listSites(userId);
    await h.deleteSite(site.id, userId);
    const d = (await getDb())!;
    expect(await d.select().from(importSiteGroups).where(and(eq(importSiteGroups.userId, userId), eq(importSiteGroups.siteId, site.id)))).toHaveLength(0);
    const again = await prepared(["GoneA"]);
    expect(again.preview.planLimit).toMatchObject({ ok: true, currentSites: 0, newSites: 1 });
    await commit(again);
    expect((await settle(again)).batch.status).toBe("complete");
    expect(await siteCount()).toBe(1);
  }, 60_000);
});
