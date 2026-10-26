import { describe, expect, it } from "vitest";
import { applyCompletedMeasures, shareBeforeChange, RESIDUAL_MIDPOINTS } from "./analytics/residual";
import { combineOverlappingRanges, sumSiteRanges } from "./recommendations";

const START = Date.UTC(2025, 9, 1);
const END = Date.UTC(2026, 9, 1);
const MID = START + (END - START) / 2;
const base = { lightingKwh: 100_000, coolingKwh: 200_000, baseloadKw: 40 };
const ctx = { windowStartMs: START, windowEndMs: END, lightingFraction: 0.2, coolingFraction: 0.4, unoccupiedHoursPerYear: 4000 };

describe("OPEN-2 residual re-estimate after completed measures", () => {
  it("pro-rates by the share of readings recorded before the change", () => {
    expect(shareBeforeChange(START - 1, START, END)).toBe(0);
    expect(shareBeforeChange(END + 1, START, END)).toBe(1);
    expect(shareBeforeChange(MID, START, END)).toBeCloseTo(0.5, 10);
    expect(shareBeforeChange(MID, END, START)).toBe(0);
  });

  it("changes nothing when no relevant measure is completed", () => {
    const r = applyCompletedMeasures(base, { ...ctx, completed: [{ measure: "rate_switch", title: "Rate switch", implementedAt: MID }] });
    expect(r).toMatchObject({ ...base, applied: [], note: null });
  });

  it("changes nothing when every reading already reflects the change", () => {
    const r = applyCompletedMeasures(base, { ...ctx, completed: [{ measure: "led_retrofit", title: "LED lighting retrofit", implementedAt: START - 86_400_000 }] });
    expect(r.lightingKwh).toBe(base.lightingKwh);
    expect(r.note).toBeNull();
  });

  it("LED completed mid-window removes lighting energy and the lighting share of baseload", () => {
    const r = applyCompletedMeasures(base, { ...ctx, completed: [{ measure: "led_retrofit", title: "LED lighting retrofit", implementedAt: MID }] });
    const cut = RESIDUAL_MIDPOINTS.led_retrofit * 0.5;
    expect(r.lightingKwh).toBeCloseTo(100_000 * (1 - cut), 6);
    expect(r.coolingKwh).toBe(200_000);
    expect(r.baseloadKw).toBeCloseTo(40 - 40 * 0.2 * cut, 6);
    expect(r.applied).toHaveLength(1);
    expect(r.note).toMatch(/Re-estimated on the load that remains after LED lighting retrofit/);
    expect(r.note).toMatch(/50% of the analyzed readings predate it/);
    expect(r.note).toMatch(/not measured/);
  });

  it("HVAC completed before the window removes the full midpoint of cooling energy", () => {
    const r = applyCompletedMeasures(base, { ...ctx, completed: [{ measure: "hvac_tuneup", title: "HVAC tune-up", implementedAt: END + 1 }] });
    expect(r.coolingKwh).toBeCloseTo(200_000 * (1 - 0.1), 6);
    expect(r.baseloadKw).toBeCloseTo(40 - 40 * 0.4 * 0.1, 6);
  });

  it("baseload reduction takes after-hours energy out of lighting and cooling in proportion", () => {
    const r = applyCompletedMeasures(base, { ...ctx, completed: [{ measure: "baseload_reduction", title: "After-hours baseload", implementedAt: END + 1 }] });
    const savedKwh = 40 * 0.175 * 4000;
    expect(r.baseloadKw).toBeCloseTo(40 * (1 - 0.175), 6);
    expect(r.lightingKwh).toBeCloseTo(100_000 - savedKwh * 0.2, 6);
    expect(r.coolingKwh).toBeCloseTo(200_000 - savedKwh * 0.4, 6);
  });

  it("applies measures in completion order and counts a repeated measure once (latest date)", () => {
    const r = applyCompletedMeasures(base, {
      ...ctx,
      completed: [
        { measure: "led_retrofit", title: "LED", implementedAt: START + 1 },
        { measure: "led_retrofit", title: "LED", implementedAt: MID },
        { measure: "hvac_tuneup", title: "HVAC", implementedAt: END + 1 },
      ],
    });
    expect(r.applied.map((a) => a.measure)).toEqual(["led_retrofit", "hvac_tuneup"]);
    expect(r.applied[0].shareBefore).toBeCloseTo(0.5, 10);
    expect(r.note).toMatch(/LED .* and HVAC/);
  });

  it("never returns negative load", () => {
    const r = applyCompletedMeasures({ lightingKwh: 10, coolingKwh: 10, baseloadKw: 100 }, { ...ctx, completed: [{ measure: "baseload_reduction", title: "B", implementedAt: END + 1 }] });
    expect(r.lightingKwh).toBeGreaterThanOrEqual(0);
    expect(r.coolingKwh).toBeGreaterThanOrEqual(0);
    expect(r.baseloadKw!).toBeGreaterThanOrEqual(0);
  });

  it("leaves a missing baseload as missing", () => {
    const r = applyCompletedMeasures({ ...base, baseloadKw: null }, { ...ctx, completed: [{ measure: "led_retrofit", title: "LED", implementedAt: MID }] });
    expect(r.baseloadKw).toBeNull();
  });
});

describe("OPEN-2 combined amounts are bounds, not sums", () => {
  it("same utility: low is the best single action, high adds every action", () => {
    expect(combineOverlappingRanges([
      { commodity: "electric", savingsRangeUsd: { low: 100, high: 300 } },
      { commodity: "electric", savingsRangeUsd: { low: 250, high: 400 } },
    ])).toEqual({ low: 250, high: 700 });
  });
  it("different utilities are independent and add at the low end too", () => {
    expect(combineOverlappingRanges([
      { commodity: "electric", savingsRangeUsd: { low: 100, high: 300 } },
      { commodity: "electric", savingsRangeUsd: { low: 250, high: 400 } },
      { commodity: "gas", savingsRangeUsd: { low: 50, high: 80 } },
    ])).toEqual({ low: 300, high: 780 });
  });
  it("no ranged items gives no figure, and sites add", () => {
    expect(combineOverlappingRanges([{ commodity: "electric", savingsRangeUsd: null }])).toBeNull();
    expect(sumSiteRanges([{ low: 1, high: 2 }, null, { low: 3, high: 5 }])).toEqual({ low: 4, high: 7 });
    expect(sumSiteRanges([null])).toBeNull();
  });
});
