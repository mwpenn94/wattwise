/**
 * Scenario engine (handoff §5 step 7, Cycle 5 physics floor) + opportunity
 * ranking + benchmarking + emissions.
 * Solar: climate-zone irradiance × defaults; Battery: SoC dispatch with RTE,
 * DoD, C-rate; sequential (solar→battery) with disclosure; efficiency: end-use
 * scaled reductions; EV/load-growth: shaped additions.
 */
import {
  BATTERY_DEFAULTS,
  BATTERY_DISCLOSURE,
  IntervalPoint,
  LABEL_NORMAL_YEAR,
  ScenarioResults,
  SEQUENTIAL_DISPATCH_DISCLOSURE,
  SOLAR_DEFAULTS,
  SOLAR_DISCLOSURE,
  TariffStructure,
} from "../../shared/wattwise";
import { costOnTariff } from "./tariffEngine";

/* ---------------- solar production model ---------------- */
/** kWh/kW-yr by climate zone (NREL PVWatts typical, fixed tilt=lat) */
const SOLAR_YIELD_BY_ZONE: Record<string, number> = {
  "1A": 1450, "2A": 1500, "2B": 1750, "3A": 1450, "3B": 1700, "3C": 1600,
  "4A": 1350, "4B": 1600, "4C": 1250, "5A": 1300, "5B": 1550, "6A": 1250,
  "6B": 1450, "7": 1200, "8": 1000,
};

/** Hourly solar shape: daylight sinusoid by hour, seasonal amplitude. */
function solarHourlyShape(hourOfYear: number): number {
  const day = Math.floor(hourOfYear / 24);
  const hour = hourOfYear % 24;
  // seasonal factor peaks at summer solstice (~day 172)
  const seasonal = 0.75 + 0.25 * Math.cos(((day - 172) / 365) * 2 * Math.PI);
  // daylight window ~ 6..18 solar time
  if (hour < 6 || hour > 18) return 0;
  const x = (hour - 6) / 12; // 0..1
  return Math.sin(Math.PI * x) * seasonal;
}

/** True when the climate zone has a mapped PVWatts-typical yield. */
export function solarZoneMapped(climateZone: string): boolean {
  return SOLAR_YIELD_BY_ZONE[climateZone] != null;
}

export function solarProduction8760(kwDc: number, climateZone: string): number[] {
  // SOLAR_YIELD_BY_ZONE values are NREL PVWatts *typical net* kWh/kW-yr —
  // they already include standard system losses (~14%: soiling, wiring,
  // inverter, availability). Callers must NOT derate kwDc again
  // (deliverable convergence cycle 5: double-loss finding, 8 passes).
  const annualYield = (SOLAR_YIELD_BY_ZONE[climateZone] ?? 1500) * kwDc;
  const raw: number[] = new Array(8760);
  let sum = 0;
  for (let h = 0; h < 8760; h++) {
    raw[h] = solarHourlyShape(h);
    sum += raw[h];
  }
  const scale = annualYield / sum;
  return raw.map((v) => v * scale);
}

/* ---------------- battery dispatch (physics floor) ---------------- */
export interface BatterySpec {
  kwh: number;
  kw: number; // inverter limit
}

/**
 * Simple TOU/peak-shaving dispatch: charge in cheapest hours (or from solar
 * surplus), discharge during the highest-rate/peak hours. Enforces RTE, DoD,
 * C-rate. Hourly resolution.
 */
export function dispatchBattery(
  load: number[], // hourly kWh (post-solar residual; may be negative = surplus)
  spec: BatterySpec,
  hourlyRate: number[], // $/kWh rate signal for arbitrage
): { residual: number[]; cycled: number } {
  const usable = spec.kwh * BATTERY_DEFAULTS.maxDepthOfDischarge;
  const maxRate = Math.min(spec.kw, spec.kwh * BATTERY_DEFAULTS.cRate);
  const rte = BATTERY_DEFAULTS.roundTripEfficiency;
  const residual = [...load];
  let soc = usable * 0.5;
  let cycled = 0;

  // Rate thresholds: charge below 30th percentile, discharge above 80th
  const sortedRates = [...hourlyRate].sort((a, b) => a - b);
  const chargeThresh = sortedRates[Math.floor(sortedRates.length * 0.3)];
  const dischargeThresh = sortedRates[Math.floor(sortedRates.length * 0.8)];

  for (let h = 0; h < residual.length; h++) {
    const rate = hourlyRate[h] ?? 0;
    // RTE model (deliverable convergence cycle 1, passes 3/9/19): full
    // round-trip losses are taken on the charge leg — energy stored in SoC is
    // input kWh × rte; discharge delivers SoC kWh 1:1. Total delivered energy
    // over a full cycle = input × rte, matching the round-trip definition.
    if (residual[h] < 0 && soc < usable) {
      // absorb solar surplus first
      const room = usable - soc;
      const charge = Math.min(-residual[h], maxRate, room / rte);
      soc += charge * rte;
      residual[h] += charge;
    } else if (rate <= chargeThresh && soc < usable) {
      const room = usable - soc;
      const charge = Math.min(maxRate, room / rte);
      soc += charge * rte;
      residual[h] += charge; // grid charging adds load
    } else if (rate >= dischargeThresh && soc > 0 && residual[h] > 0) {
      const discharge = Math.min(residual[h], maxRate, soc);
      soc -= discharge;
      residual[h] -= discharge;
      cycled += discharge;
    }
  }
  return { residual, cycled };
}

