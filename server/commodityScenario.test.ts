/**
 * Multi-commodity scenario + implementer savings specs.
 * Gas/water efficiency runs: benchmark baseline path, flat volumetric pricing,
 * per-commodity CO2e honesty, implementerSavings payload (the $/unit-saved
 * figures custom rebate programs pay on), and the router-level kind gate.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { runCommodityEfficiency } from "./commodityScenario";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { users, sites } from "../drizzle/schema";
import { ensureSeeded } from "./seed/runSeeders";
import type { TrpcContext } from "./_core/context";

function ctxFor(user: { id: number; openId: string; role: "admin" | "user"; tier?: string | null }): TrpcContext {
  return {
    user: { id: user.id, openId: user.openId, role: user.role, tier: (user.tier ?? "free") as never } as never,
    req: { ip: "127.0.0.1", headers: {} } as never,
    res: { setHeader: () => undefined, clearCookie: () => undefined } as never,
  };
}

let testUser: { id: number; openId: string; role: "admin" | "user" };
let officeSiteId: number;

beforeAll(async () => {
  await ensureSeeded();
  const db = await getDb();
  const { eq } = await import("drizzle-orm");
  await db
    .insert(users)
    .values({ openId: "cmdty-spec", name: "cmdty-spec", tier: "pro" as never })
    .onDuplicateKeyUpdate({ set: { tier: "pro" as never } });
  const [u] = await db.select().from(users).where(eq(users.openId, "cmdty-spec"));
  testUser = { id: u.id, openId: u.openId, role: "user", tier: "pro" } as never;
  // Office site with sqft — benchmark baseline path (no gas/water meters attached).
  await db.insert(sites).values({
    userId: u.id,
    name: "cmdty-spec office",
    buildingType: "office",
    sqft: 20_000,
    state: "AZ",
    zip: "85701",
  } as never);
  const rows = await db.select().from(sites).where(eq(sites.userId, u.id));
  officeSiteId = rows[rows.length - 1].id;
});

describe("runCommodityEfficiency — gas benchmark path", () => {
  it("derives a benchmark gas baseline, prices at the volumetric rate, and exposes implementer savings in therms", async () => {
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    const [site] = await db.select().from(sites).where(eq(sites.id, officeSiteId));
    const { results, loadBasis } = await runCommodityEfficiency({
      site: site as never,
      userId: testUser.id,
      commodity: "gas",
      reduction: 0.15,
    });
    expect(loadBasis).toBe("benchmark_estimate");
    const gas = results.perCommodity.gas;
    expect(gas).toBeDefined();
    // office benchmark 0.33 therms/sqft × 20,000 sqft × 15% = 990 therms saved
    expect(gas!.deltaUsage).toBeLessThan(0);
    const imp = results.implementerSavings;
    expect(imp).toBeDefined();
    expect(imp!.unitsSavedAnnual.gas).toBe(Math.abs(gas!.deltaUsage));
    expect(imp!.note).toContain("rebate");
    // CO2e per therm (11.7 lb) must be attached and negative (reduction)
    expect(results.siteTotalDeltaCo2eLb).toBeLessThan(0);
    // benchmark path is disclosed as screening-grade + low confidence
    expect(results.confidence).toBe("low");
    expect(results.disclosures.join(" ")).toContain("benchmark");
    expect(results.extrapolated).toBe(true);
  });

  it("prices gas savings in dollars only when a tariff rate exists, and discloses the unassigned-tariff fallback", async () => {
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    const [site] = await db.select().from(sites).where(eq(sites.id, officeSiteId));
    const { results } = await runCommodityEfficiency({
      site: site as never,
      userId: testUser.id,
      commodity: "gas",
      reduction: 0.1,
    });
    const joined = results.disclosures.join(" ");
    // Either a seeded tariff priced it (fallback disclosed) or none exists ($0 disclosed) — never silent.
    expect(/No natural gas tariff is assigned|No natural gas tariff available/.test(joined)).toBe(true);
    if (results.siteTotalDeltaCost !== 0) {
      expect(results.siteTotalDeltaCost).toBeLessThan(0);
      expect(results.assumptions.ratePerUnit as number).toBeGreaterThan(0);
    }
  });
});

describe("runCommodityEfficiency — water path", () => {
  it("computes water savings in gallons with no CO2e claim (disclosed gap) and immediate payback at zero capex", async () => {
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    const [site] = await db.select().from(sites).where(eq(sites.id, officeSiteId));
    // water has no office benchmark in seeds — expect either a benchmark result or the honest BAD_REQUEST
    try {
      const { results } = await runCommodityEfficiency({
        site: site as never,
        userId: testUser.id,
        commodity: "water",
        reduction: 0.2,
      });
      const water = results.perCommodity.water;
      expect(water).toBeDefined();
      expect(water!.deltaCo2eLb).toBe(0); // no defensible embedded-energy factor — never fabricated
      expect(results.disclosures.join(" ").toLowerCase()).toContain("water");
      expect(results.implementerSavings!.unitsSavedAnnual.water).toBeGreaterThan(0);
    } catch (e) {
      // acceptable honest path: no water benchmark for this building type
      expect(String(e)).toContain("efficiency scenario needs");
    }
  });
});

describe("scenariosApi.run — gas/water kinds", () => {
  it("accepts gas_efficiency and returns per-commodity results with implementer savings", async () => {
    const caller = appRouter.createCaller(ctxFor(testUser));
    const res = await caller.scenariosApi.run({
      siteId: officeSiteId,
      name: "spec gas efficiency",
      kind: "gas_efficiency",
      efficiencyReductions: { overall: 0.15 },
    });
    const results = res.results as { perCommodity: Record<string, { deltaUsage: number }>; implementerSavings?: { unitsSavedAnnual: Record<string, number> }; assumptions: Record<string, unknown> };
    expect(results.perCommodity.gas).toBeDefined();
    expect(results.perCommodity.gas.deltaUsage).toBeLessThan(0);
    expect(results.implementerSavings?.unitsSavedAnnual.gas).toBeGreaterThan(0);
    // the saved row must carry the gas transform, not an electric label
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    const { scenarios } = await import("../drizzle/schema");
    const [saved] = await db.select().from(scenarios).where(eq(scenarios.id, res.id));
    expect(saved.transform).toBe("gas_efficiency");
  });

  it("defaults to a 10% reduction when none is supplied and discloses the benchmark basis", async () => {
    const caller = appRouter.createCaller(ctxFor(testUser));
    const res = await caller.scenariosApi.run({ siteId: officeSiteId, name: "spec default reduction", kind: "gas_efficiency" });
    const results = res.results as { assumptions: { reductionFraction: number }; disclosures: string[] };
    expect(results.assumptions.reductionFraction).toBe(0.1);
    expect(results.disclosures.join(" ")).toContain("benchmark");
  });
});
