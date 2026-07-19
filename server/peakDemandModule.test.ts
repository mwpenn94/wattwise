/**
 * PEAK-2/3/4 — demand-module upgrade contract.
 * Pins: load duration curve shape + duration weighting, hours-near-peak
 * rarity metric, and per-monthly-peak contributing-load hypotheses with
 * honest hypothesis (not attribution) framing.
 */
import { describe, expect, it } from "vitest";
import { computeDemandAnalytics } from "./analytics/tariffEngine";
import type { IntervalPoint } from "../shared/wattwise";

/** Build hourly points for `days` days starting at a fixed UTC anchor. */
function hourly(days: number, kwAt: (dayIdx: number, hour: number) => number, startTs = Date.UTC(2025, 6, 1)): IntervalPoint[] {
  const pts: IntervalPoint[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const kw = kwAt(d, h);
      pts.push({ ts: startTs + (d * 24 + h) * 3_600_000, usage: kw, demand: kw, durationMin: 60 });
    }
  }
  return pts;
}

describe("PEAK-2 load duration curve", () => {
  it("returns a 101-point non-increasing curve from max to min", () => {
    const da = computeDemandAnalytics(hourly(30, (_d, h) => (h === 14 ? 100 : 20)));
    expect(da).not.toBeNull();
    const ldc = da!.loadDurationCurve;
    expect(ldc).toHaveLength(101);
    expect(ldc[0].pctOfHours).toBe(0);
    expect(ldc[100].pctOfHours).toBe(100);
    // Non-increasing
    for (let i = 1; i < ldc.length; i++) expect(ldc[i].kw).toBeLessThanOrEqual(ldc[i - 1].kw + 1e-9);
    // Left end is the peak, right end the minimum
    expect(ldc[0].kw).toBeCloseTo(100, 5);
    expect(ldc[100].kw).toBeCloseTo(20, 5);
  });

  it("hoursNearPeakPct captures peak rarity: 1 peaky hour/day ≈ 4.2% of hours", () => {
    // One hour of 100 kW per day, 23 hours of 20 kW → hours within 90% of
    // peak (>= 90 kW) = 1/24 ≈ 4.17%
    const da = computeDemandAnalytics(hourly(30, (_d, h) => (h === 14 ? 100 : 20)));
    expect(da!.hoursNearPeakPct).toBeGreaterThan(0.03);
    expect(da!.hoursNearPeakPct).toBeLessThan(0.06);
  });

  it("flat profile → hoursNearPeakPct ≈ 1 (all hours near peak)", () => {
    const da = computeDemandAnalytics(hourly(20, () => 50));
    expect(da!.hoursNearPeakPct).toBeGreaterThan(0.95);
  });
});

describe("PEAK-3/4 contributing-load hypotheses", () => {
  it("produces one hypothesis per monthly peak with hypothesis + basis strings", () => {
    // Two months of data (Jul + Aug 2025)
    const da = computeDemandAnalytics(hourly(62, (_d, h) => (h === 15 ? 80 : 15)));
    expect(da!.peakHypotheses.length).toBe(da!.monthlyPeaks.length);
    for (const ph of da!.peakHypotheses) {
      expect(ph.hypothesis.length).toBeGreaterThan(10);
      expect(ph.basis.length).toBeGreaterThan(10);
      expect(ph.kw).toBeGreaterThan(0);
    }
  });

  it("summer-afternoon peak → cooling hypothesis; overnight peak → baseload/scheduled hypothesis", () => {
    // Pass the tz explicitly so local-hour assertions are deterministic.
    // July 2025, America/Phoenix (UTC-7, no DST): 21:00 UTC = 14:00 local →
    // summer afternoon; 09:00 UTC = 02:00 local → overnight.
    const tz = "America/Phoenix";
    // NOTE: Date.UTC(2025,6,1) 00:00 UTC is Jun 30 17:00 Phoenix, so a June
    // partial month exists — select the max-kW month's hypothesis, not [0].
    const maxHyp = (da: NonNullable<ReturnType<typeof computeDemandAnalytics>>) =>
      [...da.peakHypotheses].sort((a, b) => b.kw - a.kw)[0];
    const summer = computeDemandAnalytics(hourly(30, (_d, h) => (h === 21 ? 90 : 20)), 4, [6, 7, 8, 9], tz);
    expect(maxHyp(summer!).hypothesis.toLowerCase()).toContain("cooling");
    const night = computeDemandAnalytics(hourly(30, (_d, h) => (h === 9 ? 90 : 20)), 4, [6, 7, 8, 9], tz);
    expect(maxHyp(night!).hypothesis.toLowerCase()).toMatch(/baseload|scheduled|timer/);
  });

  it("hypothesis framing is honest — basis says 'check', never asserts measurement", () => {
    const da = computeDemandAnalytics(hourly(30, (_d, h) => (h === 21 ? 90 : 20)));
    for (const ph of da!.peakHypotheses) {
      expect(ph.basis.toLowerCase()).toContain("check");
    }
  });
});
