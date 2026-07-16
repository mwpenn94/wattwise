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
} from "../../shared/wattwise";
import {
  fitCaltrackMonthly,
  intervalsToMonthly,
  normalsAsDailyTemps,
  archetypeBaseline,
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

function timeoutGuard<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Analysis exceeded ${ANALYSIS_TIMEOUT_MS / 1000}s compute timeout`)), ANALYSIS_TIMEOUT_MS)),
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
    try {
      await recordMeterEvent({ userId, analysisId, kind: "analysis_pipeline_failed", computeMs: failDurationMs, tier });
    } catch (meterErr) {
      console.error("[pipeline] failed to record meter event for failed analysis", analysisId, meterErr);
    }
    await h.updateAnalysis(analysisId, { status: msg.includes("timeout") ? "timeout" : "failed", error: msg, durationMs: failDurationMs });
    await h.audit(userId, "analysis_failed", "analysis", String(analysisId), { siteId: site.id, error: msg, durationMs: failDurationMs });
    throw e;
  }
}

async function execute(site: Site, meter: Meter | null, userId: number, tier: string, analysisId: number): Promise<PipelineResult> {
  const climateZone = site.climateZone ?? "2B";
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

  if (hasIntervals) {
    const monthly = intervalsToMonthly(points);
    const temps = normalsAsDailyTemps(monthly.map((m) => m.month), normals);
    baseline = fitCaltrackMonthly(monthly, temps, normals, { weatherIsNormalsProxy: true });
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
    if (basis) currentCost = costOnTariff(costPoints, basis.structure as TariffStructure, { tz });
    const basisTariffId = basis?.id ?? null;

    const currentTotal = currentCost?.breakdown.total ?? 0;
    for (const t of sweep.slice(0, 24)) {
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
        savingsVsCurrent: cost ? currentTotal - cost.breakdown.total : 0,
        eligibilityNote:
          "Eligibility checked on sector and peak-demand size bounds only; voltage class and customer-class minimums are not in the seeded tariff snapshot — confirm final eligibility with your utility.",
      });
    }
    // Cycle 5: stale demotion — fresh/verified rank above stale at equal savings
    comparisons.sort((a, b) => {
      if (!a.eligible !== !b.eligible) return a.eligible ? -1 : 1;
      const freshRank = (f: string) => (f === "verified" || f === "urdb_refreshed_150" || f === "manual" ? 0 : 1);
      if (freshRank(a.freshness) !== freshRank(b.freshness)) return freshRank(a.freshness) - freshRank(b.freshness);
      return b.savingsVsCurrent - a.savingsVsCurrent;
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

  if (annualizeBlocked) {
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "data_coverage",
      title: "Data span too short to annualize — benchmarking and emissions omitted",
      body: "Your interval data covers fewer than 25 days, which is too short to reliably annualize usage. EUI benchmarking and annual emissions estimates are omitted rather than extrapolated from a short window. Upload at least ~1 month of data (ideally 12 months) to unlock them.",
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
  // Cycle 6 finding 13: free-tier solar teaser for high-resource zones
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
  const kWhRate = estimateBlendedRate(currentCost, annualUsage);
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
      disclosures: [dis.disclaimer],
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
      disclosures: [dis.disclaimer],
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
        annualSavingsUsdLo: baseloadKw * 0.1 * AFTER_HOURS_PER_YEAR * kWhRate * 0.5,
        annualSavingsUsdHi: baseloadKw * 0.25 * AFTER_HOURS_PER_YEAR * kWhRate,
        capexBand: "none",
        confidence: "medium",
        rationale: `Overnight baseload averages ${baseloadKw.toFixed(1)} kW — ${((baseloadKw / demand.avgKw) * 100).toFixed(0)}% of your average load runs 24/7. Measured directly from your interval data. Savings estimated over ~${AFTER_HOURS_PER_YEAR.toLocaleString()} unoccupied hours/year.`,
        disclosures: [MODELED_ESTIMATES_DISCLAIMER],
      });
    }
  }
  const bestSwitch = comparisons.find((c) => c.eligible && c.savingsVsCurrent > 50);
  if (bestSwitch) {
    oppCands.push({
      key: "rate_switch",
      title: `Rate switch: ${bestSwitch.tariffName}`,
      category: "tariff",
      annualSavingsUsdLo: bestSwitch.savingsVsCurrent * 0.6,
      annualSavingsUsdHi: bestSwitch.savingsVsCurrent,
      capexBand: "none",
      confidence: bestSwitch.freshness === "urdb_stale" ? "low" : "medium",
      rationale:
        bestSwitch.freshness === "urdb_stale"
          ? "Rate data unverified — structure may have changed; verify current rates with your utility before switching."
          : "Re-priced your actual load profile on this tariff's published structure.",
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
  return hourly.map((usage, hIdx) => ({ ts: start + hIdx * 3600_000, durationMin: 60, usage, demand: usage }));
}

function annualize(points: IntervalPoint[]): number | null {
  if (points.length === 0) return null;
  const total = points.reduce((a, p) => a + Math.max(0, p.usage), 0);
  const spanMs = points[points.length - 1].ts + points[points.length - 1].durationMin * 60000 - points[0].ts;
  const spanDays = spanMs / 86_400_000;
  if (spanDays < 25) return null;
  return (total / spanDays) * 365;
}

function estimateBlendedRate(cost: CostResult | null, annualUsage: number | null): number {
  // All-in blended rate: total annual cost (energy + demand + fixed + CP − export)
  // per kWh (cycle 1, passes 9/19). Energy-only understates ¢/kWh on
  // demand-heavy tariffs and inflates opportunity paybacks.
  // Cycle 3, pass 69: no fabricated $0.05 floor — a genuinely low blended rate
  // (large industrial, heavy solar export) must flow through honestly; only
  // guard against degenerate non-positive values.
  if (cost && annualUsage && annualUsage > 0) {
    const r = cost.breakdown.total / annualUsage;
    if (Number.isFinite(r) && r > 0) return r;
  }
  return 0.12;
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
