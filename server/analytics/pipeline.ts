/**
 * Analysis pipeline orchestrator — one full run over a site (handoff §5).
 * Stages: intervals → demand analytics → baseline → tariff check → benchmarking
 * → emissions → insights → opportunities. Metered per stage (AC5), wrapped in
 * the per-analysis compute timeout.
 */
import {
  ANALYSIS_TIMEOUT_MS,
  COMMODITY_UNITS,
  DEFAULT_TZ,
  DISAGG_LANGUAGE,
  IntervalPoint,
  localParts,
  LABEL_CP_ESTIMATED,
  LABEL_NORMAL_YEAR,
  MODELED_ESTIMATES_DISCLAIMER,
  TariffComparison,
  TariffStructure,
  inferClimateZone,
  quickStartAssumptions,
} from "../../shared/wattwise";
import {
  fitCaltrackMonthly,
  intervalsToMonthly,
  normalsAsDailyTemps,
  archetypeBaseline,
  detectResidualAnomalies,
  AnomalyResult,
  BaselineFit,
  MonthNormalRow,
} from "./baseline";
import { computeDemandAnalytics, costOnTariff, tariffEligible, DemandAnalytics, CostResult } from "./tariffEngine";
import { benchmarkPercentile, rankOpportunities, OpportunityCandidate } from "./scenarios";
import * as h from "../dbHelpers";
import { recordMeterEvent } from "./costModel";
import type { Site, Meter } from "../../drizzle/schema";

/**
 * Unoccupied hours per year for a typical single-shift commercial facility:
 * ~12 h/weeknight × 261 weekdays + 24 h × 104 weekend days ≈ 4,900 h.
 * Used to scope after-hours baseload savings honestly (never 8760 h).
 */
const AFTER_HOURS_PER_YEAR = 4900;

export interface PipelineResult {
  analysisId: number;
  demand: DemandAnalytics | null;
  baseline: BaselineFit | null;
  currentCost: CostResult | null;
  tariffComparisons: TariffComparison[];
  benchmark: { siteEui: number | null; percentileBand: string | null; betterThanMedian: boolean | null; source: string | null } | null;
  emissions: { annualCo2eLb: number; subregion: string; factorYear: number; mapped: boolean } | null;
  insightsCount: number;
  opportunitiesCount: number;
  marginalCostUsd: number;
  disclaimer: string;
}

// Batch-35 (pass 1319a): classify timeouts by TYPE, not by string-matching the
// error message — a non-timeout failure whose message happens to contain the
// word "timeout" (e.g. a DB lock timeout inside a stage) must persist as
// status='failed', not masquerade as a compute-budget timeout.
class AnalysisTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AnalysisTimeoutError";
  }
}
function timeoutGuard<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new AnalysisTimeoutError(`Analysis exceeded ${ANALYSIS_TIMEOUT_MS / 1000}s compute timeout`)),
        ANALYSIS_TIMEOUT_MS,
      ),
    ),
  ]);
}

export async function runAnalysisPipeline(site: Site, meter: Meter | null, userId: number, tier: string): Promise<PipelineResult> {
  const t0 = Date.now();
  const analysisId = await h.createAnalysis({ siteId: site.id, userId, status: "running" });
  try {
    const result = await timeoutGuard(execute(site, meter, userId, tier, analysisId));
    const durationMs = Date.now() - t0;
    const computeCost = await recordMeterEvent({ userId, analysisId, kind: "analysis_pipeline", computeMs: durationMs, tier });
    result.marginalCostUsd += computeCost;
    await h.updateAnalysis(analysisId, {
      status: "complete",
      durationMs,
      marginalCostUsd: result.marginalCostUsd,
      completedAt: new Date(),
      weatherBasis: LABEL_NORMAL_YEAR,
      stagesCompleted: ["demand", "baseline", "tariff", "benchmark", "emissions", "insights", "opportunities"],
    });
    await h.audit(userId, "analysis_complete", "analysis", String(analysisId), { siteId: site.id, durationMs });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Cycle 5, pass 209: failed/timed-out analyses still consumed compute —
    // record the metering event on the failure path too so the free-tier cost
    // cap can never be dodged by aborted runs; metering failure must not mask
    // the original error.
    const failDurationMs = Date.now() - t0;
    // Batch-14 (pass 129): persist the failure-path compute cost onto the
    // analysis row too — the metering table already counted it toward the cap,
    // but the analysis record showed $0 for failed runs, understating displayed
    // marginal cost.
    let failCost = 0;
    try {
      failCost = await recordMeterEvent({ userId, analysisId, kind: "analysis_pipeline_failed", computeMs: failDurationMs, tier });
    } catch (meterErr) {
      console.error("[pipeline] failed to record meter event for failed analysis", analysisId, meterErr);
    }
    // Batch-35 (pass 1319a): typed check — only the compute-budget guard's own
    // rejection classifies as 'timeout'; all other failures persist as 'failed'.
    const isComputeTimeout = e instanceof AnalysisTimeoutError;
    await h.updateAnalysis(analysisId, { status: isComputeTimeout ? "timeout" : "failed", error: msg, durationMs: failDurationMs, marginalCostUsd: failCost });
    await h.audit(userId, "analysis_failed", "analysis", String(analysisId), { siteId: site.id, error: msg, durationMs: failDurationMs });
    throw e;
  }
}