/* ---------------- hourly rate signal from tariff ---------------- */
/**
 * Day-of-week convention (passes 459/473 adjudication): the platform-wide
 * contract is JS convention 0=Sun..6=Sat — declared on TariffStructure
 * (`daysOfWeek: number[]; // 0 (Sun) - 6 (Sat)` in shared/wattwise.ts), used by
 * DOW_MAP in localParts, and populated by the seeders (WEEKDAYS=[1..5],
 * ALL_DAYS=[0..6]). `d.getDay()` therefore matches the stored arrays directly;
 * NO ISO (1=Mon..7=Sun) remap may be introduced here or in tariffEngine —
 * doing so would break Sunday/Saturday matching everywhere.
 * Overnight windows (hourStart > hourEnd, e.g. 22→02) wrap midnight — same
 * rule as tariffEngine's pass-442 fix.
 */
function inHourWindow(hour: number, hourStart: number, hourEnd: number): boolean {
  if (hourStart <= hourEnd) return hour >= hourStart && hour < hourEnd;
  return hour >= hourStart || hour < hourEnd; // overnight wrap
}
/** Widest-coverage energy period rate — same hierarchical rule as touRate's
 * fallback (months dominate, then days, then hour span). Cycle 10 (pass 553):
 * the old `last array entry` fallback priced unmatched hours at an arbitrary
 * period — often the peak rate — biasing dispatch. */
function widestCoverageRate(structure: TariffStructure): number {
  let widest: { rate: number; key: [number, number, number] } | null = null;
  for (const p of structure.energy) {
    const span = (p.hourEnd - p.hourStart + 24) % 24 || 24;
    const key: [number, number, number] = [p.months.length, p.daysOfWeek.length, span];
    const wins =
      !widest ||
      key[0] > widest.key[0] ||
      (key[0] === widest.key[0] && key[1] > widest.key[1]) ||
      (key[0] === widest.key[0] && key[1] === widest.key[1] && key[2] > widest.key[2]);
    if (wins) widest = { rate: p.ratePerUnit, key };
  }
  return widest ? widest.rate : 0;
}

export function hourlyRateSignal(structure: TariffStructure, refYear = 2025): number[] {
  const out: number[] = new Array(8760);
  const start = new Date(refYear, 0, 1).getTime();
  const fallbackRate = widestCoverageRate(structure);
  for (let h = 0; h < 8760; h++) {
    const ts = start + h * 3600_000;
    const d = new Date(ts);
    let rate = 0;
    for (const p of structure.energy) {
      if (!p.months.includes(d.getMonth() + 1)) continue;
      if (!p.daysOfWeek.includes(d.getDay())) continue;
      if (inHourWindow(d.getHours(), p.hourStart, p.hourEnd)) {
        rate = p.ratePerUnit;
        break;
      }
    }
    if (rate === 0 && structure.energy.length > 0) rate = fallbackRate;
    // demand-window adder to bias battery toward peak windows
    for (const dc of structure.demand) {
      if (!dc.months.includes(d.getMonth() + 1)) continue;
      if (dc.daysOfWeek && !dc.daysOfWeek.includes(d.getDay())) continue;
      if (dc.hourStart != null && dc.hourEnd != null && inHourWindow(d.getHours(), dc.hourStart, dc.hourEnd)) {
        // Dispatch-signal heuristic only (never used for billing): spread a
        // monthly $/kW demand charge across ~100 window-hours per month
        // (≈ 5 h/day × 21 weekdays) to yield an hourly $/kWh-equivalent adder
        // that biases discharge into demand windows.
        rate += dc.ratePerKw / 100;
      }
    }
    out[h] = rate;
  }
  return out;
}

/* ---------------- hourly → IntervalPoint helpers ---------------- */
export function hourlyToPoints(hourly: number[], refYear = 2025): IntervalPoint[] {
  const start = new Date(refYear, 0, 1).getTime();
  return hourly.map((usage, h) => ({
    ts: start + h * 3600_000,
    durationMin: 60,
    usage,
    demand: usage, // 1-hour intervals: kW == kWh/h
  }));
}

