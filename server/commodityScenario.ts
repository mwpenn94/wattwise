/**
 * Gas/water efficiency scenarios — commodity-native path.
 *
 * The electric scenario engine runs an 8760 hourly simulation because electric
 * tariffs price time (TOU, demand, ratchets). Gas and water tariffs in scope
 * are flat volumetric rates, so an honest engine needs only: a defensible
 * annual baseline in meter units, a reduction fraction, the assigned (or best
 * seeded) tariff's ratePerUnit, and the commodity's emission factor.
 *
 * Baseline hierarchy (disclosed, never silent):
 *  1. measured_intervals — ≥60 days of that commodity's meter data, annualized
 *  2. benchmark_estimate — building-type benchmark intensity × sqft (labeled
 *     low-confidence; extrapolated flag set)
 * If neither exists, the run is rejected with a actionable message rather than
 * inventing a number.
 */
import { TRPCError } from "@trpc/server";
import { COMMODITIES, type Commodity } from "../shared/commodity";
import type { ScenarioResults } from "../shared/wattwise";
import * as h from "./dbHelpers";

interface SiteLike {
  id: number;
  sqft: number | null;
  buildingType: string | null;
  state: string | null;
}

export interface CommodityEfficiencyRun {
  results: ScenarioResults;
  loadBasis: "measured_intervals" | "benchmark_estimate";
}

