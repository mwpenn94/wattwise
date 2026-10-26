/**
 * OPEN-3 (Oct 26): campus scenarios and plans are priced account by account.
 *
 * Invariants:
 *  1. Every separately billed account is priced on its OWN schedule; campus
 *     totals are exact sums of the per-account rows (never one merged bill).
 *  2. Efficiency applies to every account; solar/battery/EV attach to one
 *     account (default: most annual kWh; or the user's choice). Other
 *     accounts keep their current bill exactly.
 *  3. Each account's row equals a standalone single-account scenario/plan on
 *     that account (no hidden campus-level adjustment).
 *  4. Payback is computed once on campus savings with the single-account rule.
 *  5. Per-account dollar/payback sentences are replaced by campus-level lines.
 */
import { describe, expect, it } from "vitest";
import { composeCampusMeasures, defaultTargetAccount, resolveTargetAccount, runCampusScenario, type CampusAccountBasis } from "./analytics/campusScenario";
import { runScenario, scenarioPayback } from "./analytics/scenarios";
import { composeMeasures, type PlanMeasure } from "./analytics/composer";
import type { TariffStructure } from "../shared/wattwise";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const FLAT: TariffStructure = {
  fixedMonthly: 20,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.12 }],
  demand: [],
};
const DEMAND: TariffStructure = {
  fixedMonthly: 45,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.07 }],
  demand: [{ label: "max", months: ALL_MONTHS, ratePerKw: 14 }],
} as TariffStructure;

function profile(base: number, dayBump: number, eveningBump: number): number[] {
  const out: number[] = [];
  for (let h = 0; h < 8760; h++) {
    const hod = h % 24;
    out.push(base + (hod >= 8 && hod <= 16 ? dayBump : 0) + (hod >= 17 && hod <= 20 ? eveningBump : 0));
  }
  return out;
}
function account(meterId: number, label: string, hourly: number[], structure: TariffStructure, tariffName: string): CampusAccountBasis {
  return { meterId, label, hourly, structure, tariffId: meterId * 10, tariffName, utilityName: "UNS Electric", confidence: "high", extrapolated: false };
}
const SMALL = account(11, "Portable A", profile(1.5, 1, 0.5), FLAT, "Small General Service");
const BIG = account(12, "Main building", profile(30, 45, 10), DEMAND, "Medium General Service");
const MID = account(13, "Gym", profile(6, 8, 12), DEMAND, "Medium General Service");
const CAMPUS = [SMALL, BIG, MID];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const near = (a: number, b: number, tol = 0.02) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe("campus target account", () => {
  it("defaults to the account with the most annual kWh and honors a valid choice", () => {
    expect(defaultTargetAccount(CAMPUS).meterId).toBe(12);
    expect(resolveTargetAccount(CAMPUS, 13).meterId).toBe(13);
    expect(() => resolveTargetAccount(CAMPUS, 999)).toThrow(/not one of this campus/);
  });
});