async function execute(site: Site, meter: Meter | null, userId: number, tier: string, analysisId: number): Promise<PipelineResult> {
  // Cycle 9 (pass 505, extended): pipeline shares the ZIP/state-inferred zone
  // fallback rather than assuming the hot-arid AZ default for every site.
  const climateZone = site.climateZone ?? inferClimateZone(site.zip ?? undefined, site.state ?? undefined);
  const station = await h.getWeatherStation(climateZone);
  const normals = (station?.monthlyNormals ?? []) as MonthNormalRow[];

  /* ---------- stage 1: interval data + demand analytics ---------- */
  let points: IntervalPoint[] = [];
  if (meter) {
    const rows = await h.getIntervalPoints(meter.id, userId);
    points = rows.map((r) => ({ ts: r.ts, durationMin: r.durationMin, usage: r.usage, demand: r.demand }));
  }
  const hasIntervals = points.length >= 10;
  // Cycle 3 (passes 36/66): all hour-of-day logic runs in the meter's IANA
  // timezone, never the server's.
  const tz = meter?.timezone ?? DEFAULT_TZ;
  const demand = hasIntervals ? computeDemandAnalytics(points, 4, [6, 7, 8, 9], tz) : null;

  /* ---------- stage 2: baseline ---------- */
  let baseline: BaselineFit | null = null;
  let archetypeHourly: number[] | null = null;
  let disaggMethod: "archetype_prior_only" | "regression_split" | "nilmtk_1min_plus" = "archetype_prior_only";
  let endUseFractions: Record<string, number> | null = null;

  const arch = await h.getArchetype(site.buildingType ?? "office", climateZone, vintageBand(site.vintage));
  if (arch) endUseFractions = arch.endUseFractions as Record<string, number>;

  let anomalyResult: AnomalyResult | null = null;
  if (hasIntervals) {
    const monthly = intervalsToMonthly(points);
    const temps = normalsAsDailyTemps(monthly.map((m) => m.month), normals);
    baseline = fitCaltrackMonthly(monthly, temps, normals, { weatherIsNormalsProxy: true });
    // A4: residual anomaly detection (>10% deviation from weather model +
    // sustained change-point). Honest gates inside: needs valid fit + ≥6 months.
    anomalyResult = detectResidualAnomalies(monthly, temps, baseline);
    // NILMTK gate (Cycle 4): <1-min data → regression_split at best, never nilmtk
    const resolutionMin = points[0]?.durationMin ?? 15;
    disaggMethod = resolutionMin < 1 ? "nilmtk_1min_plus" : "regression_split";
  } else if (site.sqft && arch) {
    const outOfRange =
      (arch.calibMinSqft != null && site.sqft < arch.calibMinSqft) || (arch.calibMaxSqft != null && site.sqft > arch.calibMaxSqft);
    const calibMid =
      arch.calibMinSqft != null && arch.calibMaxSqft != null ? (arch.calibMinSqft + arch.calibMaxSqft) / 2 : (arch.calibMaxSqft ?? arch.calibMinSqft ?? null);
    const ab = archetypeBaseline(arch.shape8760 as number[], arch.annualUsePerSqft, site.sqft, {
      outOfCalibrationRange: !!outOfRange,
      calibMidSqft: calibMid,
    });
    baseline = ab.fit;
    archetypeHourly = ab.hourly;
    disaggMethod = "archetype_prior_only";
  }

  if (baseline && meter) {
    await h.saveBaseline({
      siteId: site.id,
      meterId: meter.id,
      method: baseline.method === "caltrack_monthly" ? "billing_hdd_cdd" : "archetype_synthetic",
      commodity: meter.commodity,
      params: baseline.coefficients,
      rSquared: baseline.rSquared,
      cvrmse: baseline.cvrmse,
      trainStart: points[0]?.ts ?? null,
      trainEnd: points[points.length - 1]?.ts ?? null,
      weatherBasis: baseline.weatherBasis,
      confidenceLabel: baseline.confidenceLabel,
      source: station ? `noaa_normals:${station.stationId}` : "noaa_normals:default",
    });
  } else if (baseline && !meter) {
    await h.saveBaseline({
      siteId: site.id,
      method: "archetype_synthetic",
      commodity: "electric",
      params: baseline.coefficients,
      rSquared: null,
      cvrmse: null,
      weatherBasis: baseline.weatherBasis,
      confidenceLabel: baseline.confidenceLabel,
      source: arch ? `${arch.source}:${arch.sourceVersion ?? ""}` : "prototype-archetype",
    });
  }

  /* ---------- stage 3: tariff check (current + sweep) ---------- */
  const costPoints = hasIntervals ? points : archetypeHourly ? hourlyPoints(archetypeHourly) : [];
  let currentCost: CostResult | null = null;
  const comparisons: TariffComparison[] = [];
  if (costPoints.length > 0) {
    // Commodity-aware sweep: a water/gas meter must never be costed on electric
    // rates (caught by AC3 acceptance test). If no tariffs exist for the
    // commodity, the comparison is legitimately empty.
    const allTariffs = await h.listTariffs(meter?.commodity ?? "electric", site.state ?? undefined);
    const current = meter?.currentTariffId ? allTariffs.find((t) => t.id === meter.currentTariffId) : undefined;
    const utilityTariffs = allTariffs.filter(
      (t) => !site.utilityName || t.utilityName.toLowerCase().includes((site.utilityName ?? "").toLowerCase().split(" ")[0]),
    );
    const peakKw = demand?.peakKw ?? null;
    const sectorClass = site.buildingType && ["single_family", "multifamily"].includes(site.buildingType) ? "residential" : "commercial";
    const isElig = (t: (typeof allTariffs)[number]) =>
      tariffEligible({ sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin, peakKwMax: t.peakKwMax }, { sectorClass }, peakKw).eligible;
    // Sweep = same-utility rates plus any eligible rates statewide (a large site
    // may have no eligible rate at its own utility in the seeded snapshot).
    const eligibleAnywhere = allTariffs.filter(isElig);
    const sweepSet = new Map<number, (typeof allTariffs)[number]>();
    for (const t of [...utilityTariffs, ...eligibleAnywhere]) sweepSet.set(t.id, t);
    const sweep = sweepSet.size > 0 ? Array.from(sweepSet.values()) : allTariffs;

    // Current basis: assigned tariff → else first ELIGIBLE same-utility rate →
    // else first eligible rate statewide → else first same-utility rate.
    const basis =
      current ??
      utilityTariffs.find(isElig) ??
      eligibleAnywhere[0] ??
      utilityTariffs[0] ??
      sweep[0];
    // Batch-31 (pass 1099): every candidate in the basis chain descends from
    // `allTariffs`, which listTariffs() filters by the METER'S commodity (line
    // above), so a cross-commodity basis cannot arise from the fallback ladder.
    // The one path that CAN cross commodities is a manually assigned
    // currentTariffId pointing at a rate for a different commodity — `current`
    // is looked up inside the commodity-filtered list, so a mismatched
    // assignment simply won't be found and the ladder proceeds with matched
    // rates. Assert the invariant cheaply rather than trusting it silently.
    if (basis && meter?.commodity && basis.commodity !== meter.commodity) {
      // Defensive: should be unreachable per the filtering above.
      currentCost = null;
    } else if (basis) {
      currentCost = costOnTariff(costPoints, basis.structure as TariffStructure, { tz });
    }
    // Batch-13 (pass 60): when the LAST-RESORT basis (first same-utility rate,
    // possibly ineligible) is used, every downstream dollar figure is priced on
    // a rate the customer may not qualify for — disclose it, never silently.
    if (basis && !current && !isElig(basis) && currentCost) {
      currentCost.disclosures.push(
        // Batch-32 (pass 1179): scope the limitation to the CURRENT-COST baseline
        // explicitly — rows marked eligible in the comparison table remain valid
        // options; only the baseline (and thus the savings deltas) is reference-only.
        "No rate in the seeded tariff snapshot is eligible for this site's sector/size — the CURRENT-COST baseline uses the nearest available rate as a reference only, so savings-vs-current figures are also reference-only. Rates marked eligible in the comparison table are still rates this site may qualify for. Assign your actual tariff for accurate figures.",
      );
    }
    const basisTariffId = basis?.id ?? null;

    // Batch-26 (pass 899): the comparison table must always contain the tariff
    // the current-cost figure was computed on. Two ways the basis could vanish:
    // (a) an assigned `current` tariff outside utilityTariffs/eligibleAnywhere
    // was never in sweepSet; (b) the 24-row slice cut it off. Insert the basis
    // into the sweep and hoist it to the front so neither can hide it.
    let sweepRows = sweep;
    if (basis) {
      sweepRows = [basis, ...sweep.filter((t) => t.id !== basis.id)];
    }

    // Batch-35 (pass 1319b): if no current-cost basis could be established
    // (basis null — empty sweep — or the defensive commodity guard zeroed it),
    // computing savings against a phantom $0 baseline would inflate every row
    // into fake "savings". Null the deltas and disclose instead.
    const hasCostBasis = currentCost != null;
    const currentTotal = currentCost?.breakdown.total ?? 0;
    for (const t of sweepRows.slice(0, 24)) {
      const elig = tariffEligible(
        { sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin, peakKwMax: t.peakKwMax },
        { sectorClass },
        peakKw,
      );
      const cost = elig.eligible ? costOnTariff(costPoints, t.structure as TariffStructure, { tz }) : null;
      comparisons.push({
        tariffId: t.id,
        tariffName: t.name,
        utilityName: t.utilityName,
        freshness: t.freshness,
        isCurrentBasis: t.id === basisTariffId,
        eligible: elig.eligible,
        ineligibleReason: elig.reason,
        annualCost: cost?.breakdown ?? { energy: 0, demand: 0, fixed: 0, cp: null, cpMethodology: "cp_omitted_no_interval_data", total: 0 },
        // Batch-38 (pass 1559): NULL — not 0 — when no current-cost basis
        // exists. The UI already renders "— (no current-cost baseline)", but raw
        // API/export consumers received a literal 0 indistinguishable from a
        // genuine break-even delta. Null is the machine-readable equivalent.
        savingsVsCurrent: cost && hasCostBasis ? currentTotal - cost.breakdown.total : null,
        // Batch-34 (pass 1279): when the platform already KNOWS the rate is
        // ineligible, telling the user to "confirm final eligibility" was
        // contradictory — the specific reason replaces the generic caveat.
        eligibilityNote: elig.reason
          ? `Ineligible: ${elig.reason}`
          : "Eligibility checked on sector and peak-demand size bounds only; voltage class and customer-class minimums are not in the seeded tariff snapshot — confirm final eligibility with your utility.",
      });
    }
    // Cycle 5: stale demotion — fresh/verified rank above stale at equal savings.
    // Batch-15 (pass 149) adjudication: this ordering is INTENTIONAL — a stale
    // rate's computed "savings" may be mispriced by the very staleness that
    // demoted it, so promoting a stale-but-bigger-savings row above verified
    // rates would rank unreliable figures first. Savings ranks within each
    // freshness class; eligibility outranks both.
    comparisons.sort((a, b) => {
      if (!a.eligible !== !b.eligible) return a.eligible ? -1 : 1;
      const freshRank = (f: string) => (f === "verified" || f === "urdb_refreshed_150" || f === "manual" ? 0 : 1);
      if (freshRank(a.freshness) !== freshRank(b.freshness)) return freshRank(a.freshness) - freshRank(b.freshness);
      return (b.savingsVsCurrent ?? 0) - (a.savingsVsCurrent ?? 0);
    });
  }

  /* ---------- stage 4: benchmarking ---------- */
  let benchmark: PipelineResult["benchmark"] = null;
  const annualUsage = baseline?.normalizedAnnualUsage ?? (hasIntervals ? annualize(points) : null);
  // Cycle 5, pass 149: when the data span is too short to annualize (<25 days)
  // benchmark and emissions are intentionally omitted — say so explicitly
  // instead of silently showing nothing.
  const annualizeBlocked = annualUsage == null && baseline == null && hasIntervals;
  if (site.sqft && annualUsage != null && site.buildingType) {
    const bench = await h.getBenchmark(site.buildingType, meter?.commodity ?? "electric");
    if (bench) {
      const siteEui = annualUsage / site.sqft; // kWh/sqft/yr for electric benchmark
      const pct = benchmarkPercentile(siteEui, { medianEui: bench.medianEui, p25Eui: bench.p25Eui, p75Eui: bench.p75Eui });
      benchmark = { siteEui, percentileBand: pct.percentileBand, betterThanMedian: pct.betterThanMedian, source: `${bench.source} (${bench.sourceVersion})` };
    }
  }

  /* ---------- stage 5: emissions ---------- */
  // eGRID CO2e factors are lb/MWh of ELECTRICITY — applying them to gas therms
  // or water gallons would fabricate emissions (caught by AC3 acceptance test).
  // Scope-1 gas factors / water embodied energy are a disclosed MVP gap.
  let emissions: PipelineResult["emissions"] = null;
  if (annualUsage != null && (meter?.commodity ?? "electric") === "electric") {
    const zip3 = (site.zip ?? "850").slice(0, 3);
    const { factor, subregion, mapped } = await h.getEmissionsFactor(zip3);
    if (factor) {
      emissions = { annualCo2eLb: (annualUsage / 1000) * factor.co2eLbPerMwh, subregion, factorYear: factor.year, mapped };
    }
  }

  /* ---------- stage 6: insights ---------- */
  const insightRows: Parameters<typeof h.replaceInsights>[1] = [];
  const dis = DISAGG_LANGUAGE[disaggMethod];

  // Progressive participation (Jul 2026): quick-start sites run on DISCLOSED
  // placeholder attributes. replaceInsights below wipes the creation-time
  // disclosure, so the pipeline re-emits it on every run while placeholders
  // remain in effect (attrSource still quick_start_defaults) — the assumption
  // list also powers the dashboard's "add detail" chips.
  if (site.attrSource === "quick_start_defaults") {
    const qsParse = { raw: site.address ?? "", state: site.state, zip: site.zip, city: site.city };
    const qsAssumptions = quickStartAssumptions(qsParse).filter(
      // once real interval data exists, drop the interval-data assumption line
      (a) => !(a.field === "intervalData" && hasIntervals),
    );
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "intake_assumptions",
      title: "Quick-start analysis — placeholder assumptions in effect",
      body:
        `This analysis uses disclosed quick-start placeholders: ` +
        qsAssumptions.map((a) => `${a.field} → ${a.assumed}`).join("; ") +
        `. Refine any field (optional) to replace its placeholder — each "add detail" chip shows what it unlocks.`,
      severity: "info",
      disaggregationMethod: disaggMethod,
      confidence: "low",
      provenance: { method: "quick_start_intake_v1", parsedState: site.state, parsedZip: site.zip },
      metrics: { assumptions: qsAssumptions },
    });
  }

  if (annualizeBlocked) {
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "data_coverage",
      // Batch-39 (pass 1659): the suppression list must be COMPLETE — the
      // usage-scaled efficiency opportunities (HVAC tune-up, LED retrofit,
      // baseload reduction) are also gated on annualized usage, and omitting
      // them silently read as "no opportunities exist" for short-history sites.
      title: "Data span too short to annualize — benchmarking, emissions, and usage-scaled opportunities omitted",
      body: "Your interval data covers fewer than 25 days, which is too short to reliably annualize usage. EUI benchmarking, annual emissions estimates, and usage-scaled savings opportunities (HVAC tune-up, LED retrofit, after-hours baseload reduction) are omitted rather than extrapolated from a short window — their absence does NOT mean no savings exist. Rate comparisons and demand-based findings still use your real data. Upload at least ~1 month of data (ideally 12 months) to unlock the rest.",
      severity: "warning",
      disaggregationMethod: disaggMethod,
      confidence: "high",
      provenance: { method: "annualize_span_gate", minSpanDays: 25 },
      metrics: { pointCount: points.length },
    });
  }

  if (demand) {
    if (demand.loadFactor < 0.35) {
      insightRows.push({
        siteId: site.id,
        meterId: meter?.id ?? null,
        analysisId,
        kind: "load_factor",
        title: `Low load factor (${(demand.loadFactor * 100).toFixed(0)}%) — demand charges are outsized for your usage`,
        body: `Your average load is only ${(demand.loadFactor * 100).toFixed(0)}% of your peak (${demand.peakKw.toFixed(1)} kW at ${new Date(demand.peakTimestamp).toLocaleString("en-US", { timeZone: tz })}). Flattening short peaks (staggering equipment starts, load scheduling) directly reduces demand charges.`,
        severity: "opportunity",
        disaggregationMethod: disaggMethod,
        confidence: "high",
        provenance: { source: "interval_data", method: "demand_analytics" },
        metrics: { loadFactor: demand.loadFactor, peakKw: demand.peakKw },
      });
    }
    if (demand.cpProxy) {
      insightRows.push({
        siteId: site.id,
        meterId: meter?.id ?? null,
        analysisId,
        kind: "cp_exposure",
        title: `Coincident-peak exposure: top ${demand.cpProxy.topN} summer peaks identified (${LABEL_CP_ESTIMATED})`,
        body: `Your highest summer-season demand events are the best available proxy for coincident-peak billing exposure. These values are ${LABEL_CP_ESTIMATED} — actual ISO/utility system-peak timing may differ materially.`,
        severity: "info",
        disaggregationMethod: disaggMethod,
        confidence: "medium",
        provenance: { method: "cp_proxy_top_n_customer_peaks", topN: demand.cpProxy.topN },
        metrics: { events: demand.cpProxy.events },
      });
    }
  }
  if (baseline) {
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "baseline",
      title: `Weather-normalized baseline established (${baseline.confidenceLabel})`,
      body: `${baseline.disclosures.join(" ")} Annualized usage on ${LABEL_NORMAL_YEAR}: ${Math.round(baseline.normalizedAnnualUsage).toLocaleString()} kWh/yr.`,
      severity: "info",
      disaggregationMethod: disaggMethod,
      confidence: baseline.confidence,
      provenance: { method: baseline.method, weatherBasis: baseline.weatherBasis },
      metrics: { rSquared: baseline.rSquared, cvrmse: baseline.cvrmse, normalizedAnnualUsage: baseline.normalizedAnnualUsage },
    });
  }
  if (endUseFractions) {
    const ranges = Object.entries(endUseFractions)
      .filter(([, v]) => v > 0.02)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${(Math.max(0, v - 0.08) * 100).toFixed(0)}–${(Math.min(1, v + 0.08) * 100).toFixed(0)}%`)
      .join(", ");
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "end_use",
      title: `End-use breakdown (${dis.label})`,
      body: `${ranges}. ${dis.disclaimer}`,
      severity: "info",
      disaggregationMethod: disaggMethod,
      confidence: disaggMethod === "archetype_prior_only" ? "low" : "medium",
      provenance: { source: arch?.source, sourceVersion: arch?.sourceVersion },
      metrics: { endUseFractions },
    });
  }
  // A4: anomaly insights — sustained shift is a warning (operational change),
  // isolated spikes/drops are informational. Only emitted when the detector
  // actually ran (valid weather fit + ≥6 months), never from fallback fits.
  if (anomalyResult && anomalyResult.anomalies.length > 0) {
    const shift = anomalyResult.changePointMonth;
    const spikes = anomalyResult.anomalies.filter((a) => a.kind === "single_month_spike");
    const drops = anomalyResult.anomalies.filter((a) => a.kind === "single_month_drop");
    const parts: string[] = [];
    if (shift) {
      const shiftMonths = anomalyResult.anomalies.filter((a) => a.kind === "sustained_shift");
      const dir = shiftMonths[0] && shiftMonths[0].residualPct > 0 ? "above" : "below";
      parts.push(
        `Sustained shift since ${shift}: ${shiftMonths.length} consecutive month(s) run >10% ${dir} the weather-normalized model — consistent with an operational or equipment change rather than weather.`,
      );
    }
    if (spikes.length > 0) parts.push(`${spikes.length} isolated month(s) spiked >10% above the model: ${spikes.map((a) => `${a.month} (+${(a.residualPct * 100).toFixed(0)}%)`).join(", ")}.`);
    if (drops.length > 0) parts.push(`${drops.length} isolated month(s) fell >10% below the model: ${drops.map((a) => `${a.month} (${(a.residualPct * 100).toFixed(0)}%)`).join(", ")}.`);
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "anomaly",
      title: shift
        ? `Consumption change-point detected (${shift}) — usage shifted vs. weather model`
        : `${anomalyResult.anomalies.length} month(s) deviate >10% from your weather-normalized baseline`,
      body: `${parts.join(" ")} ${anomalyResult.disclosures.join(" ")}`,
      severity: shift ? "warning" : "info",
      disaggregationMethod: disaggMethod,
      confidence: baseline && baseline.confidence === "high" ? "medium" : "low",
      provenance: { method: anomalyResult.method, changePointMonth: shift },
      metrics: { anomalies: anomalyResult.anomalies },
    });
  }

  // Cycle 6 finding 13: free-tier solar teaser for high-solar-resource zones
  const highSolarZones = ["2B", "3B", "2A"];
  if (highSolarZones.includes(climateZone)) {
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "solar_resource",
      title: "This site is in a high-solar-resource zone",
      body:
        tier === "free"
          ? "Sites in this climate zone have among the highest solar yields in the US (~1,700+ kWh/kW-yr typical). Full solar feasibility modeling with your tariff's export rates is available in Plus."
          : "Sites in this climate zone have among the highest solar yields in the US. Run the solar scenario to model production against your tariff's export rates.",
      severity: "opportunity",
      disaggregationMethod: disaggMethod,
      confidence: "high",
      provenance: { source: "climate_zone_classification" },
      metrics: { climateZone },
    });
  }
  // Machine-readable summary row: persists demand analytics (incl. heatmap),
  // benchmark, emissions, current cost, and tariff comparisons so the dashboard
  // KPI cards and panels survive page reloads (live-E2E pass-1 finding).
  insightRows.push({
    siteId: site.id,
    meterId: meter?.id ?? null,
    analysisId,
    kind: "summary",
    title: "Analysis summary (machine-readable)",
    body: MODELED_ESTIMATES_DISCLAIMER,
    severity: "info",
    disaggregationMethod: disaggMethod,
    confidence: baseline?.confidence ?? "low",
    provenance: { method: "pipeline_summary_v1" },
    metrics: {
      demand,
      benchmark,
      emissions,
      currentCost,
      tariffComparisons: comparisons,
      baseline: baseline
        ? {
            method: baseline.method,
            rSquared: baseline.rSquared,
            cvrmse: baseline.cvrmse,
            confidence: baseline.confidence,
            confidenceLabel: baseline.confidenceLabel,
            normalizedAnnualUsage: baseline.normalizedAnnualUsage,
            weatherBasis: baseline.weatherBasis,
          }
        : null,
    },
  });
  await h.replaceInsights(site.id, insightRows);

  /* ---------- stage 7: opportunities ---------- */
  const oppCands: OpportunityCandidate[] = [];
  // Batch-18 (pass 419): pass the raw window total so short-history sites (<25
  // days, annualUsage null) still get their real blended rate instead of the
  // $0.12 fallback — the rate is window-invariant even when annualization isn't.
  const { rate: kWhRate, isFallback: rateIsFallback, fallbackReason } = estimateBlendedRate(currentCost, annualUsage, hasIntervals ? totalImportKwh(points) : null);
  // Batch-19 (pass 539): the disclosure names the actual cause — a customer
  // with usage data but no identified tariff was being told their "cost basis
  // could not be established", which misdirects them toward re-uploading data
  // instead of selecting a tariff.
  const fallbackRateDisclosure =
    fallbackReason === "no_tariff_cost_basis"
      ? "Savings priced at a $0.12/kWh national-average assumption because no tariff could be identified to compute your real rate — select or verify your tariff to price savings at your actual rate."
      : "Savings priced at a $0.12/kWh national-average assumption because your annual cost basis could not be established — actual savings scale with your real rate.";
  if (demand && currentCost) {
    const anyRatchet = currentCost.monthlyDetails.some((m) => m.ratchetApplied);
    const demandRate = currentCost.breakdown.demand > 0 && demand.peakKw > 0 ? currentCost.breakdown.demand / 12 / demand.peakKw : 0;
    if (demand.loadFactor < 0.45 && demandRate > 0) {
      // post-ratchet achievable reduction (Cycle 4): if ratchet active, sustained reduction needed
      const rawShave = demand.peakKw * 0.1;
      const achievable = anyRatchet ? rawShave * 0.5 : rawShave;
      oppCands.push({
        key: "peak_management",
        title: "Peak demand management (staggered starts, load scheduling)",
        category: "demand",
        annualSavingsUsdLo: achievable * demandRate * 12 * 0.5,
        annualSavingsUsdHi: achievable * demandRate * 12,
        capexBand: "low",
        confidence: "medium",
        rationale: anyRatchet
          ? "Savings reflect post-ratchet achievable reduction — your tariff's ratchet clause means one-month reductions do not reduce billed demand until the ratchet window rolls off."
          : "Estimated from shaving ~10% of monthly peaks at your tariff's demand rate.",
        disclosures: [MODELED_ESTIMATES_DISCLAIMER],
      });
    }
  }
  if (endUseFractions?.cooling && annualUsage != null && endUseFractions.cooling > 0.25) {
    const coolKwh = annualUsage * endUseFractions.cooling;
    oppCands.push({
      key: "hvac_tuneup",
      title: "HVAC tune-up / smart thermostat scheduling",
      category: "efficiency",
      annualSavingsUsdLo: coolKwh * 0.05 * kWhRate,
      annualSavingsUsdHi: coolKwh * 0.15 * kWhRate,
      capexBand: "low",
      confidence: disaggMethod === "archetype_prior_only" ? "low" : "medium",
      rationale: `Cooling is an estimated ${(endUseFractions.cooling * 100).toFixed(0)}% of annual use (${dis.label}). 5–15% cooling savings from setpoint/schedule optimization is typical.`,
      disclosures: rateIsFallback ? [dis.disclaimer, fallbackRateDisclosure] : [dis.disclaimer],
    });
  }
  if (endUseFractions?.lighting && annualUsage != null && endUseFractions.lighting > 0.1) {
    const lightKwh = annualUsage * endUseFractions.lighting;
    oppCands.push({
      key: "led_retrofit",
      title: "LED lighting retrofit",
      category: "efficiency",
      annualSavingsUsdLo: lightKwh * 0.3 * kWhRate,
      annualSavingsUsdHi: lightKwh * 0.55 * kWhRate,
      capexBand: "medium",
      confidence: disaggMethod === "archetype_prior_only" ? "low" : "medium",
      rationale: `Lighting is an estimated ${(endUseFractions.lighting * 100).toFixed(0)}% of annual use (${dis.label}). LED conversion typically cuts lighting energy 30–55%.`,
      disclosures: rateIsFallback ? [dis.disclaimer, fallbackRateDisclosure] : [dis.disclaimer],
    });
  }
  if (demand && annualUsage != null) {
    // overnight baseload from interval data (regression_split evidence)
    const baseloadKw = overnightBaseload(points, tz);
    if (baseloadKw != null && demand.avgKw > 0 && baseloadKw / demand.avgKw > 0.55) {
      oppCands.push({
        key: "baseload_reduction",
        title: "After-hours baseload reduction (equipment shutdown audit)",
        category: "operations",
        // Savings apply only during unoccupied hours (~12 h/night × 365 + weekend
        // adjustment ≈ 4,900 h/yr for a typical single-shift facility), NOT 8760 h —
        // an overnight-measured baseload cannot be "saved" during occupied hours.
        // Batch-15 (pass 149): the low estimate maps directly to the 10% reduction
        // named in the rationale — the earlier extra ×0.5 made the displayed range
        // inconsistent with the stated 10–25% reduction band.
        annualSavingsUsdLo: baseloadKw * 0.1 * AFTER_HOURS_PER_YEAR * kWhRate,
        annualSavingsUsdHi: baseloadKw * 0.25 * AFTER_HOURS_PER_YEAR * kWhRate,
        capexBand: "none",
        confidence: "medium",
        rationale: `Overnight baseload averages ${baseloadKw.toFixed(1)} kW — ${((baseloadKw / demand.avgKw) * 100).toFixed(0)}% of your average load runs 24/7. Measured directly from your interval data. Savings estimated over ~${AFTER_HOURS_PER_YEAR.toLocaleString()} unoccupied hours/year.`,
        disclosures: rateIsFallback ? [MODELED_ESTIMATES_DISCLAIMER, fallbackRateDisclosure] : [MODELED_ESTIMATES_DISCLAIMER],
      });
    }
  }
  // Batch-38 (pass 1559): savingsVsCurrent is null when no cost basis exists —
  // the `> 50` predicate already excludes null rows (null > 50 is false), but
  // the explicit check documents it and satisfies the narrowed type.
  const bestSwitch = comparisons.find((c) => c.eligible && c.savingsVsCurrent != null && c.savingsVsCurrent > 50);
  if (bestSwitch) {
    oppCands.push({
      key: "rate_switch",
      title: `Rate switch: ${bestSwitch.tariffName}`,
      category: "tariff",
      // Batch-34 (pass 1269): a rate switch is a deterministic repricing of the
      // measured load — the old 0.6 haircut on the lower bound misrepresented a
      // computed figure as uncertain. Both bounds now equal the repriced savings;
      // the residual (future load drift) is disclosed in the rationale instead.
      annualSavingsUsdLo: bestSwitch.savingsVsCurrent!,
      annualSavingsUsdHi: bestSwitch.savingsVsCurrent!,
      capexBand: "none",
      confidence: bestSwitch.freshness === "urdb_stale" ? "low" : "medium",
      rationale:
        bestSwitch.freshness === "urdb_stale"
          ? "Rate data unverified — structure may have changed; verify current rates with your utility before switching."
          : "Re-priced your actual load profile on this tariff's published structure — exact for the observed period; assumes your load pattern repeats.",
      disclosures: [MODELED_ESTIMATES_DISCLAIMER],
    });
  }
  const ranked = rankOpportunities(oppCands);
  await h.replaceOpportunities(
    site.id,
    ranked.map((c, i) => ({
      siteId: site.id,
      analysisId,
      measure: c.key,
      title: c.title,
      description: `${c.rationale} ${c.disclosures.join(" ")}`,
      estCostSavingsPerYr: (c.annualSavingsUsdLo + c.annualSavingsUsdHi) / 2,
      estEnergySavingsPerYr: null,
      energyUnit: COMMODITY_UNITS.electric.usageUnit,
      estDemandSavingsKw: c.key === "peak_management" && demand ? demand.peakKw * 0.1 : null,
      paybackBandYears: c.capexBand === "none" ? "immediate" : c.capexBand === "low" ? "0.5–2 yr" : "2–6 yr",
      confidence: c.confidence,
      disaggregationMethod: disaggMethod,
      ratchetAware: c.key === "peak_management",
      rank: i + 1,
      provenance: { savingsRange: [c.annualSavingsUsdLo, c.annualSavingsUsdHi], category: c.category },
    })),
  );

  return {
    analysisId,
    demand,
    baseline,
    currentCost,
    tariffComparisons: comparisons,
    benchmark,
    emissions,
    insightsCount: insightRows.length,
    opportunitiesCount: ranked.length,
    // Batch-19 (pass 539, adjudication corrected): this 0 is the INITIAL value,
    // not a final override — execute() cannot know its own compute cost while
    // still running. runAnalysisPipeline() meters the full wall-clock duration
    // AFTER execute() resolves and does `result.marginalCostUsd += computeCost`
    // on this same object before returning/persisting it, so callers and the
    // analyses row always see the accumulated cost, never this literal.
    marginalCostUsd: 0,
    disclaimer: MODELED_ESTIMATES_DISCLAIMER,
  };
}

/* ---------------- helpers ---------------- */
function vintageBand(vintage: number | null): string {
  if (vintage == null) return "all";
  if (vintage < 1980) return "pre1980";
  if (vintage < 2004) return "1980-2003";
  return "2004+";
}

function hourlyPoints(hourly: number[], refYear = 2025): IntervalPoint[] {
  const start = new Date(refYear, 0, 1).getTime();
  // Batch-13 (pass 63, adjudicated): for 60-minute intervals, kWh-per-hour and
  // average kW are numerically identical (kW = kWh × 60 / 60), so demand = usage
  // is exact — not an approximation. If synthetic resolution ever changes,
  // demand must become usage × 60 / durationMin.
  return hourly.map((usage, hIdx) => ({ ts: start + hIdx * 3600_000, durationMin: 60, usage, demand: usage }));
}

function annualize(points: IntervalPoint[]): number | null {
  if (points.length === 0) return null;
  // Batch-13 (pass 59): import-only sum — negative (export) intervals are
  // excluded so annualized CONSUMPTION isn't understated for solar sites; this
  // matches the benchmark definition (site EUI uses gross consumption).
  const total = points.reduce((a, p) => a + Math.max(0, p.usage), 0);
  const spanMs = points[points.length - 1].ts + points[points.length - 1].durationMin * 60000 - points[0].ts;
  const spanDays = spanMs / 86_400_000;
  if (spanDays < 25) return null;
  return (total / spanDays) * 365;
}

/** Raw import-only usage total with NO minimum-span gate — rate estimation only.
 * Batch-18 (pass 419): annualize()'s 25-day gate exists so short spans don't get
 * extrapolated into fake ANNUAL figures (benchmarking/emissions). But a blended
 * $/kWh rate is span-invariant (cost and usage cover the same window), so a
 * short history can still yield the customer's real rate — falling back to the
 * generic $0.12 there was silently mispricing opportunities for new sites. */
function totalImportKwh(points: IntervalPoint[]): number {
  return points.reduce((a, p) => a + Math.max(0, p.usage), 0);
}

function estimateBlendedRate(
  cost: CostResult | null,
  annualUsage: number | null,
  rawUsageKwh?: number | null,
): { rate: number; isFallback: boolean; fallbackReason?: "no_tariff_cost_basis" | "no_usage_data" } {
  // All-in blended rate: total annual cost (energy + demand + fixed + CP − export)
  // per kWh (cycle 1, passes 9/19). Energy-only understates ¢/kWh on
  // demand-heavy tariffs and inflates opportunity paybacks.
  // Cycle 3, pass 69: no fabricated $0.05 floor — a genuinely low blended rate
  // (large industrial, heavy solar export) must flow through honestly; only
  // guard against degenerate non-positive values.
  // Cycle 10 (pass 549): when no cost basis exists, the $0.12 national-average
  // fallback is flagged so callers disclose it instead of silently pricing
  // savings on a rate the customer may not pay.
  if (cost && annualUsage && annualUsage > 0) {
    const r = cost.breakdown.total / annualUsage;
    if (Number.isFinite(r) && r > 0) return { rate: r, isFallback: false };
  }
  // Batch-18 (pass 419): short-history path — annualUsage is null when the span
  // is <25 days, but the blended rate over the observed window is still the
  // site's real rate. Cost here is the WINDOW total (CostResult covers the
  // bill/interval window), so dividing by the same window's kWh is unit-safe.
  if (cost && rawUsageKwh && rawUsageKwh > 0) {
    const r = cost.breakdown.total / rawUsageKwh;
    if (Number.isFinite(r) && r > 0) return { rate: r, isFallback: false };
  }
  // Batch-19 (pass 539): name WHY the fallback fired so the disclosure can be
  // accurate — "no tariff/cost basis" (usage exists but no cost could be
  // computed, e.g. no tariff identified) is a different customer situation
  // from "no usage data at all", and the generic wording blamed the wrong
  // cause in the former case.
  return {
    rate: 0.12,
    isFallback: true,
    fallbackReason: (annualUsage && annualUsage > 0) || (rawUsageKwh && rawUsageKwh > 0) ? "no_tariff_cost_basis" : "no_usage_data",
  };
}

/** Mean kW between 01:00–04:00 in the meter's local timezone — the honest baseload estimator. */
function overnightBaseload(points: IntervalPoint[], tz: string): number | null {
  const vals: number[] = [];
  for (const p of points) {
    const hr = localParts(p.ts, tz).hour;
    if (hr >= 1 && hr < 4) {
      const kw = p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0);
      if (Number.isFinite(kw)) vals.push(kw);
    }
  }
  if (vals.length < 20) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