/** Annualize measured interval usage: sum ÷ span-days × 365. */
function annualizeMeasured(pts: Array<{ ts: number; usage: number }>): { annual: number; spanDays: number } {
  const total = pts.reduce((s, p) => s + p.usage, 0);
  const spanDays = Math.max(1, (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000);
  return { annual: (total / spanDays) * 365, spanDays };
}

export async function runCommodityEfficiency(opts: {
  site: SiteLike;
  userId: number;
  commodity: Commodity & ("gas" | "water");
  /** fractional reduction 0–0.9 applied to the annual baseline */
  reduction: number;
  capexUsd?: number;
}): Promise<CommodityEfficiencyRun> {
  const { site, userId, commodity, reduction } = opts;
  const meta = COMMODITIES[commodity];
  const disclosures: string[] = [];

  /* ---- baseline in meter units (therms / gallons) ---- */
  const meters = await h.listMeters(site.id, userId);
  const meter = meters.find((m) => m.commodity === commodity && m.meterRole !== "submeter") ?? meters.find((m) => m.commodity === commodity) ?? null;
  let annualBaseline: number | null = null;
  let loadBasis: "measured_intervals" | "benchmark_estimate" = "benchmark_estimate";
  let confidence: "low" | "medium" | "high" = "low";
  let extrapolated = false;
  if (meter) {
    const pts = await h.getIntervalPoints(meter.id, userId);
    if (pts.length >= 2) {
      const { annual, spanDays } = annualizeMeasured(pts);
      if (spanDays >= 60 && annual > 0) {
        annualBaseline = annual;
        loadBasis = "measured_intervals";
        confidence = spanDays >= 270 ? "high" : spanDays >= 120 ? "medium" : "low";
        extrapolated = spanDays < 270;
        if (extrapolated) {
          disclosures.push(
            `Baseline annualized from ${Math.round(spanDays)} days of measured ${meta.label.toLowerCase()} data — seasonal coverage is incomplete, so the annual figure is extrapolated.`,
          );
        }
      }
    }
  }
  if (annualBaseline == null) {
    // benchmark intensity path: buildingType benchmark for this commodity
    const bm = site.buildingType ? await h.getBenchmark(site.buildingType, commodity) : null;
    if (!bm || !site.sqft) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A ${meta.label.toLowerCase()} efficiency scenario needs either ≥60 days of ${meta.label.toLowerCase()} meter data or a building type + size for a benchmark baseline. Add a ${commodity} meter with usage data, or set building type and square footage.`,
      });
    }
    annualBaseline = bm.medianEui * site.sqft;
    loadBasis = "benchmark_estimate";
    confidence = "low";
    extrapolated = true;
    disclosures.push(
      `No measured ${meta.label.toLowerCase()} data — baseline is the ${site.buildingType} median benchmark intensity (${bm.medianEui} ${bm.unit} from ${bm.source}) × ${site.sqft.toLocaleString()} sqft. Treat results as screening-grade.`,
    );
  }

  /* ---- tariff: assigned to the meter, else best seeded match ---- */
  const assigned = meter?.currentTariffId ? await h.getTariff(meter.currentTariffId) : undefined;
  let ratePerUnit = 0;
  let tariffName: string | null = null;
  const pickRate = (structure: unknown): number => {
    const s = structure as { energy?: Array<{ ratePerUnit?: number }> } | null;
    return s?.energy?.[0]?.ratePerUnit ?? 0;
  };
  if (assigned && assigned.commodity === commodity) {
    ratePerUnit = pickRate(assigned.structure);
    tariffName = assigned.name;
  } else {
    const cands = await h.listTariffs(commodity, site.state ?? undefined);
    const pick = cands[0] ?? (await h.listTariffs(commodity))[0] ?? null;
    if (pick) {
      ratePerUnit = pickRate(pick.structure);
      tariffName = pick.name;
      disclosures.push(
        `No ${meta.label.toLowerCase()} tariff is assigned to this site — savings are priced with the seeded ${pick.name} rate (${ratePerUnit ? `$${ratePerUnit}/${meta.tariffRateUnit}` : "unavailable"}). Assign your actual tariff for bill-accurate dollars.`,
      );
    } else {
      disclosures.push(`No ${meta.label.toLowerCase()} tariff available — unit savings are computed but dollar savings are $0 until a tariff is assigned.`);
    }
  }

  /* ---- savings math (flat volumetric — honest for gas/water in scope) ---- */
  const savedUnits = annualBaseline * reduction;
  const deltaUsage = -savedUnits;
  const deltaCost = -(savedUnits * ratePerUnit);
  const deltaCo2eLb = meta.co2e.kind === "per_unit" ? -(savedUnits * meta.co2e.lbPerUnit) : 0;
  if (meta.co2e.kind === "none") disclosures.push(meta.co2e.gapNote);
  if (meta.co2e.kind === "per_unit") {
    disclosures.push(`CO2e uses ${meta.co2e.source} (${meta.co2e.lbPerUnit} lb/${meta.tariffRateUnit}).`);
  }
  disclosures.push(
    `${meta.label} savings are modeled as a flat ${Math.round(reduction * 100)}% reduction priced at the volumetric rate — ${meta.label.toLowerCase()} tariffs in scope carry no time-of-use or demand components. First-year unit savings (${Math.round(savedUnits).toLocaleString()} ${meta.usageUnit}) are the figure custom rebate programs pay on; verify with M&V before filing.`,
  );

  const capex = opts.capexUsd ?? 0;
  const annualSavingsUsd = Math.max(0, -deltaCost);
  const paybackYears = capex === 0 ? 0 : annualSavingsUsd > 0 ? Math.round((capex / annualSavingsUsd) * 10) / 10 : null;

  const confidenceLabel =
    loadBasis === "measured_intervals"
      ? `${confidence} confidence — annualized from measured ${meta.label.toLowerCase()} intervals`
      : `low confidence — benchmark-estimated baseline (no measured ${meta.label.toLowerCase()} data)`;

  const results: ScenarioResults = {
    perCommodity: {
      [commodity]: {
        deltaUsage: Math.round(deltaUsage),
        deltaDemandKw: 0,
        deltaCost: Math.round(deltaCost * 100) / 100,
        deltaCo2eLb: Math.round(deltaCo2eLb),
      },
    },
    siteTotalDeltaCost: Math.round(deltaCost * 100) / 100,
    siteTotalDeltaCo2eLb: Math.round(deltaCo2eLb),
    paybackYears,
    paybackBand: paybackYears == null ? null : paybackYears === 0 ? "immediate — no upfront cost" : `${Math.max(0, Math.round((paybackYears - 1) * 10) / 10)}–${Math.round((paybackYears + 1) * 10) / 10} yr`,
    confidence,
    confidenceLabel,
    disclosures,
    assumptions: {
      commodity,
      annualBaselineUnits: Math.round(annualBaseline),
      reductionFraction: reduction,
      ratePerUnit,
      tariffName,
      baselineBasis: loadBasis,
    },
    extrapolated,
  };
  (results as unknown as Record<string, unknown>).implementerSavings = {
    unitsSavedAnnual: { [commodity]: Math.round(savedUnits) },
    note: `First-year modeled unit savings — the figure custom rebate programs ($/${meta.tariffRateUnit} saved) pay on. Verify with M&V before filing.`,
  };
  return { results, loadBasis };
}
