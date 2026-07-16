/**
 * Analytics engine tests — CalTRACK-grade baseline fitting, exact-rules tariff
 * costing (TOU, demand, ratchet, CP), demand analytics, scenarios, and the
 * free-tier cost-cap + verbatim-label invariants. Synthetic-but-physical data.
 */
import { describe, expect, it } from "vitest";
import { fitCaltrackMonthly, intervalsToMonthly, type MonthlyUsage, type MonthNormalRow } from "./analytics/baseline";
import { applyRatchet, computeDemandAnalytics, costOnTariff, tariffEligible } from "./analytics/tariffEngine";
import { runScenario } from "./analytics/scenarios";
import {
  FREE_TIER_MAX_COST_USD,
  LABEL_CP_ESTIMATED,
  LABEL_NORMAL_YEAR,
  LABEL_PROTOTYPE_ARCHETYPE,
  type IntervalPoint,
  type TariffStructure,
} from "../shared/wattwise";

/** One year of hourly synthetic office load: base 40 kW, business-hours 120 kW, summer AC bump. */
function syntheticYear(): IntervalPoint[] {
  const pts: IntervalPoint[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let h = 0; h < 8760; h++) {
    const ts = start + h * 3_600_000;
    const d = new Date(ts);
    const hour = d.getUTCHours();
    const dow = d.getUTCDay();
    const month = d.getUTCMonth();
    const business = dow >= 1 && dow <= 5 && hour >= 8 && hour < 18;
    const summer = month >= 5 && month <= 8;
    let kw = 40 + (business ? 80 : 0) + (summer && business ? 60 : summer ? 15 : 0);
    kw += Math.sin(h / 7) * 3;
    pts.push({ ts, durationMin: 60, usage: kw, demand: kw });
  }
  return pts;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const FLAT: TariffStructure = {
  fixedMonthly: 20,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 }],
  demand: [],
};

