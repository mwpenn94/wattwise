/**
 * Analysis pipeline orchestrator — one full run over a site (handoff §5).
 * Stages: intervals → demand analytics → baseline → tariff check → benchmarking
 * → emissions → insights → opportunities. Meterly per stage (AC5), wrapped in
 * the per-analysis compute timeout.
 */
import {
  ANALYSIS_TIMEOUT_MS,
  COMMODITY_UNITS,
  CostBreakdown,
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
import { computePeakAttribution } from "./attribution";
import { benchmarkPercentile, rankOpportunities, OpportunityCandidate } from "./scenarios";
import * as h from "../dbHelpers";
import { computeCostUsd, recordMeterEvent } from "./costModel";
import { computeVacantBaseline, evaluateAwayWatchdog, tsInAwayWindow } from "../awayMode";
import { detectPvSignature, PV_GATED_INSIGHT_KINDS, pvGateMessage } from "./pvDetection";
import { staleSeedsForDomain } from "../seedLifecycle";
// Cross-commodity parity: gas/water opportunity generation rides along in the
// same stage-7 pass as electric ranking (see the injection block below).
import { generateCommodityOpportunities, type XcOpportunity } from "../commodityOpportunities";
import { STATE_PROFILES } from "../seed/nationalData";
import { resolveCommodityService } from "../commodityService";
import { deriveBillVerifiedRate } from "../billCalibration";
import { resolveTerritory, partitionByTerritory } from "../serviceTerritory";
import type { Site, Meter } from "../../drizzle/schema";

/** Opportunity candidate as it flows through ranking/persistence — electric
 * candidates plus the cross-commodity extras (unit, commodity, per-unit
 * savings) that gas/water cards carry for implementer-grade rebate math. */
type OppCand = OpportunityCandidate & Partial<Pick<XcOpportunity, "estUnitsSavedPerYr" | "unit" | "commodity">>;

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
      // §3h: stagesCompleted now carries the human-readable narration written
      // incrementally by execute()'s narrate() — don't clobber it with the old
      // stage-key list; the narration IS the record of completed stages.
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
    // Batch-44 (pass 1899): the persisted failure cost must NOT depend on the
    // metering write succeeding — if recordMeterEvent throws (metering table
    // unavailable), falling back to $0 would understate marginal cost on the
    // analysis row and reopen a free-tier cap-bypass vector under metering
    // instability. Compute the deterministic estimate up front from the same
    // model recordMeterEvent uses; the metering write is best-effort on this
    // path (its own db-unavailable branch already fails loudly).
    let failCost = computeCostUsd(failDurationMs);
    try {
      failCost = await recordMeterEvent({ userId, analysisId, kind: "analysis_pipeline_failed", computeMs: failDurationMs, tier });
    } catch (meterErr) {
      console.error(
        `[pipeline] failed to record meter event for failed analysis ${analysisId} — persisting estimated failure cost $${failCost.toFixed(4)} on the analysis row anyway`,
        meterErr,
      );
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
  /* §3h processing as proof-of-work: each stage persists a narration line AS
     IT COMPLETES (best-effort write to stagesCompleted) so the client can
     poll the running analysis and show the real pipeline. Stages narrate
     actual work — no theatrical delays; fallbacks are named inline. */
  const narration: string[] = [];
  const narrate = (line: string) => {
    narration.push(line);
    void h.updateAnalysis(analysisId, { stagesCompleted: [...narration] }).catch(() => {});
  };

  // Cycle 9 (pass 505, extended): pipeline shares the ZIP/state-inferred zone
  // fallback rather than assuming the hot-arid AZ default for every site.
  const climateZone = site.climateZone ?? inferClimateZone(site.zip ?? undefined, site.state ?? undefined);
  const station = await h.getWeatherStation(climateZone);
  const normals = (station?.monthlyNormals ?? []) as MonthNormalRow[];
  narrate(
    station
      ? `Matched weather normals — station ${station.stationId} (climate zone ${climateZone})`
      : `No weather station for zone ${climateZone} — continuing with degree-day defaults`,
  );

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

  /* GAP-A / AC11 / AC18 — PV signature detection + net/gross gate.
   * Runs only on electric interval data for sites that have NOT declared solar
   * and have no prior detection verdict. A detected-but-unresolved signature
   * BLOCKS load-shape-dependent insights further down (never silently renders
   * them) until the user answers net vs gross. */
  let pvGateActive = false;
  let pvDetection: ReturnType<typeof detectPvSignature> | null = null;
  const pvStatus = site.pvDetectionStatus ?? "none";
  if (hasIntervals && meter?.commodity === "electric") {
    if (!site.hasSolar && pvStatus === "none") {
      pvDetection = detectPvSignature(points, tz);
      if (pvDetection.detected) {
        pvGateActive = true;
        await h.updateSite(site.id, userId, {
          pvDetectionStatus: "detected_unconfirmed",
          pvDetectedAt: Date.now(),
        });
        narrate("Detected a solar-panel usage fingerprint — pausing shape-dependent insights until you confirm whether the meter is net or gross");
      }
    } else if (pvStatus === "detected_unconfirmed") {
      // Still unresolved from a prior run — keep the gate up.
      pvGateActive = true;
      pvDetection = detectPvSignature(points, tz);
    }
  }
  const demand = hasIntervals ? computeDemandAnalytics(points, 4, [6, 7, 8, 9], tz) : null;
  /* PEAK-3 weather coincidence: annotate each monthly peak with the weather
   * context of its month from station normals. We only have NORMALS (typical
   * temps), not observed weather on the peak day — so the copy says "typically"
   * and never claims the actual temperature at the peak timestamp. */
  if (demand && demand.peakHypotheses.length > 0 && normals.length > 0) {
    const annualAvg = normals.reduce((s, n) => s + (n.avgTempF ?? 0), 0) / normals.length;
    for (const ph of demand.peakHypotheses) {
      const mNum = Number(ph.month.split("-")[1]);
      const norm = normals.find((n) => n.month === mNum);
      if (norm?.avgTempF != null) {
        const delta = norm.avgTempF - annualAvg;
        const weatherNote =
          delta >= 8
            ? `weather-coincident: this month typically runs ${Math.round(delta)}°F hotter than the annual average (normals, not observed weather)`
            : delta <= -8
              ? `weather-coincident: this month typically runs ${Math.round(-delta)}°F colder than the annual average (normals, not observed weather)`
              : `weather-neutral month: typical temps within ${Math.abs(Math.round(delta))}°F of the annual average — the peak is more likely schedule- or equipment-driven`;
        ph.basis = `${ph.basis}; ${weatherNote}`;
      }
    }
  }
  narrate(
    hasIntervals
      ? `Analyzed ${points.length.toLocaleString()} interval readings — peak ${demand ? demand.peakKw.toFixed(1) : "?"} kW, load factor ${demand ? Math.round(demand.loadFactor * 100) : "?"}%`
      : meter
        ? "No interval data on this meter — switching to archetype-synthetic baseline (disclosed)"
        : "No meter on this site — building the archetype-synthetic baseline (disclosed)",
  );

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
      // Batch-44 (pass 1919a): pass the fit stats THROUGH from the baseline
      // object rather than hardcoding null — for a pure archetype prior these
      // are legitimately null (there is no observed data to fit against, so an
      // R²/CVRMSE would be meaningless), but hardcoding disconnected this row
      // from the source of truth: if archetypeBaseline ever gains a partial
      // calibration fit, the persisted record would silently misreport it.
      rSquared: baseline.rSquared,
      cvrmse: baseline.cvrmse,
      weatherBasis: baseline.weatherBasis,
      confidenceLabel: baseline.confidenceLabel,
      source: arch ? `${arch.source}:${arch.sourceVersion ?? ""}` : "prototype-archetype",
    });
  }
  narrate(
    baseline
      ? baseline.method === "caltrack_monthly"
        ? `Fit weather-normalized baseline — CalTRACK monthly, CVRMSE ${baseline.cvrmse != null ? (baseline.cvrmse * 100).toFixed(0) + "%" : "n/a"}`
        : "Built archetype-synthetic baseline for this building type and climate"
      : "No baseline possible — missing both interval data and square footage",
  );

  /* Cross-commodity stage-2 parity (owner report Jul 19): gas/water baselines
     are persisted with the SAME measured-vs-imputed discipline as electric —
     ≥60 days of that commodity's meter data → annualized measured; else
     benchmark intensity × sqft (CBECS/RECS/WaterSense), disclosed verbatim in
     confidenceLabel. Gas params carry an HDD-weighted monthly heating split
     (55% heating share weighted by HDD — EIA end-use prior); no fabricated
     hourly shape, since no gas/water 8760 archetypes are seeded and inventing
     one would violate the honesty rule.
     Service applicability (owner reports Jul 19: "not all sites are dual
     fuel", "not every building has a water or electric hookup", "service
     areas can attribute or impute this"): each commodity passes the shared
     resolution ladder in server/commodityService.ts — user override →
     meter/equipment evidence → utility service-territory imputation (seeded
     tariff snapshot) → commodity default (gas never assumed; electric/water
     plausible-active). Skips are narrated with the resolved reason. Skipped
     for the commodity being analyzed directly (its real fit persisted above).
     Failures never fail the run. */
  try {
    const allMeters = await h.listMeters(site.id, userId);
    for (const com of ["gas", "water"] as const) {
      if (meter?.commodity === com) continue; // real fit already persisted above
      // Service-applicability ladder (shared with stage-7): user override →
      // meter/equipment evidence → territory imputation → commodity default
      // (gas never assumed; water plausible-active). Skips narrated verbatim.
      const svc = await resolveCommodityService(site, userId, com).catch(() => null);
      if (svc && !svc.analyze) {
        narrate(`${com === "gas" ? "Gas" : "Water"} baseline skipped: ${svc.reason}`);
        continue;
      }
      const cMeter =
        allMeters.find((m) => m.commodity === com && m.meterRole !== "submeter") ??
        allMeters.find((m) => m.commodity === com) ??
        null;
      let annual: number | null = null;
      let basisLabel: string | null = null;
      let trainStart: number | null = null;
      let trainEnd: number | null = null;
      if (cMeter) {
        const cPts = await h.getIntervalPoints(cMeter.id, userId);
        if (cPts.length >= 2) {
          const spanDays = Math.max(1, (cPts[cPts.length - 1].ts - cPts[0].ts) / 86_400_000);
          const total = cPts.reduce((s, p) => s + p.usage, 0);
          if (spanDays >= 60 && total > 0) {
            annual = (total / spanDays) * 365;
            basisLabel = `measured — annualized from ${Math.round(spanDays)} days of ${com} meter data`;
            trainStart = cPts[0].ts;
            trainEnd = cPts[cPts.length - 1].ts;
          }
        }
      }
      let benchSource: string | null = null;
      if (annual == null && site.sqft && site.sqft > 0 && site.buildingType) {
        const bm = await h.getBenchmark(site.buildingType, com);
        if (bm) {
          annual = bm.medianEui * site.sqft;
          basisLabel = `benchmark-imputed — ${bm.medianEui} ${bm.unit} (${bm.source}) × ${site.sqft.toLocaleString()} sqft; screening-grade`;
          benchSource = `${bm.source}:${bm.sourceVersion ?? ""}`;
        }
      }
      if (annual == null || !basisLabel) continue; // neither measured nor imputable — never fabricate
      // Gas: HDD-weighted monthly heating split (annual only for water — no
      // defensible monthly shape prior exists for water use).
      let monthlySplit: number[] | null = null;
      if (com === "gas" && normals.length === 12) {
        const totalHdd = normals.reduce((s, n) => s + (n.hddBase65 ?? 0), 0);
        if (totalHdd > 0) {
          const heatFrac = Math.min(0.65, 0.55 * Math.min(1, totalHdd / 3000));
          monthlySplit = normals.map((n) => (annual! * (1 - heatFrac)) / 12 + annual! * heatFrac * ((n.hddBase65 ?? 0) / totalHdd));
        }
      }
      await h.saveBaseline({
        siteId: site.id,
        meterId: cMeter?.id ?? null,
        method: "archetype_synthetic",
        commodity: com,
        params: { annualUnits: annual, basis: basisLabel, monthlySplit },
        rSquared: null,
        cvrmse: null,
        trainStart,
        trainEnd,
        weatherBasis: com === "gas" && monthlySplit ? "normal_year_hdd_split" : "none",
        confidenceLabel: basisLabel,
        source: benchSource ?? (cMeter ? "meter_annualized" : "benchmark"),
      });
      narrate(`Persisted ${com} baseline (${basisLabel.startsWith("measured") ? "measured" : "benchmark-imputed"}): ${Math.round(annual).toLocaleString()} ${com === "gas" ? "therms" : "gal"}/yr`);
    }
  } catch (e) {
    narrate(`Cross-commodity baseline pass skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  /* ---------- stage 3: tariff check (current + sweep) ---------- */
  const costPoints = hasIntervals ? points : archetypeHourly ? hourlyPoints(archetypeHourly) : [];
  let currentCost: CostResult | null = null;
  // Batch-45 (pass 1928): whether the current-cost basis rate's STRUCTURE
  // carries demand/CP charges — null when no basis was established. A computed
  // $0 demand+cp breakdown does NOT imply the tariff has no demand charges
  // (archetype-only or unpriced sites), so the UI must branch on the structure,
  // not the priced dollars.
  let basisStructureHasDemandCharges: boolean | null = null;
  // §3b: keep the priced basis STRUCTURE around for peak attribution's
  // counterfactual re-price (same engine, same rate as the current-cost figure).
  let basisStructureForAttribution: TariffStructure | null = null;
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
    // Batch-47 (pass 2139): sector eligibility keys off buildingType — when that
    // is still a quick-start placeholder (per-field aware via refinedFields,
    // legacy rows via attrSource), the entire eligible/ineligible partition of
    // the rate sweep rests on an assumed building type. Disclose it.
    const sectorFromPlaceholder = (() => {
      const rf = Array.isArray(site.refinedFields) ? (site.refinedFields as string[]) : null;
      if (rf != null) return !rf.includes("buildingType");
      return site.attrSource === "quick_start_defaults";
    })();
    // v1.18 applicability: closed/tech-conditioned flags threaded through so a
    // closed plan or an unlawful (solar-mismatched) plan never enters the sweep.
    const isElig = (t: (typeof allTariffs)[number]) =>
      tariffEligible(
        { sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin, peakKwMax: t.peakKwMax, closedToNew: t.closedToNew, techCondition: t.techCondition },
        { sectorClass, hasSolar: site.hasSolar ?? false },
        peakKw,
      ).eligible;
    // TERR-2/3: territory-aware sweep. Utilities are territorial monopolies —
    // a Tucson site must not see UNS Electric (Mohave/Santa Cruz only) rates as
    // switch options. Resolve the site's plausible utilities from its explicit
    // utilityName → city → zip3 (fail-open: unknown location = no filtering),
    // and restrict the statewide backfill to in-territory rows. Out-of-territory
    // rows are dropped from the sweep entirely; the disclosure below says so.
    const territoryRes = resolveTerritory(
      { state: site.state, city: site.city, zip: site.zip, utilityName: site.utilityName },
      (meter?.commodity ?? "electric") as "electric" | "gas" | "water",
    );
    const { inTerritory: territoryTariffs } = partitionByTerritory(allTariffs, territoryRes);
    // Sweep = same-utility rates plus any eligible IN-TERRITORY rates (a large
    // site may have no eligible rate at its own utility in the seeded snapshot;
    // with an unresolved territory this degrades to the old statewide behavior).
    const eligibleAnywhere = territoryTariffs.filter(isElig);
    const sweepSet = new Map<number, (typeof allTariffs)[number]>();
    for (const t of [...utilityTariffs, ...eligibleAnywhere]) sweepSet.set(t.id, t);
    // Last-resort fallback prefers in-territory rows before the full statewide list.
    const sweep = sweepSet.size > 0 ? Array.from(sweepSet.values()) : territoryTariffs.length > 0 ? territoryTariffs : allTariffs;

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
    if (basis) {
      const bs = basis.structure as TariffStructure;
      basisStructureHasDemandCharges = (bs.demand?.length ?? 0) > 0 || bs.cp != null;
      basisStructureForAttribution = bs;
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
        { sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin, peakKwMax: t.peakKwMax, closedToNew: t.closedToNew, techCondition: t.techCondition },
        // v1.18: the current basis stays priceable even when closed to new
        // customers — the customer is already on it; it is only barred as a
        // SWITCH target for everyone else.
        { sectorClass, hasSolar: site.hasSolar ?? false, isCurrentBasis: t.id === basisTariffId },
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
        // Batch-41 (pass 1769): the placeholder breakdown for uncosted
        // (ineligible) rows must not claim a CP component was "omitted due to
        // no interval data" when the tariff simply has no CP charge — that
        // conflated the no-cost-basis condition with a CP-data gap and misled
        // facility managers about what was left out.
        annualCost:
          cost?.breakdown ??
          ({
            energy: 0,
            demand: 0,
            fixed: 0,
            cp: null,
            cpMethodology: (t.structure as TariffStructure).cp ? "cp_omitted_no_interval_data" : "no_cp_charges",
            total: 0,
          } as CostBreakdown),
        // Batch-38 (pass 1559): NULL — not 0 — when no current-cost basis
        // exists. The UI already renders "— (no current-cost baseline)", but raw
        // API/export consumers received a literal 0 indistinguishable from a
        // genuine break-even delta. Null is the machine-readable equivalent.
        savingsVsCurrent: cost && hasCostBasis ? currentTotal - cost.breakdown.total : null,
        // Batch-34 (pass 1279): when the platform already KNOWS the rate is
        // ineligible, telling the user to "confirm final eligibility" was
        // contradictory — the specific reason replaces the generic caveat.
        eligibilityNote:
          (elig.reason
            ? `Ineligible: ${elig.reason}`
            : "Eligibility checked on sector and peak-demand size bounds only; voltage class and customer-class minimums are not in the seeded tariff snapshot — confirm final eligibility with your utility.") +
          (sectorFromPlaceholder
            ? ` Note: the site's sector (${sectorClass}) is derived from a PLACEHOLDER building type — confirm the building type to make this eligibility call reliable.`
            : ""),
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
  narrate(
    comparisons.length > 0
      ? `Re-priced a full year on ${comparisons.length} seeded rate${comparisons.length === 1 ? "" : "s"} — ${comparisons.filter((c) => c.eligible).length} eligible for this ${meter?.commodity ?? "electric"} meter`
      : "No rate sweep possible — no load profile or no seeded rates for this commodity/state",
  );
  // TERR-3: disclose the territory basis on the current-cost result so every
  // downstream dollar surface can say WHY these utilities (and not others)
  // were compared, and flag overlap zones for the confirm-your-utility UX.
  if (currentCost && comparisons.length > 0) {
    const terrRes = resolveTerritory(
      { state: site.state, city: site.city, zip: site.zip, utilityName: site.utilityName },
      (meter?.commodity ?? "electric") as "electric" | "gas" | "water",
    );
    if (terrRes.matchPrefixes.length > 0) {
      currentCost.disclosures.push(
        terrRes.overlap
          ? `Rate comparison limited to utilities plausibly serving this location (${terrRes.plausibleUtilities.join(", ")}). ${terrRes.basis}`
          : `Rate comparison limited to ${terrRes.plausibleUtilities.join(", ")} — ${terrRes.basis} Utilities that do not serve this area are excluded.`,
      );
    } else {
      currentCost.disclosures.push(`Territory unconfirmed — ${terrRes.basis}`);
    }
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
  narrate(
    benchmark
      ? `Benchmarked against ${benchmark.source ?? "peer"} peers — ${benchmark.percentileBand ?? "percentile computed"}`
      : "Benchmark skipped — needs building type, square footage, and an annualizable usage figure",
  );

  /* ---------- stage 5: emissions ---------- */
  // eGRID CO2e factors are lb/MWh of ELECTRICITY — applying them to gas therms
  // or water gallons would fabricate emissions (caught by AC3 acceptance test).
  // Scope-1 gas factors / water embodied energy are a disclosed MVP gap.
  let emissions: PipelineResult["emissions"] = null;
  if (annualUsage != null && (meter?.commodity ?? "electric") === "electric") {
    const zip3 = (site.zip ?? "").slice(0, 3);
    const { factor, subregion, mapped } = await h.getEmissionsFactor(zip3, site.state);
    if (factor) {
      emissions = { annualCo2eLb: (annualUsage / 1000) * factor.co2eLbPerMwh, subregion, factorYear: factor.year, mapped };
    }
  }
  narrate(
    emissions
      ? `Applied eGRID ${emissions.factorYear} emissions factor${emissions.mapped ? ` for ${emissions.subregion}` : " (regional default — ZIP unmapped)"}`
      : "Emissions skipped — electric-only factors; no annualizable electric usage this run",
  );

  /* ---------- stage 6: insights ---------- */
  const insightRows: Parameters<typeof h.replaceInsights>[1] = [];
  const dis = DISAGG_LANGUAGE[disaggMethod];

  // Progressive participation (Jul 2026): quick-start sites run on DISCLOSED
  // placeholder attributes. replaceInsights below wipes the creation-time
  // disclosure, so the pipeline re-emits it on every run while placeholders
  // remain in effect — the assumption list also powers the dashboard's
  // "add detail" chips.
  // Batch-44 (pass 1919b): the gate is now PER-FIELD, not the site-level
  // attrSource flag alone. sites.refine flips attrSource to user_entered as
  // soon as ANY core attribute (buildingType/sqft/vintage) is provided, which
  // silenced this disclosure while location placeholders (state/zip → climate
  // zone, timezone, tariff sweep) were still in effect — misleading the user
  // into thinking every placeholder was resolved. Core-attribute lines are
  // gated on attrSource (refine flips it exactly when those are user-provided);
  // location lines are gated on the fields actually still missing; the
  // interval-data line on hasIntervals. The insight is emitted while ANY
  // placeholder line remains.
  // Batch-45 (pass 1949): the interval-data line is gated on !hasIntervals
  // ALONE — interval data is a property of the meter, not a core attribute, so
  // refining buildingType (which flips attrSource) must not silence the
  // "no interval data yet" placeholder while the analysis still runs on an
  // archetype shape. The `annualizeBlocked` data_coverage insight does NOT
  // cover this case (it only fires when intervals EXIST but span <25 days).
  // Batch-45 (pass 1959): core lines are now PER-FIELD when the site carries a
  // refinedFields record (quick-start sites created after this change) —
  // refining ONLY buildingType keeps the sqft and vintage placeholder lines
  // visible. Legacy rows (refinedFields null) keep the site-level attrSource
  // gate: all-or-nothing, matching their pre-1959 behavior.
  {
    const qsParse = { raw: site.address ?? "", state: site.state, zip: site.zip, city: site.city };
    const coreStillPlaceholder = site.attrSource === "quick_start_defaults";
    const CORE_FIELDS = new Set(["buildingType", "sqft", "vintage"]);
    const refinedFields = Array.isArray(site.refinedFields) ? (site.refinedFields as string[]) : null;
    // Gap-2 cascade parity: the re-emitted disclosure must describe the values
    // ACTUALLY stored on the site (cascade-derived priors), not the flat
    // national defaults — otherwise the insight text contradicts the dashboard.
    const sitePriors =
      site.buildingType && site.sqft && site.vintage
        ? { buildingType: site.buildingType, sqft: site.sqft, vintage: site.vintage }
        : undefined;
    const qsAssumptions = quickStartAssumptions(qsParse, sitePriors).filter((a) => {
      if (CORE_FIELDS.has(a.field)) {
        // Per-field gate when the refinement record exists; otherwise the
        // legacy site-level gate. A quick-start site is identifiable by either
        // attrSource=quick_start_defaults (never refined) or a non-null
        // refinedFields array (quick-start origin, possibly refined).
        if (refinedFields != null) return !refinedFields.includes(a.field);
        return coreStillPlaceholder;
      }
      // Batch-45 (pass 1949): gate on the DATA, not attrSource — a refined
      // quick-start site without uploads still runs on an archetype shape and
      // must keep this placeholder line visible.
      if (a.field === "intervalData") return !hasIntervals;
      // Location lines (state/zip): still-missing location keeps its climate/
      // timezone/tariff-sweep placeholder line regardless of attrSource — this
      // applies equally to a refined quick-start site and a sites.create site
      // that never had location (both run on the same US-median fallbacks).
      return true;
    });
    if (qsAssumptions.length > 0)
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
      // Batch-50 (pass 2539): the site-level coreStillPlaceholder boolean was
      // misleading after PARTIAL refinement (attrSource flips on the first core
      // refine, so the flag read false while some placeholders remained). The
      // provenance now names the ACTUAL remaining core placeholders, derived
      // from the same per-field filter that gated the emitted lines.
      provenance: {
        method: "quick_start_intake_v1",
        parsedState: site.state,
        parsedZip: site.zip,
        remainingCorePlaceholders: qsAssumptions.filter((a) => CORE_FIELDS.has(a.field)).map((a) => a.field),
      },
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
      // Batch-42 (pass 1809): the insight's cost claim must match the PRICED
      // rate structure. Firing "demand charges are outsized" when the current
      // rate is unpriced (currentCost null) or carries NO demand/CP charges
      // misleads a facility manager into fixing a problem their rate doesn't
      // bill for. The peaky-profile FACT is still reported — only the cost
      // framing is conditioned. (KPI sub-text got the same fix in Batch-40.)
      const demandBilled = currentCost != null && currentCost.breakdown.demand + (currentCost.breakdown.cp ?? 0) > 0;
      const rateUnpriced = currentCost == null;
      insightRows.push({
        siteId: site.id,
        meterId: meter?.id ?? null,
        analysisId,
        kind: "load_factor",
        title: demandBilled
          ? `Low load factor (${(demand.loadFactor * 100).toFixed(0)}%) — demand charges are outsized for your usage`
          : `Low load factor (${(demand.loadFactor * 100).toFixed(0)}%) — peaky profile detected`,
        body: demandBilled
          ? `Your average load is only ${(demand.loadFactor * 100).toFixed(0)}% of your peak (${demand.peakKw.toFixed(1)} kW at ${new Date(demand.peakTimestamp).toLocaleString("en-US", { timeZone: tz })}). Flattening short peaks (staggering equipment starts, load scheduling) directly reduces demand charges.`
          : rateUnpriced
            ? `Your average load is only ${(demand.loadFactor * 100).toFixed(0)}% of your peak (${demand.peakKw.toFixed(1)} kW at ${new Date(demand.peakTimestamp).toLocaleString("en-US", { timeZone: tz })}). This COULD be costly if your tariff bills demand charges — your current rate could not be priced, so the cost impact is unknown. Assign your actual rate to quantify it.`
            : `Your average load is only ${(demand.loadFactor * 100).toFixed(0)}% of your peak (${demand.peakKw.toFixed(1)} kW at ${new Date(demand.peakTimestamp).toLocaleString("en-US", { timeZone: tz })}). Your current rate carries no demand or coincident-peak charges, so this profile is not costing you extra today — but it would matter on demand-billed rates, including some in the comparison table.`,
        severity: demandBilled ? "opportunity" : "info",
        disaggregationMethod: disaggMethod,
        confidence: "high",
        provenance: { source: "interval_data", method: "demand_analytics", demandBilled, rateUnpriced },
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
    // §3b Peak attribution — "what made my peak happen": weather / schedule /
    // coincidence split, spike-vs-plateau triage, and a counterfactual $ figure
    // priced by the SAME tariff engine that prices bills. Sufficiency gates
    // (≥90 days span, ≥4 same-slot samples) live inside the module; it returns
    // null rather than guessing when data is thin.
    const peakBasisStructure = currentCost ? basisStructureForAttribution : null;
    const attribution = hasIntervals ? computePeakAttribution(points, demand, baseline, peakBasisStructure, tz) : null;
    if (attribution) {
      const parts: string[] = [];
      if (attribution.weatherKw !== null && attribution.weatherKw > 0.05)
        parts.push(`~${attribution.weatherKw.toFixed(1)} kW tracks weather response (modeled)`);
      parts.push(`~${attribution.scheduleKw.toFixed(1)} kW is your typical load for that day-of-week and hour`);
      if (attribution.coincidenceKw > 0.05)
        parts.push(`~${attribution.coincidenceKw.toFixed(1)} kW is coincidence — loads that happened to run simultaneously`);
      const cfLine = attribution.counterfactual
        ? ` Shaving ${attribution.counterfactual.shavedKw.toFixed(1)} kW off events like this is worth ~$${Math.round(attribution.counterfactual.annualSavingsUsd).toLocaleString()}/yr on your assigned rate.`
        : "";
      insightRows.push({
        siteId: site.id,
        meterId: meter?.id ?? null,
        analysisId,
        kind: "peak_attribution",
        title: `Your ${attribution.peakKw.toFixed(1)} kW peak (${attribution.peakLocal}) was ${attribution.shape === "spike" ? "a short spike" : "a sustained plateau"}`,
        body: `${parts.join("; ")}. ${attribution.shapeDetail}${cfLine}`,
        severity: attribution.counterfactual ? "opportunity" : "info",
        disaggregationMethod: disaggMethod,
        confidence: attribution.confidence,
        provenance: {
          method: "peak_attribution_v1",
          disclosures: attribution.disclosures,
          counterfactualMethod: attribution.counterfactual?.method ?? null,
        },
        metrics: {
          peakKw: attribution.peakKw,
          peakTs: attribution.peakTs,
          shape: attribution.shape,
          weatherKw: attribution.weatherKw,
          scheduleKw: attribution.scheduleKw,
          coincidenceKw: attribution.coincidenceKw,
          counterfactualSavingsUsd: attribution.counterfactual?.annualSavingsUsd ?? null,
        },
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

  /* §3i-2 consolidation finding — sites with 2+ MAIN electric meters that
     both carry interval data: if their peaks land at different hours, the
     coincident (summed-series) peak is lower than the sum of individual
     peaks, and combined billing MIGHT cut demand charges. Honesty gates:
     needs ≥2 metered mains with ≥10 readings each; the coincident profile is
     labeled ANALYSIS ONLY (utilities decide consolidation eligibility, not
     us); no dollar claim without a demand rate on the basis tariff. */
  try {
    const siteMeters = await h.listMeters(site.id, userId);
    const mainElectric = siteMeters.filter((m2) => m2.commodity === "electric" && m2.meterRole === "main");
    if (mainElectric.length >= 2) {
      const series = await Promise.all(
        mainElectric.map(async (m2) => {
          const rows = await h.getIntervalPoints(m2.id, userId);
          return { meter: m2, rows };
        }),
      );
      const metered = series.filter((s2) => s2.rows.length >= 10);
      if (metered.length >= 2) {
        // Per-meter peak kW + peak hour; coincident peak from the summed series.
        const perMeter = metered.map((s2) => {
          let peakKw = 0;
          let peakTs = 0;
          for (const r of s2.rows) {
            const kw = r.demand ?? (r.durationMin > 0 ? (r.usage * 60) / r.durationMin : 0);
            if (kw > peakKw) {
              peakKw = kw;
              peakTs = r.ts;
            }
          }
          return { label: s2.meter.label ?? `meter ${s2.meter.id}`, peakKw, peakHour: new Date(peakTs).getHours() };
        });
        const bucket = new Map<number, number>();
        for (const s2 of metered) {
          for (const r of s2.rows) {
            const kw = r.demand ?? (r.durationMin > 0 ? (r.usage * 60) / r.durationMin : 0);
            bucket.set(r.ts, (bucket.get(r.ts) ?? 0) + kw);
          }
        }
        let coincidentPeakKw = 0;
        bucket.forEach((v) => {
          if (v > coincidentPeakKw) coincidentPeakKw = v;
        });
        const sumOfPeaks = perMeter.reduce((a, p) => a + p.peakKw, 0);
        const reductionKw = sumOfPeaks - coincidentPeakKw;
        const hoursDiffer = new Set(perMeter.map((p) => p.peakHour)).size > 1;
        if (hoursDiffer && reductionKw > 0.5) {
          insightRows.push({
            siteId: site.id,
            meterId: null,
            analysisId,
            kind: "consolidation",
            title: `Your ${metered.length} main meters peak at different hours — combined billing could reduce billed demand`,
            body:
              `${perMeter.map((p) => `${p.label} peaks ~${p.peakHour}:00 at ${p.peakKw.toFixed(1)} kW`).join("; ")}. ` +
              `Sum of individual peaks: ${sumOfPeaks.toFixed(1)} kW; coincident (combined-profile) peak: ${coincidentPeakKw.toFixed(1)} kW — ` +
              `${reductionKw.toFixed(1)} kW lower. If your utility offers meter consolidation or totalized billing on a demand rate, ` +
              `billed demand could drop by up to that amount. The coincident profile is an analysis-only construct — ` +
              `consolidation eligibility, fees, and rate impacts are the utility's call; dollar impact depends on your demand rate.`,
            severity: "opportunity",
            disaggregationMethod: disaggMethod,
            confidence: "medium",
            provenance: { method: "coincident_sum_of_meter_series", meters: perMeter.map((p) => p.label) },
            metrics: { perMeter, sumOfPeaksKw: sumOfPeaks, coincidentPeakKw, reductionKw },
          });
        }
      }
    }
  } catch {
    /* consolidation finding is best-effort — never fails the pipeline */
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
  /* AC16b — building performance-standard compliance card. Only renders when
     a seeded program plausibly applies (jurisdiction + sector + floor area);
     shows deadline countdown, EUI vs target, path-to-target, and penalty
     exposure. EUI basis (measured vs estimated) is always disclosed. */
  try {
    const { assessCompliance } = await import("../compliance");
    const assessments = await assessCompliance({
      state: site.state ?? null,
      buildingType: site.buildingType ?? null,
      sqft: site.sqft ?? null,
      annualKwh: (meter?.commodity ?? "electric") === "electric" ? annualUsage : null,
      euiBasis: hasIntervals && annualUsage != null ? "measured" : annualUsage != null ? "estimated" : "unknown",
    });
    for (const a of assessments) {
      insightRows.push({
        siteId: site.id,
        meterId: meter?.id ?? null,
        analysisId,
        kind: "compliance",
        title: a.bindingTarget
          ? `${a.programName}: ${a.monthsToDeadline} months to deadline`
          : `${a.programName}: reporting deadline in ${a.monthsToDeadline} months`,
        body: a.pathToTarget,
        severity: a.onTrack === false ? "warning" : "info",
        disaggregationMethod: disaggMethod,
        confidence: a.euiBasis === "measured" ? "high" : "low",
        provenance: { method: "compliance_seed_v1", disclosure: a.disclosure, source: a.programCode },
        metrics: { compliance: a },
      });
      narrate(
        `AC16b: ${a.programName} applies — ${a.monthsToDeadline} mo to deadline${a.gapPct != null ? `, EUI gap ${a.gapPct > 0 ? "+" : ""}${a.gapPct}%` : ""}${a.penaltyExposureUsd ? `, penalty exposure ~$${a.penaltyExposureUsd.toLocaleString()}` : ""}`,
      );
    }
  } catch (e) {
    narrate(`AC16b compliance check skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  /* GAP-I — de-identified cohort insight, 15/15 privacy rule: renders ONLY
     when the site's cohort (state | building type | size band) has ≥15
     members. Below that, nothing — no teaser. Cohorts recompute weekly. */
  try {
    const { recomputeCohorts, cohortInsightFor } = await import("../cohort");
    if ((meter?.commodity ?? "electric") === "electric") {
      await recomputeCohorts();
      const cohort = await cohortInsightFor({
        state: site.state ?? null,
        buildingType: site.buildingType ?? null,
        sqft: site.sqft ?? null,
        annualKwh: annualUsage,
      });
      if (cohort) {
        insightRows.push({
          siteId: site.id,
          meterId: meter?.id ?? null,
          analysisId,
          kind: "cohort",
          title: `How you compare with ${cohort.n} similar buildings`,
          body: cohort.message,
          severity: "info",
          disaggregationMethod: disaggMethod,
          confidence: "medium",
          provenance: { method: "cohort_15_15_v1", cohortKey: cohort.cohortKey, n: cohort.n },
          metrics: { cohort },
        });
        narrate(`GAP-I: cohort insight rendered (n=${cohort.n} ≥ 15, ${cohort.standing.replace(/_/g, " ")})`);
      } else {
        narrate("GAP-I: cohort below the 15-member privacy floor — rendered nothing (by design)");
      }
    }
  } catch (e) {
    narrate(`GAP-I cohort skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  /* AC13 — probable equipment inventory + lifecycle horizon + degradation
     drift + sizing diagnostics, composed into the annual-checkup story.
     Every inventory row is INFERRED (source='inferred', carrying the
     observation that justified it) until the user confirms or edits it —
     the insight says so explicitly. Fail-open: never blocks the analysis. */
  try {
    const { inferEquipment, syncInferredEquipment, lifecycleHorizon, degradationDrift, sizingDiagnostic, annualCheckupStory } = await import("../equipment");
    const hvacShareRaw = (endUseFractions?.cooling ?? 0) + (endUseFractions?.heating ?? 0);
    const hvacShare = hvacShareRaw > 0 ? hvacShareRaw : null;
    const baseloadShare = endUseFractions?.plug_load ?? endUseFractions?.baseload ?? null;
    const metersForEquip = await h.listMeters(site.id, userId);
    const hasGasMeter = metersForEquip.some((m) => m.commodity === "gas");
    // Degradation drift needs the PRIOR run's normalized annual usage — read
    // it from the previous summary insight BEFORE this run's rows replace it.
    let priorNorm: number | null = null;
    try {
      const priorInsights = await h.listInsights(site.id, userId);
      const priorSummary = priorInsights.find((i) => i.kind === "summary");
      priorNorm = ((priorSummary?.metrics ?? null) as { baseline?: { normalizedAnnualUsage?: number | null } } | null)?.baseline?.normalizedAnnualUsage ?? null;
    } catch {
      /* drift optional */
    }
    const inferred = inferEquipment({
      buildingType: site.buildingType ?? null,
      sqft: site.sqft ?? null,
      state: site.state ?? null,
      hvacShare,
      baseloadShare,
      hasSolar: site.hasSolar ?? false,
      hasGasMeter,
      peakKw: demand?.peakKw ?? null,
    });
    await syncInferredEquipment(site.id, userId, inferred);
    const invRows = await h.listEquipment(site.id, userId);
    const lifecycle = lifecycleHorizon(
      invRows.map((r) => ({ equipKey: r.equipKey, label: r.label, installYear: r.installYear ?? null, serviceLifeYears: r.serviceLifeYears ?? null })),
    );
    const currentNorm = baseline?.normalizedAnnualUsage ?? null;
    const drift =
      priorNorm != null && currentNorm != null && Math.abs(priorNorm - currentNorm) > 1e-6 ? degradationDrift(currentNorm, priorNorm) : null;
    const sizing = sizingDiagnostic({ loadFactor: demand?.loadFactor ?? null, hvacShare, peakKw: demand?.peakKw ?? null, sqft: site.sqft ?? null });
    const story = annualCheckupStory({ siteName: site.name, lifecycle, drift, sizing });
    const planningItems = lifecycle.filter((l) => l.window === "past_typical_life" || l.window === "inside_5yr_window");
    insightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "equipment",
      title:
        planningItems.length > 0
          ? `Equipment checkup: ${planningItems.length} item${planningItems.length === 1 ? "" : "s"} in the replacement-planning window`
          : "Equipment checkup: probable inventory (confirm to sharpen)",
      body: story,
      severity: planningItems.length > 0 || (drift?.material === true && drift.driftPct > 0) ? "warning" : "info",
      disaggregationMethod: disaggMethod,
      confidence: "low",
      provenance: {
        method: "equipment_inference_v1",
        disclosure:
          "Inventory is inferred from usage patterns and building attributes with typical service lives — not an inspection. Confirm or edit rows to make lifecycle planning yours.",
        inferredCount: inferred.length,
      },
      metrics: { lifecycle, drift, sizing: sizing.kind === "no_finding" ? null : sizing },
    });
    narrate(
      `AC13: equipment checkup — ${invRows.length} inventory row${invRows.length === 1 ? "" : "s"}${planningItems.length > 0 ? `, ${planningItems.length} in the replacement-planning window` : ""}${drift?.material ? `, normalized drift ${drift.driftPct > 0 ? "+" : ""}${drift.driftPct}%` : ""}`,
    );
  } catch (e) {
    narrate(`AC13 equipment checkup skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  /* AC14 — vertical packs: production-normalized KPI + regressor honesty.
     Renders when the building type matches a pack OR the user has logged
     production periods. The KPI itself only computes from real logged data. */
  try {
    const { VERTICAL_PACKS, packForBuildingType, listProduction, productionKpi, regressorDisclosure } = await import("../verticals");
    const periods = await listProduction(site.id, userId);
    const typePack = packForBuildingType(site.buildingType ?? null);
    const packsWithData = VERTICAL_PACKS.filter((p) => periods.some((r) => r.metricKey === p.metricKey && r.quantity > 0));
    const activePacks = packsWithData.length > 0 ? packsWithData : typePack ? [typePack] : [];
    if (activePacks.length > 0) {
      const usageKwhInWindow = (fromTs: number, toTs: number) =>
        points.reduce((s, p) => (p.ts >= fromTs && p.ts < toTs && p.usage > 0 ? s + p.usage : s), 0);
      for (const pack of activePacks) {
        const kpi = hasIntervals ? productionKpi({ pack, periods, usageKwhInWindow }) : null;
        const hasData = periods.some((r) => r.metricKey === pack.metricKey && r.quantity > 0);
        insightRows.push({
          siteId: site.id,
          meterId: meter?.id ?? null,
          analysisId,
          kind: "vertical",
          title: kpi ? `${pack.label}: ${Math.round(kpi.intensity).toLocaleString()} ${kpi.kpiLabel}` : `${pack.label}: production-driven building`,
          body: kpi ? `${kpi.message} ${kpi.coverageNote} ${regressorDisclosure(pack, true)}` : regressorDisclosure(pack, hasData),
          severity: "info",
          disaggregationMethod: disaggMethod,
          confidence: kpi ? "medium" : "low",
          provenance: {
            method: "vertical_pack_v1",
            packKey: pack.packKey,
            ...(kpi?.typicalRange ? { rangeBasis: kpi.typicalRange.basis } : {}),
            disclosure: "Production KPI computed only over periods you logged — never an assumed production figure. Typical ranges are published ranges with a named basis, not percentiles.",
          },
          metrics: { kpi },
        });
        narrate(`AC14: vertical pack '${pack.packKey}' — ${kpi ? `KPI ${Math.round(kpi.intensity).toLocaleString()} ${kpi.kpiLabel}` : "regressor note (no production log yet)"}`);
      }
    }
  } catch (e) {
    narrate(`AC14 vertical pack skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  // NEXT-1 (Jul 21): rate resolution hoisted above the summary write so the
  // machine-readable ratePricing block below reflects the SAME resolution the
  // stage-7 opportunity pricing uses — one ladder, one answer.
  // Batch-18 (pass 419): pass the raw window total so short-history sites (<25
  // days, annualUsage null) still get their real blended rate instead of the
  // $0.12 fallback — the rate is window-invariant even when annualization isn't.
  const stateProfileRow = site.state ? STATE_PROFILES.find((p) => p.state === site.state) : null;
  const stateAvgRate = stateProfileRow ? { rate: stateProfileRow.commRateCents / 100, state: stateProfileRow.state } : null;
  // NEXT-1: bill-verified calibration — only fetched when it could matter
  // (no tariff-priced cost basis), since the real-cost tiers win regardless.
  const billVerified = currentCost == null ? await deriveBillVerifiedRate(site.id, userId, "electric") : null;
  const { rate: kWhRate, isFallback: rateIsFallback, fallbackReason, fallbackBasis } = estimateBlendedRate(currentCost, annualUsage, hasIntervals ? totalImportKwh(points) : null, hasIntervals && points.length > 0, stateAvgRate, billVerified);
  const priceBasisPhrase = fallbackBasis ?? "a $0.12/kWh national-average assumption";
  // Machine-readable summary row: persists demand analytics (incl. heatmap),
  // benchmark, emissions, current cost, and tariff comparisons so the dashboard
  // KPI cards and panels survive page reloads (live-E2E pass-1 finding).
  // v1.22 S-LIFECYCLE staleness chip-widening: when a seeded source this
  // analysis leans on has passed its refresh cadence, figures derived from it
  // widen — named and dated, never silent. Fail-open: freshness telemetry
  // must never fail the analysis.
  let staleDisclosures: string[] = [];
  try {
    const staleDomains = await Promise.all([staleSeedsForDomain("tariffs"), staleSeedsForDomain("emissions"), staleSeedsForDomain("benchmark")]);
    staleDisclosures = staleDomains
      .flat()
      .map(
        (s) =>
          `${s.label} is ${s.ageDays} days old (refresh cadence ${s.cadenceDays} days) — figures that lean on it carry wider uncertainty until it's refreshed.`,
      );
  } catch {
    /* freshness check must never fail the analysis */
  }
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
    provenance: { method: "pipeline_summary_v1", ...(staleDisclosures.length ? { seedStaleness: staleDisclosures } : {}) },
    metrics: {
      demand,
      benchmark,
      emissions,
      currentCost,
      // NEXT-1/NEXT-2 (Jul 21): machine-readable rate provenance so the UI can
      // render a tier badge and — when the rate is imputed — a "calibrate with
      // a bill" callout. tier ordering: tariff_priced_actual > bill_verified >
      // state_average_imputed > national_assumption.
      ratePricing: {
        rateUsdPerKwh: kWhRate,
        isFallback: rateIsFallback,
        basis: rateIsFallback ? priceBasisPhrase : "your tariff-priced cost basis (actual)",
        tier: !rateIsFallback
          ? "tariff_priced_actual"
          : billVerified
            ? "bill_verified"
            : stateAvgRate
              ? "state_average_imputed"
              : "national_assumption",
        // SEAS-1 (Jul 21): monthly blended-rate curve when 3+ bills across 3+
        // calendar months show material (>5%) seasonal spread — null otherwise.
        // Only populated on the bill_verified tier; the UI renders a seasonal
        // strip so summer-tier sites see WHY their summer dollars run hotter.
        monthlyCurve: billVerified?.monthlyCurve ?? null,
        seasonalSpreadPct: billVerified?.seasonalSpreadPct ?? null,
      },
      // Batch-45 (pass 1928): structure-level flag so the dashboard can say
      // "your rate has no demand charges" ONLY when the structure truly has
      // none — never inferred from a $0 priced breakdown.
      basisStructureHasDemandCharges,
      // §3i demand review ritual: the per-cycle review needs billed-vs-actual
      // demand by month (ratchet watch) and a suggested set-point — the 90th-
      // percentile of monthly peaks, a target the building already proved it
      // can hit in most months. Analysis-derived, never a guarantee.
      demandReview:
        demand && currentCost && currentCost.monthlyDetails.length > 0
          ? {
              months: currentCost.monthlyDetails.map((m) => ({
                month: m.month,
                actualPeakKw: m.actualPeakKw,
                billedDemandKw: m.billedDemandKw,
                ratchetApplied: m.ratchetApplied,
                peakTimestamp: m.peakTimestamp,
              })),
              setPointKw: (() => {
                const peaks = currentCost.monthlyDetails.map((m) => m.actualPeakKw).sort((a, b) => a - b);
                const idx = Math.min(peaks.length - 1, Math.floor(peaks.length * 0.9));
                return peaks[Math.max(0, idx - 1)] ?? peaks[0];
              })(),
              demandRateUsdPerKwMo:
                currentCost.breakdown.demand > 0 && demand.peakKw > 0 ? currentCost.breakdown.demand / 12 / demand.peakKw : null,
              anyRatchet: currentCost.monthlyDetails.some((m) => m.ratchetApplied),
            }
          : null,
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
  /* PV gate enforcement: while a detected solar signature is unresolved,
   * load-shape-dependent insights are withheld and replaced by ONE gate card
   * that explains what is paused and why. Blocked, not silently rendered. */
  let persistedInsightRows = insightRows;
  if (pvGateActive) {
    const withheld = insightRows.filter((r) => PV_GATED_INSIGHT_KINDS.has(r.kind));
    persistedInsightRows = insightRows.filter((r) => !PV_GATED_INSIGHT_KINDS.has(r.kind));
    persistedInsightRows.push({
      siteId: site.id,
      meterId: meter?.id ?? null,
      analysisId,
      kind: "pv_gate",
      title: "Do you have solar panels? One answer unlocks the rest",
      body: pvGateMessage(pvDetection ?? { detected: true, signatureDayShare: 0, daysAnalyzed: 0, hasNegativeIntervals: false, rationale: "previously detected" }),
      severity: "warning",
      confidence: "high",
      provenance: {
        method: "pv_signature_detector_v1",
        detection: pvDetection,
        withheldKinds: withheld.map((r) => r.kind),
        resolution: "Answer net/gross (or 'no solar here') on the dashboard to release the paused insights on the next analysis.",
      },
      metrics: { withheldCount: withheld.length },
    });
    narrate(`Withheld ${withheld.length} shape-dependent insight${withheld.length === 1 ? "" : "s"} behind the solar net/gross question — blocked, not guessed`);
  }
  await h.replaceInsights(site.id, persistedInsightRows);
  narrate(`Wrote ${persistedInsightRows.length} insight${persistedInsightRows.length === 1 ? "" : "s"} — every figure carries its provenance`);

  /* ---------- stage 7: opportunities ---------- */
  const oppCands: OpportunityCandidate[] = [];
  // §2.57 sewer-on-winter-water linkage (water meters only): most municipal
  // sewer charges are set from WINTER water usage (winter-quarter-average
  // convention — winter use ≈ indoor-only, proxying what actually reaches the
  // sewer). Cutting winter indoor use therefore pays twice: on the water bill
  // now AND on 12 months of sewer billing set by that winter window. Applies
  // only with ≥2 winter months of real data; the sewer rate itself is NOT
  // seeded, so the sewer-side figure is labeled a convention-based estimate.
  if ((meter?.commodity ?? "electric") === "water" && hasIntervals && points.length > 0) {
    const monthlyW = intervalsToMonthly(points);
    const winter = monthlyW.filter((m) => {
      const mm = Number(String(m.month).slice(5, 7));
      return mm === 12 || mm === 1 || mm === 2;
    });
    if (winter.length >= 2) {
      const winterAvg = winter.reduce((a, m) => a + m.usage, 0) / winter.length;
      const annualWater = monthlyW.reduce((a, m) => a + m.usage, 0);
      // volumetric rate from the priced basis (total minus fixed, per unit)
      const volRate = currentCost && annualWater > 0 ? Math.max(0, (currentCost.breakdown.total - currentCost.breakdown.fixed) / annualWater) : 0;
      if (volRate > 0 && winterAvg > 0) {
        // Indoor-reduction screening band: 10–20% of winter average (leak
        // repair, fixture efficiency). Water-side: reduction × 12 × volumetric
        // rate. Sewer-side: same volume re-billed all year at an ASSUMED sewer
        // rate of 0.8–1.0× the water volumetric rate (typical municipal ratio
        // is 0.8–1.4×; we take the conservative end and disclose it).
        oppCands.push({
          key: "winter_water_sewer",
          title: "Cut winter indoor water use — it sets your sewer bill all year",
          category: "efficiency",
          annualSavingsUsdLo: winterAvg * 0.1 * 12 * volRate * 1.8,
          annualSavingsUsdHi: winterAvg * 0.2 * 12 * volRate * 2.0,
          capexBand: "low",
          confidence: "low",
          rationale: `Your winter monthly average (${winterAvg.toFixed(0)} ${COMMODITY_UNITS.water.usageUnit}/mo over ${winter.length} winter months) is what most municipal utilities use to set sewer charges for the entire following year (winter-quarter-average convention). Reducing winter indoor use 10–20% — leak repair, fixture efficiency — saves on the water bill now AND on 12 months of sewer billing set by that window.`,
          disclosures: [
            "Sewer-side savings assume your municipality sets sewer charges from winter water usage and bills sewer volume at 0.8–1.0× your water volumetric rate — Meterly does not have your sewer tariff on file; verify the convention on your sewer bill before counting these dollars.",
            MODELED_ESTIMATES_DISCLAIMER,
          ],
        });
      }
    }
  }
  // Batch-19 (pass 539): the disclosure names the actual cause — a customer
  // with usage data but no identified tariff was being told their "cost basis
  // could not be established", which misdirects them toward re-uploading data
  // instead of selecting a tariff.
  // Batch-41 (pass 1769): a third cause — valid interval data that is export-
  // dominated (no positive net-import kWh) — must not be blamed on "usage data"
  // the customer did in fact upload; the blended-rate math is import-only.
  const fallbackRateDisclosure =
    fallbackReason === "no_tariff_cost_basis"
      ? `Savings priced at ${priceBasisPhrase} because no tariff could be identified to compute your real rate — select or verify your tariff to price savings at your actual rate.`
      : fallbackReason === "no_net_import"
        ? `Savings priced at ${priceBasisPhrase}: your interval data is valid but shows no positive net-import energy (export-dominated profile), and the blended-rate calculation is based on imported kWh only.`
        : `Savings priced at ${priceBasisPhrase} because your annual cost basis could not be established — actual savings scale with your real rate.`;
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
      rationale: `Cooling is an estimated ${(endUseFractions.cooling * 100).toFixed(0)}% of annual use (${dis.label}). The 5–15% cooling-savings band spans ENERGY STAR's smart-thermostat field finding (~8% of HVAC energy) and ACEEE/LBNL retro-commissioning ranges for setpoint and schedule optimization.`,
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
      rationale: `Lighting is an estimated ${(endUseFractions.lighting * 100).toFixed(0)}% of annual use (${dis.label}). The 30–55% band reflects DOE Solid-State Lighting program findings for LED conversion from mixed fluorescent/HID stock (upper end with occupancy controls).`,
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
  /* AC15 — incentives on the opportunity feed. Two obligations:
     (1) demand-response enrollments are NEGATIVE-COST actions (the utility
         pays you) and surface as their own "they pay you" card;
     (2) any capex measure with a live matching incentive names it with the
         source — pre/post-incentive economics render in the scenario layer. */
  try {
    const { matchIncentives } = await import("../incentives");
    const sector =
      site.buildingType && ["single_family", "multifamily"].includes(site.buildingType) ? ("residential" as const) : ("commercial" as const);
    const drMatches = await matchIncentives({
      measureKey: "peak_management",
      state: site.state ?? null,
      utilityName: site.utilityName ?? null,
      sectorClass: sector,
      capexUsd: 0,
    });
    const drPay = drMatches.filter((m) => m.kind === "dr_payment" && (m.annualUsd ?? 0) > 0);
    if (drPay.length > 0) {
      const total = drPay.reduce((s, m) => s + (m.annualUsd ?? 0), 0);
      oppCands.push({
        key: "dr_enrollment",
        title: `Demand-response enrollment — ${drPay[0].whoPays.split(" (")[0]} pays you`,
        category: "tariff",
        annualSavingsUsdLo: total,
        annualSavingsUsdHi: total,
        capexBand: "none",
        confidence: "medium",
        rationale: `${drPay.map((m) => m.name).join("; ")}: enrollment credits worth ~$${total}/yr — a negative-cost action; the utility pays you to allow brief peak-event adjustments you can override.`,
        disclosures: [drPay[0].disclosure],
      });
      narrate(`AC15: demand-response enrollment surfaced as a they-pay-you card ($${total}/yr, ${drPay.length} program${drPay.length === 1 ? "" : "s"})`);
    }
    for (const c of oppCands) {
      if (c.capexBand === "none") continue;
      const ms = await matchIncentives({
        measureKey: c.key,
        state: site.state ?? null,
        utilityName: site.utilityName ?? null,
        sectorClass: sector,
        capexUsd: 0,
      });
      const live = ms.filter((m) => m.annualUsd == null);
      if (live.length > 0) {
        c.disclosures = [
          ...(c.disclosures ?? []),
          `Incentive available: ${live.map((m) => m.name).join("; ")} (${live[0].sourceName}) — run the scenario for pre- and post-incentive payback.`,
        ];
      }
    }
  } catch (e) {
    narrate(`AC15 incentive matching skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  /* v1.18 §5 stage 5 — tenure modes: opportunity generation must respect what
     the occupant can actually DO. "A renter shown a solar payback is a spec
     failure." Owner-capex measures (building retrofits the tenant cannot
     execute: LED retrofit and any capexBand 'medium'+) are moved out of the
     renter's action feed into a separate 'worth raising with your landlord'
     bucket — never deleted (the dollars are real; the AUDIENCE differs).
     In-control measures (rate switch, schedule/setpoint, behavioral, peak
     management, water fixtures) stay. Condo/HOA keeps in-unit measures and
     tags shared-system items the same way. Owners see everything unchanged. */
  const OWNER_CAPEX_KEYS = new Set(["led_retrofit"]);
  const tenure = (site as { tenure?: "own" | "rent" | "condo_hoa" }).tenure ?? "own";
  const isOwnerCapex = (c: OpportunityCandidate) =>
    OWNER_CAPEX_KEYS.has(c.key) || c.capexBand === "medium" || c.capexBand === "high";
  /* Cross-commodity parity (owner report Jul 19): gas/water opportunities are
     generated HERE, in the SAME run, because replaceOpportunities wipes the
     site's rows per analysis — generating them in a separate run would let an
     electric re-run silently clobber the gas/water cards. Baselines follow
     the same imputed-vs-measured discipline as electric: measured when ≥60
     days of that commodity's meter data exists, else benchmark-imputed
     (CBECS/RECS/WaterSense intensity × sqft) with the imputation disclosed
     verbatim on every card. Injected BEFORE tenure filtering so renter/HOA
     rules apply to gas/water capex measures identically. */
  try {
    const currentCommodity = meter?.commodity ?? "electric";
    const xc = (await generateCommodityOpportunities(
      { id: site.id, buildingType: site.buildingType, sqft: site.sqft, state: site.state, zip: site.zip },
      userId,
      normals,
      narrate,
    )).filter((c) => c.commodity !== currentCommodity);
    const existingKeys = new Set(oppCands.map((c) => c.key));
    for (const c of xc) if (!existingKeys.has(c.key)) oppCands.push(c);
  } catch (e) {
    narrate(`Cross-commodity opportunity generation skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  const tenureFiltered = tenure === "own" ? oppCands : oppCands.filter((c) => !isOwnerCapex(c));
  const landlordBucket = tenure === "own" ? [] : oppCands.filter(isOwnerCapex);
  if (landlordBucket.length > 0) {
    narrate(
      `Tenure-aware feed (${tenure === "rent" ? "renter" : "condo/HOA"}): ${landlordBucket.length} owner-capex measure${landlordBucket.length === 1 ? "" : "s"} moved to 'worth raising with your landlord' — your feed leads with dollars in your control`,
    );
  }
  const ranked = rankOpportunities(tenureFiltered) as OppCand[];
  // Landlord-bucket items are persisted AFTER the in-control ranking with a
  // provenance audience marker so the UI renders them in a separate card and
  // never as a payback the renter is asked to buy.
  const landlordRows = (landlordBucket as OppCand[]).map((c, i) => ({
    siteId: site.id,
    analysisId,
    measure: c.key,
    title: c.title,
    description: c.rationale,
    estCostSavingsPerYr: (c.annualSavingsUsdLo + c.annualSavingsUsdHi) / 2,
    estEnergySavingsPerYr: c.estUnitsSavedPerYr ?? null,
    energyUnit: c.unit ?? COMMODITY_UNITS.electric.usageUnit,
    estDemandSavingsKw: null,
    paybackBandYears: c.capexBand === "none" ? "immediate" : c.capexBand === "low" ? "0.5–2 yr" : "2–6 yr",
    confidence: c.confidence,
    disaggregationMethod: disaggMethod,
    ratchetAware: false,
    rank: 1000 + i,
    provenance: {
      savingsRange: [c.annualSavingsUsdLo, c.annualSavingsUsdHi],
      category: c.category,
      disclosures: c.disclosures,
      audience: "landlord" as "occupant" | "landlord",
      audienceNote:
        tenure === "rent"
          ? "Capital measure — your landlord pays, the building benefits. Pre-drafted ask available; worth raising at lease renewal."
          : "Shared-system measure — raise with your HOA/board; savings accrue to the building.",
      commodity: c.commodity ?? "electric",
    },
  }));
  await h.replaceOpportunities(
    site.id,
    ranked.map((c, i) => ({
      siteId: site.id,
      analysisId,
      measure: c.key,
      title: c.title,
      // Owner bug report (Jul 18): disclaimers were concatenated into the
      // description, displacing the actual recommendation on the card. The
      // description is now the cause/rationale ONLY; disclosures move to
      // provenance where the card's "where this comes from" expander shows them.
      description: c.rationale,
      estCostSavingsPerYr: (c.annualSavingsUsdLo + c.annualSavingsUsdHi) / 2,
      estEnergySavingsPerYr: c.estUnitsSavedPerYr ?? null,
      energyUnit: c.unit ?? COMMODITY_UNITS.electric.usageUnit,
      estDemandSavingsKw: c.key === "peak_management" && demand ? demand.peakKw * 0.1 : null,
      paybackBandYears: c.capexBand === "none" ? "immediate" : c.capexBand === "low" ? "0.5–2 yr" : "2–6 yr",
      confidence: c.confidence,
      disaggregationMethod: disaggMethod,
      ratchetAware: c.key === "peak_management",
      rank: i + 1,
      provenance: { savingsRange: [c.annualSavingsUsdLo, c.annualSavingsUsdHi], category: c.category, disclosures: c.disclosures, audience: "occupant" as "occupant" | "landlord", commodity: c.commodity ?? "electric" },
    })).concat(landlordRows),
  );
    narrate(`Ranked ${ranked.length} opportunit${ranked.length === 1 ? "y" : "ies"} by estimated annual dollar impact`);
  /* §3i alerts — generated here, because in a manual-upload world the analysis
     run is the only moment new information appears. Dollar-first + batched:
     upsertAlert refuses rows under the $25 materiality floor and refreshes the
     open (site, kind) row instead of duplicating. Alert failures never fail
     the analysis. */
  try {
    if (anomalyResult && anomalyResult.changePointMonth && currentCost && currentCost.breakdown.total > 0) {
      const shiftMonths = anomalyResult.anomalies.filter((a) => a.kind === "sustained_shift");
      if (shiftMonths.length > 0) {
        const avgResidual = shiftMonths.reduce((s, a) => s + a.residualPct, 0) / shiftMonths.length;
        const annualUsdImpact = Math.abs(avgResidual) * currentCost.breakdown.total;
        await h.upsertAlert({
          userId,
          siteId: site.id,
          kind: "anomaly",
          title: `Usage shifted ${avgResidual > 0 ? "up" : "down"} ~${Math.abs(avgResidual * 100).toFixed(0)}% vs. weather model since ${anomalyResult.changePointMonth}`,
          body: `Sustained ${shiftMonths.length}-month deviation from the weather-normalized baseline — consistent with an operational or equipment change rather than weather. At your current annual cost this is roughly $${Math.round(annualUsdImpact).toLocaleString()}/yr if it persists. Modeled estimate.`,
          dollarImpactUsd: annualUsdImpact,
          confidence: baseline && baseline.confidence === "high" ? "medium" : "low",
        });
      }
    }
    /* v1.19 §5 stage 4 — away-mode watchdog: when the site is flagged away,
       evaluate the away-window intervals against the vacant baseline. Sustained
       excess (6h+) fires a safety alert (no $25 floor); quiet posts nothing here
       (the reassurance card renders from site state in the feed). Evaluated at
       analysis time — in a manual-upload world this is the only moment new
       information appears, and the card copy says so. */
    const away = site as { awayMode?: boolean; awayStart?: number | null; awayEnd?: number | null };
    if (away.awayMode && hasIntervals && points.length > 0) {
      const awayPts = points
        .filter((p) => tsInAwayWindow(p.ts, { awayMode: true, awayStart: away.awayStart ?? null, awayEnd: away.awayEnd ?? null }))
        .map((p) => ({ ts: p.ts, durationMin: p.durationMin, usage: p.usage }));
      if (awayPts.length > 0) {
        const commodity = (meter?.commodity ?? "electric") as "electric" | "gas" | "water";
        const vacant = computeVacantBaseline(
          points.map((p) => ({ ts: p.ts, durationMin: p.durationMin, usage: p.usage })),
          commodity,
          away.awayStart ?? null,
          meter?.timezone ?? undefined,
        );
        const finding = evaluateAwayWatchdog(awayPts, vacant, commodity, {
          ratePerUnit: kWhRate,
          siteLabel: site.name,
          tz: meter?.timezone ?? undefined,
        });
        narrate(
          finding.kind === "quiet"
            ? `Away watchdog: all quiet — usage holding at the empty-home baseline across ${awayPts.length} away-window readings`
            : `Away watchdog: ${finding.kind.replace(/_/g, " ")} detected across ${awayPts.length} away-window readings`,
        );
        if (finding.kind === "excess_usage" || finding.kind === "sustained_water_flow") {
          await h.upsertAlert({
            userId,
            siteId: site.id,
            kind: "away_watchdog",
            title: finding.title,
            body: finding.body,
            dollarImpactUsd: finding.dollarImpactUsd,
            confidence: vacant?.basis === "overnight_floor" ? "medium" : "low",
          });
        }
      }
    }
    const top = ranked[0];
    if (top) {
      const mid = (top.annualSavingsUsdLo + top.annualSavingsUsdHi) / 2;
      await h.upsertAlert({
        userId,
        siteId: site.id,
        kind: "rate_opportunity",
        title: `${top.title} — ~$${Math.round(mid).toLocaleString()}/yr modeled`,
        body: `${top.rationale} Range $${Math.round(top.annualSavingsUsdLo).toLocaleString()}–$${Math.round(top.annualSavingsUsdHi).toLocaleString()}/yr. Modeled estimate — not a guarantee.`,
        dollarImpactUsd: mid,
        confidence: top.confidence,
      });
    }
  } catch {
    /* alerts must never fail the analysis */
  }
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
  hasAnyPoints?: boolean,
  stateAvg?: { rate: number; state: string } | null,
  billVerified?: { rate: number; basis: string } | null,
): { rate: number; isFallback: boolean; fallbackReason?: "no_tariff_cost_basis" | "no_usage_data" | "no_net_import"; fallbackBasis?: string } {
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
  // Batch-41 (pass 1769): an export-dominated site CAN have interval data yet
  // zero net-import kWh — telling that customer "no usage data" misdirects
  // them toward re-uploading valid data. The blended rate is import-only by
  // design; name that condition specifically.
  const hasPositiveUsage = (annualUsage && annualUsage > 0) || (rawUsageKwh && rawUsageKwh > 0);
  // NEXT-1 (Jul 21, "calibrate to my bill"): when no tariff/cost basis exists
  // but the customer has REAL bills on file, their own blended rate (sum cost /
  // sum usage across recent actual-read bills, latest revision per period —
  // billCalibration.ts) beats every imputation: it is an observed price, not a
  // modeled or averaged one. Still flagged isFallback because it lacks the
  // tariff structure needed for per-period exactness (TOU/demand split), but
  // the basis string carries bill-verified provenance so disclosures and
  // badges rank it above all imputed tiers.
  if (billVerified && Number.isFinite(billVerified.rate) && billVerified.rate > 0) {
    return {
      rate: billVerified.rate,
      isFallback: true,
      fallbackReason: hasPositiveUsage ? "no_tariff_cost_basis" : hasAnyPoints ? "no_net_import" : "no_usage_data",
      fallbackBasis: billVerified.basis,
    };
  }
  // Owner directive (Jul 19, "actual as able, imputed where required, notated
  // accordingly"): before dropping all the way to the generic $0.12 national
  // assumption, use the site's STATE-average commercial retail rate (EIA-861
  // 2024, seeded in STATE_PROFILES) — a materially better imputation (state
  // averages span ~9¢ WY to ~40¢ HI) that is still explicitly notated.
  if (stateAvg && Number.isFinite(stateAvg.rate) && stateAvg.rate > 0) {
    return {
      rate: stateAvg.rate,
      isFallback: true,
      fallbackReason: hasPositiveUsage ? "no_tariff_cost_basis" : hasAnyPoints ? "no_net_import" : "no_usage_data",
      fallbackBasis: `the ${stateAvg.state} state-average rate ($${stateAvg.rate.toFixed(3)}/kWh, EIA-861 2024 — state-average imputed)`,
    };
  }
  return {
    rate: 0.12,
    isFallback: true,
    fallbackReason: hasPositiveUsage ? "no_tariff_cost_basis" : hasAnyPoints ? "no_net_import" : "no_usage_data",
    fallbackBasis: "a $0.12/kWh national-average assumption",
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
