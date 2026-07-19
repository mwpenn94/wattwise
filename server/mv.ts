/**
 * M&V (measurement & verification) — IPMVP Option C, whole-facility.
 *
 * Custom rebate programs ($/kWh, $/therm saved) pay on VERIFIED savings, not
 * modeled ones. The verification recipe every program manual shares:
 *   1. Fit a weather-normalized baseline model on pre-install usage (CalTRACK
 *      monthly — the same fitter this app already uses for baselines).
 *   2. Project that model over the post-install (reporting) period.
 *   3. Avoided usage = model prediction − measured usage, with the model's
 *      CV(RMSE) carried as the uncertainty band.
 *
 * Honesty rules baked in:
 * - Never silently proceed with a bad model: CV(RMSE) and months coverage are
 *   surfaced, and results below programs' typical acceptance gates are labeled.
 * - Weather regressor is station NORMALS (typical weather), not observed
 *   weather — disclosed verbatim, because slopes then reflect typical response.
 * - No fabricated confidence: the uncertainty band comes from model CV(RMSE),
 *   and if the model can't be fit, we say why rather than guessing.
 */
import { TRPCError } from "@trpc/server";
import {
  fitCaltrackMonthly,
  intervalsToMonthly,
  normalsAsDailyTemps,
  type BaselineFit,
  type MonthNormalRow,
  type MonthlyUsage,
} from "./analytics/baseline";
import { COMMODITIES, type Commodity } from "../shared/commodity";
import { inferClimateZone } from "../shared/wattwise";
import * as h from "./dbHelpers";

export interface MvMonthRow {
  month: string; // YYYY-MM
  measured: number;
  predicted: number;
  avoided: number; // predicted − measured (positive = savings)
  days: number;
}

export interface MvAssessment {
  commodity: Commodity;
  unit: string;
  method: "ipmvp_option_c_caltrack_monthly";
  installDate: string; // ISO date the measure went in
  baselineMonths: number;
  reportingMonths: number;
  model: {
    rSquared: number | null;
    cvrmse: number | null;
    confidence: BaselineFit["confidence"];
    confidenceLabel: string;
    meetsAshraeGate: boolean; // CV(RMSE) ≤ 25% for monthly models (ASHRAE Guideline 14)
  };
  rows: MvMonthRow[];
  totalAvoidedUnits: number;
  /** ± band on totalAvoidedUnits from model CV(RMSE) */
  uncertaintyUnits: number;
  /** avoided units priced at the meter's tariff volumetric rate, if known */
  avoidedCostUsd: number | null;
  ratePerUnit: number | null;
  disclosures: string[];
}

/** Predict a month's usage from the fitted coefficients + normals proxy. */
function predictMonth(fit: BaselineFit, monthKey: string, days: number, normals: MonthNormalRow[]): number {
  const mi = parseInt(monthKey.split("-")[1], 10);
  const nrm = normals.find((n) => n.month === mi);
  const { baseloadPerDay, coolingSlope, heatingSlope, coolingBalanceF, heatingBalanceF } = fit.coefficients;
  const avg = nrm?.avgTempF ?? 65;
  const cdd = days * Math.max(0, avg - coolingBalanceF);
  const hdd = days * Math.max(0, heatingBalanceF - avg);
  return baseloadPerDay * days + coolingSlope * cdd + heatingSlope * hdd;
}

