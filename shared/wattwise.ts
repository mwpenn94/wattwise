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
  /**
   * Charges sharing a demandGroup are alternative windows of ONE billed demand
   * determinant (e.g., SRP E-36 winter 5-9am + 5-9pm): the engine bills
   * max(kW across the group's windows) x ratePerKw ONCE, not once per window.
   */
  demandGroup?: string;
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
  /** Batch-41 (pass 1769): `no_cp_charges` — the tariff has no CP component;
   * nothing was "omitted". Placeholder breakdowns for uncosted (ineligible)
   * rows must not claim a CP omission the structure never had. */
  cpMethodology: "cp_proxy_top_n_customer_peaks" | "cp_omitted_no_interval_data" | "no_cp_charges";
  cpTopNApplied?: number;
  /** Batch-40 (pass 1742): uplift added by a tariff minimum-bill floor, kept
   * separate so energy/demand/fixed reflect actual metered charges and
   * Σ(components) − export ≡ total holds. 0 when no floor triggered. */
  minBillAdjustment?: number;
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
  /** Annual savings vs the current-cost baseline. NULL when no current-cost
   * basis exists (Batch-38, pass 1559) — the previous 0 sentinel was
   * indistinguishable from a genuine $0 delta for raw API/export consumers. */
  savingsVsCurrent: number | null;
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
  // Batch-26 (pass 913): the simulation's starting state of charge is now a
  // declared default rather than a hardcoded literal inside dispatchBattery.
  // 0.5 (mid-charge) is the neutral steady-state assumption for a daily-cycling
  // dispatch simulation — starting empty (0.2) would understate day-1 dispatch
  // and starting full would overstate it; mid-charge minimizes warm-up bias.
  initialSoC: 0.5,
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

/* ---------- Progressive participation: quick-start intake (Jul 2026) ----------
 * A user may begin with NOTHING but a free-text address (or a bill photo).
 * parseQuickAddress extracts what it honestly can (2-letter state, 5-digit ZIP,
 * city guess) from free text with zero external geocoding calls, and
 * QUICK_START_DEFAULTS supplies disclosed placeholder attributes so the
 * archetype pipeline can produce an immediate quick-win analysis. Every
 * defaulted field is enumerated in the returned assumption list so the UI and
 * insights can disclose exactly what was assumed and what refining it unlocks.
 * Multi-step forms remain available but are strictly optional refinements. */

const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
]);

export interface QuickAddressParse {
  /** Original free text, trimmed. */
  raw: string;
  state: string | null;
  zip: string | null;
  /** Best-effort city guess (token before ", ST" pattern), may be null. */
  city: string | null;
}

export function parseQuickAddress(freeText: string): QuickAddressParse {
  const raw = freeText.trim().replace(/\s+/g, " ");
  // ZIP: last 5-digit (optionally ZIP+4) group in the string.
  const zipMatches = raw.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  const zip = zipMatches ? zipMatches[1] : null;
  // State: 2-letter token that is a real USPS code, preferring the one
  // immediately before the ZIP, else the last standalone match.
  let state: string | null = null;
  const tokenRe = /\b([A-Za-z]{2})\b/g;
  let m: RegExpExecArray | null;
  const candidates: Array<{ code: string; index: number }> = [];
  while ((m = tokenRe.exec(raw)) !== null) {
    const code = m[1].toUpperCase();
    if (US_STATE_CODES.has(code)) candidates.push({ code, index: m.index });
  }
  if (candidates.length > 0) {
    if (zip != null) {
      const zipIdx = raw.indexOf(zip);
      const before = candidates.filter((c) => c.index < zipIdx);
      state = (before.length > 0 ? before[before.length - 1] : candidates[candidates.length - 1]).code;
    } else {
      state = candidates[candidates.length - 1].code;
    }
  }
  // City guess: the comma-separated segment right before the state token.
  let city: string | null = null;
  if (state) {
    const cityRe = new RegExp(`([A-Za-z .'-]{2,40}),?\\s+${state}\\b`, "i");
    const cm = raw.match(cityRe);
    if (cm) {
      const seg = cm[1].split(",").pop()?.trim() ?? "";
      // discard segments that look like street lines (start with a number)
      if (seg && !/^\d/.test(seg)) city = seg;
    }
  }
  return { raw, state, zip, city };
}

/** Disclosed placeholder attributes used ONLY for the quick-start first pass. */
export const QUICK_START_DEFAULTS = {
  buildingType: "office",
  sqft: 10_000,
  vintage: 2000,
} as const;

export interface QuickStartAssumption {
  field: string;
  assumed: string;
  /** What providing the real value unlocks — surfaced on "add detail" chips. */
  unlocks: string;
}

/** Build the honest assumption list for a quick-start site given what the
 *  address parse actually recovered. */
export function quickStartAssumptions(parse: QuickAddressParse): QuickStartAssumption[] {
  const a: QuickStartAssumption[] = [
    {
      field: "buildingType",
      assumed: `${QUICK_START_DEFAULTS.buildingType} (placeholder)`,
      unlocks: "Correct building type re-selects the peer archetype load shape and the EUI benchmark peer group.",
    },
    {
      field: "sqft",
      assumed: `${QUICK_START_DEFAULTS.sqft.toLocaleString()} sqft (placeholder)`,
      unlocks: "Real floor area scales the synthetic baseline and makes the EUI benchmark percentile meaningful.",
    },
    {
      field: "vintage",
      assumed: `built ~${QUICK_START_DEFAULTS.vintage} (placeholder)`,
      unlocks: "Actual vintage picks the correct archetype efficiency band.",
    },
    {
      field: "intervalData",
      assumed: "none — synthetic archetype profile in use",
      unlocks: "Uploading an interval file replaces every synthetic figure with measured demand analytics, real tariff re-pricing, and anomaly detection.",
    },
  ];
  if (!parse.state) {
    a.unshift({
      field: "state",
      assumed: "unknown — US-median climate assumptions applied",
      unlocks: "A state (or full address) selects your climate zone, timezone, and the tariffs swept for the rate check.",
    });
  }
  if (!parse.zip) {
    a.push({
      field: "zip",
      assumed: parse.state ? `state-level climate/emissions defaults for ${parse.state}` : "US-median climate + emissions defaults",
      unlocks: "A ZIP refines the climate zone and selects the correct eGRID emissions subregion.",
    });
  }
  return a;
}
