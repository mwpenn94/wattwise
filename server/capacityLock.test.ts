/**
 * OPEN-4 (Oct 26) — per-owner capacity lock (dbHelpers.withUserCapacityLock).
 *
 * Every quota-limited write (sites, uploads, scenarios) and the bulk importer
 * serialize on the owner's users row inside a READ COMMITTED transaction, with
 * the count and the insert on that same transaction. These tests prove:
 *  - concurrent free-tier site creations through the real router stop exactly
 *    at the cap (the old GET_LOCK ran on a different pooled connection);
 *  - a waiter counts the row its predecessor just committed (the TiDB
 *    REPEATABLE READ stale-snapshot race found on Oct 26);
 *  - a failed callback rolls back and releases the lock;
 *  - concurrent monthly-quota uploads are serialized the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { sites, uploads, users } from "../drizzle/schema";
import { FREE_TIER_MAX_SITES, FREE_TIER_MAX_UPLOADS_PER_MONTH } from "../shared/wattwise";

const openId = `capacity-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctxFor(id: number): TrpcContext {
  return {
    user: { id, openId, email: `${openId}@test.local`, name: openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
async function siteCount() {
  const db = (await getDb())!;
  const [r] = await db.select({ n: sql<number>`COUNT(*)` }).from(sites).where(eq(sites.userId, userId));
  return Number(r.n);
}
async function clearSites() {
  for (const s of await h.listSites(userId)) await h.deleteSite(s.id, userId);
}

beforeAll(async () => {
  const db = (await getDb())!;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: "free" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u!.id;
});
afterAll(async () => {
  const db = await getDb();
  if (!db || !userId) return;
  await clearSites();
  await db.delete(uploads).where(eq(uploads.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("withUserCapacityLock", () => {
  it(`concurrent free-tier site creations stop exactly at the ${FREE_TIER_MAX_SITES}-site cap`, async () => {
    await clearSites();
    const caller = appRouter.createCaller(ctxFor(userId));
    const attempts = FREE_TIER_MAX_SITES + 4;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        caller.sites.create({ name: `Race ${i}`, siteType: "office", sectorClass: "commercial", climateZone: "2B", state: "AZ", zip: "85004", floorAreaSqft: 1000 }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const denied = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(FREE_TIER_MAX_SITES);
    expect(denied).toHaveLength(attempts - FREE_TIER_MAX_SITES);
    // Every refusal is the plan limit itself, never a lock or database error.
    for (const d of denied) expect(String(d.reason?.message)).toMatch(new RegExp(`Free tier is limited to ${FREE_TIER_MAX_SITES} sites`));
    expect(await siteCount()).toBe(FREE_TIER_MAX_SITES);
    await clearSites();
  }, 60_000);

  it("a waiter counts the row its predecessor committed (READ COMMITTED after the row lock)", async () => {
    await clearSites();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let waiterSaw = -1;
    const holder = h.withUserCapacityLock(userId, async (tx) => {
      await gate;
      await h.createSite({ userId, name: "Holder site" }, tx);
    });
    await sleep(200);
    const waiter = h.withUserCapacityLock(userId, async (tx) => {
      waiterSaw = await h.countSites(userId, tx);
    });
    await sleep(300);
    // The waiter is blocked on the users row; it has not counted yet.
    expect(waiterSaw).toBe(-1);
    release();
    await Promise.all([holder, waiter]);
    expect(waiterSaw).toBe(1);
    await clearSites();
  }, 30_000);

  it("a failed callback rolls back its insert and releases the lock", async () => {
    await clearSites();
    await expect(
      h.withUserCapacityLock(userId, async (tx) => {
        await h.createSite({ userId, name: "Rolled back" }, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await siteCount()).toBe(0);
    const n = await Promise.race([h.withUserCapacityLock(userId, (tx) => h.countSites(userId, tx)), sleep(5_000).then(() => "timeout")]);
    expect(n).toBe(0);
  }, 30_000);

  it("a missing owner is refused without writing", async () => {
    await expect(h.withUserCapacityLock(-424242, async () => "never")).rejects.toThrow(/Account not found/);
  });

  it("concurrent monthly-quota uploads are serialized at the limit", async () => {
    const db = (await getDb())!;
    await db.delete(uploads).where(eq(uploads.userId, userId));
    const attempts = FREE_TIER_MAX_UPLOADS_PER_MONTH + 3;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        h.withUserQuotaLock(userId, async (tx) => {
          if ((await h.countUploadsThisMonth(userId, tx)) >= FREE_TIER_MAX_UPLOADS_PER_MONTH) throw new Error("quota");
          return h.createUpload({ userId, filename: `q${i}.csv`, sha256: `cap-${i}`.padEnd(64, "0"), format: "csv", status: "pending" }, tx);
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(FREE_TIER_MAX_UPLOADS_PER_MONTH);
    expect(results.filter((r) => r.status === "rejected").every((r) => String((r as PromiseRejectedResult).reason?.message) === "quota")).toBe(true);
    expect(await h.countUploadsThisMonth(userId)).toBe(FREE_TIER_MAX_UPLOADS_PER_MONTH);
    await db.delete(uploads).where(eq(uploads.userId, userId));
  }, 60_000);
});
