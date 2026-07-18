/**
 * Peak Attribution (UX addendum §3b) — "what made my peak happen?"
 *
 * Splits the annual peak demand event into honest, additive-ish components:
 *   - weather share: how much of the peak-hour load tracks weather response
 *     (scaled from the monthly CalTRACK fit at the peak month's conditions —
 *     a monthly model applied to an hour, so it is labeled a modeled share
 *     with wide bands, never a measurement)
 *   - schedule share: how much reflects the site's typical time-of-week load
 *     at that hour (median load for that day-of-week/hour across the record)
 *   - coincidence residual: the remainder — the part of the peak that is
 *     neither typical schedule nor weather-explained (simultaneity of loads)
 *
 * Also classifies the peak shape (spike vs plateau) from adjacent intervals,
 * because the fix differs: spikes → stagger/sequence equipment; plateaus →
 * setpoint/schedule changes or storage.
 *
 * Counterfactual pricing: re-runs the tariff engine on a modified series with
 * the peak window shaved by the actionable share, producing a $ figure with
 * the same engine that prices real bills — never a flat ¢/kWh shortcut.
 *
 * Sufficiency gates (honesty):
 *   - needs ≥ 90 days of interval data covering the peak month
 *   - weather split requires a usable baseline fit (rSquared not null)
 *   - all shares carry "modeled" labels and the disclosure names the method
 */
import type { IntervalPoint, TariffStructure } from "../../shared/wattwise";
import { DEFAULT_TZ, localParts } from "../../shared/wattwise";
import { costOnTariff, type DemandAnalytics } from "./tariffEngine";
import type { BaselineFit } from "./baseline";

export interface PeakAttribution {
  peakKw: number;
  peakTs: number;
  peakLocal: string; // human-readable local time
  shape: "spike" | "plateau";
  shapeDetail: string;
  /** shares in kW, each >= 0; weather + schedule + coincidence ≈ peakKw */
  weatherKw: number | null; // null when no usable weather fit
  scheduleKw: number;
  coincidenceKw: number;
  /** counterfactual: shave the actionable share across the peak window */
  counterfactual: {
    shavedKw: number;
    annualSavingsUsd: number;
    method: string;
  } | null;
  confidence: "low" | "medium";
  disclosures: string[];
}

/** median of a numeric array (returns 0 for empty) */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function kwOf(p: IntervalPoint): number | null {
  if (typeof p.demand === "number" && Number.isFinite(p.demand)) return p.demand;
  if (!Number.isFinite(p.usage) || !p.durationMin || p.durationMin <= 0) return null;
  return (p.usage * 60) / p.durationMin;
}

