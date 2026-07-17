/**
 * Batch-46 (pass 2052): minimum-bill floor must account for the month's CP
 * charge. A tariff carrying BOTH minBill and a CP charge previously applied
 * the uplift to energy+demand+fixed alone and THEN added CP on top — a light
 * month paid the floor plus the full CP, overstating the bill by the overlap.
 *
 * Invariants under test:
 * 1. When energy+fixed+CP already clears the floor, NO uplift is applied
 *    (minBillAdjustment === 0) and the total equals the plain component sum.
 * 2. When energy+fixed+CP is still below the floor, the uplift is exactly
 *    floor − (energy+fixed+CP), so the month's total lands ON the floor.
 * 3. The component-sum identity Σ(energy+demand+fixed+cp+minBillAdjustment)
 *    − exportCredits ≡ total holds in both cases.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff } from "./analytics/tariffEngine";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

/** One month of hourly points, flat load at `kw`, Jan 2025 (31 days). */
function flatMonthPoints(kw: number): IntervalPoint[] {
  const pts: IntervalPoint[] = [];
  const start = Date.UTC(2025, 0, 1, 8, 0, 0, 0); // 8:00 UTC = midnight Phoenix
  // 31×24 − 1 hours: the last interval STARTS at Jan 31 23:00 Phoenix-local,
  // so every point buckets into 2025-01 (a full 744-hour span would start its
  // final interval at Feb 1 00:00 local and create a stray one-point month).
  for (let h = 0; h < 31 * 24 - 1; h++) {
    pts.push({ ts: start + h * 3600_000, usage: kw, durationMin: 60, demand: kw });
  }
  return pts;
}

const TZ = "America/Phoenix";
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function baseStructure(overrides: Partial<TariffStructure>): TariffStructure {
  return {
    fixedMonthly: 10,
    energy: [{ label: "flat", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 }],
    demand: [],
    ...overrides,
  };
}

describe("minimum bill with CP charges (Batch-46 pass 2052)", () => {
  // Flat 2 kW × 743 h = 1486 kWh → energy $148.6, fixed $10.
  // CP: topN=1, all-year season, ratePerKw=5 → avgCpKw=2 → cpPerMonth=$10.
  const cpStructure = {
    cp: { topN: 1, ratePerKw: 5, peakSeasonMonths: ALL_MONTHS, chargeMonths: 12 },
  };

  it("takes no uplift when energy+fixed+CP clears the floor", () => {
    // Floor $165: energy 148.6 + fixed 10 = 158.6 < 165, but +CP 10 = 168.6 ≥ 165.
    const structure = baseStructure({ ...cpStructure, minBill: 165 });
    const res = costOnTariff(flatMonthPoints(2), structure, { tz: TZ });
    expect(res).not.toBeNull();
    const b = res!.breakdown;
    expect(b.minBillAdjustment ?? 0).toBe(0);
    // Total is the plain sum — no floor inflation.
    const sum = b.energy + b.demand + b.fixed + (b.cp ?? 0) + (b.minBillAdjustment ?? 0) - (b.exportCredits ?? 0);
    expect(b.total).toBeCloseTo(sum, 6);
    expect(b.total).toBeCloseTo(168.6, 1);
  });

  it("uplifts only the shortfall after CP when still below the floor", () => {
    // Floor $180: energy 148.6 + fixed 10 + CP 10 = 168.6 < 180 → uplift 11.4.
    const structure = baseStructure({ ...cpStructure, minBill: 180 });
    const res = costOnTariff(flatMonthPoints(2), structure, { tz: TZ });
    expect(res).not.toBeNull();
    const b = res!.breakdown;
    expect(b.minBillAdjustment ?? 0).toBeCloseTo(11.4, 1);
    // Month lands exactly on the floor (no export credits in this fixture).
    expect(b.total).toBeCloseTo(180, 1);
    const sum = b.energy + b.demand + b.fixed + (b.cp ?? 0) + (b.minBillAdjustment ?? 0) - (b.exportCredits ?? 0);
    expect(b.total).toBeCloseTo(sum, 6);
  });

  it("keeps pre-existing minBill behavior when the tariff has no CP charge", () => {
    // Floor $200: energy 148.6 + fixed 10 = 158.6 → uplift 41.4 (unchanged path).
    const structure = baseStructure({ minBill: 200 });
    const res = costOnTariff(flatMonthPoints(2), structure, { tz: TZ });
    expect(res).not.toBeNull();
    const b = res!.breakdown;
    expect(b.minBillAdjustment ?? 0).toBeCloseTo(41.4, 1);
    expect(b.total).toBeCloseTo(200, 1);
  });
});
