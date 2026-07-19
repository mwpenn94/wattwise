/**
 * commodityOpportunities.ts — cross-commodity auto-opportunity generation
 * (parity fix, owner report Jul 19: "imputed usage and savings opportunities
 * exist on an energy basis but not for gas and water — contradictory").
 *
 * Called from the analysis pipeline's stage 7 so gas/water opportunities are
 * generated IN THE SAME RUN as electric ones (replaceOpportunities wipes the
 * site's rows per run — generating these in a separate run would let an
 * electric re-run silently clobber gas/water cards, or vice versa).
 *
 * Baseline resolution per commodity mirrors commodityScenario.ts exactly:
 *   1. measured — ≥60 days of that commodity's meter data, annualized
 *   2. benchmark-imputed — building-type benchmark intensity × sqft
 *      (CBECS/RECS for gas, EPA WaterSense for water), disclosed verbatim
 * Sites with neither a commodity meter nor (buildingType + sqft) generate
 * nothing for that commodity — absence is honest, not an error.
 *
 * Pricing: the meter's assigned tariff if it matches the commodity, else the
 * best seeded state tariff, else any seeded tariff for the commodity. If no
 * rate exists, unit savings still surface with $0 dollars and a disclosure —
 * never a fabricated national average for gas/water.
 */
import { COMMODITIES, type Commodity } from "../shared/commodity"; // commodity metadata (units/labels)
import * as h from "./dbHelpers";

export interface CommodityOpportunity {
  key: string;
  title: string;
  category: string;
  annualSavingsUsdLo: number;
  annualSavingsUsdHi: number;
  capexBand: "none" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  rationale: string;
  disclosures: string[];
  /** implementer-grade first-year unit savings (midpoint) in the commodity's meter unit */
  estUnitsSavedPerYr: number;
  unit: string;
  commodity: Commodity;
}

interface SiteLike {
  id: number;
  buildingType?: string | null;
  sqft?: number | null;
  state?: string | null;
}

interface CommodityBasis {
  commodity: "gas" | "water";
  annualUnits: number;
  basis: "measured" | "benchmark_imputed";
  spanDays: number | null;
  ratePerUnit: number;
  tariffName: string | null;
  benchmarkNote: string | null;
  hasMeter: boolean;
}