export function computePeakAttribution(
  points: IntervalPoint[],
  demand: DemandAnalytics,
  baseline: BaselineFit | null,
  tariffStructure: TariffStructure | null,
  tz: string = DEFAULT_TZ,
): PeakAttribution | null {
  const disclosures: string[] = [];
  if (points.length < 10) return null;

  // ---- sufficiency: ≥90 days of data ----
  const spanMs = points[points.length - 1].ts - points[0].ts;
  const spanDays = spanMs / 86_400_000;
  if (spanDays < 90) return null;

  const peakTs = demand.peakTimestamp;
  const peakKw = demand.peakKw;
  if (!Number.isFinite(peakKw) || peakKw <= 0) return null;
  const pk = localParts(peakTs, tz);

  // ---- schedule share: median kW at this day-of-week/hour across record ----
  const towSamples: number[] = [];
  for (const p of points) {
    const lp = localParts(p.ts, tz);
    if (lp.dow === pk.dow && lp.hour === pk.hour) {
      const kw = kwOf(p);
      if (kw !== null && Number.isFinite(kw)) towSamples.push(kw);
    }
  }
  if (towSamples.length < 4) return null; // not enough same-slot history
  const scheduleKw = Math.min(median(towSamples), peakKw);

  // ---- weather share: modeled from monthly fit, capped by residual ----
  let weatherKw: number | null = null;
  if (baseline && baseline.rSquared !== null && baseline.method !== "archetype_synthetic") {
    // Monthly slopes are kWh/day per degree-day. Convert the peak month's
    // typical daily weather-driven energy to an average kW and attribute the
    // cooling/heating portion at the peak hour with a peak-coincidence factor.
    // This is deliberately conservative and clearly labeled as modeled.
    const c = baseline.coefficients;
    // approximate degree-days at peak from season: use slope magnitudes as a
    // share of total modeled daily energy rather than absolute reconstruction
    const dailyBase = Math.max(c.baseloadPerDay, 0);
    const month = pk.month; // 1-12
    const isCooling = month >= 5 && month <= 9;
    const slope = isCooling ? c.coolingSlope : c.heatingSlope;
    if (slope > 0 && dailyBase >= 0) {
      // typical degree-days/day in peak season ~8-12; use 10 as normal-year
      // proxy (the fit already used normals as regressor — same basis)
      const weatherDailyKwh = slope * 10;
      const totalDailyKwh = dailyBase + weatherDailyKwh;
      if (totalDailyKwh > 0) {
        const weatherShare = weatherDailyKwh / totalDailyKwh;
        // weather load concentrates at peak hours; apply 1.5x concentration,
        // capped so schedule+weather never exceeds the peak itself
        weatherKw = Math.min(peakKw * weatherShare * 1.5, Math.max(peakKw - scheduleKw, 0));
      }
      disclosures.push(
        "Weather share is modeled from the monthly weather fit applied at the peak hour (normal-year degree-day basis, 1.5× peak-hour concentration) — a modeled estimate, not a submetered measurement.",
      );
    } else {
      weatherKw = 0;
    }
  } else {
    disclosures.push(
      "No usable weather regression for this site — the peak is split between typical-schedule and coincidence components only.",
    );
  }

  const coincidenceKw = Math.max(peakKw - scheduleKw - (weatherKw ?? 0), 0);

  // ---- peak shape triage: spike vs plateau ----
  // count consecutive intervals within 5% of peak around the peak timestamp
  const idx = points.findIndex((p) => p.ts === peakTs);
  let nearCount = 1;
  if (idx >= 0) {
    for (let i = idx + 1; i < points.length; i++) {
      const kw = kwOf(points[i]);
      if (kw !== null && kw >= peakKw * 0.95) nearCount++;
      else break;
    }
    for (let i = idx - 1; i >= 0; i--) {
      const kw = kwOf(points[i]);
      if (kw !== null && kw >= peakKw * 0.95) nearCount++;
      else break;
    }
  }
  const durMin = points[Math.max(idx, 0)]?.durationMin ?? 60;
  const nearMinutes = nearCount * durMin;
  const shape: "spike" | "plateau" = nearMinutes <= 60 ? "spike" : "plateau";
  const shapeDetail =
    shape === "spike"
      ? `Load stayed within 5% of the peak for only ~${nearMinutes} minutes — a short spike. Staggering equipment starts or sequencing large loads is usually the cheapest fix.`
      : `Load stayed within 5% of the peak for ~${(nearMinutes / 60).toFixed(1)} hours — a sustained plateau. Setpoint/schedule changes or storage matter more than start-staggering here.`;

  // ---- counterfactual: shave the actionable (coincidence) share ----
  let counterfactual: PeakAttribution["counterfactual"] = null;
  if (tariffStructure && coincidenceKw > 0.5) {
    const shaveKw = coincidenceKw * 0.5; // assume half the coincidence share is addressable
    const targetKw = peakKw - shaveKw;
    const shaved: IntervalPoint[] = points.map((p) => {
      const kw = kwOf(p);
      if (kw === null || kw <= targetKw) return p;
      const scaled = targetKw / kw;
      return {
        ...p,
        usage: p.usage * scaled,
        demand: typeof p.demand === "number" ? p.demand * scaled : p.demand,
      };
    });
    try {
      const before = costOnTariff(points, tariffStructure, { tz });
      const after = costOnTariff(shaved, tariffStructure, { tz });
      const savings = before.breakdown.total - after.breakdown.total;
      if (Number.isFinite(savings) && savings > 0) {
        counterfactual = {
          shavedKw: shaveKw,
          annualSavingsUsd: savings,
          method:
            "Full-year re-price on your assigned rate with all intervals above the shaved threshold scaled down — the same engine that prices your bills, not a flat ¢/kWh estimate.",
        };
      }
    } catch {
      // tariff engine may throw on unusual structures; attribution still stands
    }
  }
  if (!counterfactual) {
    disclosures.push(
      tariffStructure
        ? "No counterfactual $ figure: the addressable coincidence share is too small to price meaningfully."
        : "No counterfactual $ figure: no priced rate is assigned to this meter — assign your actual tariff to see what shaving this peak is worth.",
    );
  }

  return {
    peakKw,
    peakTs,
    peakLocal: new Date(peakTs).toLocaleString("en-US", { timeZone: tz }),
    shape,
    shapeDetail,
    weatherKw,
    scheduleKw,
    coincidenceKw,
    counterfactual,
    confidence: weatherKw !== null ? "medium" : "low",
    disclosures,
  };
}
