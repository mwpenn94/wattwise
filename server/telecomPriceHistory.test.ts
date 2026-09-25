import { describe, expect, it } from "vitest";
import { detectPriceCreep, normalizeMonthlyPrice } from "./telecomPriceHistory";

describe("telecom price history", () => {
  it("normalizes non-monthly bill periods to a monthly basis", () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 1, 1);
    expect(normalizeMonthlyPrice(100, start, end)).toBeCloseTo(98.18, 2);
  });

  it("does not flag a single observation or immaterial movement", () => {
    expect(detectPriceCreep([{ periodStart: 1, periodEnd: 2, normalizedMonthlyUsd: 100 }], 4)).toBeNull();
    expect(detectPriceCreep([
      { periodStart: 1, periodEnd: 2, normalizedMonthlyUsd: 100 },
      { periodStart: 2, periodEnd: 3, normalizedMonthlyUsd: 104 },
    ], 4)).toBeNull();
  });

  it("flags a material jump and marks three rising periods as sustained", () => {
    const result = detectPriceCreep([
      { periodStart: 1, periodEnd: 2, normalizedMonthlyUsd: 100 },
      { periodStart: 2, periodEnd: 3, normalizedMonthlyUsd: 112 },
      { periodStart: 3, periodEnd: 4, normalizedMonthlyUsd: 125 },
    ], 4);
    expect(result?.deltaMonthlyUsd).toBe(13);
    expect(result?.deltaPct).toBeCloseTo(13 / 112);
    expect(result?.sustained).toBe(true);
  });
});
