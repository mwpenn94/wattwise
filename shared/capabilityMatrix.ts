/**
 * v1.17 §5.0(a) — CAPABILITY MATRIX (single source of truth).
 *
 * Rows = insight classes shipped in this build; columns = data state
 * (address-only → bill → 12-months-of-bills → interval). Each cell is
 * unlocked / degraded / locked, with the gate cited. The UX accuracy ladder
 * (Estimate → Good → Great → Measured) is GENERATED from this matrix —
 * v2.8 §1: every rung names, in advance, the specific insights the next
 * upload unlocks, so the ladder is a contract, not encouragement.
 *
 * Honesty constraint: an insight class appears here ONLY if the running build
 * actually produces it at that rung. Over-promising in the ladder poisons the
 * core loop (v2.8 P75) — when a capability ships or is removed, this table is
 * the one place to update, and the ladder + pricing bullets follow.
 */

/** The four data states this build distinguishes. Matches server/estimate.ts
 * ACCURACY_LADDER rung ids — the ladder is derived from these entries. */
export type DataRung = "estimate" | "good" | "great" | "measured";

export type CellState = "unlocked" | "degraded" | "locked";

export interface InsightClassRow {
  id: string;
  /** Plain-language name shown in ladder rung unlock lists (8th-grade voice). */
  name: string;
  /** First rung at which the class is UNLOCKED. */
  unlockedAt: DataRung;
  /** Rungs (before unlockedAt) where a degraded version renders with wider
   * confidence chips — null when the class is simply locked until unlock. */
  degradedAt?: DataRung[];
  /** The gate, cited (v1.17 §5.0a: "with the gate cited"). */
  gate: string;
}

/** Ordered rung index for comparisons. */
export const RUNG_ORDER: Record<DataRung, number> = {
  estimate: 0,
  good: 1,
  great: 2,
  measured: 3,
};

/**
 * Every insight class in the shipped build, with its unlock gate.
 * NOTE: hourly/15-min interval data is one "measured" rung in this build —
 * the parser accepts both; classes that sharpen at 15-min say so in the gate.
 */
export const INSIGHT_CLASSES: InsightClassRow[] = [
  {
    id: "cost_estimate",
    name: "Annual cost estimate + peer percentile",
    unlockedAt: "estimate",
    gate: "Address + building type select a peer archetype and local rates.",
  },
  {
    id: "rate_check",
    name: "Rate check (eligible-plan sweep)",
    unlockedAt: "estimate",
    degradedAt: undefined,
    gate: "Runs on the archetype profile at Estimate (labeled as such); your real usage shape replaces it at Measured for a full-precision sweep.",
  },
  {
    id: "benchmark_eui",
    name: "Peer-building benchmark (energy-use intensity)",
    unlockedAt: "estimate",
    gate: "Needs building type + floor area; real bills replace modeled usage at Good.",
  },
  {
    id: "actual_cost_tariff",
    name: "Your actual costs and tariff, verified",
    unlockedAt: "good",
    gate: "One utility bill provides the real rate and billed totals.",
  },
  {
    id: "weather_normalized_baseline",
    name: "Weather-normalized baseline (what weather did vs what you did)",
    unlockedAt: "great",
    degradedAt: ["good"],
    gate: "Needs ≥6 billing periods for a defensible fit; 12 months covers both seasons. Fewer months = wider confidence chips.",
  },
  {
    id: "anomaly_detection",
    name: "Bill anomaly detection",
    unlockedAt: "great",
    gate: "Needs a fitted baseline (R² ≥ 0.5, ≥6 months) to call a residual anomalous.",
  },
  {
    id: "demand_analytics",
    name: "Peak demand analytics (monthly peaks, ratchet, load factor, heatmap)",
    unlockedAt: "measured",
    gate: "Demand exists only in interval data; bills carry at most one printed peak.",
  },
  {
    id: "peak_attribution",
    name: "Peak-day story (when your peak hit and what it cost)",
    unlockedAt: "measured",
    gate: "Needs interval timestamps to locate the billing peak window.",
  },
  {
    id: "tariff_sweep_full",
    name: "Full-precision tariff sweep (TOU + demand + ratchet re-pricing)",
    unlockedAt: "measured",
    gate: "TOU and demand charges re-price hour by hour — archetype shapes only approximate this at earlier rungs.",
  },
  {
    id: "solar_battery_economics",
    name: "Solar + battery economics on your real load",
    unlockedAt: "measured",
    degradedAt: ["estimate", "good", "great"],
    gate: "Dispatch simulation runs hourly; earlier rungs use the archetype shape with wider bands.",
  },
  {
    id: "end_use_split",
    name: "End-use breakdown (ranges, never appliance claims)",
    unlockedAt: "measured",
    degradedAt: ["estimate", "good", "great"],
    gate: "Regression split needs interval data; earlier rungs show the peer-archetype statistical prior, labeled.",
  },
  {
    id: "scenario_precision",
    name: "Scenario modeling on measured hours (rate switch, schedule shift, EV)",
    unlockedAt: "measured",
    degradedAt: ["estimate", "good", "great"],
    gate: "Scenarios run at every rung — on measured data the deltas come from your hours, not a model of buildings like yours.",
  },
];

/** Cell lookup: state of one insight class at one rung. */
export function cellState(row: InsightClassRow, rung: DataRung): CellState {
  if (RUNG_ORDER[rung] >= RUNG_ORDER[row.unlockedAt]) return "unlocked";
  if (row.degradedAt?.includes(rung)) return "degraded";
  return "locked";
}

/** Insight classes newly unlocked BY moving to `rung` (not before). */
export function unlockedAtRung(rung: DataRung): InsightClassRow[] {
  return INSIGHT_CLASSES.filter((r) => r.unlockedAt === rung);
}

export interface LadderRung {
  rung: DataRung;
  label: string;
  /** What data gets you here. */
  unlockedBy: string;
  /** v2.8 §1 ladder-as-contract: the specific insights THIS rung unlocks,
   * named before upload. Generated from the capability matrix. */
  unlocks: string[];
}

const RUNG_META: Array<{ rung: DataRung; label: string; unlockedBy: string }> = [
  { rung: "estimate", label: "Estimate", unlockedBy: "Address + building type (buildings like yours)" },
  { rung: "good", label: "Good", unlockedBy: "One utility bill (your actual costs and tariff)" },
  { rung: "great", label: "Great", unlockedBy: "12 months of bills (weather-normalized baseline)" },
  { rung: "measured", label: "Measured", unlockedBy: "Interval data — Green Button or utility CSV (hour-by-hour truth)" },
];

/** The accuracy ladder, generated FROM the matrix (v1.17 §5.0a / v2.8 §1). */
export function buildAccuracyLadder(): LadderRung[] {
  return RUNG_META.map((meta) => ({
    ...meta,
    unlocks: unlockedAtRung(meta.rung).map((r) => r.name),
  }));
}

/** One-line contract sentence for a rung's next step, used by upload nudges:
 * "Add interval data → peak demand analytics, peak-day story, …" */
export function nextRungContract(current: DataRung): string | null {
  const idx = RUNG_ORDER[current];
  const next = RUNG_META.find((m) => RUNG_ORDER[m.rung] === idx + 1);
  if (!next) return null;
  const names = unlockedAtRung(next.rung).map((r) => r.name);
  return `${next.unlockedBy} → ${names.join(", ")}`;
}
