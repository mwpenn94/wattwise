/**
 * A4 anomaly detection — residual >10% flags + sustained change-point,
 * with honesty gates (no valid fit / thin coverage → skipped, disclosed).
 */
import { describe, expect, it } from "vitest";
import {
  detectResidualAnomalies,
  fitCaltrackMonthly,
  MonthlyUsage,
  MonthNormalRow,
  normalsAsDailyTemps,
} from "./analytics/baseline";

// Phoenix-like normals: hot summers (CDD), mild winters
const NORMALS: MonthNormalRow[] = [
  { month: 1, hddBase65: 300, cddBase65: 0, avgTempF: 55 },
  { month: 2, hddBase65: 200, cddBase65: 5, avgTempF: 58 },
  { month: 3, hddBase65: 100, cddBase65: 40, avgTempF: 63 },
  { month: 4, hddBase65: 20, cddBase65: 150, avgTempF: 70 },
  { month: 5, hddBase65: 0, cddBase65: 350, avgTempF: 78 },
  { month: 6, hddBase65: 0, cddBase65: 600, avgTempF: 88 },
  { month: 7, hddBase65: 0, cddBase65: 750, avgTempF: 93 },
  { month: 8, hddBase65: 0, cddBase65: 700, avgTempF: 91 },
  { month: 9, hddBase65: 0, cddBase65: 500, avgTempF: 85 },
  { month: 10, hddBase65: 10, cddBase65: 200, avgTempF: 73 },
  { month: 11, hddBase65: 120, cddBase65: 20, avgTempF: 62 },
  { month: 12, hddBase65: 280, cddBase65: 0, avgTempF: 56 },
];

/**
 * Build 12 months of synthetic usage that follows the weather model exactly.
 * IMPORTANT: normalsAsDailyTemps produces FLAT daily temps (avgTempF), so the
 * regressor's CDD is max(0, avgTempF - base) × days — usage must be built from
 * the SAME flat-temp degree days for the fit to be exact.
 */
function modelConformingYear(): MonthlyUsage[] {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // ~true model: 100 kWh/day baseload + 2 kWh per flat-temp CDD (base 65)
  return NORMALS.map((n, i) => ({
    month: `2025-${String(i + 1).padStart(2, "0")}`,
    usage: 100 * daysInMonth[i] + 2 * Math.max(0, n.avgTempF - 65) * daysInMonth[i],
    days: daysInMonth[i],
  }));
}

function fitAndDetect(monthly: MonthlyUsage[]) {
  const temps = normalsAsDailyTemps(monthly.map((m) => m.month), NORMALS);
  const fit = fitCaltrackMonthly(monthly, temps, NORMALS, { weatherIsNormalsProxy: true });
  return { fit, res: detectResidualAnomalies(monthly, temps, fit) };
}

describe("A4 residual anomaly detection", () => {
  it("clean model-conforming year yields no anomalies", () => {
    const { fit, res } = fitAndDetect(modelConformingYear());
    expect(fit.rSquared).not.toBeNull();
    expect(res.anomalies.length).toBe(0);
    expect(res.changePointMonth).toBeNull();
  });

  it("flags an isolated >10% spike month without declaring a change-point", () => {
    const year = modelConformingYear();
    year[3] = { ...year[3], usage: year[3].usage * 1.35 }; // April +35%
    const { res } = fitAndDetect(year);
    const april = res.anomalies.find((a) => a.month === "2025-04");
    expect(april).toBeDefined();
    // Fit re-optimizes around the outlier, so the sign is what matters most:
    expect(april!.residualPct).toBeGreaterThan(0.1);
    expect(res.changePointMonth).toBeNull();
    expect(["single_month_spike", "sustained_shift"]).toContain(april!.kind);
    expect(april!.kind).toBe("single_month_spike");
  });

  it("detects a sustained tail shift as a change-point with sustained_shift labels", () => {
    const year = modelConformingYear();
    // Last 4 months run 30% hot — e.g. new equipment installed in September
    for (let i = 8; i < 12; i++) year[i] = { ...year[i], usage: year[i].usage * 1.3 };
    const { res } = fitAndDetect(year);
    expect(res.changePointMonth).not.toBeNull();
    // Change-point must be at or before the first manipulated month given fit drift
    expect(res.changePointMonth! <= "2025-09").toBe(true);
    const shifted = res.anomalies.filter((a) => a.kind === "sustained_shift");
    expect(shifted.length).toBeGreaterThanOrEqual(3);
    expect(res.disclosures.some((d) => d.includes("Sustained shift"))).toBe(true);
  });

  it("honesty gate: skips when coverage is under 6 months", () => {
    const year = modelConformingYear().slice(0, 5);
    const { res } = fitAndDetect(year);
    expect(res.anomalies.length).toBe(0);
    expect(res.disclosures.some((d) => d.includes("fewer than 6"))).toBe(true);
  });

  it("honesty gate: skips when there is no valid weather fit (flat-mean fallback)", () => {
    // Constant usage w/ tiny variation across 3 usable months → fallback path
    const monthly: MonthlyUsage[] = [
      { month: "2025-01", usage: 3100, days: 31 },
      { month: "2025-02", usage: 2800, days: 28 },
      { month: "2025-03", usage: 3100, days: 31 },
    ];
    const temps = normalsAsDailyTemps(monthly.map((m) => m.month), NORMALS);
    const fit = fitCaltrackMonthly(monthly, temps, NORMALS, { weatherIsNormalsProxy: true });
    const res = detectResidualAnomalies(monthly, temps, fit);
    expect(res.anomalies.length).toBe(0);
    // Batch-48 (pass 2181): early exits carry ONLY the skip reason — the
    // methodology preamble ("anomalies are flagged where…") would imply a
    // detection pass that never ran.
    expect(res.disclosures.length).toBe(1);
    expect(res.disclosures[0]).toContain("skipped");
    expect(res.disclosures.some((d) => d.includes("Anomalies are flagged"))).toBe(false);
  });
});
