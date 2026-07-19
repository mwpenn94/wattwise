/**
 * Cross-commodity opportunity generation specs (OPP-5) — verifies the parity
 * fix: gas/water auto-ranked opportunities with measured-vs-imputed basis
 * discipline, honest disclosures, and unit savings for rebate math.
 *
 * Pure-function tests with mocked dbHelpers — no live DB rows created.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listMeters: vi.fn(),
  getIntervalPoints: vi.fn(),
  getBenchmark: vi.fn(),
  getTariff: vi.fn(),
  listTariffs: vi.fn(),
  getSiteGeometry: vi.fn(),
}));
vi.mock("./dbHelpers", () => mocks);

import { generateCommodityOpportunities } from "./commodityOpportunities";

const normals = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  hddBase65: [900, 700, 500, 200, 50, 0, 0, 0, 20, 200, 500, 800][i],
  cddBase65: [0, 0, 20, 100, 300, 500, 600, 550, 350, 100, 10, 0][i],
  avgTempF: [45, 48, 55, 65, 75, 85, 90, 88, 80, 66, 54, 46][i],
}));

const site = { id: 1, sqft: 20000, buildingType: "office", state: "AZ" };

const narrate = () => {};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  // default: sqft-only site (no meters), gas + water benchmarks seeded
  mocks.listMeters.mockResolvedValue([]);
  mocks.getIntervalPoints.mockResolvedValue([]);
  mocks.getSiteGeometry.mockResolvedValue(undefined);
  mocks.getTariff.mockResolvedValue(undefined);
  mocks.getBenchmark.mockImplementation(async (_bt: string, com: string) => {
    if (com === "gas") return { medianEui: 0.35, unit: "therms/sqft/yr", source: "CBECS 2018" };
    if (com === "water") return { medianEui: 15, unit: "gal/sqft/yr", source: "EPA WaterSense" };
    return undefined;
  });
  mocks.listTariffs.mockImplementation(async (com: string) => {
    if (com === "gas")
      return [{ id: 11, commodity: "gas", name: "SW Gas G-5", structure: { energy: [{ ratePerUnit: 1.05 }] } }];
    if (com === "water")
      return [{ id: 12, commodity: "water", name: "City W-1", structure: { energy: [{ ratePerUnit: 0.00519 }] } }];
    return [];
  });
});

describe("generateCommodityOpportunities (cross-commodity parity)", () => {
  it("produces gas and water opportunities for a sqft-only site via benchmark-imputed baselines", async () => {
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    const keys = cands.map((c) => c.key);
    expect(keys).toContain("gas_heating_tuneup");
    expect(keys).toContain("gas_weatherization");
    expect(keys).toContain("gas_water_heating");
    expect(keys).toContain("water_fixture_efficiency");
    // every candidate carries a commodity tag and implementer unit savings
    for (const c of cands) {
      expect(["gas", "water"]).toContain(c.commodity);
      expect(c.estUnitsSavedPerYr).toBeGreaterThan(0);
      expect(c.unit.length).toBeGreaterThan(0);
      expect(c.annualSavingsUsdHi).toBeGreaterThan(0);
      expect(c.annualSavingsUsdHi).toBeGreaterThanOrEqual(c.annualSavingsUsdLo);
    }
  });

  it("discloses the benchmark-imputed basis on every candidate (honesty rule)", async () => {
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const all = (c.rationale + " " + c.disclosures.join(" ")).toLowerCase();
      expect(all).toMatch(/benchmark-imputed|screening-grade/);
    }
  });

  it("returns no candidates when no benchmark exists and no meters are present", async () => {
    mocks.getBenchmark.mockResolvedValue(undefined);
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    expect(cands).toHaveLength(0);
  });

  it("uses measured meter data (annualized) when ≥60 days of gas intervals exist", async () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2025, 0, 1);
    mocks.listMeters.mockResolvedValue([{ id: 7, commodity: "gas", meterRole: "primary", currentTariffId: null }]);
    mocks.getIntervalPoints.mockImplementation(async (meterId: number) =>
      meterId === 7 ? Array.from({ length: 90 }, (_, i) => ({ ts: t0 + i * day, usage: 10 })) : [],
    );
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    const gas = cands.filter((c) => c.commodity === "gas");
    expect(gas.length).toBeGreaterThan(0);
    const tuneup = gas.find((c) => c.key === "gas_heating_tuneup");
    expect(tuneup).toBeDefined();
    // measured basis is stated in the rationale and upgrades confidence
    expect(tuneup!.rationale.toLowerCase()).toContain("measured");
    expect(tuneup!.confidence).toBe("medium");
    // 90 days × 10 therms/day → ~3,650 therms/yr annualized baseline
    expect(tuneup!.rationale).toMatch(/3,6\d\d|3,7\d\d/);
  });

  it("never fabricates leak-screening savings from an imputed water baseline", async () => {
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    const keys = cands.filter((c) => c.commodity === "water").map((c) => c.key);
    expect(keys).toContain("water_fixture_efficiency");
    // leak screening requires measured continuous-flow evidence
    expect(keys).not.toContain("water_leak_screening");
  });

  it("prices gas savings on the commodity's own tariff, never electric rates (AC3)", async () => {
    const cands = await generateCommodityOpportunities(site, 1, normals, narrate);
    const gas = cands.find((c) => c.key === "gas_heating_tuneup");
    expect(gas).toBeDefined();
    // midpoint USD / midpoint therms should recover ≈ the $1.05/therm seeded rate
    const midUsd = (gas!.annualSavingsUsdLo + gas!.annualSavingsUsdHi) / 2;
    const usdPerUnit = midUsd / gas!.estUnitsSavedPerYr;
    expect(usdPerUnit).toBeGreaterThan(0.8);
    expect(usdPerUnit).toBeLessThan(1.3);
  });
});
