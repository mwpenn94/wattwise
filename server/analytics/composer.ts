/**
 * Bill Builder composition engine (UX addendum v1.9 §3c).
 *
 * Principle: savings never add; profiles compose. Each measure is a transform
 * on the 8760 hourly profile. A selected basket = ordered composition of
 * transforms → ONE re-priced profile. This is the only architecture that
 * cannot double-count savings.
 *
 * Order of application mirrors runScenario's physics: efficiency (reduces
 * load) → EV (adds load) → solar (offsets) → battery (dispatches on what
 * remains). Battery dispatch receives the PRE-battery composed profile as its
 * demand-setpoint baseline, consistent with the single-scenario engine.
 *
 * Overlap honesty: we also run each measure INDIVIDUALLY on the untouched
 * baseline and report `sumOfIndividual` vs `composedSavings`. The difference
 * is the overlap — named, never hidden. Composed savings ≤ sum-of-parts is the
 * expected direction (measures compete for the same kWh/peaks); when synergy
 * makes composed > sum (battery arbitraging a TOU rate the solar exposed), the
 * UI must explain it rather than silently displaying it (§4 display rule).
 */
import {
  ScenarioInput,
  runScenario,
  solarProduction8760,
  solarZoneMapped,
  dispatchBattery,
  hourlyRateSignal,
  hourlyToPoints,
  SOLAR_FALLBACK_YIELD_KWH_PER_KW,
} from "./scenarios";
import { costOnTariff, tariffEligible } from "./tariffEngine";
import { TariffStructure, BATTERY_DEFAULTS, LABEL_NORMAL_YEAR, SOLAR_DISCLOSURE, BATTERY_DISCLOSURE } from "@shared/wattwise";

/** One selectable measure in the plan basket. */
export interface PlanMeasure {
  /** Stable key for the UI (also used in overlap attribution). */
  key: string;
  /** Human label, e.g. "Rooftop solar 5 kW". */
  label: string;
  kind: "efficiency" | "ev_load" | "solar" | "battery";
  solarKwDc?: number;
  batteryKwh?: number;
  batteryKw?: number;
  efficiencyReductions?: Record<string, number>;
  capexUsd?: number;
}

export interface ComposedResult {
  /** Annual bill on the untouched baseline profile, current rate. */
  baselineAnnualCost: number;
  /** Annual bill on the composed profile, current rate. */
  composedAnnualCost: number;
  /** baseline − composed (positive = the basket saves money). */
  composedSavings: number;
  /** Σ of each measure's individual savings run on the untouched baseline. */
  sumOfIndividualSavings: number;
  /** sumOfIndividual − composed (positive = measures overlap/compete). */
  overlap: number;
  perMeasure: Array<{ key: string; label: string; individualSavings: number; confidence: "low" | "medium" | "high" }>;
  /** Weakest confidence among selected measures (never better than worst input). */
  confidence: "low" | "medium" | "high";
  /** Basket payback: summed capex ÷ composed savings. Null when not meaningful. */
  basketCapexUsd: number;
  basketPaybackYears: number | null;
  basketPaybackBand: string | null;
  /** Peak import kW before/after composition. */
  baselinePeakKw: number;
  composedPeakKw: number;
  /** Annual CO2e delta, lb (negative = reduction). */
  deltaCo2eLb: number;
  /** Rate re-sweep on the COMPOSED profile (§3c: rate choice evaluated last). */
  rateSweep: Array<{
    tariffId: number;
    tariffName: string;
    utilityName: string;
    eligible: boolean;
    ineligibleReason?: string;
    annualCostOnComposed: number;
    savingsVsCurrentOnComposed: number;
    isCurrentBasis: boolean;
  }>;
  /** True when the best eligible rate on the composed profile differs from the current basis. */
  ratePlanOvertake: { tariffName: string; utilityName: string; additionalSavings: number } | null;
  disclosures: string[];
}

const cap = (v: number) => Math.round(v * 100) / 100;