describe("runCampusScenario", () => {
  it("efficiency applies to every account, each priced on its own schedule; totals are exact sums", () => {
    const r = runCampusScenario(CAMPUS, { kind: "efficiency", efficiencyReductions: { all: 0.1 } }, "2B", 900);
    expect(r.campus.accounts).toHaveLength(3);
    expect(r.campus.accounts.every((a) => a.measureApplied)).toBe(true);
    expect(r.campus.targetMeterId).toBeNull();
    for (const line of r.campus.accounts) {
      const acct = CAMPUS.find((a) => a.meterId === line.meterId)!;
      const solo = runScenario(acct.hourly, { kind: "efficiency", efficiencyReductions: { all: 0.1 } }, acct.structure, "2B", 900, "high", false);
      expect(line.tariffName).toBe(acct.tariffName);
      near(line.baselineAnnualCost, solo.baselineAnnualCost ?? 0);
      near(line.scenarioAnnualCost, solo.scenarioAnnualCost ?? 0);
      near(line.deltaCost, solo.siteTotalDeltaCost);
      expect(line.deltaCost).toBeLessThan(0);
    }
    near(r.baselineAnnualCost ?? 0, sum(r.campus.accounts.map((a) => a.baselineAnnualCost)));
    near(r.scenarioAnnualCost ?? 0, sum(r.campus.accounts.map((a) => a.scenarioAnnualCost)));
    near(r.siteTotalDeltaCost, sum(r.campus.accounts.map((a) => a.deltaCost)));
    near(r.perCommodity.electric!.deltaDemandKw, sum(r.campus.accounts.map((a) => a.deltaPeakKw)));
    expect(r.disclosures[0]).toMatch(/3 separately billed service agreements/);
    expect(r.disclosures.some((d) => d.includes("sum of each account's own billing-peak change"))).toBe(true);
  });

  it("solar attaches to one account; the other accounts' bills are unchanged", () => {
    const r = runCampusScenario(CAMPUS, { kind: "solar", solarKwDc: 50 }, "2B", 900);
    expect(r.campus.targetMeterId).toBe(12);
    const applied = r.campus.accounts.filter((a) => a.measureApplied);
    expect(applied.map((a) => a.meterId)).toEqual([12]);
    for (const a of r.campus.accounts.filter((x) => !x.measureApplied)) {
      expect(a.deltaCost).toBe(0);
      expect(a.scenarioAnnualCost).toBe(a.baselineAnnualCost);
    }
    const solo = runScenario(BIG.hourly, { kind: "solar", solarKwDc: 50 }, BIG.structure, "2B", 900, "high", false);
    near(r.siteTotalDeltaCost, solo.siteTotalDeltaCost);
    expect(r.disclosures[0]).toMatch(/modeled on Main building \(Medium General Service\)/);
    // Choosing a different account moves the measure there.
    const r2 = runCampusScenario(CAMPUS, { kind: "solar", solarKwDc: 50 }, "2B", 900, 11);
    expect(r2.campus.targetMeterId).toBe(11);
    expect(r2.campus.accounts.filter((a) => a.measureApplied).map((a) => a.meterId)).toEqual([11]);
  });

  it("payback is computed once on campus savings with the single-account rule", () => {
    const r = runCampusScenario(CAMPUS, { kind: "efficiency", efficiencyReductions: { all: 0.15 }, capexUsd: 60_000 }, "2B", 900);
    const expected = scenarioPayback(60_000, r.siteTotalDeltaCost, r.confidence);
    expect(r.paybackYears).toBe(expected.paybackYears);
    expect(r.paybackBand).toBe(expected.paybackBand);
    expect(r.paybackBand).not.toBeNull();
    // Exactly one payback sentence, the campus-level one (per-account ones are dropped).
    const pb = r.disclosures.filter((d) => d.startsWith("Payback band is derived from"));
    expect(pb).toHaveLength(1);
    expect(pb[0]).toContain("campus scenario's weakest account");
  });

  it("never prices the combined campus load as one bill", () => {
    const r = runCampusScenario(CAMPUS, { kind: "efficiency", efficiencyReductions: { all: 0.1 } }, "2B", 900);
    const merged = CAMPUS[0].hourly.map((_, i) => sum(CAMPUS.map((a) => a.hourly[i])));
    const mergedRun = runScenario(merged, { kind: "efficiency", efficiencyReductions: { all: 0.1 } }, DEMAND, "2B", 900, "high", false);
    // The merged single-bill baseline differs (one fixed charge, coincident peak).
    expect(Math.abs((mergedRun.baselineAnnualCost ?? 0) - (r.baselineAnnualCost ?? 0))).toBeGreaterThan(1);
  });
});

