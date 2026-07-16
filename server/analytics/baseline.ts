/**
 * Baseline engine — CalTRACK-inspired balance-point regression, in-process TS.
 * Methods (provenance enum in `baselines.method`):
 *  - caltrack_monthly: HDD/CDD balance-point grid-search OLS on monthly usage
 *  - caltrack_hourly_tow: time-of-week + temperature bins on interval data
 *  - archetype_synthetic: prototype-archetype 8760 calibrated to user inputs
 *  - predictive_baseline: forward projection on "normal-year basis"
 *
 * Honesty gates: R², CVRMSE reported; coverage < 9 months → "low confidence,
 * extrapolated"; archetype paths labeled "prototype-archetype" verbatim.
 */
import { LABEL_NORMAL_YEAR, LABEL_PROTOTYPE_ARCHETYPE } from "../../shared/wattwise";

export interface MonthlyUsage {
  month: string; // YYYY-MM
  usage: number;
  days: number;
}

export interface MonthNormalRow {
  month: number;
  hddBase65: number;
  cddBase65: number;
  avgTempF: number;
}

export interface BaselineFit {
  method: "caltrack_monthly" | "caltrack_hourly_tow" | "archetype_synthetic" | "predictive_baseline";
  coefficients: {
    baseloadPerDay: number;
    coolingSlope: number; // per CDD
    heatingSlope: number; // per HDD
    coolingBalanceF: number;
    heatingBalanceF: number;
  };
  rSquared: number | null;
  cvrmse: number | null;
  monthsCoverage: number;
  confidence: "low" | "medium" | "high";
  confidenceLabel: string;
  weatherBasis: string; // LABEL_NORMAL_YEAR for normalized outputs
  /** normalized annual usage on normal-year basis */
  normalizedAnnualUsage: number;
  disclosures: string[];
}

/** Simple OLS: y = b0 + b1*x1 + b2*x2 (per-day). Returns null if singular. */
function ols3(
  rows: Array<{ y: number; x1: number; x2: number }>,
): { b0: number; b1: number; b2: number; r2: number; cvrmse: number } | null {
  const n = rows.length;
  if (n < 4) return null;
  // Build normal equations for [1, x1, x2]
  let sx1 = 0, sx2 = 0, sy = 0, sx1x1 = 0, sx2x2 = 0, sx1x2 = 0, sx1y = 0, sx2y = 0;
  for (const r of rows) {
    sx1 += r.x1; sx2 += r.x2; sy += r.y;
    sx1x1 += r.x1 * r.x1; sx2x2 += r.x2 * r.x2; sx1x2 += r.x1 * r.x2;
    sx1y += r.x1 * r.y; sx2y += r.x2 * r.y;
  }
  // Solve 3x3 via Cramer's rule
  const A = [
    [n, sx1, sx2],
    [sx1, sx1x1, sx1x2],
    [sx2, sx1x2, sx2x2],
  ];
  const B = [sy, sx1y, sx2y];
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const dA = det(A);
  if (Math.abs(dA) < 1e-9) return null;
  const repl = (col: number) => A.map((row, i) => row.map((v, j) => (j === col ? B[i] : v)));
  const b0 = det(repl(0)) / dA;
  const b1 = det(repl(1)) / dA;
  const b2 = det(repl(2)) / dA;
  const yBar = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const r of rows) {
    const pred = b0 + b1 * r.x1 + b2 * r.x2;
    ssTot += (r.y - yBar) ** 2;
    ssRes += (r.y - pred) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  const cvrmse = yBar !== 0 ? Math.sqrt(ssRes / Math.max(1, n - 3)) / Math.abs(yBar) : 1;
  return { b0, b1, b2, r2, cvrmse };
}

function degreeDays(avgTempsByDay: number[], base: number, kind: "hdd" | "cdd"): number {
  let s = 0;
  for (const t of avgTempsByDay) s += kind === "cdd" ? Math.max(0, t - base) : Math.max(0, base - t);
  return s;
}