export function composeMeasures(
  baselineHourly: number[],
  measures: PlanMeasure[],
  structure: TariffStructure,
  climateZone: string,
  co2eLbPerMwh: number,
  baselineConfidence: "low" | "medium" | "high",
  extrapolated: boolean,
  endUseFractions: Record<string, number> | undefined,
  candidateTariffs: Array<{
    id: number;
    name: string;
    utilityName: string;
    sector: string;
    commodity: string;
    peakKwMin: number | null;
    peakKwMax: number | null;
    structure: TariffStructure;
    isCurrentBasis: boolean;
  }>,
  sectorClass: string,
): ComposedResult {
  const disclosures: string[] = [
    `Composed plan modeled on ${LABEL_NORMAL_YEAR} hourly profile — measures compose on one profile; savings are never summed independently.`,
  ];

  /* ---- 1. individual runs (for the overlap honesty line) ---- */
  const perMeasure = measures.map((m) => {
    const input: ScenarioInput = {
      kind: m.kind === "battery" ? "battery" : m.kind,
      solarKwDc: m.solarKwDc,
      batteryKwh: m.batteryKwh,
      batteryKw: m.batteryKw,
      efficiencyReductions: m.efficiencyReductions,
      endUseFractions,
      capexUsd: m.capexUsd,
    };
    const r = runScenario(baselineHourly, input, structure, climateZone, co2eLbPerMwh, baselineConfidence, extrapolated);
    return {
      key: m.key,
      label: m.label,
      individualSavings: cap(-r.siteTotalDeltaCost), // deltaCost negative = savings
      confidence: r.confidence as "low" | "medium" | "high",
    };
  });
  const sumOfIndividualSavings = cap(perMeasure.reduce((a, m) => a + m.individualSavings, 0));

  /* ---- 2. composed profile: apply ALL transforms in physics order ---- */
  let hourly = [...baselineHourly];

  // efficiency first (reduces the load everything else acts on)
  const effMeasures = measures.filter((m) => m.kind === "efficiency" && m.efficiencyReductions);
  if (effMeasures.length > 0 && endUseFractions) {
    // Merge reductions per end use, capping each end use at 90% (API bound) and
    // the aggregate at 100% — two measures cannot remove more than all of an
    // end use's load.
    const merged: Record<string, number> = {};
    for (const m of effMeasures) {
      for (const [endUse, frac] of Object.entries(m.efficiencyReductions!)) {
        merged[endUse] = Math.min(0.9, (merged[endUse] ?? 0) + frac);
      }
    }
    let totalReduction = 0;
    for (const [endUse, frac] of Object.entries(merged)) {
      totalReduction += (endUseFractions[endUse] ?? 0) * frac;
    }
    if (totalReduction > 1) {
      disclosures.push("Combined efficiency reductions were capped at 100% of load — treat as a theoretical maximum.");
      totalReduction = 1;
    }
    hourly = hourly.map((v) => v * (1 - totalReduction));
    if (effMeasures.length > 1) {
      disclosures.push(
        "Multiple efficiency measures acting on the same end use are capped at that end use's remaining load — they compete for the same kWh, which is part of the overlap shown.",
      );
    }
  }

  // EV load (adds overnight load before solar/battery see the profile)
  // (no ev in PlanMeasure yet — reserved for future basket extension)

  // solar
  const solarMeasures = measures.filter((m) => m.kind === "solar" && m.solarKwDc);
  const totalSolarKw = solarMeasures.reduce((a, m) => a + (m.solarKwDc ?? 0), 0);
  if (totalSolarKw > 0) {
    const prod = solarProduction8760(totalSolarKw, climateZone);
    hourly = hourly.map((v, h) => v - prod[h]);
    disclosures.push(SOLAR_DISCLOSURE);
    if (!solarZoneMapped(climateZone)) {
      disclosures.push(
        `Climate zone "${climateZone}" has no mapped solar-yield entry — a generic ${SOLAR_FALLBACK_YIELD_KWH_PER_KW.toLocaleString()} kWh/kW-yr default was used; treat solar production as low confidence.`,
      );
    }
  }

  // battery last (dispatches on the composed residual; setpoint baseline is
  // the PRE-battery composed profile, mirroring runScenario's convention)
  const battMeasures = measures.filter((m) => m.kind === "battery" && m.batteryKwh);
  const totalBattKwh = battMeasures.reduce((a, m) => a + (m.batteryKwh ?? 0), 0);
  if (totalBattKwh > 0) {
    const totalBattKw = battMeasures.reduce((a, m) => a + (m.batteryKw ?? (m.batteryKwh ?? 0) * BATTERY_DEFAULTS.cRate), 0);
    const preBattery = [...hourly];
    const rateSignal = hourlyRateSignal(structure);
    const { residual } = dispatchBattery(hourly, { kwh: totalBattKwh, kw: totalBattKw }, rateSignal, preBattery);
    hourly = residual;
    disclosures.push(BATTERY_DISCLOSURE);
    if (totalSolarKw > 0) {
      disclosures.push("Solar and battery dispatch sequentially (solar offsets first, battery dispatches on the residual) — co-optimized control could differ.");
    }
  }

  /* ---- 3. price both profiles on the current rate ---- */
  const basePoints = hourlyToPoints(baselineHourly);
  const composedPoints = hourlyToPoints(hourly);
  const baseCost = costOnTariff(basePoints, structure);
  const composedCost = costOnTariff(composedPoints, structure);
  const baselineAnnualCost = cap(baseCost.breakdown.total);
  const composedAnnualCost = cap(composedCost.breakdown.total);
  const composedSavings = cap(baselineAnnualCost - composedAnnualCost);
  const overlap = cap(sumOfIndividualSavings - composedSavings);
  if (measures.length >= 2) {
    if (overlap > 1) {
      disclosures.push(
        `Individually these measures would sum to $${Math.round(sumOfIndividualSavings).toLocaleString()}/yr, but together they save $${Math.round(composedSavings).toLocaleString()}/yr — they overlap by $${Math.round(overlap).toLocaleString()} (measures compete for the same energy and peaks).`,
      );
    } else if (overlap < -1) {
      // Synergy: composed beats sum-of-parts. §4 display rule — explain, never
      // just display a better-than-parts number.
      disclosures.push(
        `Together these measures save $${Math.round(composedSavings).toLocaleString()}/yr — MORE than their individual sum ($${Math.round(sumOfIndividualSavings).toLocaleString()}). The synergy is real but modeled: one measure reshapes the profile in a way that amplifies another (e.g., battery dispatch exploiting the peaks solar leaves behind). Treat the extra margin with the basket's confidence chip, not as a bonus guarantee.`,
      );
    }
  }

  /* ---- 4. peaks, emissions, payback, confidence ---- */
  const baselinePeakKw = baselineHourly.length ? cap(Math.max(0, ...baselineHourly)) : 0;
  const composedPeakKw = hourly.length ? cap(Math.max(0, ...hourly)) : 0;
  const deltaUsage = hourly.reduce((a, b) => a + b, 0) - baselineHourly.reduce((a, b) => a + b, 0);
  const deltaCo2eLb = cap((deltaUsage / 1000) * co2eLbPerMwh);
  disclosures.push("Emissions deltas use an annual-average grid intensity factor — marginal/hourly intensity differs.");

  const basketCapexUsd = cap(measures.reduce((a, m) => a + (m.capexUsd ?? 0), 0));
  let basketPaybackYears: number | null = null;
  let basketPaybackBand: string | null = null;
  if (basketCapexUsd === 0 && composedSavings > 1) {
    basketPaybackYears = 0;
    basketPaybackBand = "immediate — no upfront cost";
  } else if (basketCapexUsd > 0 && composedSavings > 1) {
    basketPaybackYears = cap(basketCapexUsd / composedSavings);
    basketPaybackBand = `${(basketPaybackYears * 0.75).toFixed(1)}–${(basketPaybackYears * 1.5).toFixed(1)} years`;
    disclosures.push("Basket payback band is a fixed heuristic spread (75%–150%), not derived from quantified uncertainty; excludes incentives, financing, degradation, and rate escalation.");
  }

  // weakest-chip inheritance (§3c): the basket is never more confident than
  // its least confident member OR the baseline.
  const order = { low: 0, medium: 1, high: 2 } as const;
  const weakest = perMeasure.reduce<"low" | "medium" | "high">(
    (acc, m) => (order[m.confidence] < order[acc] ? m.confidence : acc),
    extrapolated ? "low" : baselineConfidence === "low" ? "low" : "medium",
  );

  /* ---- 5. rate re-sweep on the composed profile (§3c: rate last) ---- */
  const rateSweep = candidateTariffs.map((t) => {
    const elig = tariffEligible(
      { sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin, peakKwMax: t.peakKwMax },
      { sectorClass },
      composedPeakKw > 0 ? composedPeakKw : null,
    );
    const cost = costOnTariff(composedPoints, t.structure);
    return {
      tariffId: t.id,
      tariffName: t.name,
      utilityName: t.utilityName,
      eligible: elig.eligible,
      ineligibleReason: elig.reason,
      annualCostOnComposed: cap(cost.breakdown.total),
      savingsVsCurrentOnComposed: cap(composedAnnualCost - cost.breakdown.total),
      isCurrentBasis: t.isCurrentBasis,
    };
  });
  rateSweep.sort((a, b) => a.annualCostOnComposed - b.annualCostOnComposed);
  const bestEligible = rateSweep.find((r) => r.eligible);
  const current = rateSweep.find((r) => r.isCurrentBasis);
  let ratePlanOvertake: ComposedResult["ratePlanOvertake"] = null;
  if (bestEligible && current && !bestEligible.isCurrentBasis && bestEligible.savingsVsCurrentOnComposed > 1) {
    ratePlanOvertake = {
      tariffName: bestEligible.tariffName,
      utilityName: bestEligible.utilityName,
      additionalSavings: cap(bestEligible.savingsVsCurrentOnComposed),
    };
    disclosures.push(
      `On your composed profile, ${bestEligible.utilityName} — ${bestEligible.tariffName} overtakes your current rate by $${Math.round(bestEligible.savingsVsCurrentOnComposed).toLocaleString()}/yr. Rate eligibility checked on sector and peak size only — confirm with the utility before switching.`,
    );
  }

  return {
    baselineAnnualCost,
    composedAnnualCost,
    composedSavings,
    sumOfIndividualSavings,
    overlap,
    perMeasure,
    confidence: weakest,
    basketCapexUsd,
    basketPaybackYears,
    basketPaybackBand,
    baselinePeakKw,
    composedPeakKw,
    deltaCo2eLb,
    rateSweep,
    ratePlanOvertake,
    disclosures,
  };
}