/* ---------------- scenario runner ---------------- */
export interface ScenarioInput {
  kind: "solar" | "battery" | "solar_battery" | "efficiency" | "ev_load" | "tariff_switch";
  solarKwDc?: number;
  batteryKwh?: number;
  batteryKw?: number;
  /** efficiency: fraction reduction per end use, e.g. {cooling: 0.2} */
  efficiencyReductions?: Record<string, number>;
  endUseFractions?: Record<string, number>;
  /** EV: annual kWh added, charged overnight */
  evAnnualKwh?: number;
  capexUsd?: number;
}

export function runScenario(
  baselineHourly: number[],
  input: ScenarioInput,
  structure: TariffStructure,
  climateZone: string,
  co2eLbPerMwh: number,
  baselineConfidence: "low" | "medium" | "high",
  extrapolated: boolean,
): ScenarioResults {
  const disclosures: string[] = [`Modeled on ${LABEL_NORMAL_YEAR} hourly profile.`];
  let hourly = [...baselineHourly];
  let dispatchMethod: "sequential" | "co_optimized" | undefined;

  if (input.kind === "efficiency" && input.efficiencyReductions && input.endUseFractions) {
    let totalReduction = 0;
    for (const [endUse, frac] of Object.entries(input.efficiencyReductions)) {
      const share = input.endUseFractions[endUse] ?? 0;
      totalReduction += share * frac;
    }
    hourly = hourly.map((v) => v * (1 - totalReduction));
    disclosures.push(
      "Efficiency savings scale the affected end-use share of load uniformly — actual measure performance varies with equipment, controls, and operations.",
    );
  }

  if (input.kind === "ev_load" && input.evAnnualKwh) {
    const perNightHours = 6; // 22:00–04:00
    const nightlyKwh = input.evAnnualKwh / 365 / perNightHours;
    for (let h = 0; h < hourly.length; h++) {
      const hod = h % 24;
      if (hod >= 22 || hod < 4) hourly[h] += nightlyKwh;
    }
    disclosures.push("EV charging modeled as uniform overnight (10pm–4am) load — managed charging schedules can shift this.");
  }

  if ((input.kind === "solar" || input.kind === "solar_battery") && input.solarKwDc) {
    // Pass nameplate kW DC directly: zone yields are PVWatts-typical *net of
    // system losses* — applying systemLossFraction here would double-count
    // losses and understate production (convergence cycle-5 fix).
    const prod = solarProduction8760(input.solarKwDc, climateZone);
    hourly = hourly.map((v, h) => v - prod[h]); // may go negative = export
    disclosures.push(SOLAR_DISCLOSURE);
    disclosures.push(
      `Solar yield basis: PVWatts-typical net annual yield for climate zone ${climateZone} (system losses ~${Math.round(SOLAR_DEFAULTS.systemLossFraction * 100)}% already included in the zone yield).`,
    );
    if (!solarZoneMapped(climateZone)) {
      disclosures.push(
        `Climate zone "${climateZone}" has no mapped solar-yield entry — a generic 1,500 kWh/kW-yr default was used; treat solar production as low confidence.`,
      );
    }
  }

  if ((input.kind === "battery" || input.kind === "solar_battery") && input.batteryKwh) {
    const rateSignal = hourlyRateSignal(structure);
    const { residual } = dispatchBattery(hourly, { kwh: input.batteryKwh, kw: input.batteryKw ?? input.batteryKwh * BATTERY_DEFAULTS.cRate }, rateSignal);
    hourly = residual;
    disclosures.push(BATTERY_DISCLOSURE);
    if (input.kind === "solar_battery") {
      dispatchMethod = "sequential";
      disclosures.push(SEQUENTIAL_DISPATCH_DISCLOSURE);
    }
  }

  const basePoints = hourlyToPoints(baselineHourly);
  const scenPoints = hourlyToPoints(hourly);
  const baseCost = costOnTariff(basePoints, structure);
  const scenCost = costOnTariff(scenPoints, structure);
  disclosures.push(...scenCost.disclosures.filter((d) => !baseCost.disclosures.includes(d)));

  const baseUsage = baselineHourly.reduce((a, b) => a + b, 0);
  const scenUsageNet = hourly.reduce((a, b) => a + b, 0);
  const deltaUsage = scenUsageNet - baseUsage; // negative = reduction
  const deltaCost = scenCost.breakdown.total - baseCost.breakdown.total; // negative = savings
  // emissions: grid CO2e on net consumption (exports credited at grid average — disclosed)
  const deltaCo2eLb = (deltaUsage / 1000) * co2eLbPerMwh;
  // Cycle 6 (pass 313): the annual-average limitation applies regardless of the
  // delta's sign — increased consumption may coincide with high-marginal-intensity
  // peaker dispatch just as decreases may — so the disclosure is unconditional.
  disclosures.push("Emissions deltas use annual-average grid intensity (eGRID subregion) — marginal/hourly intensity differs.");

  // Guard: Math.max(...[]) === -Infinity; empty series must yield 0 peak (pass-441).
  const basePeak = baselineHourly.length > 0 ? Math.max(...baselineHourly) : 0;
  const scenPeak = hourly.length > 0 ? Math.max(...hourly) : 0;

  let paybackYears: number | null = null;
  let paybackBand: string | null = null;
  // Cycle 10 (pass 553): negligible savings (< $1/yr) produce astronomically
  // long, meaningless payback figures — suppress the payback rather than show
  // a 50,000-year number.
  if (input.capexUsd && deltaCost < -1) {
    paybackYears = input.capexUsd / -deltaCost;
    const lo = paybackYears * 0.75;
    const hi = paybackYears * 1.5;
    paybackBand = `${lo.toFixed(1)}–${hi.toFixed(1)} years`;
    disclosures.push("Payback shown as a range reflecting modeling uncertainty — the band spans 75% to 150% of the point estimate; excludes incentives, financing, degradation, and rate escalation.");
  }

  const confidence = extrapolated ? "low" : baselineConfidence === "high" ? "medium" : "low";
  return {
    perCommodity: {
      electric: { deltaUsage, deltaDemandKw: scenPeak - basePeak, deltaCost, deltaCo2eLb },
    },
    siteTotalDeltaCost: deltaCost,
    siteTotalDeltaCo2eLb: deltaCo2eLb,
    paybackYears,
    paybackBand,
    confidence,
    confidenceLabel: `${confidence} confidence — scenario deltas inherit baseline uncertainty${extrapolated ? " (extrapolated baseline)" : ""}`,
    disclosures,
    assumptions: {
      solar: input.solarKwDc ? { ...SOLAR_DEFAULTS, kwDc: input.solarKwDc } : undefined,
      battery: input.batteryKwh ? { ...BATTERY_DEFAULTS, kwh: input.batteryKwh, kw: input.batteryKw } : undefined,
      efficiency: input.efficiencyReductions,
      ev: input.evAnnualKwh,
      capexUsd: input.capexUsd,
    },
    extrapolated,
    dispatchMethod,
    baselineAnnualCost: baseCost.breakdown.total,
    scenarioAnnualCost: scenCost.breakdown.total,
  };
}

