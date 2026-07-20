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
  DEFAULT_TZ,
  IntervalPoint,
  LABEL_NORMAL_YEAR,
  localParts,
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

/** Batch-29 (pass 1019): single named constant for the unmapped-zone fallback
 * yield — the computation and the user-facing disclosure MUST cite the same
 * number (a reviewer caught the disclosure text drifting from the literal). */
export const SOLAR_FALLBACK_YIELD_KWH_PER_KW = 1500;

/** True when the climate zone has a mapped PVWatts-typical yield. */
/** Batch-37 (pass 1493): zone keys are uppercase ("2B", "4A") but site
 * climateZone is free-text user input (siteInput allows any ≤16-char string) —
 * a lowercase "4a" must match its zone, not silently fall to the generic
 * fallback yield while the disclosure names the zone as if it were mapped. */
function normZone(climateZone: string): string {
  return climateZone.trim().toUpperCase();
}
export function solarZoneMapped(climateZone: string): boolean {
  return SOLAR_YIELD_BY_ZONE[normZone(climateZone)] != null;
}

export function solarProduction8760(kwDc: number, climateZone: string): number[] {
  // SOLAR_YIELD_BY_ZONE values are NREL PVWatts *typical net* kWh/kW-yr —
  // they already include standard system losses (~14%: soiling, wiring,
  // inverter, availability). Callers must NOT derate kwDc again
  // (deliverable convergence cycle 5: double-loss finding, 8 passes).
  // Batch-37 (pass 1493): case/whitespace-normalized lookup — keeps the yield
  // and the solarZoneMapped disclosure consistent for any input casing.
  const annualYield = (SOLAR_YIELD_BY_ZONE[normZone(climateZone)] ?? SOLAR_FALLBACK_YIELD_KWH_PER_KW) * kwDc;
  const raw: number[] = new Array(8760);
  let sum = 0;
  for (let h = 0; h < 8760; h++) {
    raw[h] = solarHourlyShape(h);
    sum += raw[h];
  }
  // Batch-51 (pass 2633): defensive divide-by-zero guard. If the hourly shape
  // summed to 0 (unreachable with the current daylight window, but this is the
  // single point where a shape regression would turn into 8760 NaN/Infinity
  // values poisoning every downstream cost figure), return an all-zero
  // production profile instead of scaling by annualYield/0.
  if (!(sum > 0)) return new Array(8760).fill(0);
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
  // Batch-42 (pass 1823): the demand-setpoint proxy must track the ORIGINAL
  // (pre-solar) baseline load. When `load` is a post-solar residual, solar
  // suppresses daytime values, so a residual-driven peakSoFar could sit far
  // below the real billed baseline peak — grid-charging capped at that
  // deflated setpoint could still create a metered import peak HIGHER than
  // anything in the residual history yet the comparison the customer cares
  // about is vs their original bill. Callers with a solar step pass the
  // pre-solar baseline here; battery-only callers omit it (load IS original).
  originalLoad?: number[],
): { residual: number[]; cycled: number } {
  const usable = spec.kwh * BATTERY_DEFAULTS.maxDepthOfDischarge;
  const maxRate = Math.min(spec.kw, spec.kwh * BATTERY_DEFAULTS.cRate);
  const rte = BATTERY_DEFAULTS.roundTripEfficiency;
  const residual = [...load];
  // Batch-26 (pass 913): declared default, not a hardcoded literal.
  let soc = usable * BATTERY_DEFAULTS.initialSoC;
  let cycled = 0;

  // Rate thresholds — Batch-39 (pass 1660): derived from distinct rate LEVELS,
  // not percentile positions. The old 30th/80th-percentile approach silently
  // disabled dispatch on realistic TOU tariffs: a summer-weekday-afternoon
  // on-peak window covers only ~5% of the year's hours, so BOTH percentiles
  // landed on the off-peak rate, the flat-signal guard tripped, and a battery
  // facing an obvious 0.07/0.22 arbitrage spread sat idle all year (the
  // strengthened battery vitest exposed this: zero kWh moved, $0 delta).
  // Level-based thresholds are position-free: charge at the CHEAPEST distinct
  // level, discharge at the MOST EXPENSIVE, regardless of how few hours the
  // peak window spans. Batch-21 (pass 563) NaN filtering retained. Batch-27
  // (pass 929) flat-signal semantics retained: a single distinct level means
  // no spread to arbitrage — rate-driven dispatch stays disabled (±Infinity)
  // and only solar-surplus absorption operates.
  const finiteRates = hourlyRate.filter((r) => Number.isFinite(r));
  const levels = Array.from(new Set(finiteRates)).sort((a, b) => a - b);
  let chargeThresh = -Infinity;
  let dischargeThresh = Infinity;
  if (levels.length >= 2) {
    chargeThresh = levels[0];
    dischargeThresh = levels[levels.length - 1];
  }

  // Batch-40 (pass 1743) + Batch-41 (passes 1754/1763/1769): peakSoFar tracks
  // the POSITIVE part of the input profile (billed demand is import-side, so
  // export hours never set a peak). The update is unconditional-monotone. The
  // Batch-40 special case (`: maxRate` when peakSoFar === 0) was itself flagged
  // and is removed. Batch-44 (passes 1893/1923): the Batch-41 "unified" rule
  // headroom = max(0, peakSoFar − residual[h]) CONFLATED two regimes — with a
  // negative residual (export hour) the subtraction inflated headroom ABOVE
  // peakSoFar, so GRID energy (not just surplus) could be drawn until the
  // meter reached peakSoFar even on a site whose import history was far lower,
  // and conversely surplus absorption depended on the grid-charge branch's
  // rate condition. The two concerns are now separate and explicit:
  //   • SURPLUS ABSORPTION (residual < 0): always allowed, capped by the
  //     surplus magnitude itself — import-neutral by construction (residual
  //     can rise at most to 0, never creating an import peak).
  //   • GRID-CHARGING (cheap-rate hours): capped by
  //     max(0, peakSoFar − max(0, residual[h])) — the import-side load only.
  //     Flooring residual at 0 means an export hour offers exactly peakSoFar
  //     of grid headroom (meter swings from export to at most the causal
  //     import peak), and a site with NO import history (peakSoFar = 0) gets
  //     zero grid headroom — it can still absorb its own surplus via the
  //     first branch. Grid-charging resumes once a real import peak exists.
  // Batch-44 (pass 1913) INVARIANT: dispatchBattery is called at most ONCE per
  // runScenario. peakSoFar is re-initialized per call from the causal prefix of
  // originalLoad — if staged/multi-battery dispatch is ever introduced, callers
  // MUST pass the same immutable pre-dispatch originalLoad to every stage so
  // each stage's setpoint proxy reflects the true baseline, not a residual
  // already modified by a previous stage.
  let peakSoFar = 0; // running max of the POSITIVE original load (causal demand-setpoint proxy)
  for (let h = 0; h < residual.length; h++) {
    const rate = hourlyRate[h] ?? 0;
    // Batch-42 (pass 1823): causal max over the PRE-solar original profile
    // when provided — the residual can be solar-suppressed and would
    // understate the site's true demand setpoint.
    // Batch-48 (pass 2203): when originalLoad IS provided it is authoritative.
    // The old `originalLoad?.[h] ?? load[h]` silently fell back to the
    // POST-solar load[h] for any out-of-range index (length mismatch), letting
    // solar-suppressed hours pollute the pre-solar setpoint proxy. Out-of-range
    // now contributes 0 to the monotone max; the load[h] fallback applies only
    // when no originalLoad was passed at all (battery-only dispatch, where
    // load IS the original profile).
    // Batch-50 (pass 2589): NaN-sanitize both branches — Math.max(x, NaN, 0)
    // is NaN, so a single corrupt upstream value would permanently poison
    // peakSoFar from that hour onward and cascade NaN into headroom, dispatch,
    // and the scenario deltas shown to the user. `?? 0` guards only
    // null/undefined, not NaN.
    const setpointSample = originalLoad != null ? originalLoad[h] : load[h];
    peakSoFar = Math.max(peakSoFar, Number.isFinite(setpointSample) ? setpointSample : 0, 0);
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
      // Batch-39 (pass 1660): PEAK-AWARE charge cap. Naive grid-charging at
      // full inverter rate during cheap hours can CREATE a new billing peak
      // (e.g. +50 kW on top of a 120 kW business-hours load in a cheap-rate
      // shoulder month → 170 kW new max), silently trading energy-arbitrage
      // savings for a larger demand charge — the debug trace showed demand
      // +$675/yr eating a third of the energy savings. A real BMS charges
      // below the demand setpoint; model that by capping charge so residual
      // never exceeds the highest load seen so far in the ORIGINAL profile
      // (a conservative, causal proxy for the site's demand setpoint — uses
      // no future information).
      // Import-side headroom only: floor the residual at 0 so export depth
      // can never inflate grid-charge headroom above the causal import peak.
      const headroom = Math.max(0, peakSoFar - Math.max(0, residual[h]));
      const room = usable - soc;
      const charge = Math.min(maxRate, room / rte, headroom);
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
      (key[0] === widest.key[0] && key[1] === widest.key[1] && key[2] > widest.key[2]) ||
      // Batch-47 (passes 2133/2143): ties on the full coverage key resolve to
      // the LOWEST rate — the same deterministic, customer-favorable policy as
      // touRate's widest-coverage fallback (Batch-12 pass 12), so the dispatch
      // signal can never depend on seed array order.
      (key[0] === widest.key[0] && key[1] === widest.key[1] && key[2] === widest.key[2] && p.ratePerUnit < widest.rate);
    if (wins) widest = { rate: p.ratePerUnit, key };
  }
  return widest ? widest.rate : 0;
}

