/**
 * UNF-1 (Oct 26) — bulkImport.unfinished: the app-wide "your import is
 * unfinished" notice. Imports advance only while the Upload page is open, so
 * the console must be able to say so from any page. These tests check the
 * query reports paused bulk batches and paused single-site files in plain
 * progress terms, hides files that a request is working on right now, never
 * leaks another owner's imports, and is read-only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { importBatchFiles, importBatches, uploads, users } from "../drizzle/schema";
import { unfinishedImportProgress } from "../client/src/components/UnfinishedImportNotice";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ids: number[] = [];
let owner = 0;
let other = 0;
let siteId = 0;

function ctxFor(id: number, openId: string): TrpcContext {
  return {
    user: { id, openId, email: `${openId}@test.local`, name: openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
const caller = (id: number) => appRouter.createCaller(ctxFor(id, `unf1-${stamp}-${id}`));

function sheetState(over: Partial<{ phase: string; token: string | null; leaseUntil: number; cursor: number; sheets: number }>) {
  const n = over.sheets ?? 20;
  return {
    v: 1, phase: over.phase ?? "importing", token: over.token ?? null, leaseUntil: over.leaseUntil ?? 0, startedAt: Date.now() - 3600_000,
    clock: { timeZone: "America/Phoenix", basis: "end" }, commodityHint: null,
    sheetNames: Array.from({ length: n }, (_, i) => `Sheet${i + 1}`), headers: {}, addressCount: 1, addressExamples: [],
    cursor: over.cursor ?? 0, resumeSheet: null, meters: [], createdMeterIds: [],
  };
}

beforeAll(async () => {
  const db = (await getDb())!;
  for (const tag of ["owner", "other"]) {
    const openId = `unf1-${stamp}-${tag}`;
    const [r] = await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: "free" });
    ids.push(Number(r.insertId));
  }
  [owner, other] = ids;
  siteId = await h.createSite({ userId: owner, name: "UNF-1 fixture site", address: "1 Test Way", city: "Kingman", state: "AZ", zip: "86401" } as never);
}, 30_000);

afterAll(async () => {
  const db = (await getDb())!;
  for (const id of ids) {
    await db.delete(importBatchFiles).where(eq(importBatchFiles.userId, id));
    await db.delete(importBatches).where(eq(importBatches.userId, id));
    await h.deleteAllUserData(id);
  }
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
}, 60_000);

describe("UNF-1 unfinished imports", () => {
  it("is empty for an owner with nothing unfinished", async () => {
    const r = await caller(owner).bulkImport.unfinished();
    expect(r).toEqual({ batches: [], files: [] });
  });

  it("reports a paused bulk batch with plain progress, its files, and running=false once the lease lapsed", async () => {
    const db = (await getDb())!;
    const summary = {
      phase: "enriching", sheetsTotal: 20, sheetsDone: 20, sheetsImported: 20, sheetsFailed: 0, sheetsDuplicate: 0, pointsWritten: 700_800,
      sitesCreated: 10, sitesReused: 1, metersCreated: 20, metersReused: 0, tariffsAssigned: 20, campusTotals: 4, analysesRun: 0, analysesFailed: 0,
      currentSheet: null, currentSite: null, siteIds: Array.from({ length: 11 }, (_, i) => 9_000_000 + i), entityId: null,
      options: { runAnalysis: true }, startedAt: Date.now() - 7200_000, notes: [], postProcessing: {},
    };
    const [b] = await db.insert(importBatches).values({ userId: owner, status: "committing", summary, workerToken: "stale-token", leaseUntil: Date.now() - 60_000 } as never);
    const batchId = Number(b.insertId);
    await db.insert(importBatchFiles).values({ batchId, userId: owner, filename: "KUSD first half.xlsx", sha256: "a".repeat(64), sizeBytes: 1, sheetCount: 20 } as never);
    // a finished batch never shows
    await db.insert(importBatches).values({ userId: owner, status: "complete", summary } as never);

    const r = await caller(owner).bulkImport.unfinished();
    expect(r.batches).toHaveLength(1);
    const x = r.batches[0];
    expect(x).toMatchObject({ batchId, filenames: ["KUSD first half.xlsx"], phase: "enriching", sheetsDone: 20, sheetsTotal: 20, sites: 11, analysesRun: 0, runAnalysis: true, running: false });
    expect(unfinishedImportProgress(x)).toBe("All 20 sheets are in; property facts and analysis for 11 sites still to run.");
    expect(unfinishedImportProgress({ ...x, phase: "importing", sheetsDone: 7 })).toBe("7 of 20 sheets imported so far.");
    expect(unfinishedImportProgress({ ...x, phase: "analyzing", sites: 1 })).toBe("All 20 sheets are in; analysis for 1 site still to run.");

    // while a request holds a live lease it is reported as running
    await db.update(importBatches).set({ workerToken: "live", leaseUntil: Date.now() + 60_000 }).where(eq(importBatches.id, batchId));
    expect((await caller(owner).bulkImport.unfinished()).batches[0].running).toBe(true);
    // read-only: the query changed nothing
    const [row] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(row.status).toBe("committing");
    expect(row.workerToken).toBe("live");
  });

  it("lists paused single-site files but not ones a request is working on", async () => {
    const db = (await getDb())!;
    const base = { userId: owner, siteId, sha256: "b".repeat(64), format: "xlsx", status: "pending" } as const;
    const [p] = await db.insert(uploads).values({ ...base, filename: "Dolan Springs.xlsx", ingestState: sheetState({ cursor: 3 }) } as never);
    await db.insert(uploads).values({ ...base, filename: "Active.xlsx", ingestState: sheetState({ token: "t", leaseUntil: Date.now() + 60_000 }) } as never);
    await db.insert(uploads).values({ ...base, filename: "Done.xlsx", status: "parsed", ingestState: null } as never);
    const r = await caller(owner).bulkImport.unfinished();
    expect(r.files).toEqual([{ uploadId: Number(p.insertId), siteId, filename: "Dolan Springs.xlsx", sheetsDone: 3, sheetsTotal: 20, awaitingChoice: false }]);
  });

  it("never shows another owner's imports", async () => {
    const r = await caller(other).bulkImport.unfinished();
    expect(r).toEqual({ batches: [], files: [] });
  });
});