/* ---------------- opportunity ranking ---------------- */
export interface OpportunityCandidate {
  key: string;
  title: string;
  category: string;
  annualSavingsUsdLo: number;
  annualSavingsUsdHi: number;
  capexBand: "none" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  rationale: string;
  disclosures: string[];
}

export function rankOpportunities(cands: OpportunityCandidate[]): OpportunityCandidate[] {
  const capexWeight: Record<string, number> = { none: 1.0, low: 0.85, medium: 0.6, high: 0.4 };
  const confWeight: Record<string, number> = { high: 1.0, medium: 0.7, low: 0.4 };
  return [...cands].sort((a, b) => {
    const evA = ((a.annualSavingsUsdLo + a.annualSavingsUsdHi) / 2) * capexWeight[a.capexBand] * confWeight[a.confidence];
    const evB = ((b.annualSavingsUsdLo + b.annualSavingsUsdHi) / 2) * capexWeight[b.capexBand] * confWeight[b.confidence];
    return evB - evA;
  });
}

/* ---------------- benchmarking ---------------- */
export function benchmarkPercentile(
  siteEui: number,
  bench: { medianEui: number; p25Eui: number | null; p75Eui: number | null },
): { percentileBand: string; betterThanMedian: boolean } {
  const { medianEui, p25Eui, p75Eui } = bench;
  // NOTE (EUI convention): lower EUI = more efficient. p25/p75 here are the
  // 25th/75th percentiles of the *consumption* distribution.
  if (p25Eui != null && siteEui <= p25Eui) return { percentileBand: "Top quartile (lowest 25% of energy use)", betterThanMedian: true };
  if (siteEui <= medianEui) return { percentileBand: "Second quartile (below-median energy use)", betterThanMedian: true };
  if (p75Eui != null && siteEui <= p75Eui) return { percentileBand: "Third quartile (above-median energy use)", betterThanMedian: false };
  return { percentileBand: "Bottom quartile (highest 25% of energy use)", betterThanMedian: false };
}