export function hourlyRateSignal(structure: TariffStructure, refYear = 2025, tz: string = DEFAULT_TZ): number[] {
  const out: number[] = new Array(8760);
  const start = new Date(refYear, 0, 1).getTime();
  const fallbackRate = widestCoverageRate(structure);
  for (let h = 0; h < 8760; h++) {
    const ts = start + h * 3600_000;
    // Batch-39 (pass 1660): the dispatch signal MUST evaluate TOU windows in
    // the SAME timezone costOnTariff bills in (localParts/tz), not the server's
    // local clock (`new Date(ts).getHours()`). The old server-local evaluation
    // shifted every on-peak window by the UTC↔tariff-tz offset (7h for the
    // Phoenix default on a UTC server), so the battery discharged into hours
    // that billing priced at OFF-peak — dispatch looked profitable to itself
    // while the bill went UP (the strengthened battery vitest caught the
    // scenario costing +$2.1k/yr instead of saving).
    const lp = localParts(ts, tz);
    const d = { getMonth: () => lp.month - 1, getDay: () => lp.dow, getHours: () => lp.hour };
    // Batch-20 (pass 549): explicit matched flag instead of the `rate === 0`
    // sentinel — a legitimately zero-priced period (e.g. free-nights TOU rider)
    // matched but was then clobbered by the widest-coverage fallback, biasing
    // the dispatch signal upward in exactly the hours a battery should charge.
    // Note the demand-window adder below runs AFTER this block unconditionally,
    // so adders were never dropped on unmatched hours (that half of the review
    // finding was incorrect); only the zero-rate sentinel collision was real.
    let rate = 0;
    let matched = false;
    for (const p of structure.energy) {
      if (!p.months.includes(d.getMonth() + 1)) continue;
      if (!p.daysOfWeek.includes(d.getDay())) continue;
      if (inHourWindow(d.getHours(), p.hourStart, p.hourEnd)) {
        rate = p.ratePerUnit;
        matched = true;
        break;
      }
    }
    // Batch-27 (pass 953): the fallback applies on ANY unmatched hour — the
    // old `energy.length > 0` guard was redundant-but-confusing: with zero
    // energy periods widestCoverageRate returns 0, so applying it is identical
    // to leaving rate at 0. Note an energy-period-free tariff prices energy at
    // $0/kWh by definition of the seeded structure (fixed/demand-only rate);
    // the dispatch signal still carries the demand-window adders below, so
    // "free energy" does not disable peak-shaving dispatch.
    if (!matched) rate = fallbackRate;
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
  /** GAP-T §2.3: NEM banking rules from the tariff row — how export credits
   * bank (kWh vs dollar) and when they expire changes solar economics. */
  nem?: { banking?: string | null; creditExpiry?: string | null },
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
    // Batch-36 (pass 1383): a summed reduction > 1 would flip (1 - totalReduction)
    // NEGATIVE and invert the entire load series — physically nonsensical negative
    // consumption propagating into every cost figure. Seeded archetype fractions
    // sum to 1.0 and the API caps each frac at 0.9, so the aggregate cannot exceed
    // 0.9 today, but end-use fraction sources are data (future archetypes, custom
    // disaggregation) — clamp defensively and DISCLOSE when the clamp engages
    // rather than silently producing an impossible model.
    if (totalReduction > 1) {
      disclosures.push(
        `Requested efficiency reductions summed to ${(totalReduction * 100).toFixed(0)}% of total load — capped at 100% (a building cannot consume negative energy); treat this scenario as a theoretical maximum.`,
      );
      totalReduction = 1;
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
        `Climate zone "${climateZone}" has no mapped solar-yield entry — a generic ${SOLAR_FALLBACK_YIELD_KWH_PER_KW.toLocaleString()} kWh/kW-yr default was used; treat solar production as low confidence.`,
      );
    }
    // GAP-T §2.3 — net-metering banking basis. Export credits are not cash:
    // kWh banking offsets later usage at retail; dollar banking (net billing)
    // credits at an avoided-cost rate below retail; annual true-ups can
    // forfeit chronic overproduction. The economics shown must say which
    // regime they assume.
    if (nem?.banking === "kwh") {
      disclosures.push(
        `Export-credit basis: this rate banks exports as kWh credits (net metering)${nem.creditExpiry ? ` — unused credits ${nem.creditExpiry === "annual" ? "reset at the annual true-up; chronic overproduction is forfeited" : `expire ${nem.creditExpiry}`}` : ""}. Savings assume credits offset later usage at the full retail rate.`,
      );
    } else if (nem?.banking === "dollar") {
      disclosures.push(
        `Export-credit basis: this rate credits exports in dollars at an export rate below retail (net billing)${nem.creditExpiry ? ` — credits ${nem.creditExpiry === "annual" ? "true up annually" : `expire ${nem.creditExpiry}`}` : ""}. Oversizing the array returns less than the retail rate suggests.`,
      );
    } else {
      disclosures.push(
        "Export-credit basis unknown for this rate — savings assume exports offset usage at the modeled export rate. Confirm your utility's net-metering vs net-billing rules; annual true-up forfeiture can reduce first-year value.",
      );
    }
  }

  if ((input.kind === "battery" || input.kind === "solar_battery") && input.batteryKwh) {
    const rateSignal = hourlyRateSignal(structure);
    // Batch-42 (pass 1823): pass the PRE-solar baseline so the demand-setpoint
    // proxy is not solar-suppressed (for battery-only runs hourly === baseline).
    const { residual } = dispatchBattery(hourly, { kwh: input.batteryKwh, kw: input.batteryKw ?? input.batteryKwh * BATTERY_DEFAULTS.cRate }, rateSignal, baselineHourly);
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
  // Batch-60 (pass 3073): do NOT name "eGRID subregion" here — the factor the
  // caller passes may be the US-average fallback (unresolved region), and this
  // layer cannot see which. The neutral wording is true in both cases; the
  // Dashboard emissions KPI discloses region resolution specifically.
  disclosures.push("Emissions deltas use an annual-average grid intensity factor — marginal/hourly intensity differs.");

  // Guard: Math.max(...[]) === -Infinity; empty series must yield 0 peak (pass-441).
  // Batch-50 (pass 2583): IMPORT-side peaks only. After solar subtraction the
  // hourly array can be negative in every hour (export-dominated site); a raw
  // Math.max then returns the least-negative EXPORT value, which is not a
  // billing demand — demand charges bill on import kW, never export depth.
  // Clamp both peaks at 0 so deltaDemandKw compares like with like.
  const basePeak = baselineHourly.length > 0 ? Math.max(0, ...baselineHourly) : 0;
  const scenPeak = hourly.length > 0 ? Math.max(0, ...hourly) : 0;

  let paybackYears: number | null = null;
  let paybackBand: string | null = null;
  // Cycle 10 (pass 553): negligible savings (< $1/yr) produce astronomically
  // long, meaningless payback figures — suppress the payback rather than show
  // a 50,000-year number.
  // Batch-18 (pass 419): a NO-CAPEX scenario with real savings must not read as
  // "no financial benefit" — null payback on a $0-capex change (rate switch,
  // operational baseload trim) misleads in the opposite direction from the
  // 50,000-year problem. Zero upfront cost + positive savings = immediate payback.
  if ((input.capexUsd == null || input.capexUsd === 0) && deltaCost < -1) {
    paybackYears = 0;
    paybackBand = "immediate — no upfront cost";
  }

  // Batch-26 (passes 903/913): a scenario inherits its baseline's confidence,
  // capped at "medium" (a modeled counterfactual is never "high" even on a
  // high-confidence baseline); extrapolation always forces "low". The previous
  // ternary collapsed medium baselines to low with no cause, understating
  // reliability.
  const confidence = extrapolated ? "low" : baselineConfidence === "low" ? "low" : "medium";
  if (paybackYears == null && input.capexUsd && deltaCost < -1) {
    paybackYears = input.capexUsd / -deltaCost;
    // Accuracy pass (owner directive Jul 20, "as accurate/precise/justified as
    // possible"): the band now DERIVES from the scenario's stated confidence
    // tier instead of one fixed 75–150% spread. Tier → savings-uncertainty
    // half-width, anchored to the M&V machinery's own gates (mv.ts applies the
    // ASHRAE G14 CV(RMSE) ≤25% payability gate; proveIt.ts assumes 25% CV when
    // no fit exists; extrapolated/archetype baselines carry more):
    //   medium (best a modeled counterfactual can be) → ±25% savings
    //   low (extrapolated span or archetype baseline)  → -40%/+30% (asymmetric:
    //        savings shortfall is the dominant failure mode on weak baselines).
    // Payback ∝ 1/savings, so the payback band inverts the savings multipliers.
    const spread = confidence === "medium" ? { savLo: 0.75, savHi: 1.25, pct: "±25%" } : { savLo: 0.6, savHi: 1.3, pct: "-40%/+30%" };
    const lo = paybackYears / spread.savHi;
    const hi = paybackYears / spread.savLo;
    paybackBand = `${lo.toFixed(1)}–${hi.toFixed(1)} years`;
    disclosures.push(
      `Payback band is derived from this scenario's ${confidence}-confidence baseline (savings uncertainty ${spread.pct}, anchored to the ASHRAE G14 CV(RMSE) ≤25% M&V gate); excludes incentives, financing, degradation, and rate escalation.`,
    );
  }
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
      // Batch-46 (pass 2023): report the EFFECTIVE power rating the dispatch
      // actually used — when kW is omitted, dispatchBattery defaults it to
      // kwh × cRate, and the disclosed assumptions must mirror that, not echo a
      // null input. kwSource distinguishes user-specified from C-rate-defaulted.
      battery: input.batteryKwh
        ? {
            ...BATTERY_DEFAULTS,
            kwh: input.batteryKwh,
            kw: input.batteryKw ?? input.batteryKwh * BATTERY_DEFAULTS.cRate,
            kwSource: input.batteryKw != null ? "user_specified" : "defaulted_c_rate",
          }
        : undefined,
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
