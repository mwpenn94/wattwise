/**
 * Cross-commodity opportunity generation specs (OPP-5) — verifies the parity
 * fix: gas/water auto-ranked opportunities with measured-vs-imputed basis
 * discipline, honest disclosures, and unit savings for rebate math.
 *
 * Pure-function tests with mocked dbHelpers — no live DB rows created.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MonthNormalRow } from "./analytics/baseline";

const mocks = vi.hoisted(() => ({
  listMeters: vi.fn(),
  listEquipment: vi.fn(),
  getIntervalPoints: vi.fn(),
  getBenchmark: vi.fn(),
  getTariff: vi.fn(),
  listTariffs: vi.fn(),
  getSiteGeometry: vi.fn(),
}));

vi.mock("./dbHelpers", () => mocks);

import { generateCommodityOpportunities } from "./commodityOpportunities";

const site = { id: 1, buildingType: "office", sqft: 10_000, state: "AZ" };
const noop = () => {};

/** 12 months of normals with meaningful HDD (heating climate). */
const heatingNormals: MonthNormalRow[] = Array.from({ length: 12 }, (_, i) => ({
  month: i + 1,
  hddBase65: i < 3 || i > 9 ? 600 : 50,
  cddBase65: 100,
  avgTempF: 55,
})) as unknown as MonthNormalRow[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMeters.mockResolvedValue([]);
  // Gas is never assumed (SVC ladder) — specs that exercise gas paths provide
  // evidence via user-confirmed gas equipment; water stays plausible-active.
  mocks.listEquipment.mockResolvedValue([{ source: "user_confirmed", label: "Gas boiler / furnace", notes: null }]);
  mocks.getIntervalPoints.mockResolvedValue([]);
  mocks.getBenchmark.mockResolvedValue(undefined);
  mocks.getTariff.mockResolvedValue(undefined);
  // Populated service territory by default (SVC ladder tier 3) — a row without
  // a usable energy rate keeps pricing on the national-average fallback.
  mocks.listTariffs.mockResolvedValue([{ utilityName: "Territory Utility", name: "T-1", commodity: "any", structure: { energy: [] } }]);
  mocks.getSiteGeometry.mockResolvedValue(undefined);
});

describe("generateCommodityOpportunities — basis discipline", () => {
  it("returns nothing when a commodity has neither meter data nor a benchmark (never fabricates)", async () => {
    const out = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    expect(out).toEqual([]);
  });

  it("imputes a gas basis from benchmark × sqft and labels it benchmark-imputed", async () => {
    mocks.getBenchmark.mockImplementation(async (_bt: string, com: string) =>
      com === "gas" ? { medianEui: 0.3, unit: "therms/sqft-yr", source: "CBECS 2018" } : undefined,
    );
    const out = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    const gas = out.filter((c) => c.commodity === "gas");
    expect(gas.length).toBeGreaterThanOrEqual(1);
    for (const c of gas) {
      expect(c.disclosures.join(" ")).toMatch(/benchmark-imputed/);
      expect(c.confidence).toBe("low"); // imputed never claims medium+
      expect(c.unit).toBe("therms");
      expect(c.estUnitsSavedPerYr).toBeGreaterThan(0);
    }
  });

  it("uses a measured basis when ≥60 days of gas meter data exists and raises confidence", async () => {
    mocks.listMeters.mockResolvedValue([{ id: 9, commodity: "gas", meterRole: "main", currentTariffId: null }]);
    const day = 86_400_000;
    const t0 = Date.UTC(2025, 0, 1);
    mocks.getIntervalPoints.mockResolvedValue(
      Array.from({ length: 90 }, (_, i) => ({ ts: t0 + i * day, usage: 3 })), // 3 therms/day
    );
    const out = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    const tuneup = out.find((c) => c.key === "gas_heating_tuneup");
    expect(tuneup).toBeDefined();
    expect(tuneup!.disclosures.join(" ")).toMatch(/measured — annualized from \d+ days/);
    expect(tuneup!.confidence).toBe("medium");
  });

  it("only claims water leak screening with MEASURED data, never imputed", async () => {
    mocks.getBenchmark.mockImplementation(async (_bt: string, com: string) =>
      com === "water" ? { medianEui: 12, unit: "gal/sqft-yr", source: "WaterSense" } : undefined,
    );
    const imputedRun = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    expect(imputedRun.find((c) => c.key === "water_leak_screening")).toBeUndefined();
    expect(imputedRun.find((c) => c.key === "water_fixture_efficiency")).toBeDefined();

    mocks.listMeters.mockResolvedValue([{ id: 7, commodity: "water", meterRole: "main", currentTariffId: null }]);
    const day = 86_400_000;
    const t0 = Date.UTC(2025, 0, 1);
    mocks.getIntervalPoints.mockResolvedValue(
      Array.from({ length: 90 }, (_, i) => ({ ts: t0 + i * day, usage: 400 })), // 400 gal/day
    );
    const measuredRun = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    expect(measuredRun.find((c) => c.key === "water_leak_screening")).toBeDefined();
  });
});

describe("generateCommodityOpportunities — pricing and climate honesty", () => {
  it("prices at the seeded state tariff rate when available and names it", async () => {
    mocks.getBenchmark.mockImplementation(async (_bt: string, com: string) =>
      com === "gas" ? { medianEui: 0.3, unit: "therms/sqft-yr", source: "CBECS 2018" } : undefined,
    );
    mocks.listTariffs.mockImplementation(async (com: string) =>
      com === "gas"
        ? [{ name: "SW Gas G-5 Commercial", commodity: "gas", structure: { energy: [{ ratePerUnit: 1.1 }] } }]
        : [],
    );
    const out = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    const tuneup = out.find((c) => c.key === "gas_heating_tuneup")!;
    expect(tuneup.rationale).toMatch(/SW Gas G-5 Commercial/);
  });

  it("clamps the heating fraction down in a no-HDD climate so hot-climate sites never claim big heating savings", async () => {
    mocks.getBenchmark.mockImplementation(async (_bt: string, com: string) =>
      com === "gas" ? { medianEui: 0.3, unit: "therms/sqft-yr", source: "CBECS 2018" } : undefined,
    );
    const hotNormals = heatingNormals.map((n) => ({ ...n, hddBase65: 0 })) as MonthNormalRow[];
    const hot = await generateCommodityOpportunities(site, 1, hotNormals, noop);
    const cold = await generateCommodityOpportunities(site, 1, heatingNormals, noop);
    const hotTuneup = hot.find((c) => c.key === "gas_heating_tuneup")!;
    const coldTuneup = cold.find((c) => c.key === "gas_heating_tuneup")!;
    expect(hotTuneup.annualSavingsUsdHi).toBeLessThan(coldTuneup.annualSavingsUsdHi);
    expect(hotTuneup.rationale).toMatch(/15%/); // clamped floor disclosed
  });
});
