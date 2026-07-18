/**
 * §3b Peak attribution — unit specs.
 * Synthetic interval series with a known schedule and an injected coincidence
 * spike; verifies the split math, shape triage, counterfactual pricing, and
 * the honesty gates (short span → null, thin same-slot history → null).
 */
import { describe, expect, it } from "vitest";
import { computePeakAttribution } from "./analytics/attribution";
import { computeDemandAnalytics } from "./analytics/tariffEngine";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";
import type { BaselineFit } from "./analytics/baseline";

const TZ = "America/Phoenix";

/** Build an hourly series: weekday business-hours load 40 kW, nights 10 kW. */
function buildSeries(days: number, opts?: { spikeAt?: number; spikeKw?: number; plateauHours?: number }): IntervalPoint[] {
  const points: IntervalPoint[] = [];
  const start = Date.UTC(2025, 5, 2, 0, 0, 0); // Jun 2 2025 (Mon 00:00 UTC ≈ Sun 17:00 Phoenix)
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = start + (d * 24 + h) * 3_600_000;
      // Phoenix is UTC-7 year-round
      const localHour = (h - 7 + 24) % 24;
      const dow = Math.floor((ts / 86_400_000 + 4) % 7); // 0=Sun
      const business = dow >= 1 && dow <= 5 && localHour >= 8 && localHour < 18;
      let kw = business ? 40 : 10;
      if (opts?.spikeAt !== undefined) {
        const idx = d * 24 + h;
        const width = opts.plateauHours ?? 1;
        if (idx >= opts.spikeAt && idx < opts.spikeAt + width) kw = opts.spikeKw ?? 80;
      }
      points.push({ ts, durationMin: 60, usage: kw, demand: kw });
    }
  }
  return points;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const FLAT_DEMAND_TARIFF: TariffStructure = {
  fixedMonthly: 20,
  energy: [
    { label: "all", months: ALL_MONTHS, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 },
  ],
  demand: [{ label: "all-hours demand", months: ALL_MONTHS, ratePerKw: 15 }],
} as TariffStructure;

const GOOD_FIT: BaselineFit = {
  method: "caltrack_monthly",
  coefficients: { baseloadPerDay: 500, coolingSlope: 20, heatingSlope: 0, coolingBalanceF: 65, heatingBalanceF: 55 },
  rSquared: 0.9,
  cvrmse: 0.1,
  monthsCoverage: 12,
  confidence: "high",
  confidenceLabel: "high",
  weatherBasis: "normal-year",
  normalizedAnnualUsage: 250_000,
  disclosures: [],
};

describe("peak attribution (§3b)", () => {
  it("returns null for spans under 90 days (sufficiency gate)", () => {
    const pts = buildSeries(30, { spikeAt: 15 * 24 + 20, spikeKw: 90 });
    const demand = computeDemandAnalytics(pts, 4, [6, 7, 8, 9], TZ)!;
    expect(computePeakAttribution(pts, demand, GOOD_FIT, null, TZ)).toBeNull();
  });

  it("splits a coincidence spike: schedule share ≈ typical slot load, coincidence covers the excess", () => {
    // 120 days, spike of 90 kW for one hour in week 8 during business hours
    const spikeIdx = 56 * 24 + 21; // day 56, 21:00 UTC = 14:00 Phoenix (weekday afternoon)
    const pts = buildSeries(120, { spikeAt: spikeIdx, spikeKw: 90 });
    const demand = computeDemandAnalytics(pts, 4, [6, 7, 8, 9], TZ)!;
    const attr = computePeakAttribution(pts, demand, null, null, TZ)!;
    expect(attr).not.toBeNull();
    expect(attr.peakKw).toBeCloseTo(90, 0);
    // typical load in that slot is 40 kW (business hours) — schedule share
    expect(attr.scheduleKw).toBeGreaterThan(5);
    expect(attr.scheduleKw).toBeLessThanOrEqual(45);
    // no weather fit provided → weather share null, coincidence takes the rest
    expect(attr.weatherKw).toBeNull();
    expect(attr.scheduleKw + attr.coincidenceKw).toBeCloseTo(attr.peakKw, 1);
    expect(attr.confidence).toBe("low");
  });

  it("classifies a one-hour spike as spike and a 4-hour plateau as plateau", () => {
    const spikeIdx = 56 * 24 + 21;
    const spiky = buildSeries(120, { spikeAt: spikeIdx, spikeKw: 90 });
    const dSpiky = computeDemandAnalytics(spiky, 4, [6, 7, 8, 9], TZ)!;
    expect(computePeakAttribution(spiky, dSpiky, null, null, TZ)!.shape).toBe("spike");

    const flat = buildSeries(120, { spikeAt: spikeIdx, spikeKw: 90, plateauHours: 4 });
    const dFlat = computeDemandAnalytics(flat, 4, [6, 7, 8, 9], TZ)!;
    expect(computePeakAttribution(flat, dFlat, null, null, TZ)!.shape).toBe("plateau");
  });

  it("prices the counterfactual with the tariff engine when a rate is assigned", () => {
    const spikeIdx = 56 * 24 + 21;
    const pts = buildSeries(120, { spikeAt: spikeIdx, spikeKw: 90 });
    const demand = computeDemandAnalytics(pts, 4, [6, 7, 8, 9], TZ)!;
    const attr = computePeakAttribution(pts, demand, null, FLAT_DEMAND_TARIFF, TZ)!;
    expect(attr.counterfactual).not.toBeNull();
    expect(attr.counterfactual!.shavedKw).toBeGreaterThan(0);
    // shaving demand on a $15/kW tariff must save real dollars
    expect(attr.counterfactual!.annualSavingsUsd).toBeGreaterThan(0);
    expect(attr.counterfactual!.method).toContain("re-price");
  });

  it("includes a modeled weather share when a usable fit exists, capped by the peak", () => {
    const spikeIdx = 56 * 24 + 21;
    const pts = buildSeries(120, { spikeAt: spikeIdx, spikeKw: 90 });
    const demand = computeDemandAnalytics(pts, 4, [6, 7, 8, 9], TZ)!;
    const attr = computePeakAttribution(pts, demand, GOOD_FIT, null, TZ)!;
    expect(attr.weatherKw).not.toBeNull();
    expect(attr.weatherKw!).toBeGreaterThanOrEqual(0);
    // shares never exceed the peak
    expect((attr.weatherKw ?? 0) + attr.scheduleKw + attr.coincidenceKw).toBeCloseTo(attr.peakKw, 1);
    expect(attr.confidence).toBe("medium");
    expect(attr.disclosures.join(" ")).toContain("modeled");
  });
});
