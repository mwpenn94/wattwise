/**
 * GAP-A / AC11 / AC18 — solar (PV) signature detection and the net/gross gate.
 *
 * Detection: a behind-the-meter PV system on a NET-metered interval feed leaves
 * a characteristic fingerprint — midday consumption collapses toward (or below)
 * zero on sunny days while morning/evening usage stays normal. We detect it
 * WITHOUT weather data by comparing the midday trough against shoulder usage
 * across many days: real buildings don't idle to near-zero at noon and then
 * ramp in the evening, day after day, unless generation is offsetting load.
 *
 * The gate: when a signature is detected on a site that has NOT declared solar,
 * every load-shape-dependent insight is blocked (not silently rendered) until
 * the user answers one question: does your meter record NET (after solar) or
 * GROSS usage? Getting this wrong flips the sign of half the analytics, so
 * honesty demands the pipeline stop and ask rather than guess.
 */
import type { IntervalPoint } from "../../shared/wattwise";
import { localParts } from "../../shared/wattwise";

export interface PvDetectionResult {
  detected: boolean;
  /** share of analyzed days showing the midday-collapse fingerprint */
  signatureDayShare: number;
  daysAnalyzed: number;
  /** true when any interval goes negative (export) — unambiguous */
  hasNegativeIntervals: boolean;
  rationale: string;
}

/**
 * Detect a PV self-consumption/export fingerprint in interval data.
 * Requires >= 30 days of sub-daily data to speak at all — below that the
 * detector stays silent (returns detected=false with rationale).
 */
export function detectPvSignature(points: IntervalPoint[], tz: string): PvDetectionResult {
  const silent = (why: string): PvDetectionResult => ({
    detected: false,
    signatureDayShare: 0,
    daysAnalyzed: 0,
    hasNegativeIntervals: false,
    rationale: why,
  });
  if (points.length === 0) return silent("no interval data");
  const resolutionMin = points[0]?.durationMin ?? 60;
  if (resolutionMin > 60) return silent("interval resolution coarser than hourly — midday shape not resolvable");

  // Bucket usage by local day and coarse hour bands.
  type DayAgg = { midday: number; middayN: number; shoulder: number; shoulderN: number; minMidday: number; negative: boolean };
  const days = new Map<string, DayAgg>();
  let hasNegative = false;
  for (const p of points) {
    const lp = localParts(p.ts, tz);
    const dayKey = `${lp.monthKey}-${String(lp.day).padStart(2, "0")}`;
    const hour = lp.hour;
    let d = days.get(dayKey);
    if (!d) {
      d = { midday: 0, middayN: 0, shoulder: 0, shoulderN: 0, minMidday: Infinity, negative: false };
      days.set(dayKey, d);
    }
    if (p.usage < 0) {
      hasNegative = true;
      d.negative = true;
    }
    if (hour >= 10 && hour < 15) {
      d.midday += p.usage;
      d.middayN += 1;
      if (p.usage < d.minMidday) d.minMidday = p.usage;
    } else if ((hour >= 6 && hour < 9) || (hour >= 18 && hour < 22)) {
      d.shoulder += p.usage;
      d.shoulderN += 1;
    }
  }

  const complete = Array.from(days.values()).filter((d) => d.middayN >= 3 && d.shoulderN >= 3);
  if (complete.length < 30) {
    return {
      detected: hasNegative && complete.length >= 7,
      signatureDayShare: 0,
      daysAnalyzed: complete.length,
      hasNegativeIntervals: hasNegative,
      rationale: hasNegative
        ? `negative (export) intervals present across ${complete.length} days — unambiguous PV signal even below the 30-day shape threshold`
        : `only ${complete.length} analyzable days (needs ≥30) — detector stays silent`,
    };
  }

  // Fingerprint per day: midday average collapses below 35% of shoulder average
  // (or goes negative) while shoulder usage stays material.
  let signatureDays = 0;
  for (const d of complete) {
    const middayAvg = d.midday / d.middayN;
    const shoulderAvg = d.shoulder / d.shoulderN;
    if (d.negative) {
      signatureDays += 1;
      continue;
    }
    if (shoulderAvg > 0 && middayAvg < shoulderAvg * 0.35) signatureDays += 1;
  }
  const share = signatureDays / complete.length;
  // Threshold: 40% of days showing the fingerprint. Cloudy days and weekend
  // shape changes keep the share below 100% for real PV; occupancy quirks
  // rarely push a non-PV building above ~25%.
  const detected = hasNegative || share >= 0.4;
  return {
    detected,
    signatureDayShare: Math.round(share * 100) / 100,
    daysAnalyzed: complete.length,
    hasNegativeIntervals: hasNegative,
    rationale: hasNegative
      ? "negative (export) intervals present — meter records net flow with PV export"
      : detected
        ? `${Math.round(share * 100)}% of ${complete.length} days show the midday-collapse fingerprint (threshold 40%)`
        : `${Math.round(share * 100)}% of ${complete.length} days show the fingerprint — below the 40% threshold`,
  };
}

/** Insight kinds whose math depends on the load shape being pure consumption.
 * These are BLOCKED while a detected PV signature is unresolved. */
export const PV_GATED_INSIGHT_KINDS = new Set([
  // On a net-metered feed the observed load shape is consumption MINUS
  // generation — every one of these reads the shape as if it were pure
  // consumption, so their math silently flips sign or direction:
  "load_factor", // load factor computed from a solar-carved midday trough
  "peak_attribution", // "what drives your peaks" misreads solar backfill
  "baseline", // weather regression fits generation, not building physics
  "end_use", // disaggregation splits a shape that isn't the building's
  "cp_exposure", // coincident-peak exposure misestimated by masked load
  "anomaly", // solar output variation masquerades as usage anomalies
]);

export type PvGateState = "not_applicable" | "blocked_unconfirmed" | "resolved_net" | "resolved_gross" | "dismissed";

/** Compute the gate state from site fields. */
export function pvGateState(site: {
  hasSolar: boolean;
  pvDetectionStatus: string | null;
  netMeteringBasis: string | null;
}): PvGateState {
  const status = site.pvDetectionStatus ?? "none";
  if (status === "detected_unconfirmed") return "blocked_unconfirmed";
  if (status === "confirmed_net") return "resolved_net";
  if (status === "confirmed_gross") return "resolved_gross";
  if (status === "dismissed") return "dismissed";
  // Declared solar without detection: basis matters too, but never blocks —
  // the user told us, so we trust netMeteringBasis (defaulting to net).
  return "not_applicable";
}

/** Human sentence for the gate card. */
export function pvGateMessage(r: PvDetectionResult): string {
  return (
    `Your usage pattern looks like a home or building with solar panels — midday usage drops far below morning and evening levels (${r.rationale}). ` +
    `Before we show savings numbers that depend on your usage shape, tell us one thing: does your meter report usage after solar (net) or total usage (gross)? ` +
    `Getting this wrong would make most of the numbers below meaningless, so we pause them instead of guessing.`
  );
}
