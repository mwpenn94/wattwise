/**
 * §3e Prove-it verification loop.
 *
 * When a user marks a measure implemented, each evaluation pass compares the
 * counterfactual baseline (what the model expected WITHOUT the measure) against
 * actual metered usage after the implementation date, month by month.
 *
 * Honesty gates (from the addendum, non-negotiable):
 *  - No verdict at all before ONE full calendar month of post-implementation data.
 *  - Fewer than 3 evaluable months → verdict band is labeled "early read" and the
 *    status can be at most on_track / underperforming, never "verified".
 *  - The comparison band is derived from the baseline model's CVRMSE — a wide
 *    (low-confidence) baseline yields a wide band, and a delta inside the band
 *    is "inconclusive", never claimed as savings.
 *  - Misses are handled with next steps, not blame (copy lives in the verdict note).
 */
import type { BaselineFit } from "./baseline";

export interface MonthlyActual {
  /** "YYYY-MM" local month key */
  month: string;
  /** metered kWh for the month */
  usageKwh: number;
  /** expected kWh for the month from the counterfactual baseline */
  expectedKwh: number;
}

export interface MonthVerdict {
  month: string;
  expectedKwh: number;
  actualKwh: number;
  /** positive = used less than the counterfactual (good) */
  deltaKwh: number;
  deltaUsd: number;
  bandUsd: number;
  verdict: "saving" | "inconclusive" | "over_baseline";
  note: string;
}

export interface ProveItResult {
  status: "awaiting_data" | "on_track" | "verified" | "underperforming" | "inconclusive";
  monthVerdicts: MonthVerdict[];
  /** sum of month deltas that cleared the band, in $ (never counts inconclusive months) */
  verifiedSavingsUsd: number;
  headline: string;
  disclosures: string[];
}

/**
 * Evaluate an implementation against post-date monthly actuals.
 * `blendedRateUsdPerKwh` converts kWh deltas to dollars — the same blended rate
 * the pipeline uses elsewhere, disclosed as such.
 */
