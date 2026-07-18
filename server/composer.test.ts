/**
 * Bill Builder composer engine tests (UX addendum §3c).
 *
 * Verifies the honesty invariants the UI story depends on:
 *  1. Composition-not-addition — composed savings ≠ naive sum when measures
 *     interact, and the overlap figure is exactly sum − composed.
 *  2. Weakest-chip confidence — the basket inherits the weakest measure chip.
 *  3. Physics order — efficiency shrinks the profile BEFORE solar offsets it,
 *     so composed solar savings on a reduced profile are ≤ solar-alone savings.
 *  4. Rate re-sweep runs on the composed profile and only reports an overtake
 *     when a non-basis tariff genuinely prices lower.
 */
import { describe, expect, it } from "vitest";
import { composeMeasures, presetBaskets, type PlanMeasure } from "./analytics/composer";
import type { TariffStructure } from "../shared/wattwise";

type SweepTariff = Parameters<typeof composeMeasures>[8][number];

/** Flat-ish synthetic year: 8760 hours, mild daily shape, ~36,500 kWh/yr. */
function syntheticHourly(): number[] {
  const out: number[] = [];
  for (let h = 0; h < 8760; h++) {
    const hod = h % 24;
    // Daytime bump (solar-coincident) + evening peak.
    const day = hod >= 8 && hod <= 17 ? 2.0 : 0;
    const evening = hod >= 18 && hod <= 21 ? 3.0 : 0;
    out.push(2.5 + day + evening);
  }
  return out;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const FLAT: TariffStructure = {
  fixedMonthly: 12,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.14 }],
  demand: [],
};

const CHEAPER: TariffStructure = {
  fixedMonthly: 10,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.11 }],
  demand: [],
};

function sweepRows(currentId = 1): SweepTariff[] {
  return [
    {
      id: 1,
      name: "Standard",
      utilityName: "Test Utility",
      sector: "commercial",
      commodity: "electric",
      peakKwMin: null,
      peakKwMax: null,
      structure: FLAT,
      isCurrentBasis: currentId === 1,
    },
    {
      id: 2,
      name: "Saver",
      utilityName: "Test Utility",
      sector: "commercial",
      commodity: "electric",
      peakKwMin: null,
      peakKwMax: null,
      structure: CHEAPER,
      isCurrentBasis: currentId === 2,
    },
  ];
}

const EFFICIENCY: PlanMeasure = {
  key: "eff15",
  label: "15% efficiency retrofit",
  kind: "efficiency",
  efficiencyReductions: { all: 0.15 },
  capexUsd: 5000,
};

const SOLAR: PlanMeasure = {
  key: "solar10",
  label: "10 kW solar",
  kind: "solar",
  solarKwDc: 10,
  capexUsd: 25000,
};

describe("composeMeasures — composition-not-addition", () => {
  it("overlap equals sum-of-individual minus composed, and both figures are reported", () => {
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY, SOLAR], FLAT, "5B", 727.9, "high", false, undefined, sweepRows(), "commercial");
    expect(r.sumOfIndividualSavings).toBeGreaterThan(0);
    expect(r.composedSavings).toBeGreaterThan(0);
    expect(r.overlap).toBeCloseTo(r.sumOfIndividualSavings - r.composedSavings, 6);
    // Efficiency shrinks the profile before solar offsets it, so the composed
    // total must save less than (or equal to) the naive sum on a flat rate.
    expect(r.composedSavings).toBeLessThanOrEqual(r.sumOfIndividualSavings + 1e-6);
  });

  it("single measure composes with zero overlap by construction", () => {
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY], FLAT, "5B", 727.9, "high", false, undefined, sweepRows(), "commercial");
    expect(r.overlap).toBeCloseTo(0, 6);
    expect(r.composedSavings).toBeCloseTo(r.sumOfIndividualSavings, 6);
  });
});

describe("composeMeasures — confidence and payback", () => {
  it("basket inherits the weakest confidence chip (solar forces medium-or-lower on a high basis)", () => {
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY, SOLAR], FLAT, "5B", 727.9, "high", false, undefined, sweepRows(), "commercial");
    expect(["medium", "low"]).toContain(r.confidence);
  });

  it("basket payback uses total capex over composed savings", () => {
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY, SOLAR], FLAT, "5B", 727.9, "high", false, undefined, sweepRows(), "commercial");
    expect(r.basketCapexUsd).toBe(30000);
    expect(r.basketPaybackBand).toBeTruthy();
  });
});

describe("composeMeasures — rate re-sweep on composed profile", () => {
  it("reports an overtake when a cheaper eligible tariff prices lower on the new profile", () => {
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY], FLAT, "5B", 727.9, "high", false, undefined, sweepRows(1), "commercial");
    expect(r.ratePlanOvertake).not.toBeNull();
    expect(r.ratePlanOvertake!.tariffName).toBe("Saver");
    expect(r.ratePlanOvertake!.additionalSavings).toBeGreaterThan(0);
  });

  it("reports no overtake when the current basis is already the cheapest", () => {
    const rows: SweepTariff[] = [
      { ...sweepRows(2)[0], isCurrentBasis: false },
      { ...sweepRows(2)[1], isCurrentBasis: true },
    ];
    const r = composeMeasures(syntheticHourly(), [EFFICIENCY], CHEAPER, "5B", 727.9, "high", false, undefined, rows, "commercial");
    expect(r.ratePlanOvertake).toBeNull();
  });
});

describe("presetBaskets", () => {
  it("returns three baskets with conservative ⊂ balanced ⊂ aggressive measure counts", () => {
    const p = presetBaskets(2000, undefined);
    expect(p.conservative.length).toBeGreaterThan(0);
    expect(p.balanced.length).toBeGreaterThanOrEqual(p.conservative.length);
    expect(p.aggressive.length).toBeGreaterThanOrEqual(p.balanced.length);
  });

  it("scales solar sizing with square footage", () => {
    const small = presetBaskets(1200, undefined);
    const large = presetBaskets(80_000, undefined);
    const solarSmall = small.aggressive.find((m) => m.kind === "solar");
    const solarLarge = large.aggressive.find((m) => m.kind === "solar");
    expect(solarSmall && solarLarge).toBeTruthy();
    expect(solarLarge!.solarKwDc!).toBeGreaterThan(solarSmall!.solarKwDc!);
  });
});
