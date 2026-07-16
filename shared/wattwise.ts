/**
 * WattWise shared types & constants — commodity-agnostic core.
 * Verbatim label constants live here so UI and engine can never drift.
 */

/* ---------- Verbatim honesty labels (handoff + owner constraints) ---------- */
export const LABEL_CP_ESTIMATED = "estimated — not ISO system peaks" as const;
export const LABEL_PROTOTYPE_ARCHETYPE = "prototype-archetype" as const;
export const LABEL_NORMAL_YEAR = "normal-year basis" as const;
export const MODELED_ESTIMATES_DISCLAIMER =
  "All outputs are modeled estimates — not a professional energy audit, engineering study, or financial/tax advice. Savings projections carry the stated confidence ranges." as const;

/* ---------- Free-tier economics ---------- */
export const FREE_TIER_MAX_COST_USD = 0.2;
export const FREE_TIER_MONTHLY_LLM_BUDGET_USD = 0.5;
export const FREE_TIER_MAX_SITES = 2;
export const FREE_TIER_SCENARIOS_PER_MONTH = 3;
export const FREE_TIER_MAX_UPLOADS_PER_MONTH = 12;
export const ANALYSIS_TIMEOUT_MS = 60_000;
export const PARSE_TIMEOUT_MS = 45_000;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/* ---------- Timezone-aware local time parts (deliverable cycle 3) ----------
 * All interval timestamps are UTC ms. TOU matching, demand windows, heatmaps
 * and baseload windows must be computed in the METER'S timezone, never the
 * server's. Cached formatters keep this fast enough for 35k-point sweeps. */
const _dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(tz: string): Intl.DateTimeFormat {
  let f = _dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      weekday: "short",
    });
    _dtfCache.set(tz, f);
  }
  return f;
}
const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  dow: number; // 0=Sun
  monthKey: string; // "YYYY-MM"
}
export function localParts(tsMs: number, tz: string): LocalParts {
  try {
    const parts = dtfFor(tz).formatToParts(tsMs);
    let year = 0,
      month = 0,
      day = 0,
      hour = 0,
      dow = 0;
    for (const p of parts) {
      if (p.type === "year") year = parseInt(p.value, 10);
      else if (p.type === "month") month = parseInt(p.value, 10);
      else if (p.type === "day") day = parseInt(p.value, 10);
      else if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
      else if (p.type === "weekday") dow = DOW_MAP[p.value] ?? 0;
    }
    return { year, month, day, hour, dow, monthKey: `${year}-${String(month).padStart(2, "0")}` };
  } catch {
    // Unknown tz string — fall back to server-local interpretation (disclosed by callers).
    const d = new Date(tsMs);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      dow: d.getDay(),
      monthKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    };
  }
}
export const DEFAULT_TZ = "America/Phoenix";

/* ---------- Commodity abstraction: (flow, peak_rate_of_flow) ---------- */
export type Commodity = "electric" | "gas" | "water";
export const COMMODITY_UNITS: Record<
  Commodity,
  { usageUnit: string; demandUnit: string; kBtuPerUnit: number }
> = {
  electric: { usageUnit: "kWh", demandUnit: "kW", kBtuPerUnit: 3.412 },
  gas: { usageUnit: "therms", demandUnit: "therms/hr", kBtuPerUnit: 100 },
  water: { usageUnit: "gal", demandUnit: "gpm", kBtuPerUnit: 0 },
};

/* ---------- Disaggregation honesty gating ---------- */
export type DisaggregationMethod =
  | "archetype_prior_only"
  | "regression_split"
  | "nilmtk_1min_plus";

export const DISAGG_LANGUAGE: Record<
  DisaggregationMethod,
  { label: string; disclaimer: string }
> = {
  archetype_prior_only: {
    label: "Statistical prior (peer archetype)",
    disclaimer:
      "End-use breakdown is a statistical prior from peer-building archetypes — not measured for this building. Shown as ranges, never point claims.",
  },
  regression_split: {
    label: "Regression split (weather + baseload)",
    disclaimer:
      "End-use breakdown estimated by balance-point regression of your interval data reconciled with peer archetypes. At 15-minute resolution, appliance-level detection is not possible — values are ranges, not measurements.",
  },
  nilmtk_1min_plus: {
    label: "High-resolution disaggregation (≥1-min data)",
    disclaimer:
      "Appliance-level disaggregation from high-resolution (sub-minute) interval data. Values remain modeled estimates.",
  },
};

/* ---------- Tariff structure JSON ---------- */
export interface TouPeriod {
  label: string;
  months: number[]; // 1-12
  daysOfWeek: number[]; // 0 (Sun) - 6 (Sat)
  hourStart: number; // 0-23 inclusive
  hourEnd: number; // exclusive, e.g. 20 = until 8pm
  ratePerUnit: number; // $/kWh
}

export interface DemandCharge {
  label: string;
  months: number[];
  /** window restriction; null = anytime peak */
  hourStart?: number;
  hourEnd?: number;
  daysOfWeek?: number[];
  ratePerKw: number;
}

export interface RatchetClause {
  lookbackMonths: number;
  ratchetPct: number; // 0.9 = 90%
  applicablePeriod: "all" | "summer";
}

export interface CpCharge {
  /** default N=4, overridable per tariff */
  topN: number;
  peakSeasonMonths: number[];
  /** $/kW-MONTH applied to the CP-average billing determinant (ERCOT 4CP pattern). */
  ratePerKw: number;
  /** number of billing months the CP determinant is charged (default 12) */
  chargeMonths?: number;
}

export interface ExportRateStructure {
  type: "net_metering_retail" | "net_billing_avoided_cost" | "fixed_buyback" | "zero";
  ratePerKwh: number;
  notes?: string;
}

