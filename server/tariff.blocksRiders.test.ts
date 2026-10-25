import { describe, expect, it } from "vitest";
import { costOnTariff, tariffEligible } from "./analytics/tariffEngine";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function point(monthZeroIndexed: number, usage: number, demand = 0): IntervalPoint {
  return { ts: Date.UTC(2026, monthZeroIndexed, 15, 12), durationMin: 60, usage, demand };
}

const EGSGS: TariffStructure = {
  fixedMonthly: 0,
  energy: [],
  energyBlocks: [
    { upToKwh: 400, ratePerUnit: 0.104167 },
    { upToKwh: 7500, ratePerUnit: 0.114417 },
    { upToKwh: null, ratePerUnit: 0.159003 },
  ],
  demand: [],
};

describe("tariff blocks and riders", () => {
  it("prices all three EGSGS monthly blocks", () => {
    const result = costOnTariff([point(9, 10_000)], EGSGS, { tz: "UTC" });
    expect(result.breakdown.energy).toBeCloseTo(400 * 0.104167 + 7100 * 0.114417 + 2500 * 0.159003, 6);
  });

  it("caps REST and applies inclusive rider-month windows", () => {
    const structure: TariffStructure = {
      ...EGSGS,
      riders: [
        { label: "REST", ratePerUnit: 0.0126, monthlyCapUsd: 59.5 },
        { label: "PPFAC", ratePerUnit: 0.004508, validFrom: "2026-10-01" },
        { label: "PPFAC temporary credit", ratePerUnit: -0.020931, validFrom: "2026-05-01", validTo: "2026-12-31" },
      ],
    };
    const october = costOnTariff([point(9, 10_000)], structure, { tz: "UTC" });
    const octoberRiders = Object.fromEntries((october.breakdown.riders ?? []).map((r) => [r.label, r.amount]));
    expect(octoberRiders.REST).toBeCloseTo(59.5, 6);
    expect(octoberRiders.PPFAC).toBeCloseTo(45.08, 6);
    expect(octoberRiders["PPFAC temporary credit"]).toBeCloseTo(-209.31, 6);

    const january = costOnTariff([point(0, 10_000)], structure, { tz: "UTC" });
    const januaryRiders = Object.fromEntries((january.breakdown.riders ?? []).map((r) => [r.label, r.amount]));
    expect(januaryRiders.PPFAC).toBeUndefined();
    expect(januaryRiders["PPFAC temporary credit"]).toBeUndefined();
  });

  it("enforces the 20 kW MGS minimum billing demand", () => {
    const structure: TariffStructure = {
      fixedMonthly: 0,
      energy: [],
      demand: [{ label: "Billing demand", months: ALL_MONTHS, ratePerKw: 14.67 }],
      demandMinKw: 20,
    };
    const result = costOnTariff([point(9, 12, 12)], structure, { tz: "UTC" });
    expect(result.monthlyDetails[0].billedDemandKw).toBe(20);
    expect(result.breakdown.demand).toBeCloseTo(20 * 14.67, 6);
  });

  it("limits school-only tariffs to school building types", () => {
    const tariff = { sector: "commercial", commodity: "electric", peakKwMin: null, peakKwMax: null, schoolOnly: true };
    expect(tariffEligible(tariff, { sectorClass: "commercial", buildingType: "office" }, null)).toMatchObject({ eligible: false });
    expect(tariffEligible(tariff, { sectorClass: "commercial", buildingType: "school" }, null)).toMatchObject({ eligible: false });
    expect(tariffEligible(tariff, { sectorClass: "commercial", buildingType: "school", k12Confirmed: true }, null)).toEqual({ eligible: true });
  });

  it("keeps legacy flat structures priced identically", () => {
    const legacy: TariffStructure = {
      fixedMonthly: 12,
      energy: [{ label: "All energy", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 }],
      demand: [],
    };
    const result = costOnTariff([point(9, 100)], legacy, { tz: "UTC" });
    expect(result.breakdown).toMatchObject({ energy: 10, fixed: 12, demand: 0, total: 22 });
    expect(result.breakdown.riders).toBeUndefined();
  });
});