/**
 * CalTRACK-monthly fit: grid search cooling balance 55–75, heating 50–65,
 * per-day OLS of usage ~ baseload + coolingSlope*CDD/day + heatingSlope*HDD/day.
 * monthlyTemps: for each usage month, mean daily temps (actual weather proxy —
 * we use station normals when actual weather unavailable, disclosed).
 */
export function fitCaltrackMonthly(
  monthly: MonthlyUsage[],
  monthDailyTemps: Map<string, number[]>,
  normals: MonthNormalRow[],
  opts: { weatherIsNormalsProxy: boolean },
): BaselineFit {
  const usable = monthly.filter((m) => monthDailyTemps.has(m.month) && m.days > 20);
  const disclosures: string[] = [];
  if (opts.weatherIsNormalsProxy) {
    disclosures.push(
      "Actual weather history unavailable — station climate normals used as the weather regressor; slopes reflect typical (not actual-year) weather response.",
    );
  }

  let best: { fit: NonNullable<ReturnType<typeof ols3>>; cb: number; hb: number } | null = null;
  for (let cb = 55; cb <= 75; cb += 2.5) {
    for (let hb = 50; hb <= 65; hb += 2.5) {
      if (hb > cb) continue;
      const rows = usable.map((m) => {
        const temps = monthDailyTemps.get(m.month)!;
        return {
          y: m.usage / m.days,
          x1: degreeDays(temps, cb, "cdd") / m.days,
          x2: degreeDays(temps, hb, "hdd") / m.days,
        };
      });
      const fit = ols3(rows);
      if (!fit) continue;
      // physical plausibility: slopes non-negative
      if (fit.b1 < 0 || fit.b2 < 0 || fit.b0 < 0) continue;
      if (!best || fit.r2 > best.fit.r2) best = { fit, cb, hb };
    }
  }

  const coverage = usable.length;
  if (!best) {
    // fall back to flat mean model
    const meanPerDay = usable.length ? usable.reduce((a, m) => a + m.usage / m.days, 0) / usable.length : 0;
    disclosures.push("Weather regression not statistically valid for this data — flat per-day mean baseline used.");
    const annual = meanPerDay * 365;
    return {
      method: "caltrack_monthly",
      coefficients: { baseloadPerDay: meanPerDay, coolingSlope: 0, heatingSlope: 0, coolingBalanceF: 65, heatingBalanceF: 60 },
      rSquared: null,
      cvrmse: null,
      monthsCoverage: coverage,
      confidence: "low",
      confidenceLabel: `low confidence — ${coverage} months coverage, no valid weather fit; flat per-day mean baseline used (no R²/CVRMSE — model was not fit)`,
      weatherBasis: LABEL_NORMAL_YEAR,
      normalizedAnnualUsage: annual,
      disclosures,
    };
  }

  const { fit, cb, hb } = best;
  // Normalized annual on normal-year basis
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let annual = 0;
  for (let m = 0; m < 12; m++) {
    const nrm = normals[m];
    // approximate normal-month daily temps as flat avg (HDD/CDD from normals directly)
    // Cycle 3, pass 71: degree days can never be negative — clamp both
    // balance-point-adjusted CDD and HDD at zero, and never let a single month
    // contribute negative energy to the annualized total.
    //
    // Dimensional note (cycle 5, pass 181 adjudication): the OLS fit is per-day
    // (y = kWh/day, x = DD/day), so a month's contribution is
    // days×(b0 + b1·cddPerDay) = b0·days + b1·monthlyCDD — nrm.cddBase65 is a
    // MONTHLY total, so multiplying it by the per-day slope is correct.
    // The balance-point shift term converts a per-day DD delta (°F shift ×
    // 0.35 occurrence fraction) into a monthly DD delta via ×daysInMonth —
    // also dimensionally consistent; 0.35 ≈ fraction of days whose mean temp
    // falls inside the shifted balance band (flat-distribution approximation,
    // disclosed as an approximation).
    // Batch-33 (pass 1251): the balance-point shift must be SIGNED. The old
    // Math.max(0, 65 - cb) truncated the CDD adjustment to zero whenever the
    // fitted cooling balance sat ABOVE 65°F (cb > 65 must DECREASE base-65 CDD:
    // a higher balance point means fewer cooling degree-days), and the HDD term
    // similarly must INCREASE when hb > 65 and decrease when hb < 65. Only the
    // outer clamp keeps a month's degree-days non-negative.
    const cdd = Math.max(0, nrm.cddBase65 + (65 - cb) * daysInMonth[m] * 0.35); // balance-point adjustment approximation (signed)
    const hdd = Math.max(0, nrm.hddBase65 + (hb - 65) * daysInMonth[m] * 0.35);
    annual += Math.max(0, fit.b0 * daysInMonth[m] + fit.b1 * cdd + fit.b2 * hdd);
  }
  disclosures.push(`Annualized usage computed on ${LABEL_NORMAL_YEAR} (NOAA 1991–2020 station normals).`);

  const confidence = coverage >= 12 && fit.r2 >= 0.7 ? "high" : coverage >= 9 && fit.r2 >= 0.5 ? "medium" : "low";
  // Batch-18 (pass 421): when coverage (<9 months) is WHY confidence is low, the
  // label must say so — a good-looking R² with a vague "extrapolated" suffix let
  // customers read a thin fit as reliable. Name the causal reason explicitly.
  // Batch-34 (pass 1301): the same causal-reason rule applies when a WEAK FIT
  // is the driver — with coverage ≥9 but R²<0.5 the label previously carried no
  // reason at all, inviting the wrong inference that coverage was the issue.
  const reasons: string[] = [];
  if (coverage < 9) reasons.push(`only ${coverage} months of data (needs ≥9); annualized figures are extrapolated beyond observed coverage`);
  if (fit.r2 < 0.5) reasons.push(`weather model fit is weak (R²=${fit.r2.toFixed(2)}, needs ≥0.5) — usage is not well explained by temperature`);
  else if (fit.r2 < 0.7 && confidence !== "high") reasons.push(`moderate fit (R²=${fit.r2.toFixed(2)} < 0.7 needed for high confidence)`);
  const extrap = confidence !== "high" && reasons.length > 0 ? ` — ${confidence} confidence because ${reasons.join("; ")}` : "";
  return {
    method: "caltrack_monthly",
    coefficients: {
      baseloadPerDay: fit.b0,
      coolingSlope: fit.b1,
      heatingSlope: fit.b2,
      coolingBalanceF: cb,
      heatingBalanceF: hb,
    },
    rSquared: Math.round(fit.r2 * 1000) / 1000,
    cvrmse: Math.round(fit.cvrmse * 1000) / 1000,
    monthsCoverage: coverage,
    confidence,
    confidenceLabel: `${confidence} confidence — R²=${fit.r2.toFixed(2)}, CVRMSE=${fit.cvrmse.toFixed(2)}, ${coverage} months${extrap}`,
    weatherBasis: LABEL_NORMAL_YEAR,
    normalizedAnnualUsage: Math.max(0, annual),
    disclosures,
  };
}

