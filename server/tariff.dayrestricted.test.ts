/**
 * Batch-46 (pass 2012): an hourless demand charge that carries a daysOfWeek
 * restriction must bill the DAY-FILTERED peak, not the unrestricted ratcheted
 * monthly peak. Weekend peaks must not leak into a weekdays-only determinant.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff } from "./analytics/tariffEngine";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const HOUR = 60;

/** Build hourly points for June 2026 (UTC): weekday load 10 kW, but one
 * SATURDAY hour spikes to 50 kW. June 6, 2026 is a Saturday. */
function buildPoints(): IntervalPoint[] {
  const pts: IntervalPoint[] = [];
  const start = Date.UTC(2026, 5, 1, 0, 0, 0); // Mon Jun 1 2026
  for (let d = 0; d < 28; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = start + (d * 24 + h) * 3_600_000;
      const dow = new Date(ts).getUTCDay();
      const isSpike = d === 5 && h === 14; // Sat Jun 6, 14:00 UTC
      const kw = isSpike ? 50 : 10;
      pts.push({ ts, durationMin: HOUR, usage: kw, demand: kw });
    }
  }
  return pts;
}

const BASE: TariffStructure = {
  fixedMonthly: 0,
  energy: [
    { label: "all", months: [1,2,3,4,5,6,7,8,9,10,11,12], daysOfWeek: [0,1,2,3,4,5,6], hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 },
  ],
  demand: [],
};

describe("day-restricted hourless demand charges (Batch-46 pass 2012)", () => {
  it("weekdays-only hourless charge bills the weekday peak, not the weekend spike", () => {
    const structure: TariffStructure = {
      ...BASE,
      demand: [
        { label: "weekday anytime demand", months: [6], daysOfWeek: [1, 2, 3, 4, 5], ratePerKw: 10 },
      ],
    };
    const res = costOnTariff(buildPoints(), structure, { tz: "UTC" });
    // Weekday peak is 10 kW; the 50 kW spike happened on a Saturday and must
    // NOT set the billed determinant. 10 kW × $10/kW = $100.
    expect(res.breakdown.demand).toBeCloseTo(100, 6);
  });

  it("truly unrestricted hourless charge still bills the ratcheted monthly peak (incl. weekend)", () => {
    const structure: TariffStructure = {
      ...BASE,
      demand: [{ label: "anytime demand", months: [6], ratePerKw: 10 }],
    };
    const res = costOnTariff(buildPoints(), structure, { tz: "UTC" });
    // Unrestricted determinant = full monthly peak 50 kW × $10/kW = $500.
    expect(res.breakdown.demand).toBeCloseTo(500, 6);
  });

  it("export-credit subtrahend is exposed so Σ(components) − exportCredits ≡ total (Batch-46 pass 1990)", () => {
    const structure: TariffStructure = {
      ...BASE,
      exportRate: { type: "fixed_buyback", ratePerKwh: 0.05 },
    };
    const pts = buildPoints();
    // Make some hours net-export
    for (let i = 0; i < 20; i++) pts[i * 30].usage = -5;
    const res = costOnTariff(pts, structure, { tz: "UTC" });
    expect(res.breakdown.exportCredits ?? 0).toBeGreaterThan(0);
    const sum =
      res.breakdown.energy +
      res.breakdown.demand +
      res.breakdown.fixed +
      (res.breakdown.cp ?? 0) +
      (res.breakdown.minBillAdjustment ?? 0) -
      (res.breakdown.exportCredits ?? 0);
    expect(res.breakdown.total).toBeCloseTo(sum, 6);
  });
});