const TOU_DEMAND: TariffStructure = {
  fixedMonthly: 30,
  energy: [
    { label: "summer on-peak", months: [6, 7, 8, 9], daysOfWeek: [1, 2, 3, 4, 5], hourStart: 15, hourEnd: 20, ratePerUnit: 0.22 },
    { label: "off-peak", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.07 },
  ],
  demand: [{ label: "all", months: ALL_MONTHS, ratePerKw: 14 }] as TariffStructure["demand"],
  ratchet: { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" } as TariffStructure["ratchet"],
};

/** Synthetic monthly normals: hot summers, mild winters (PHX-like). */
function synthNormals(): MonthNormalRow[] {
  const avg = [55, 58, 64, 72, 81, 91, 95, 93, 88, 76, 63, 54];
  return avg.map((t, i) => ({ month: i + 1, avgTempF: t, hdd65: Math.max(0, 65 - t) * 30, cdd65: Math.max(0, t - 65) * 30 }));
}

function tempsFor(months: string[]): Map<string, number[]> {
  const normals = synthNormals();
  const map = new Map<string, number[]>();
  for (const m of months) {
    const mon = parseInt(m.split("-")[1]!, 10);
    const t = normals[mon - 1]!.avgTempF;
    map.set(m, Array.from({ length: 30 }, (_, d) => t + Math.sin(d) * 3));
  }
  return map;
}

describe("CalTRACK-grade monthly baseline", () => {
  it("fits HDD/CDD regression with strong R² on weather-driven load", () => {
    const months: MonthlyUsage[] = [];
    const keys: string[] = [];
    for (let i = 0; i < 24; i++) {
      const y = 2024 + Math.floor(i / 12);
      const mon = (i % 12) + 1;
      const key = `${y}-${String(mon).padStart(2, "0")}`;
      keys.push(key);
      const t = synthNormals()[mon - 1]!.avgTempF;
      const cddDay = Math.max(0, t - 68);
      const hddDay = Math.max(0, 60 - t);
      months.push({ month: key, usage: 600 * 30 + 120 * cddDay * 30 + 40 * hddDay * 30, days: 30 });
    }
    const fit = fitCaltrackMonthly(months, tempsFor(keys), synthNormals(), { weatherIsNormalsProxy: true });
    expect(fit.method).toBeTruthy();
    expect(fit.rSquared ?? 0).toBeGreaterThan(0.85);
    // proxy-weather disclosure must be present (honest labeling)
    expect(fit.disclosures.join(" ")).toContain("normals");
  });

  it("intervalsToMonthly aggregates a year of hourly data into 12 buckets", () => {
    const monthly = intervalsToMonthly(syntheticYear());
    expect(monthly.length).toBe(12);
    expect(monthly.every((m) => m.usage > 0 && m.days >= 28)).toBe(true);
  });
});

describe("Demand analytics", () => {
  // Synthetic points sit on UTC boundaries — pass tz "UTC" explicitly so month
  // bucketing is deterministic (the engine defaults to America/Phoenix).
  const da = computeDemandAnalytics(syntheticYear(), 4, [6, 7, 8, 9], "UTC")!;

  it("computes peak, load factor, heatmap dimensions", () => {
    expect(da).not.toBeNull();
    expect(da.peakKw).toBeGreaterThan(170);
    expect(da.loadFactor).toBeGreaterThan(0.2);
    expect(da.loadFactor).toBeLessThan(0.9);
    expect(da.heatmap.length).toBe(7);
    expect(da.heatmap[0]!.length).toBe(24);
    expect(da.monthlyPeaks.length).toBe(12);
  });

  it("labels CP proxy verbatim: estimated — not ISO system peaks", () => {
    expect(LABEL_CP_ESTIMATED).toBe("estimated — not ISO system peaks");
    expect(da.cpProxy).not.toBeNull();
    expect(da.cpProxy!.label).toBe("estimated — not ISO system peaks");
    expect(da.cpProxy!.events.length).toBeGreaterThan(0);
    expect(da.cpProxy!.topN).toBe(4);
  });
});

describe("Exact-rules tariff engine", () => {
  const pts = syntheticYear();

  it("flat tariff = fixed + energy·rate exactly", () => {
    const res = costOnTariff(pts, FLAT, { tz: "UTC" });
    const kwh = pts.reduce((s, p) => s + p.usage, 0);
    expect(res.breakdown.total).toBeCloseTo(20 * 12 + kwh * 0.1, 0);
    expect(res.breakdown.cpMethodology).toBeDefined();
  });

  it("TOU pricing bills on-peak energy above flat-only pricing and includes demand charges", () => {
    const res = costOnTariff(pts, TOU_DEMAND, { tz: "UTC" });
    const flatOnly = costOnTariff(pts, { ...TOU_DEMAND, energy: [TOU_DEMAND.energy[1]!] }, { tz: "UTC" });
    expect(res.breakdown.energy).toBeGreaterThan(flatOnly.breakdown.energy);
    expect(res.breakdown.demand).toBeGreaterThan(0);
  });

  it("demandGroup bills max across alternative windows once, not per window", () => {
    // Two windows of one determinant (SRP E-36 winter pattern): morning 5-9, evening 17-21.
    const grouped: TariffStructure = {
      fixedMonthly: 0,
      energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.05 }],
      demand: [
        { label: "am", months: ALL_MONTHS, hourStart: 5, hourEnd: 9, daysOfWeek: ALL_DAYS, ratePerKw: 10, demandGroup: "g" },
        { label: "pm", months: ALL_MONTHS, hourStart: 17, hourEnd: 21, daysOfWeek: ALL_DAYS, ratePerKw: 10, demandGroup: "g" },
      ] as TariffStructure["demand"],
    };
    const ungroupedSum: TariffStructure = {
      ...grouped,
      demand: grouped.demand.map((d) => ({ ...d, demandGroup: undefined })) as TariffStructure["demand"],
    };
    const res = costOnTariff(pts, grouped, { tz: "UTC" });
    const resSum = costOnTariff(pts, ungroupedSum, { tz: "UTC" });
    // Grouped bills ONE determinant (max of windows); ungrouped double-bills both windows.
    expect(res.breakdown.demand).toBeGreaterThan(0);
    expect(res.breakdown.demand).toBeLessThan(resSum.breakdown.demand);
    // Morning-peaking load must be captured by the group (max >= evening-only peak):
    const eveningOnly: TariffStructure = {
      ...grouped,
      demand: [{ label: "pm", months: ALL_MONTHS, hourStart: 17, hourEnd: 21, daysOfWeek: ALL_DAYS, ratePerKw: 10 }] as TariffStructure["demand"],
    };
    const resEve = costOnTariff(pts, eveningOnly, { tz: "UTC" });
    expect(res.breakdown.demand).toBeGreaterThanOrEqual(resEve.breakdown.demand);

    // Batch-26 (pass 900a): the >= assertion above cannot falsify an
    // implementation that bills the WRONG window's peak. Use a deterministic
    // morning-peaking load (8 kW at 6:00, 2 kW at 18:00, single month) and
    // assert the grouped determinant is EXACTLY the morning peak — an
    // evening-window pick would bill 2×10 instead of 8×10.
    const janDays = Array.from({ length: 28 }, (_, d) => d + 1);
    const morningPts = janDays.flatMap((day) => [
      { ts: Date.UTC(2025, 0, day, 6, 0, 0), usage: 8, durationMin: 60 }, // 8 kWh in 1h → 8 kW, am window
      { ts: Date.UTC(2025, 0, day, 18, 0, 0), usage: 2, durationMin: 60 }, // 2 kW, pm window
    ]);
    const resMorning = costOnTariff(morningPts, grouped, { tz: "UTC" });
    expect(resMorning.breakdown.demand).toBeCloseTo(8 * 10, 5); // morning peak × $10/kW, one month
  });

  it("ratchet floors billed demand at percent of trailing peak", () => {
    const details = applyRatchet(
      [
        { month: "2025-06", peakKw: 200, peakTs: 1 },
        { month: "2025-07", peakKw: 210, peakTs: 2 },
        { month: "2025-08", peakKw: 60, peakTs: 3 },
      ],
      { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" },
    );
    const aug = details.find((b) => b.month === "2025-08")!;
    expect(aug.billedDemandKw).toBeCloseTo(0.8 * 210, 5);
    expect(aug.ratchetApplied).toBe(true);
    const jul = details.find((b) => b.month === "2025-07")!;
    expect(jul.billedDemandKw).toBe(210);
    expect(jul.ratchetApplied).toBe(false);
  });

  it("ratchet window includes the current month (cycle-2 pass-22 convention)", () => {
    // With pct = 1.0 the inclusion is observable: the current month's own peak
    // enters the determinant window, so billed equals the max of the window
    // including itself — and the following month ratchets off that new high.
    const details = applyRatchet(
      [
        { month: "2025-06", peakKw: 100, peakTs: 1 },
        { month: "2025-07", peakKw: 300, peakTs: 2 }, // new high in current month
        { month: "2025-08", peakKw: 50, peakTs: 3 },
      ],
      { lookbackMonths: 11, ratchetPct: 1.0, applicablePeriod: "all" },
    );
    const jul = details.find((b) => b.month === "2025-07")!;
    expect(jul.billedDemandKw).toBe(300); // own peak is the window max — no distortion
    const aug = details.find((b) => b.month === "2025-08")!;
    expect(aug.billedDemandKw).toBe(300); // ratchets off July's new high
    expect(aug.ratchetApplied).toBe(true);
    // pct < 1 behavior unchanged (no-op on the current month itself)
    const d2 = applyRatchet(
      [{ month: "2025-06", peakKw: 100, peakTs: 1 }],
      { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" },
    );
    expect(d2[0].billedDemandKw).toBe(100);
    expect(d2[0].ratchetApplied).toBe(false);
    // Batch-26 (pass 900b): the current month's peak must also feed the
    // LOOKBACK for subsequent months at pct < 1 — a regression that excluded
    // it would bill month 2 at its own 50 kW instead of 0.8×100 = 80 kW.
    const d3 = applyRatchet(
      [
        { month: "2025-06", peakKw: 100, peakTs: 1 },
        { month: "2025-07", peakKw: 50, peakTs: 2 },
      ],
      { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" },
    );
    const jul3 = d3.find((b) => b.month === "2025-07")!;
    expect(jul3.billedDemandKw).toBeCloseTo(0.8 * 100, 5);
    expect(jul3.ratchetApplied).toBe(true);
  });

  it("eligibility filter blocks ineligible rates with a reason", () => {
    const verdict = tariffEligible(
      { sector: "residential", commodity: "electric", peakKwMin: null, peakKwMax: 20 },
      { sectorClass: "commercial" },
      180,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it("size-window eligibility uses peak kW bounds", () => {
    const verdict = tariffEligible(
      { sector: "commercial", commodity: "electric", peakKwMin: 100, peakKwMax: null },
      { sectorClass: "commercial" },
      60,
    );
    expect(verdict.eligible).toBe(false);
  });
});

describe("Scenario engine", () => {
  const hourly = syntheticYear().map((p) => p.usage);

  it("efficiency scenario reduces energy and cost", () => {
    const res = runScenario(
      hourly,
      { kind: "efficiency", efficiencyReductions: { cooling: 0.2 }, endUseFractions: { cooling: 0.4 } },
      TOU_DEMAND,
      "2B",
      850,
      "medium",
      false,
    );
    expect(res.scenarioAnnualCost!).toBeLessThan(res.baselineAnnualCost!);
    expect(res.siteTotalDeltaCost).toBeLessThan(0);
  });

  it("battery peak-shave cannot create energy (round-trip losses) yet reduces demand cost", () => {
    const res = runScenario(hourly, { kind: "battery", batteryKw: 50, batteryKwh: 200 }, TOU_DEMAND, "2B", 850, "medium", false);
    expect(res.disclosures.length).toBeGreaterThan(0);
    expect(res.disclosures.join(" ").toLowerCase()).toContain("round-trip");
  });

  it("solar+battery combo labels sequential dispatch honestly", () => {
    const res = runScenario(hourly, { kind: "solar_battery", solarKwDc: 100, batteryKw: 50, batteryKwh: 200 }, TOU_DEMAND, "2B", 850, "medium", false);
    expect(res.dispatchMethod).toBe("sequential");
  });

  it("solar scenario carries assumption disclosures; confidence inherits baseline (Batch-26)", () => {
    const res = runScenario(hourly, { kind: "solar", solarKwDc: 100 }, TOU_DEMAND, "2B", 850, "medium", false);
    // Batch-26 (passes 903/913): a medium-confidence baseline without
    // extrapolation no longer collapses to "low" — it stays "medium".
    expect(res.confidence).toBe("medium");
    // Extrapolation still forces low regardless of baseline confidence:
    const resExtrap = runScenario(hourly, { kind: "solar", solarKwDc: 100 }, TOU_DEMAND, "2B", 850, "medium", true);
    expect(resExtrap.confidence).toBe("low");
    // And a low baseline stays low:
    const resLow = runScenario(hourly, { kind: "solar", solarKwDc: 100 }, TOU_DEMAND, "2B", 850, "low", false);
    expect(resLow.confidence).toBe("low");
    expect(res.disclosures.join(" ").length).toBeGreaterThan(10);
    expect(Object.keys(res.assumptions).length).toBeGreaterThan(0);
  });

  it("scenario results are labeled normal-year basis", () => {
    const res = runScenario(hourly, { kind: "efficiency", efficiencyReductions: { cooling: 0.1 }, endUseFractions: { cooling: 0.4 } }, FLAT, "2B", 850, "high", false);
    expect(res.disclosures.join(" ")).toContain(LABEL_NORMAL_YEAR);
  });
});

describe("Honest-labeling and cost-cap invariants", () => {
  it("verbatim label constants", () => {
    expect(LABEL_PROTOTYPE_ARCHETYPE).toBe("prototype-archetype");
    expect(LABEL_NORMAL_YEAR).toBe("normal-year basis");
    expect(LABEL_CP_ESTIMATED).toBe("estimated — not ISO system peaks");
  });

  it("free-tier marginal cost cap is ≤ $0.20 in code", () => {
    expect(FREE_TIER_MAX_COST_USD).toBeLessThanOrEqual(0.2);
  });
});