export async function assessMv(opts: {
  siteId: number;
  userId: number;
  meterId: number;
  /** epoch ms — measure in-service date splitting baseline vs reporting */
  installedAt: number;
}): Promise<MvAssessment> {
  const { siteId, userId, meterId, installedAt } = opts;
  const site = await h.getSite(siteId, userId);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
  const meters = await h.listMeters(siteId, userId);
  const meter = meters.find((m) => m.id === meterId);
  if (!meter) throw new TRPCError({ code: "NOT_FOUND", message: "Meter not found on this site" });
  const commodity = (meter.commodity ?? "electric") as Commodity;
  const meta = COMMODITIES[commodity];

  const pts = await h.getIntervalPoints(meterId, userId);
  if (pts.length < 2) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "M&V needs measured usage on this meter — no interval or billing data found." });
  }
  const pre = pts.filter((p) => p.ts < installedAt);
  const post = pts.filter((p) => p.ts >= installedAt);
  const preMonthly = intervalsToMonthly(pre);
  const postMonthly = intervalsToMonthly(post);
  if (preMonthly.length < 9) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `M&V baseline needs ≥9 months of pre-install data (CalTRACK minimum; 12 preferred) — found ${preMonthly.length}. Move the install date or add history.`,
    });
  }
  if (postMonthly.length < 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No post-install usage yet — M&V can run once the first reporting-period bill lands." });
  }

  /* ---- weather ---- */
  const climateZone = site.climateZone ?? inferClimateZone(site.zip ?? undefined, site.state ?? undefined);
  const station = await h.getWeatherStation(climateZone);
  const normals = (station?.monthlyNormals ?? []) as MonthNormalRow[];
  const disclosures: string[] = [];
  if (normals.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `No weather station for climate zone ${climateZone} — a weather-normalized baseline cannot be fit.` });
  }
  disclosures.push(
    "Weather regressor is station climate normals (typical weather), not observed weather for the actual months — avoided-usage figures are typical-weather estimates. Programs requiring observed-weather M&V need AMI + station history.",
  );

  /* ---- baseline model on pre-install months ---- */
  const temps = normalsAsDailyTemps(preMonthly.map((m) => m.month), normals);
  const fit = fitCaltrackMonthly(preMonthly, temps, normals, { weatherIsNormalsProxy: true });
  disclosures.push(...fit.disclosures);
  const meetsAshraeGate = fit.cvrmse != null && fit.cvrmse <= 0.25;
  if (!meetsAshraeGate) {
    disclosures.push(
      `Model CV(RMSE) ${fit.cvrmse != null ? Math.round(fit.cvrmse * 100) + "%" : "unavailable"} exceeds the ASHRAE Guideline 14 gate (≤25% for monthly models) — most custom programs will ask for a better baseline before paying on these numbers.`,
    );
  }

  /* ---- reporting period: avoided usage per month ---- */
  const rows: MvMonthRow[] = postMonthly
    .filter((m: MonthlyUsage) => m.days >= 20)
    .map((m) => {
      const predicted = predictMonth(fit, m.month, m.days, normals);
      return {
        month: m.month,
        measured: Math.round(m.usage * 100) / 100,
        predicted: Math.round(predicted * 100) / 100,
        avoided: Math.round((predicted - m.usage) * 100) / 100,
        days: m.days,
      };
    });
  const partialMonths = postMonthly.length - rows.length;
  if (partialMonths > 0) {
    disclosures.push(`${partialMonths} partial reporting month(s) (<20 days of data) excluded from the avoided-usage total.`);
  }
  if (rows.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "All post-install months are partial (<20 days) — M&V needs at least one full reporting month." });
  }
  const totalAvoided = rows.reduce((s, r) => s + r.avoided, 0);
  const totalPredicted = rows.reduce((s, r) => s + r.predicted, 0);
  const uncertaintyUnits = fit.cvrmse != null ? Math.round(Math.abs(totalPredicted) * fit.cvrmse * 100) / 100 : Math.round(Math.abs(totalPredicted) * 0.5 * 100) / 100;

  /* ---- price avoided units at the assigned tariff's volumetric rate ---- */
  let ratePerUnit: number | null = null;
  if (meter.currentTariffId) {
    const t = await h.getTariff(meter.currentTariffId);
    const s = t?.structure as { energy?: Array<{ ratePerUnit?: number }> } | undefined;
    ratePerUnit = s?.energy?.[0]?.ratePerUnit ?? null;
    if (commodity === "electric") {
      disclosures.push(
        "Avoided cost uses the first volumetric rate on the assigned tariff — TOU/demand effects are not re-simulated in M&V; the scenario engine remains the source for rate-sensitive dollar forecasts.",
      );
    }
  } else {
    disclosures.push(`No tariff assigned to this meter — avoided ${meta.usageUnit} are verified but not priced. Assign a tariff for dollar figures.`);
  }
  disclosures.push(
    `Verified avoided usage is the number custom rebate programs ($/${meta.tariffRateUnit} saved) pay on — export these rows with the model statistics for program filing.`,
  );

  return {
    commodity,
    unit: meta.usageUnit,
    method: "ipmvp_option_c_caltrack_monthly",
    installDate: new Date(installedAt).toISOString().slice(0, 10),
    baselineMonths: preMonthly.length,
    reportingMonths: rows.length,
    model: {
      rSquared: fit.rSquared,
      cvrmse: fit.cvrmse,
      confidence: fit.confidence,
      confidenceLabel: fit.confidenceLabel,
      meetsAshraeGate,
    },
    rows,
    totalAvoidedUnits: Math.round(totalAvoided * 100) / 100,
    uncertaintyUnits,
    avoidedCostUsd: ratePerUnit != null ? Math.round(totalAvoided * ratePerUnit * 100) / 100 : null,
    ratePerUnit,
    disclosures,
  };
}