export interface TariffStructure {
  fixedMonthly: number;
  energy: TouPeriod[];
  demand: DemandCharge[];
  ratchet?: RatchetClause;
  cp?: CpCharge;
  exportRate?: ExportRateStructure;
  minBill?: number;
}

/* ---------- Analysis result shapes ---------- */
export interface CostBreakdown {
  energy: number;
  demand: number;
  fixed: number;
  cp: number | null; // null = omitted (no interval data)
  cpMethodology: "cp_proxy_top_n_customer_peaks" | "cp_omitted_no_interval_data";
  cpTopNApplied?: number;
  total: number;
}

export interface MonthlyDemandDetail {
  month: string; // YYYY-MM
  actualPeakKw: number;
  billedDemandKw: number; // post-ratchet
  ratchetApplied: boolean;
  peakTimestamp: number;
}

export interface TariffComparison {
  tariffId: number;
  tariffName: string;
  utilityName: string;
  freshness: string;
  /** True when this rate was used as the current-cost basis for savings math. */
  isCurrentBasis?: boolean;
  eligible: boolean;
  ineligibleReason?: string;
  annualCost: CostBreakdown;
  savingsVsCurrent: number;
  /** Cycle 6: discloses which eligibility predicates were checked vs unverifiable */
  eligibilityNote?: string;
}

export interface ScenarioResultPerCommodity {
  deltaUsage: number;
  deltaDemandKw: number;
  deltaCost: number;
  deltaCo2eLb: number;
}

export interface ScenarioResults {
  perCommodity: Partial<Record<Commodity, ScenarioResultPerCommodity>>;
  siteTotalDeltaCost: number;
  siteTotalDeltaCo2eLb: number;
  paybackYears: number | null;
  paybackBand: string | null;
  confidence: "low" | "medium" | "high";
  confidenceLabel: string;
  disclosures: string[];
  assumptions: Record<string, unknown>;
  extrapolated: boolean;
  dispatchMethod?: "sequential" | "co_optimized";
  baselineAnnualCost?: number;
  scenarioAnnualCost?: number;
}

/* ---------- Interval point used across engines ---------- */
export interface IntervalPoint {
  ts: number; // UTC ms interval start
  durationMin: number;
  usage: number;
  demand: number | null;
}

/* ---------- Battery physics floor (Cycle 5) ---------- */
export const BATTERY_DEFAULTS = {
  roundTripEfficiency: 0.9,
  maxDepthOfDischarge: 0.9,
  cRate: 0.5,
  degradationModeled: false,
} as const;

export const SOLAR_DEFAULTS = {
  azimuthDeg: 180,
  tiltPolicy: "latitude" as const,
  systemLossFraction: 0.14,
  dcAcRatio: 1.2,
  shadingModeled: false,
} as const;

export const SOLAR_DISCLOSURE =
  "Solar estimate uses climate-zone typical-year irradiance with default assumptions (south-facing, tilt = latitude, standard losses, no site shading). Actual production varies materially (±20–40%) with roof orientation, shading, and equipment. Verify export compensation with your utility." as const;

export const BATTERY_DISCLOSURE =
  "Battery estimate applies simplified dispatch with 90% round-trip efficiency, 90% usable depth-of-discharge, 0.5C rate limit, and no degradation modeling — simplified dispatch overstates long-run savings." as const;

export const SEQUENTIAL_DISPATCH_DISCLOSURE =
  "Solar and battery are modeled sequentially (solar first, battery on residual load), not co-optimized; co-optimized results may differ by 10–20%." as const;

/* ---------- Climate-zone inference (Cycle 5 pass 146; shared in Cycle 9 pass 505) ----------
 * Coarse IECC zone from ZIP prefix / state. Moved here so pipeline, routers,
 * and scenario code all share the SAME fallback instead of a hardcoded
 * hot-arid "2B" default. Dominant-population zone per state; ZIP-prefix
 * refinements for known intra-state variation (AZ elevations). */
export function inferClimateZone(zip?: string, state?: string): string {
  const z3 = zip?.slice(0, 3);
  if (z3) {
    if (["850", "851", "852", "853", "855", "863", "864", "865"].includes(z3)) return "2B"; // Phoenix/Havasu/Kingman
    if (["856", "857"].includes(z3)) return "2B"; // Tucson
    if (["859", "860"].includes(z3)) return "5B"; // Flagstaff / high country
  }
  const STATE_ZONE: Record<string, string> = {
    AL: "3A", AK: "7", AZ: "2B", AR: "3A", CA: "3B", CO: "5B", CT: "5A", DE: "4A",
    DC: "4A", FL: "2A", GA: "3A", HI: "1A", ID: "5B", IL: "5A", IN: "5A", IA: "5A",
    KS: "4A", KY: "4A", LA: "2A", ME: "6A", MD: "4A", MA: "5A", MI: "5A", MN: "6A",
    MS: "3A", MO: "4A", MT: "6B", NE: "5A", NV: "3B", NH: "6A", NJ: "4A", NM: "4B",
    NY: "5A", NC: "3A", ND: "7", OH: "5A", OK: "3A", OR: "4C", PA: "5A", RI: "5A",
    SC: "3A", SD: "6A", TN: "4A", TX: "2A", UT: "5B", VT: "6A", VA: "4A", WA: "4C",
    WV: "5A", WI: "6A", WY: "6B",
  };
  if (state && STATE_ZONE[state.toUpperCase()]) return STATE_ZONE[state.toUpperCase()];
  return "4A"; // US-median fallback (mixed-humid), disclosed as inferred
}