export function evaluateImplementation(
  months: MonthlyActual[],
  fit: BaselineFit | null,
  blendedRateUsdPerKwh: number,
  expectedAnnualSavingsUsd: number | null,
): ProveItResult {
  const disclosures: string[] = [];
  if (months.length === 0) {
    return {
      status: "awaiting_data",
      monthVerdicts: [],
      verifiedSavingsUsd: 0,
      headline: "Awaiting your first full month of post-change data.",
      disclosures: [
        "No verdict is made until one full calendar month of usage after your implementation date lands — anything sooner would be a guess.",
      ],
    };
  }

  // Band width: baseline model uncertainty. CVRMSE of the fit (typical 0.05–0.3)
  // scaled to each month's expected usage. No fit → very wide band (25%).
  const cv = fit?.cvrmse != null && fit.cvrmse > 0 ? fit.cvrmse : 0.25;
  if (!fit) {
    disclosures.push(
      "No weather-adjusted baseline model was available — a wide ±25% band was applied, so only large changes can be confirmed.",
    );
  } else {
    disclosures.push(
      `Comparison band: ±${Math.round(cv * 100)}% of expected usage, from the baseline model's error (CVRMSE). Deltas inside the band are reported as inconclusive, not savings.`,
    );
  }

  const monthVerdicts: MonthVerdict[] = months.map((m) => {
    const deltaKwh = m.expectedKwh - m.usageKwh;
    const deltaUsd = deltaKwh * blendedRateUsdPerKwh;
    const bandKwh = m.expectedKwh * cv;
    const bandUsd = bandKwh * blendedRateUsdPerKwh;
    let verdict: MonthVerdict["verdict"];
    let note: string;
    if (deltaKwh > bandKwh) {
      verdict = "saving";
      note = `Used ${Math.round(deltaKwh)} kWh less than the weather-adjusted counterfactual — outside the uncertainty band, so this reads as a real change.`;
    } else if (deltaKwh < -bandKwh) {
      verdict = "over_baseline";
      note = `Usage ran ${Math.round(-deltaKwh)} kWh ABOVE the counterfactual. Common causes: new equipment, schedule change, or the measure not operating as configured — worth a walk-through before assuming the measure failed.`;
    } else {
      verdict = "inconclusive";
      note = `The change (${deltaKwh >= 0 ? "-" : "+"}${Math.round(Math.abs(deltaKwh))} kWh) sits inside the model's uncertainty band — honestly can't be attributed either way yet.`;
    }
    return {
      month: m.month,
      expectedKwh: Math.round(m.expectedKwh),
      actualKwh: Math.round(m.usageKwh),
      deltaKwh: Math.round(deltaKwh),
      deltaUsd: Math.round(deltaUsd),
      bandUsd: Math.round(bandUsd),
      verdict,
      note,
    };
  });

  const savingMonths = monthVerdicts.filter((v) => v.verdict === "saving");
  const overMonths = monthVerdicts.filter((v) => v.verdict === "over_baseline");
  const verifiedSavingsUsd = savingMonths.reduce((s, v) => s + v.deltaUsd, 0);

  // Status ladder with the <3-months early-read gate.
  const evaluable = monthVerdicts.length;
  let status: ProveItResult["status"];
  if (evaluable < 3) {
    // early read — never "verified"
    if (savingMonths.length > 0 && overMonths.length === 0) status = "on_track";
    else if (overMonths.length > 0) status = "underperforming";
    else status = "inconclusive";
    disclosures.push(
      `Early read (${evaluable} month${evaluable === 1 ? "" : "s"}): a "verified" verdict needs at least 3 evaluable months.`,
    );
  } else if (savingMonths.length >= Math.ceil(evaluable * 0.6) && overMonths.length === 0) {
    status = "verified";
  } else if (savingMonths.length > overMonths.length) {
    status = "on_track";
  } else if (overMonths.length > savingMonths.length) {
    status = "underperforming";
  } else {
    status = "inconclusive";
  }

  let headline: string;
  if (status === "verified") {
    headline = `Verified: $${Math.round(verifiedSavingsUsd)} saved so far vs the counterfactual baseline.`;
  } else if (status === "on_track") {
    headline = `On track: $${Math.round(verifiedSavingsUsd)} of band-clearing savings so far — more months will firm this up.`;
  } else if (status === "underperforming") {
    headline =
      "Not showing yet: usage is running above the counterfactual. Here's what to check next — not a verdict on you.";
  } else {
    headline = "Inconclusive so far: the change is inside the model's uncertainty band.";
  }

  if (expectedAnnualSavingsUsd != null && evaluable >= 3) {
    const annualizedActual = (verifiedSavingsUsd / evaluable) * 12;
    disclosures.push(
      `Expected ~$${Math.round(expectedAnnualSavingsUsd)}/yr at mark time; current pace annualizes to ~$${Math.round(annualizedActual)}/yr.`,
    );
  }
  disclosures.push(
    `Dollars use your blended rate ($${blendedRateUsdPerKwh.toFixed(3)}/kWh) — bill-exact verification needs the rate re-price, available in reports.`,
  );

  return { status, monthVerdicts, verifiedSavingsUsd: Math.round(verifiedSavingsUsd), headline, disclosures };
}

/**
 * Build monthly expected-vs-actual pairs from interval data and a baseline fit.
 * Months are only evaluable when: fully after the implementation date AND fully
 * complete (not the current partial month) AND having ≥85% reading coverage.
 */
export function buildMonthlyActuals(
  points: Array<{ ts: number; usage: number }>,
  implementedAtMs: number,
  expectedKwhByMonth: (monthKey: string) => number | null,
  tz: string,
  nowMs: number = Date.now(),
): MonthlyActual[] {
  // group post-implementation points into local calendar months
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" });
  const byMonth = new Map<string, { kwh: number; count: number }>();
  for (const p of points) {
    if (p.ts < implementedAtMs) continue;
    const key = fmt.format(new Date(p.ts)); // "YYYY-MM"
    const cur = byMonth.get(key) ?? { kwh: 0, count: 0 };
    cur.kwh += p.usage;
    cur.count += 1;
    byMonth.set(cur === byMonth.get(key) ? key : key, cur);
  }
  const currentMonthKey = fmt.format(new Date(nowMs));
  const implMonthKey = fmt.format(new Date(implementedAtMs));

  const out: MonthlyActual[] = [];
  for (const [month, agg] of Array.from(byMonth.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (month === currentMonthKey) continue; // partial current month — never judged
    if (month === implMonthKey) continue; // implementation month is mixed — excluded
    // coverage check: hourly data → ~720 readings/month; accept ≥85% of 28-day floor
    if (agg.count < 24 * 28 * 0.85) continue;
    const expected = expectedKwhByMonth(month);
    if (expected == null || expected <= 0) continue;
    out.push({ month, usageKwh: agg.kwh, expectedKwh: expected });
  }
  return out;
}