describe("composeCampusMeasures", () => {
  const LED: PlanMeasure = { key: "led", label: "LED retrofit", kind: "efficiency", efficiencyReductions: { lighting: 0.4 }, capexUsd: 20_000 } as PlanMeasure;
  const PV: PlanMeasure = { key: "pv", label: "Solar 40 kW", kind: "solar", solarKwDc: 40, capexUsd: 80_000 } as PlanMeasure;
  const ENDUSE = { lighting: 0.25, cooling: 0.35, plug: 0.4 };

  it("per-account rows match standalone plans; totals and peaks are sums; capex counted once", () => {
    const r = composeCampusMeasures(CAMPUS, [LED, PV], "2B", 900, ENDUSE, "commercial", false);
    expect(r.campus.targetMeterId).toBe(12);
    for (const line of r.campus.accounts) {
      const acct = CAMPUS.find((a) => a.meterId === line.meterId)!;
      const ms = [LED, PV].filter((m) => m.kind !== "solar" || acct.meterId === 12).map((m) => ({ ...m, capexUsd: undefined }));
      const solo = composeMeasures(acct.hourly, ms, acct.structure, "2B", 900, "high", false, ENDUSE, [], "commercial", false);
      near(line.baselineAnnualCost, solo.baselineAnnualCost);
      near(line.scenarioAnnualCost, solo.composedAnnualCost);
      expect(line.measureApplied).toBe(true);
    }
    near(r.baselineAnnualCost, sum(r.campus.accounts.map((a) => a.baselineAnnualCost)));
    near(r.composedAnnualCost, sum(r.campus.accounts.map((a) => a.scenarioAnnualCost)));
    near(r.composedSavings, r.baselineAnnualCost - r.composedAnnualCost);
    near(r.overlap, r.sumOfIndividualSavings - r.composedSavings);
    expect(r.basketCapexUsd).toBe(100_000);
    expect(r.rateSweep).toEqual([]);
    expect(r.ratePlanOvertake).toBeNull();
    expect(r.disclosures.some((d) => d.startsWith("Rate choice is reviewed separately for each account"))).toBe(true);
    expect(r.disclosures.filter((d) => d.startsWith("Basket payback band is derived from") && !d.includes("campus"))).toHaveLength(r.basketPaybackBand ? 1 : 0);
  });

  it("efficiency-only plan touches every account and needs no target", () => {
    const r = composeCampusMeasures(CAMPUS, [LED], "2B", 900, ENDUSE, "commercial", false);
    expect(r.campus.targetMeterId).toBeNull();
    expect(r.campus.accounts.every((a) => a.measureApplied)).toBe(true);
    expect(r.composedSavings).toBeGreaterThan(0);
  });

  it("a solar-only plan leaves the untouched accounts at their current cost", () => {
    const r = composeCampusMeasures(CAMPUS, [PV], "2B", 900, ENDUSE, "commercial", false, 13);
    expect(r.campus.targetMeterId).toBe(13);
    const untouched = r.campus.accounts.filter((a) => !a.measureApplied);
    expect(untouched.map((a) => a.meterId).sort()).toEqual([11, 12]);
    for (const a of untouched) expect(a.scenarioAnnualCost).toBe(a.baselineAnnualCost);
    expect(() => composeCampusMeasures(CAMPUS, [PV], "2B", 900, ENDUSE, "commercial", false, 4242)).toThrow(/not one of this campus/);
  });
});

describe("whole-building efficiency (Oct 26 fix: the Scenarios page sends { all: x })", () => {
  it("a 10% whole-building reduction lowers energy cost by 10% on a flat rate, with or without end-use fractions", () => {
    const hourly = profile(4, 3, 2);
    const kwh = sum(hourly);
    for (const fractions of [undefined, { lighting: 0.3, cooling: 0.4, plug: 0.3 }]) {
      const r = runScenario(hourly, { kind: "efficiency", efficiencyReductions: { all: 0.1 }, endUseFractions: fractions }, FLAT, "2B", 900, "high", false);
      near(r.perCommodity.electric!.deltaUsage, -kwh * 0.1, 0.5);
      near(r.siteTotalDeltaCost, -kwh * 0.1 * 0.12, 0.5);
    }
    // End-use keys still scale only their share.
    const lit = runScenario(hourly, { kind: "efficiency", efficiencyReductions: { lighting: 0.5 }, endUseFractions: { lighting: 0.2, other: 0.8 } }, FLAT, "2B", 900, "high", false);
    near(lit.perCommodity.electric!.deltaUsage, -kwh * 0.1, 0.5);
  });
  it("the plan composer honors a whole-building reduction too", () => {
    const hourly = profile(4, 3, 2);
    const r = composeMeasures(hourly, [{ key: "eff", label: "Whole building", kind: "efficiency", efficiencyReductions: { all: 0.1 } } as PlanMeasure], FLAT, "2B", 900, "high", false, undefined, [], "commercial", false);
    near(r.composedSavings, sum(hourly) * 0.1 * 0.12, 0.5);
  });
});

describe("campus notes are not repeated per account", () => {
  it("notes that differ only by account amount appear once with an account count", () => {
    const accts = [account(1, "A", profile(4, 3, 2), DEMAND, "MGS"), account(2, "B", profile(8, 6, 4), DEMAND, "MGS"), account(3, "C", profile(2, 1, 1), FLAT, "SGS")];
    const r = runCampusScenario(accts, { kind: "efficiency", efficiencyReductions: { all: 0.1 } }, "2B", 900);
    const topics = r.disclosures.map((d) => d.replace(/[$\u2212-]?\d[\d,.]*%?/g, "#"));
    expect(new Set(topics).size).toBe(topics.length);
  });
});
