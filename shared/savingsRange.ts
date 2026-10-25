/**
 * Savings estimates are always displayed as confidence-derived ranges. The
 * multipliers match the existing scenario/composer convention: high-confidence
 * estimates use ±15%, medium ±25%, and low confidence uses the deliberately
 * asymmetric -40%/+30% band used for weaker modeled baselines.
 */
export type SavingsConfidence = "low" | "medium" | "high";

export interface SavingsRangeUsd {
  low: number;
  high: number;
}

export function savingsRangeFromEstimate(
  estimateUsd: number | null | undefined,
  confidence: SavingsConfidence | string | null | undefined,
): SavingsRangeUsd | null {
  if (estimateUsd == null || !Number.isFinite(estimateUsd) || estimateUsd <= 0) return null;
  const multipliers = confidence === "high" ? { low: 0.85, high: 1.15 } : confidence === "low" ? { low: 0.6, high: 1.3 } : { low: 0.75, high: 1.25 };
  return {
    low: Math.round(estimateUsd * multipliers.low * 100) / 100,
    high: Math.round(estimateUsd * multipliers.high * 100) / 100,
  };
}

export function addSavingsRanges(ranges: Array<SavingsRangeUsd | null | undefined>): SavingsRangeUsd {
  return ranges.reduce<SavingsRangeUsd>(
    (total, range) => ({ low: total.low + (range?.low ?? 0), high: total.high + (range?.high ?? 0) }),
    { low: 0, high: 0 },
  );
}

/** A range label, never a point promise. Used by every recommendation surface. */
export function formatSavingsRangeUsd(range: SavingsRangeUsd | null | undefined): string {
  if (range == null || !Number.isFinite(range.low) || !Number.isFinite(range.high)) return "—";
  const format = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  return `${format(range.low)}–${format(range.high)}`;
}
