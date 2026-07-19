/**
 * TERR + BILL + RECON specs (owner, Jul 19)
 *
 * 1. ZIP-level territory attribution — lookupTerritory contract and its
 *    consumption in the commodity-service ladder (tier 3a): a positively
 *    known-unserved ZIP imputes gas absent; a served ZIP makes gas plausible;
 *    an uncovered ZIP falls through (registry silence is never absence).
 * 2. Bill evidence — noteBillEvidence settles an unset commodity as active,
 *    NEVER overrides a user's "none" (surfaces a contradiction insight
 *    instead), and no-ops when already active.
 * 3. Report rebates/units — assembleReportData carries unit savings and
 *    incentive matches; practitionerCsv exposes them as columns.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- mocks ----------------------------------------------------------------
const dbState: {
  sites: Record<number, Record<string, unknown>>;
  insights: Array<Record<string, unknown>>;
  updates: Array<{ siteId: number; patch: Record<string, unknown> }>;
} = { sites: {}, insights: [], updates: [] };

vi.mock("./dbHelpers", () => ({
  getSite: vi.fn(async (siteId: number) => dbState.sites[siteId]),
  updateSite: vi.fn(async (siteId: number, _userId: number, patch: Record<string, unknown>) => {
    dbState.updates.push({ siteId, patch });
    dbState.sites[siteId] = { ...dbState.sites[siteId], ...patch };
  }),
  addInsight: vi.fn(async (row: Record<string, unknown>) => {
    dbState.insights.push(row);
    return { id: dbState.insights.length };
  }),
  listMeters: vi.fn(async () => []),
  listEquipment: vi.fn(async () => []),
  listTariffs: vi.fn(async () => [{ id: 1, utilityName: "Some Utility" }]),
  listOpportunities: vi.fn(async () => []),
  listMeasureImplementations: vi.fn(async () => []),
  listInsights: vi.fn(async () => []),
  getLatestBaseline: vi.fn(async () => null),
}));

const territoryMap: Record<string, { covered: boolean; utilities: string[]; served: boolean | null }> = {};
vi.mock("./serviceTerritories", () => ({
  lookupTerritory: vi.fn(async (zip: string | null | undefined, commodity: string) => {
    const zip3 = (zip ?? "").slice(0, 3);
    const hit = territoryMap[`${zip3}:${commodity}`];
    return hit ? { ...hit, sourceVersion: "test-registry.1" } : { covered: false, utilities: [], served: null, sourceVersion: null };
  }),
}));

import { resolveCommodityService, noteBillEvidence } from "./commodityService";

beforeEach(() => {
  dbState.sites = {};
  dbState.insights = [];
  dbState.updates = [];
  for (const k of Object.keys(territoryMap)) delete territoryMap[k];
});

const site = (over: Record<string, unknown> = {}) => ({
  id: 1,
  state: "AZ",
  zip: "86500",
  utilityName: null,
  servicesProfile: null,
  ...over,
});

// ---- TERR: ZIP-level ladder tier ------------------------------------------
describe("ZIP-level territory attribution (tier 3a)", () => {
  it("imputes gas absent when the registry positively knows the ZIP3 is unserved", async () => {
    territoryMap["865:gas"] = { covered: true, utilities: [], served: false };
    const r = await resolveCommodityService(site({ zip: "86503" }) as never, 7, "gas");
    expect(r.analyze).toBe(false);
    expect(r.basis).toBe("territory_imputed");
    expect(r.reason).toContain("865");
    expect(r.reason).toContain("registry");
  });

  it("makes gas plausible-active when a gas utility serves the ZIP3, naming the utility", async () => {
    territoryMap["850:gas"] = { covered: true, utilities: ["Southwest Gas"], served: true };
    const r = await resolveCommodityService(site({ zip: "85004" }) as never, 7, "gas");
    expect(r.analyze).toBe(true);
    expect(r.basis).toBe("territory_imputed");
    expect(r.reason).toContain("Southwest Gas");
  });

  it("falls through on uncovered ZIPs — registry silence is never absence (gas stays not-assumed via default)", async () => {
    // No territoryMap entries: covered=false everywhere. State snapshot has a
    // utility (listTariffs mock returns one row), so gas falls to the gas
    // default: no evidence → not analyzed, basis "default".
    const r = await resolveCommodityService(site({ zip: "99999" }) as never, 7, "gas");
    expect(r.analyze).toBe(false);
    expect(r.basis).toBe("default");
  });

  it("user override always beats territory imputation", async () => {
    territoryMap["865:gas"] = { covered: true, utilities: [], served: false };
    const r = await resolveCommodityService(site({ zip: "86503", servicesProfile: { gas: "active" } }) as never, 7, "gas");
    expect(r.analyze).toBe(true);
    expect(r.basis).toBe("user_override");
  });

  it("electric in a served territory falls through to the near-universal default", async () => {
    territoryMap["850:electric"] = { covered: true, utilities: ["APS"], served: true };
    const r = await resolveCommodityService(site({ zip: "85004" }) as never, 7, "electric");
    expect(r.analyze).toBe(true);
    expect(r.basis).toBe("default");
  });
});

// ---- BILL: bill evidence ----------------------------------------------------
describe("bill-upload service evidence", () => {
  it("settles an unset commodity as active when a bill arrives", async () => {
    dbState.sites[1] = { id: 1, servicesProfile: null };
    await noteBillEvidence(1, 7, "gas");
    expect(dbState.updates).toHaveLength(1);
    expect((dbState.updates[0].patch as { servicesProfile: Record<string, string> }).servicesProfile.gas).toBe("active");
  });

  it("never overrides a user's 'none' — surfaces a contradiction insight instead", async () => {
    dbState.sites[1] = { id: 1, servicesProfile: { gas: "none" } };
    await noteBillEvidence(1, 7, "gas");
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.insights).toHaveLength(1);
    expect(String(dbState.insights[0].title)).toContain("gas bill is on file");
    expect(dbState.insights[0].severity).toBe("warning");
  });

  it("no-ops when the commodity is already active", async () => {
    dbState.sites[1] = { id: 1, servicesProfile: { water: "active" } };
    await noteBillEvidence(1, 7, "water");
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.insights).toHaveLength(0);
  });

  it("preserves other commodities' settings when stamping one", async () => {
    dbState.sites[1] = { id: 1, servicesProfile: { gas: "none" } };
    await noteBillEvidence(1, 7, "water");
    const patch = dbState.updates[0].patch as { servicesProfile: Record<string, string> };
    expect(patch.servicesProfile.water).toBe("active");
    expect(patch.servicesProfile.gas).toBe("none");
  });
});

// ---- RECON: reports carry units + rebates -----------------------------------
describe("report unit savings + rebates", () => {
  it("practitionerCsv exposes unit_savings, demand_kw and rebates columns", async () => {
    const { practitionerCsv } = await import("./reports");
    const csv = practitionerCsv({
      site: { id: 1, name: "Test", state: "AZ", buildingType: "office", sqft: 1000 },
      generatedAt: Date.now(),
      annualCostUsd: 1000,
      annualCostChip: "Est.",
      measures: [
        {
          title: "Gas heating tune-up",
          measure: "gas_heating_tuneup",
          what: "x",
          annualSavingsUsd: 500,
          paybackLabel: "1-2 yr",
          costClass: null,
          confidence: "medium",
          chip: "Est.",
          unitSavings: { value: 320, unit: "therms" },
          demandSavingsKw: null,
          rebates: [{ name: "SWG Efficiency Rebate", valueUsd: 250, source: "Southwest Gas" }],
        },
      ],
      plannedTotalUsd: 500,
      verdicts: [],
      verifiedTotalUsd: 0,
      baseline: null,
      disclaimer: "test",
    });
    const header = csv.split("\n")[0];
    expect(header).toContain("unit_savings");
    expect(header).toContain("demand_kw");
    expect(header).toContain("rebates");
    expect(csv).toContain("320 therms/yr");
    expect(csv).toContain("SWG Efficiency Rebate");
  });
});