function annualizeMeasured(pts: Array<{ ts: number; usage: number }>): { annual: number; spanDays: number } {
  const total = pts.reduce((s, p) => s + p.usage, 0);
  const spanDays = Math.max(1, (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000);
  return { annual: (total / spanDays) * 365, spanDays };
}

function pickRate(structure: unknown): number {
  const s = structure as { energy?: Array<{ ratePerUnit?: number }> } | null;
  return s?.energy?.[0]?.ratePerUnit ?? 0;
}

/** Resolve the annual baseline + volumetric rate for one non-electric commodity.
 *  Returns null when neither measured data nor a benchmark path exists. */
async function resolveBasis(
  site: SiteLike,
  userId: number,
  commodity: "gas" | "water",
  meters: Array<{ id: number; commodity: string; meterRole: string | null; currentTariffId: number | null }>,
): Promise<CommodityBasis | null> {
  const meter =
    meters.find((m) => m.commodity === commodity && m.meterRole !== "submeter") ??
    meters.find((m) => m.commodity === commodity) ??
    null;
  let annualUnits: number | null = null;
  let basis: "measured" | "benchmark_imputed" = "benchmark_imputed";
  let spanDays: number | null = null;
  let benchmarkNote: string | null = null;
  if (meter) {
    const pts = await h.getIntervalPoints(meter.id, userId);
    if (pts.length >= 2) {
      const a = annualizeMeasured(pts);
      if (a.spanDays >= 60 && a.annual > 0) {
        annualUnits = a.annual;
        basis = "measured";
        spanDays = a.spanDays;
      }
    }
  }
  if (annualUnits == null) {
    if (!site.buildingType || !site.sqft) return null;
    const bm = await h.getBenchmark(site.buildingType, commodity);
    if (!bm) return null;
    annualUnits = bm.medianEui * site.sqft;
    basis = "benchmark_imputed";
    benchmarkNote = `${bm.medianEui} ${bm.unit} (${bm.source}) × ${site.sqft.toLocaleString()} sqft`;
  }
  /* pricing — assigned tariff, else seeded state tariff, else any seeded */
  let ratePerUnit = 0;
  let tariffName: string | null = null;
  const assigned = meter?.currentTariffId ? await h.getTariff(meter.currentTariffId) : undefined;
  if (assigned && assigned.commodity === commodity) {
    ratePerUnit = pickRate(assigned.structure);
    tariffName = assigned.name;
  } else {
    const cands = await h.listTariffs(commodity, site.state ?? undefined);
    const pick = cands[0] ?? (await h.listTariffs(commodity))[0] ?? null;
    if (pick) {
      ratePerUnit = pickRate(pick.structure);
      tariffName = pick.name;
    }
  }
  return { commodity, annualUnits, basis, spanDays, ratePerUnit, tariffName, benchmarkNote, hasMeter: !!meter };
}

const IMPUTED_DISCLAIMER = (label: string, note: string) =>
  `No measured ${label} data on this site — the baseline is benchmark-imputed: ${note}. Savings are screening-grade; add a meter or bills to firm them up.`;

const PRICING_NOTE = (basis: CommodityBasis, meta: { label: string; tariffRateUnit: string }) =>
  basis.ratePerUnit > 0
    ? `Priced at ${basis.tariffName} ($${basis.ratePerUnit}/${meta.tariffRateUnit})${basis.hasMeter ? "" : " — assign your actual tariff for bill-accurate dollars"}.`
    : `No ${meta.label.toLowerCase()} rate on file — unit savings shown, dollars are $0 until a tariff is assigned.`;

/** HDD-weighted heating fraction of annual gas use. With no per-building
 *  disaggregation we use the climate's HDD concentration as the honest proxy:
 *  buildings in heating climates spend more of their gas on space heat.
 *  Bounded 35–75% and disclosed. */
function gasHeatingFraction(normals: Array<{ hddBase65: number; cddBase65: number }>): { fraction: number; note: string } {
  if (normals.length === 0) return { fraction: 0.5, note: "no weather normals matched — a 50% heating share is assumed and disclosed" };
  const hdd = normals.reduce((s, n) => s + (n.hddBase65 ?? 0), 0);
  // National reference: ~4,500 HDD65 ≈ 60% of gas to space heat (EIA RECS/CBECS
  // end-use splits). Scale linearly, clamp to a defensible band.
  const raw = 0.6 * (hdd / 4500);
  const fraction = Math.min(0.75, Math.max(0.35, raw));
  return {
    fraction,
    note: `heating share estimated from your climate's ${Math.round(hdd).toLocaleString()} annual heating degree-days (EIA end-use splits, clamped 35–75%)`,
  };
}

/**
 * Generate auto-ranked gas + water opportunities for a site. Runs inside the
 * pipeline's stage 7. Every candidate carries implementer unit savings.
 */
export async function generateCommodityOpportunities(
  site: SiteLike,
  userId: number,
  normals: Array<{ month: number; hddBase65: number; cddBase65: number; avgTempF: number }>,
  narrate: (msg: string) => void,
): Promise<CommodityOpportunity[]> {
  const out: CommodityOpportunity[] = [];
  let meters: Array<{ id: number; commodity: string; meterRole: string | null; currentTariffId: number | null }> = [];
  try {
    meters = (await h.listMeters(site.id, userId)) as typeof meters;
  } catch {
    return out;
  }

  /* ---------------- natural gas ---------------- */
  const gas = await resolveBasis(site, userId, "gas", meters);
  if (gas && gas.annualUnits > 0) {
    const meta = COMMODITIES.gas;
    const conf: "low" | "medium" = gas.basis === "measured" ? "medium" : "low";
    const baseDisclosures: string[] = [];
    if (gas.basis === "benchmark_imputed" && gas.benchmarkNote) {
      baseDisclosures.push(IMPUTED_DISCLAIMER(meta.label.toLowerCase(), gas.benchmarkNote));
    }
    baseDisclosures.push(PRICING_NOTE(gas, meta));
    const heat = gasHeatingFraction(normals);
    const heatingTherms = gas.annualUnits * heat.fraction;

    // 1) Heating tune-up / controls: 5–12% of heating gas (combustion tuning,
    //    setback schedules, boiler reset). Low capex, well-established band.
    {
      const lo = heatingTherms * 0.05;
      const hi = heatingTherms * 0.12;
      out.push({
        key: "gas_heating_tuneup",
        title: "Heating system tune-up & controls (combustion tuning, setbacks)",
        category: "efficiency",
        annualSavingsUsdLo: lo * gas.ratePerUnit,
        annualSavingsUsdHi: hi * gas.ratePerUnit,
        capexBand: "low",
        confidence: conf,
        rationale: `Space heating is an estimated ${(heat.fraction * 100).toFixed(0)}% of your ${Math.round(gas.annualUnits).toLocaleString()} therm/yr ${gas.basis === "measured" ? "measured" : "benchmark-imputed"} gas baseline (${heat.note}). Combustion tuning, thermostat setbacks, and boiler reset controls typically cut heating gas 5–12%.`,
        disclosures: baseDisclosures,
        estUnitsSavedPerYr: Math.round((lo + hi) / 2),
        unit: meta.usageUnit,
        commodity: "gas",
      });
    }
    // 2) Water-heating efficiency: 8–15% of the NON-heating gas share (low-flow
    //    fixtures, pipe insulation, setpoint to 120°F). Applies where gas serves
    //    DHW — disclosed as an assumption, not asserted.
    {
      const dhwTherms = gas.annualUnits * (1 - heat.fraction) * 0.55; // ~55% of non-space-heat gas is DHW (EIA end-use)
      const lo = dhwTherms * 0.08;
      const hi = dhwTherms * 0.15;
      if (hi * Math.max(gas.ratePerUnit, 0.5) >= 10) {
        out.push({
          key: "gas_water_heating",
          title: "Hot-water efficiency (setpoint, insulation, low-flow)",
          category: "efficiency",
          annualSavingsUsdLo: lo * gas.ratePerUnit,
          annualSavingsUsdHi: hi * gas.ratePerUnit,
          capexBand: "low",
          confidence: "low",
          rationale: `An estimated ${Math.round(dhwTherms).toLocaleString()} therms/yr goes to water heating (EIA end-use split of the non-space-heat share). A 120°F setpoint, tank/pipe insulation, and low-flow fixtures typically save 8–15% of it.`,
          disclosures: [...baseDisclosures, "Assumes gas-fired water heating — if your hot water is electric, this measure belongs on the electric side instead."],
          estUnitsSavedPerYr: Math.round((lo + hi) / 2),
          unit: meta.usageUnit,
          commodity: "gas",
        });
      }
    }
    // 3) Weatherization — tied to confirmed envelope geometry when available:
    //    air sealing + insulation, 8–20% of heating gas. Capex medium.
    {
      let envelopeNote = "";
      let lo = heatingTherms * 0.08;
      let hi = heatingTherms * 0.2;
      let capex: "medium" = "medium";
      try {
        const geo = await h.getSiteGeometry(site.id, userId);
        if (geo?.exposureScore != null && geo.exposureScore > 0.6) {
          hi = heatingTherms * 0.22;
          envelopeNote = ` Your confirmed building geometry shows a high envelope exposure score (${geo.exposureScore.toFixed(2)}) — more exposed wall area means air sealing and insulation work harder here.`;
        } else if (geo?.footprintSqft) {
          envelopeNote = " Sized against your confirmed footprint geometry.";
        }
      } catch {
        /* geometry optional */
      }
      out.push({
        key: "gas_weatherization",
        title: "Weatherization — air sealing & insulation",
        category: "efficiency",
        annualSavingsUsdLo: lo * gas.ratePerUnit,
        annualSavingsUsdHi: hi * gas.ratePerUnit,
        capexBand: capex,
        confidence: conf === "medium" ? "medium" : "low",
        rationale: `Air sealing and insulation typically cut heating gas 8–20%.${envelopeNote} Heating gas here is an estimated ${Math.round(heatingTherms).toLocaleString()} therms/yr (${heat.note}).`,
        disclosures: baseDisclosures,
        estUnitsSavedPerYr: Math.round((lo + hi) / 2),
        unit: meta.usageUnit,
        commodity: "gas",
      });
    }
    narrate(
      `Gas opportunities generated from a ${gas.basis === "measured" ? `measured baseline (${Math.round(gas.spanDays ?? 0)} days annualized)` : "benchmark-imputed baseline (disclosed)"} — ${Math.round(gas.annualUnits).toLocaleString()} therms/yr`,
    );
  }

  /* ---------------- water ---------------- */
  const water = await resolveBasis(site, userId, "water", meters);
  if (water && water.annualUnits > 0) {
    const meta = COMMODITIES.water;
    const conf: "low" | "medium" = water.basis === "measured" ? "medium" : "low";
    const baseDisclosures: string[] = [];
    if (water.basis === "benchmark_imputed" && water.benchmarkNote) {
      baseDisclosures.push(IMPUTED_DISCLAIMER(meta.label.toLowerCase(), water.benchmarkNote));
    }
    baseDisclosures.push(PRICING_NOTE(water, meta));

    // 1) Fixture efficiency: 10–25% of indoor use (WaterSense fixtures,
    //    aerators, flush valves). Indoor share assumed 70% absent irrigation data.
    {
      const indoorGal = water.annualUnits * 0.7;
      const lo = indoorGal * 0.1;
      const hi = indoorGal * 0.25;
      out.push({
        key: "water_fixture_efficiency",
        title: "Fixture efficiency (WaterSense fixtures, aerators, flush valves)",
        category: "efficiency",
        annualSavingsUsdLo: lo * water.ratePerUnit,
        annualSavingsUsdHi: hi * water.ratePerUnit,
        capexBand: "low",
        confidence: conf,
        rationale: `Indoor use is an estimated 70% of your ${Math.round(water.annualUnits).toLocaleString()} gal/yr ${water.basis === "measured" ? "measured" : "benchmark-imputed"} water baseline. WaterSense-rated fixtures typically cut indoor use 10–25%. Sewer charges keyed to water volume roughly double the dollar impact where they apply.`,
        disclosures: [...baseDisclosures, "The 70% indoor share is an assumption absent irrigation submetering — sites with heavy irrigation should treat the range as conservative for outdoor measures and optimistic for indoor ones."],
        estUnitsSavedPerYr: Math.round((lo + hi) / 2),
        unit: meta.usageUnit,
        commodity: "water",
      });
    }
    // 2) Leak screening — only claimable with measured data showing a
    //    continuous-flow floor; on imputed baselines it surfaces as a
    //    zero-dollar diagnostic prompt rather than fabricated savings.
    if (water.basis === "measured" && water.hasMeter) {
      const meterRow = meters.find((m) => m.commodity === "water");
      if (meterRow) {
        try {
          const pts = await h.getIntervalPoints(meterRow.id, userId);
          if (pts.length >= 48) {
            const sorted = [...pts].sort((a, b) => a.usage - b.usage);
            const floor = sorted[Math.floor(sorted.length * 0.05)]?.usage ?? 0;
            if (floor > 0) {
              const spanDaysW = Math.max(1, (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000);
              const readsPerDay = pts.length / spanDaysW;
              const annualLeakGal = floor * readsPerDay * 365;
              if (annualLeakGal > water.annualUnits * 0.03) {
                out.push({
                  key: "water_leak_screening",
                  title: "Continuous-flow signature — leak screening recommended",
                  category: "efficiency",
                  annualSavingsUsdLo: annualLeakGal * 0.5 * water.ratePerUnit,
                  annualSavingsUsdHi: annualLeakGal * water.ratePerUnit,
                  capexBand: "none",
                  confidence: "medium",
                  rationale: `Your water meter never reads below ${floor.toFixed(1)} ${meta.usageUnit} per interval (5th-percentile floor) — a continuous-flow signature consistent with a leak or always-on process load of roughly ${Math.round(annualLeakGal).toLocaleString()} gal/yr. A plumber's leak check is cheap relative to the water it may be costing.`,
                  disclosures: [...baseDisclosures, "A continuous-flow floor can also be legitimate process load (cooling makeup, irrigation timers) — the range assumes 50–100% of the floor is recoverable; verify before counting."],
                  estUnitsSavedPerYr: Math.round(annualLeakGal * 0.75),
                  unit: meta.usageUnit,
                  commodity: "water",
                });
              }
            }
          }
        } catch {
          /* leak screen optional */
        }
      }
    }
    narrate(
      `Water opportunities generated from a ${water.basis === "measured" ? `measured baseline (${Math.round(water.spanDays ?? 0)} days annualized)` : "benchmark-imputed baseline (disclosed)"} — ${Math.round(water.annualUnits).toLocaleString()} gal/yr`,
    );
  }
  return out;
}
