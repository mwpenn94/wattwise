/**
 * NSD-1 — next-step directive specs (Jul 22): per-site rate-change impact
 * (IMP), territory-driven docket auto-registration (DKT), and the gas-depth
 * acquisition floor (GWD). Same style as rateCurrency.test.ts: DB-touching
 * flows run against the live dev DB with prefixed synthetic rows cleaned up.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "./db";
import { bills, meters, rateAcquisitionQueue, rateSources, rateVerifications, sites, tariffs } from "../drizzle/schema";
import { attachImpactToVerifications, computeRateChangeImpact } from "./rateImpact";
import { STATE_COMMISSION_DOCKETS, ensureDocketCoverage } from "./stateDockets";
import { MAJOR_GAS_LDCS, seedGasDepthQueue } from "./gasWaterDepth";

const P = "impx-test-";

async function cleanup() {
  const db = await getDb();
  if (!db) return;
  const siteRows = await db.select({ id: sites.id }).from(sites).where(like(sites.name, `${P}%`));
  for (const s of siteRows) {
    const ms = await db.select({ id: meters.id }).from(meters).where(eq(meters.siteId, s.id));
    for (const m of ms) await db.delete(bills).where(eq(bills.meterId, m.id));
    await db.delete(meters).where(eq(meters.siteId, s.id));
  }
  await db.delete(sites).where(like(sites.name, `${P}%`));
  await db.delete(tariffs).where(like(tariffs.urdbId, `${P}%`));
  await db.delete(rateVerifications).where(like(rateVerifications.sourceKey, `${P}%`));
}
afterAll(cleanup);

describe("computeRateChangeImpact (IMP-1)", () => {
  it("attributes impact to a site on the changed utility using billed usage, and skips out-of-state sites", async () => {
    const db = await getDb();
    if (!db) return;
    // synthetic tariff in an unlikely state pairing to isolate the spec
    await db.insert(tariffs).values({
      urdbId: `${P}elec`,
      utilityName: `${P}Test Power Co`,
      name: "Residential TEST",
      sector: "residential",
      commodity: "electric",
      state: "WY",
      structure: { fixedMonthly: 10, energyRates: [{ rate: 0.1, label: "all" }] },
      source: "urdb_bulk",
      freshness: "manual",
    } as never);
    // in-state site + meter with a year of billed usage
    const [siteRes] = await db.insert(sites).values({ userId: 1, name: `${P}site-in`, state: "WY", utilityName: `${P}Test Power Co` } as never);
    const siteId = (siteRes as unknown as { insertId: number }).insertId;
    const [meterRes] = await db.insert(meters).values({ siteId, userId: 1, commodity: "electric", label: `${P}m1`, usageUnit: "kWh" } as never);
    const meterId = (meterRes as unknown as { insertId: number }).insertId;
    const yearAgo = new Date(Date.now() - 360 * 86_400_000);
    const now = new Date();
    await db.insert(bills).values({ meterId, periodStart: yearAgo, periodEnd: now, usage: 12000, totalCost: 1500, source: "manual" } as never);
    // out-of-state site on same utility name — must NOT be counted
    const [outRes] = await db.insert(sites).values({ userId: 1, name: `${P}site-out`, state: "VT", utilityName: `${P}Test Power Co` } as never);
    const outSiteId = (outRes as unknown as { insertId: number }).insertId;
    await db.insert(meters).values({ siteId: outSiteId, userId: 1, commodity: "electric", label: `${P}m2`, usageUnit: "kWh" } as never);

    const impact = await computeRateChangeImpact([{ urdbId: `${P}elec`, volumetricDeltas: [0.01], fixedMonthlyDelta: 2 }]);
    expect(impact).not.toBeNull();
    const mine = impact!.perSite.filter((s) => s.siteId === siteId);
    expect(mine.length).toBe(1);
    expect(mine[0].usageBasis).toBe("billed");
    // ~12000 kWh/yr (annualized from 360d) × $0.01 + 12 × $2 ≈ $145.67
    expect(mine[0].estUsdYrDelta).toBeGreaterThan(120);
    expect(mine[0].estUsdYrDelta).toBeLessThan(175);
    expect(impact!.perSite.some((s) => s.siteId === outSiteId)).toBe(false);
    expect(impact!.disclosure).toContain("usage constant");
  });

  it("lists sites without usage data honestly (no fabricated dollars) unless a fixed delta exists", async () => {
    const db = await getDb();
    if (!db) return;
    await db.insert(tariffs).values({
      urdbId: `${P}gas`,
      utilityName: `${P}Test Gas Co`,
      name: "Gas TEST",
      sector: "residential",
      commodity: "gas",
      state: "WY",
      structure: { fixedMonthly: 15, energyRates: [{ rate: 0.8, label: "all" }] },
      source: "urdb_bulk",
      freshness: "manual",
    } as never);
    const [sr] = await db.insert(sites).values({ userId: 1, name: `${P}site-nousage`, state: "WY", utilityName: `${P}Test Gas Co` } as never);
    const sid = (sr as unknown as { insertId: number }).insertId;
    await db.insert(meters).values({ siteId: sid, userId: 1, commodity: "gas", label: `${P}m3`, usageUnit: "therms" } as never);

    const volOnly = await computeRateChangeImpact([{ urdbId: `${P}gas`, volumetricDeltas: [0.05], fixedMonthlyDelta: 0 }]);
    const row = volOnly!.perSite.find((s) => s.siteId === sid);
    expect(row).toBeDefined();
    expect(row!.usageBasis).toBe("none");
    expect(row!.estUsdYrDelta).toBeNull(); // never invent usage

    const fixedToo = await computeRateChangeImpact([{ urdbId: `${P}gas`, volumetricDeltas: [0.05], fixedMonthlyDelta: 3 }]);
    const row2 = fixedToo!.perSite.find((s) => s.siteId === sid);
    expect(row2!.estUsdYrDelta).toBe(36); // 12 × $3 needs no usage assumption
  });

  it("returns null for unknown tariff ids and attaches impact to recent verification rows", async () => {
    const db = await getDb();
    if (!db) return;
    expect(await computeRateChangeImpact([{ urdbId: `${P}missing`, volumetricDeltas: [0.01], fixedMonthlyDelta: 0 }])).toBeNull();
    const t0 = Date.now() - 1000;
    await db.insert(rateVerifications).values({ sourceKey: `${P}src`, status: "changed", method: "agent", checkedAt: Date.now(), applied: true } as never);
    const n = await attachImpactToVerifications(`${P}src`, t0, {
      affectedSites: 1,
      totalUsdYrDelta: 42,
      perSite: [],
      disclosure: "test",
    });
    expect(n).toBe(1);
    const rows = await db.select().from(rateVerifications).where(eq(rateVerifications.sourceKey, `${P}src`));
    expect((rows[0].impact as { totalUsdYrDelta: number }).totalUsdYrDelta).toBe(42);
  });
});

describe("state docket auto-registration (DKT-1/2)", () => {
  it("covers all 50 states + DC with official commission URLs", () => {
    expect(Object.keys(STATE_COMMISSION_DOCKETS).length).toBe(51);
    for (const [st, e] of Object.entries(STATE_COMMISSION_DOCKETS)) {
      expect(st).toMatch(/^[A-Z]{2}$/);
      expect(e.url).toMatch(/^https?:\/\//);
      expect(e.commission.length).toBeGreaterThan(5);
    }
  });

  it("registers docket watches for states with sites, idempotently, and never governs tariff rows", async () => {
    const db = await getDb();
    if (!db) return;
    // the test sites created above live in WY and VT
    const first = await ensureDocketCoverage();
    const again = await ensureDocketCoverage();
    expect(again.registered.length).toBe(0); // idempotent on second pass
    expect(first.registered.length + first.alreadyCovered).toBeGreaterThanOrEqual(2);
    const wy = await db.select().from(rateSources).where(eq(rateSources.sourceKey, "docket-state-wy"));
    expect(wy.length).toBe(1);
    expect(wy[0].sourceKind).toBe("docket");
    expect((wy[0].governsUrdbIds as string[]).length).toBe(0);
    expect(wy[0].sourceUrl).toBe(STATE_COMMISSION_DOCKETS.WY.url);
  });
});

describe("gas-depth acquisition floor (GWD-2)", () => {
  it("enqueues the major-LDC floor idempotently (no duplicate queue rows)", async () => {
    const db = await getDb();
    if (!db) return;
    const r1 = await seedGasDepthQueue();
    expect(r1.enqueued).toBe(MAJOR_GAS_LDCS.length);
    await seedGasDepthQueue(); // second pass must not duplicate
    const socal = await db
      .select()
      .from(rateAcquisitionQueue)
      .where(and(eq(rateAcquisitionQueue.utilityName, "SoCalGas (Southern California Gas)"), eq(rateAcquisitionQueue.state, "CA"), eq(rateAcquisitionQueue.commodity, "gas")));
    expect(socal.length).toBe(1);
  });
});