/** Aggregate interval points into monthly usage + month→daily-temps from normals. */
export function intervalsToMonthly(points: Array<{ ts: number; usage: number }>): MonthlyUsage[] {
  const byMonth = new Map<string, { usage: number; days: Set<number> }>();
  for (const p of points) {
    const d = new Date(p.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const rec = byMonth.get(key) ?? { usage: 0, days: new Set<number>() };
    rec.usage += p.usage;
    rec.days.add(d.getDate());
    byMonth.set(key, rec);
  }
  return Array.from(byMonth.entries())
    .map(([month, r]) => ({ month, usage: r.usage, days: r.days.size }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Build per-month daily temp arrays from monthly normals (proxy weather). */
export function normalsAsDailyTemps(months: string[], normals: MonthNormalRow[]): Map<string, number[]> {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const out = new Map<string, number[]>();
  for (const m of months) {
    const mi = parseInt(m.split("-")[1], 10) - 1;
    const nrm = normals[mi];
    if (!nrm) continue;
    out.set(m, new Array(daysInMonth[mi]).fill(nrm.avgTempF));
  }
  return out;
}

/**
 * Archetype-synthetic baseline: calibrated prototype-archetype 8760.
 * Returns 8760 hourly kWh plus fit metadata; label enforced verbatim.
 */
export function archetypeBaseline(
  shape8760: number[],
  annualUsePerSqft: number,
  sqft: number,
  opts: { outOfCalibrationRange: boolean; calibMidSqft?: number | null },
): { hourly: number[]; fit: BaselineFit } {
  const annual = annualUsePerSqft * sqft;
  // Annual energy scales ~linearly with sqft at fixed EUI, but PEAK DEMAND
  // does not — load diversity flattens peaks as floor area grows (v1.6
  // convergence finding, pass 41). Beyond the calibration-cell midpoint,
  // derate the shape's peakiness toward its mean by 1-1/sqrt(sizeRatio),
  // capped at 25% flattening. Annual energy is preserved exactly.
  const mid = opts.calibMidSqft ?? null;
  let scalingMethod: "linear_eui" | "sqrt_demand_derating" = "linear_eui";
  let hourly: number[];
  if (mid != null && mid > 0 && sqft > mid) {
    const flatten = Math.min(0.25, 1 - 1 / Math.sqrt(sqft / mid));
    const mean = 1 / shape8760.length;
    hourly = shape8760.map((f) => (f + (mean - f) * flatten) * annual);
    scalingMethod = "sqrt_demand_derating";
  } else {
    hourly = shape8760.map((f) => f * annual);
  }
  const disclosures = [
    `Baseline synthesized from ${LABEL_PROTOTYPE_ARCHETYPE} load shapes calibrated to your building inputs — no measured data underlies this estimate.`,
    `Annualized on ${LABEL_NORMAL_YEAR}.`,
    scalingMethod === "sqrt_demand_derating"
      ? "Peak demand derated for load diversity (sqrt-of-size) — raw linear scaling overstates peaks for floor areas above the archetype calibration midpoint."
      : "Scaled linearly on floor area at the archetype's energy-use intensity.",
  ];
  if (opts.outOfCalibrationRange) {
    disclosures.push(
      "Building size is outside the archetype calibration range — results are extrapolated and confidence is reduced to low.",
    );
  }
  return {
    hourly,
    fit: {
      method: "archetype_synthetic",
      coefficients: { baseloadPerDay: annual / 365, coolingSlope: 0, heatingSlope: 0, coolingBalanceF: 65, heatingBalanceF: 60 },
      rSquared: null,
      cvrmse: null,
      monthsCoverage: 0,
      // scalingMethod recorded in disclosures; enum kept out of coefficients
      // to preserve the BaselineFit numeric contract.
      confidence: opts.outOfCalibrationRange ? "low" : "medium",
      confidenceLabel: opts.outOfCalibrationRange
        ? `low confidence — ${LABEL_PROTOTYPE_ARCHETYPE}, outside calibration range (extrapolated)`
        : `medium confidence — ${LABEL_PROTOTYPE_ARCHETYPE} calibrated to inputs`,
      weatherBasis: LABEL_NORMAL_YEAR,
      normalizedAnnualUsage: annual,
      disclosures,
    },
  };
}

/* ---------------- residual anomaly detection (handoff A4 item) ---------------- */
export interface MonthlyAnomaly {
  month: string; // YYYY-MM
  actual: number;
  predicted: number;
  residualPct: number; // signed, e.g. +0.18 = 18% above model
  kind: "single_month_spike" | "single_month_drop" | "sustained_shift";
}

export interface AnomalyResult {
  anomalies: MonthlyAnomaly[];
  changePointMonth: string | null; // first month of a detected sustained shift
  method: "caltrack_residual_10pct_v1";
  disclosures: string[];
}

/**
 * Residual-based anomaly detection on the fitted CalTRACK-monthly model:
 * - Per-month residual = (actual − predicted) / predicted; |residual| > 10%
 *   flags the month (spike or drop).
 * - Change-point: the earliest month from which ALL subsequent residuals
 *   (≥ 3 months) share the same sign and each exceeds 10% — a sustained
 *   consumption shift (schedule change, equipment addition/failure) rather
 *   than a one-off. Flagged months inside the shift are re-labeled
 *   `sustained_shift`.
 *
 * Honesty gates: requires a real weather fit (non-null R²) and ≥ 6 usable
 * months — residuals from a flat-mean fallback or a thin fit would fabricate
 * anomalies from model error rather than consumption change.
 */
export function detectResidualAnomalies(
  monthly: MonthlyUsage[],
  monthDailyTemps: Map<string, number[]>,
  fit: BaselineFit,
): AnomalyResult {
  const disclosures = [
    "Anomalies are flagged where actual monthly usage deviates >10% from the weather-model prediction — weather-driven variation is already accounted for by the model; remaining deviations reflect operational/equipment change, model error, or data issues.",
  ];
  const empty: AnomalyResult = { anomalies: [], changePointMonth: null, method: "caltrack_residual_10pct_v1", disclosures };
  if (fit.method !== "caltrack_monthly" || fit.rSquared == null) {
    disclosures.push("Anomaly detection skipped — no statistically valid weather fit to compute residuals against.");
    return empty;
  }
  // Batch-18 (pass 471): residuals from a weak fit are mostly model error, not
  // operational change — an R²=0.1 model leaves ~90% of variance unexplained, so
  // >10% "anomalies" against it would be flagged noise presented as fact. Gate on
  // the same R²≥0.5 threshold that defines medium fit confidence, and say why.
  if (fit.rSquared < 0.5) {
    disclosures.push(`Anomaly detection skipped — the weather model explains too little of your usage variance (R²=${fit.rSquared.toFixed(2)}, needs ≥0.50) for residual deviations to be attributed to operational change rather than model error.`);
    return empty;
  }
  const usable = monthly.filter((m) => monthDailyTemps.has(m.month) && m.days > 20);
  if (usable.length < 6) {
    disclosures.push("Anomaly detection skipped — fewer than 6 usable months of coverage.");
    return empty;
  }
  const c = fit.coefficients;
  const rows = usable.map((m) => {
    const temps = monthDailyTemps.get(m.month)!;
    const cddPerDay = degreeDays(temps, c.coolingBalanceF, "cdd") / m.days;
    const hddPerDay = degreeDays(temps, c.heatingBalanceF, "hdd") / m.days;
    const predictedPerDay = c.baseloadPerDay + c.coolingSlope * cddPerDay + c.heatingSlope * hddPerDay;
    const predicted = predictedPerDay * m.days;
    const residualPct = predicted > 0 ? (m.usage - predicted) / predicted : 0;
    return { month: m.month, actual: m.usage, predicted, residualPct };
  });

  const flagged = rows.filter((r) => Math.abs(r.residualPct) > 0.1);

  // Change-point: earliest index i such that rows[i..] all share sign and all >10%
  let changePointMonth: string | null = null;
  for (let i = 0; i <= rows.length - 3; i++) {
    const tail = rows.slice(i);
    const sign = Math.sign(tail[0].residualPct);
    if (sign === 0) continue;
    if (tail.every((r) => Math.sign(r.residualPct) === sign && Math.abs(r.residualPct) > 0.1)) {
      changePointMonth = tail[0].month;
      break;
    }
  }

  const anomalies: MonthlyAnomaly[] = flagged.map((r) => ({
    month: r.month,
    actual: Math.round(r.actual * 100) / 100,
    predicted: Math.round(r.predicted * 100) / 100,
    residualPct: Math.round(r.residualPct * 1000) / 1000,
    // A month is part of the sustained shift only if it is at/after the change
    // point AND shares the shift's direction (by construction tail.every()
    // guarantees this for rows, but the sign check makes the invariant local
    // and structurally safe against future edits — batch-12 pass 21).
    kind:
      changePointMonth != null &&
      r.month >= changePointMonth &&
      Math.sign(r.residualPct) === Math.sign(rows.find((x) => x.month === changePointMonth)?.residualPct ?? 0)
        ? "sustained_shift"
        : r.residualPct > 0
          ? "single_month_spike"
          : "single_month_drop",
  }));
  if (changePointMonth) {
    disclosures.push(
      `Sustained shift detected from ${changePointMonth}: all subsequent months deviate >10% in the same direction — consistent with an operational or equipment change, not weather.`,
    );
  }
  return { anomalies, changePointMonth, method: "caltrack_residual_10pct_v1", disclosures };
}