/** Preset baskets (§3c): decision-fatigue relief. Sized off site sqft. */
export function presetBaskets(sqft: number | null, endUseFractions: Record<string, number> | undefined): Record<"conservative" | "balanced" | "aggressive", PlanMeasure[]> {
  const size = sqft ?? 2000;
  const solarKw = Math.max(2, Math.min(20, Math.round(size / 400)));
  const battKwh = Math.max(5, Math.min(40, Math.round(size / 200)));
  const hasCooling = (endUseFractions?.cooling ?? 0) > 0.05;
  const behavioral: PlanMeasure[] = hasCooling
    ? [{ key: "eff_cooling", label: "Cooling setpoint & schedule optimization", kind: "efficiency", efficiencyReductions: { cooling: 0.1 }, capexUsd: 0 }]
    : [{ key: "eff_plug", label: "Plug-load & schedule discipline", kind: "efficiency", efficiencyReductions: { plug: 0.1 }, capexUsd: 0 }];
  const lowCapex: PlanMeasure[] = [
    ...behavioral,
    { key: "eff_lighting", label: "LED lighting retrofit", kind: "efficiency", efficiencyReductions: { lighting: 0.4 }, capexUsd: Math.round(size * 0.5) },
  ];
  const everything: PlanMeasure[] = [
    ...lowCapex,
    { key: "solar", label: `Rooftop solar ${solarKw} kW`, kind: "solar", solarKwDc: solarKw, capexUsd: solarKw * 2500 },
    { key: "battery", label: `Battery ${battKwh} kWh`, kind: "battery", batteryKwh: battKwh, capexUsd: battKwh * 700 },
  ];
  return { conservative: behavioral, balanced: lowCapex, aggressive: everything };
}
