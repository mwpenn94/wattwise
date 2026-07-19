/**
 * GAP-D / AC16a — bill-reconciliation self-calibration suite.
 *
 * Contract pinned here:
 *  1. A bill whose actual cost matches the tariff prediction (within the
 *     8%/$10 tolerance) records a `match` reconciliation; enough hits upgrade
 *     the tariff to `verified_against_bill`.
 *  2. Wildly divergent actual-read bills record `mismatch` rows; when misses
 *     outnumber hits past the threshold the tariff flips to
 *     `mismatch_flagged` — trust widens rather than silently staying seeded.
 *  3. Estimated-read bills are EXCLUDED from calibration entirely.
 *  4. Fail-open: a meter with no tariff produces no reconciliation and no
 *     error.
 *  5. tariffTrustDisclosure maps each status to honest user-facing copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { reconcileBill, tariffTrustDisclosure } from "./billReconciliation";
import { getDb } from "./db";
import { billReconciliations, tariffs, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import * as h from "./dbHelpers";

const OPEN_ID = `recon-suite-${Date.now()}`;

async function getDbOrFail() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable in test environment");
  return db;
}

async function makeCaller() {
  const db = await getDbOrFail();
  await db.insert(users).values({ openId: OPEN_ID, name: "Recon Suite", tier: "pro", role: "user" });
  const [user] = await db.select().from(users).where(eq(users.openId, OPEN_ID)).limit(1);
  const ctx = { user, req: {} as never, res: {} as never } as unknown as Parameters<typeof appRouter.createCaller>[0];
  return { caller: appRouter.createCaller(ctx), user };
}

describe("GAP-D bill reconciliation (AC16a)", () => {
  let caller: Awaited<ReturnType<typeof makeCaller>>["caller"];
  let userId: number;
  let siteId: number;
  let meterId: number;
  let tariffId: number;

  beforeAll(async () => {
    const made = await makeCaller();
    caller = made.caller;
    userId = made.user.id;

    const site = (await caller.sites.create({
      name: "Recon Test Site",
      siteType: "building",
      buildingType: "office",
      sqft: 10_000,
      state: "AZ",
      zip: "85001",
    })) as { id?: number } | number;
    siteId = typeof site === "number" ? site : (site.id as number);

    const meter = (await caller.sites.createMeter({ siteId, label: "Recon Main", commodity: "electric" })) as { id: number };
    meterId = meter.id;

    // Deterministic flat tariff: $0.10/kWh + $10/mo fixed — predictable cost.
    const db = await getDbOrFail();
    const [ins] = await db.insert(tariffs).values({
      name: "Recon Flat 10",
      utilityName: "Recon Test Utility",
      // CLEAN-3 (owner report Jul 19): fixture tariffs are tagged so the
      // listTariffs query-layer guard hides them from every user-facing
      // surface even if cleanup fails; afterAll below removes the row too.
      source: "test_fixture",
      sector: "commercial",
      commodity: "electric",
      state: "AZ",
      structure: {
        fixedMonthly: 10,
        energy: [
          {
            label: "all-hours",
            ratePerUnit: 0.1,
            months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            hourStart: 0,
            hourEnd: 24,
          },
        ],
        demand: [],
      },
    } as typeof tariffs.$inferInsert);
    tariffId = ins.insertId;
    await caller.sites.setMeterTariff({ meterId, tariffId });
  });

  // CLEAN-2 (owner report Jul 19): this suite previously left its fixture
  // tariff + user data in the shared database, which leaked "Recon Flat 10"
  // rows into the live rate check. Tests MUST clean up after themselves.
  afterAll(async () => {
    const db = await getDbOrFail();
    await h.deleteAllUserData(userId).catch(() => {});
    await db.delete(tariffs).where(eq(tariffs.id, tariffId)).catch(() => {});
    await db.delete(users).where(eq(users.id, userId));
  });

  async function addBill(opts: { start: string; end: string; usage: number; cost: number; readType?: "actual" | "estimated" }) {
    return (await caller.bills.create({
      meterId,
      periodStart: opts.start,
      periodEnd: opts.end,
      totalUsage: opts.usage,
      usageUnit: "kWh",
      totalCostUsd: opts.cost,
      readType: opts.readType ?? "actual",
    })) as { id?: number } & Record<string, unknown>;
  }

  it("records a match when the bill agrees with the tariff prediction", async () => {
    // 1000 kWh over June 2026 → predicted ≈ $10 fixed + $100 energy = $110.
    await addBill({ start: "2026-06-01", end: "2026-07-01", usage: 1000, cost: 110 });
    const db = await getDbOrFail();
    const rows = await db.select().from(billReconciliations).where(eq(billReconciliations.userId, userId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].verdict).toBe("match");
  });

  it("upgrades tariff trust to verified_against_bill after repeated hits", async () => {
    await addBill({ start: "2026-07-01", end: "2026-08-01", usage: 1200, cost: 130 }); // predicted ≈ $130
    const db = await getDbOrFail();
    const [t] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId)).limit(1);
    expect(t.trustStatus).toBe("verified_against_bill");
    expect(t.reconcileHits ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("skips estimated-read bills — they never move trust", async () => {
    const db = await getDbOrFail();
    const before = (await db.select().from(billReconciliations).where(eq(billReconciliations.userId, userId))).length;
    await addBill({ start: "2026-08-01", end: "2026-09-01", usage: 900, cost: 500, readType: "estimated" });
    const after = (await db.select().from(billReconciliations).where(eq(billReconciliations.userId, userId))).length;
    expect(after).toBe(before);
    const [t] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId)).limit(1);
    expect(t.trustStatus).toBe("verified_against_bill"); // unchanged
  });

  it("flags the tariff once mismatches outnumber hits", async () => {
    // Hits are 2; misses must exceed hits AND reach the threshold → 3 misses.
    await addBill({ start: "2026-09-01", end: "2026-10-01", usage: 1000, cost: 400 });
    await addBill({ start: "2026-10-01", end: "2026-11-01", usage: 1000, cost: 400 });
    await addBill({ start: "2026-11-01", end: "2026-12-01", usage: 1000, cost: 400 });
    const db = await getDbOrFail();
    const [t] = await db.select().from(tariffs).where(eq(tariffs.id, tariffId)).limit(1);
    expect(t.trustStatus).toBe("mismatch_flagged");
    expect(t.reconcileMisses ?? 0).toBeGreaterThan(t.reconcileHits ?? 0);
  });

  it("fail-open: a meter with no tariff produces no reconciliation, no error", async () => {
    const meter2 = (await caller.sites.createMeter({ siteId, label: "No Tariff", commodity: "electric" })) as { id: number };
    const out = await reconcileBill(999_999_999, meter2.id, userId);
    expect(out.reconciled).toBe(false);
  });

  it("tariffTrustDisclosure maps statuses to honest copy", () => {
    expect(tariffTrustDisclosure("seeded").label).toMatch(/seeded/i);
    expect(tariffTrustDisclosure("seeded").disclosure).toMatch(/hasn't been verified/i);
    expect(tariffTrustDisclosure("verified_against_bill").label).toMatch(/verified/i);
    expect(tariffTrustDisclosure("verified_against_bill").disclosure).toBeNull();
    const flagged = tariffTrustDisclosure("mismatch_flagged");
    expect(flagged.label).toMatch(/review/i);
    expect(flagged.disclosure).toMatch(/wider uncertainty/i);
  });

  it("reconciliation math stays within the documented tolerance semantics", async () => {
    const db = await getDbOrFail();
    const rows = await db.select().from(billReconciliations).where(eq(billReconciliations.userId, userId));
    for (const r of rows) {
      const deltaUsd = Math.abs(r.predictedUsd - r.actualUsd);
      const withinTol = r.deltaPct <= 0.08 || deltaUsd <= 10;
      expect(r.verdict).toBe(withinTol ? "match" : "mismatch");
    }
  });
});
