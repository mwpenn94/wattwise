/**
 * Oct 24 rate-data integrity regressions (owner: "insane how you've somehow
 * omitted or lost all reference data for utility rates").
 *
 *  1. A seed-version bump must never revert a rate value that the
 *     verification agent applied from the official source.
 *  2. The filed UNS MGS "may be moved to LGS at 750 kW" rule is a condition
 *     the user confirms — never a silent exclusion and never silently ignored.
 *  3. The shipped UNS Gas seed matches the official Oct-1-2026 Statement of
 *     Rates (Tariff Sheet 1.1, Decision No. 81653).
 */
import { describe, expect, it } from "vitest";
import { replayVerifiedValues } from "./seed/runSeeders";
import { tariffEligible, tariffEligibilityTerms } from "./analytics/tariffEngine";
import { SEED_TARIFFS } from "./seed/seedData";
import type { TariffStructure } from "../shared/wattwise";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function gasStructure(rate: number, fixed: number): TariffStructure {
  return {
    fixedMonthly: fixed,
    energy: [{ label: "All gas (base $0.3801 + PGA $0.4487)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: rate }],
    demand: [],
  };
}

describe("seeder replays verified rate updates", () => {
  it("keeps a verified value that is as new or newer than the seed snapshot", () => {
    const seeded = gasStructure(0.8304, 11.96);
    const out = replayVerifiedValues(seeded, "2026-06-01", {
      effectiveDate: "2026-09-01",
      fixedMonthly: 11.96,
      energyRates: [{ label: "All gas (base $0.3801 + PGA $0.4475)", ratePerUnit: 0.8292 }],
    });
    expect(out.energy[0].ratePerUnit).toBeCloseTo(0.8292, 6);
    // the input snapshot is not mutated
    expect(seeded.energy[0].ratePerUnit).toBeCloseTo(0.8304, 6);
  });

  it("lets a newer official seed snapshot win over an older verification", () => {
    const seeded = gasStructure(0.81, 12.5);
    const out = replayVerifiedValues(seeded, "2026-12-01", {
      effectiveDate: "2026-09-01",
      fixedMonthly: 11.96,
      energyRates: [{ label: "All gas (base $0.3801 + PGA $0.4475)", ratePerUnit: 0.8292 }],
    });
    expect(out.energy[0].ratePerUnit).toBeCloseTo(0.81, 6);
    expect(out.fixedMonthly).toBe(12.5);
  });

  it("ignores verifications without an effective date or with non-positive values", () => {
    const seeded = gasStructure(0.8304, 11.96);
    expect(replayVerifiedValues(seeded, "2026-06-01", { energyRates: [{ label: "All gas", ratePerUnit: 0.5 }] }).energy[0].ratePerUnit).toBeCloseTo(0.8304, 6);
    expect(
      replayVerifiedValues(seeded, "2026-06-01", { effectiveDate: "2026-09-01", fixedMonthly: 0, energyRates: [{ label: "All gas", ratePerUnit: 0 }] }),
    ).toMatchObject({ fixedMonthly: 11.96 });
    expect(replayVerifiedValues(seeded, "2026-06-01", undefined)).toBe(seeded);
  });
});

describe("UNS MGS 750 kW reclassification is a condition", () => {
  const mgs = SEED_TARIFFS.find((t) => t.urdbId === "uns-egmgs");
  it("is declared on the seeded MGS schedule from the filed note", () => {
    expect(mgs).toBeDefined();
    expect((mgs!.structure as TariffStructure).reclassifyAtKw).toEqual({ kw: 750, to: "Large General Service (LGS)" });
  });

  it("adds a plain condition above 750 kW and stays eligible", () => {
    const terms = { sector: mgs!.sector, commodity: mgs!.commodity, peakKwMin: mgs!.peakKwMin, peakKwMax: mgs!.peakKwMax, ...tariffEligibilityTerms(mgs!.structure as TariffStructure) };
    const big = tariffEligible(terms, { sectorClass: "commercial", buildingType: "warehouse", switchTermsConfirmed: true }, 3530);
    expect(big.eligible).toBe(true);
    expect((big.conditions ?? []).some((c) => /750 kW/.test(c) && /LGS/.test(c))).toBe(true);
    const small = tariffEligible(terms, { sectorClass: "commercial", buildingType: "warehouse", switchTermsConfirmed: true }, 120);
    expect((small.conditions ?? []).some((c) => /750 kW/.test(c))).toBe(false);
  });

  it("does not attach the condition to the customer's current basis", () => {
    const terms = { sector: mgs!.sector, commodity: mgs!.commodity, peakKwMin: mgs!.peakKwMin, peakKwMax: mgs!.peakKwMax, ...tariffEligibilityTerms(mgs!.structure as TariffStructure) };
    const cur = tariffEligible(terms, { sectorClass: "commercial", buildingType: "warehouse", isCurrentBasis: true }, 3530);
    expect((cur.conditions ?? []).some((c) => /750 kW/.test(c))).toBe(false);
  });
});

describe("UNS Gas seed matches the official Oct-1-2026 Statement of Rates", () => {
  it.each([
    ["unsg-grres", 11.96, 0.8292],
    ["unsg-ggsvs", 28.37, 0.7623],
  ])("%s", (urdbId, fixed, perTherm) => {
    const row = SEED_TARIFFS.find((t) => t.urdbId === urdbId)!;
    const st = row.structure as TariffStructure;
    expect(st.fixedMonthly).toBeCloseTo(fixed, 2);
    expect(st.energy[0].ratePerUnit).toBeCloseTo(perTherm, 4);
    expect(row.effectiveDate).toBe("2026-10-01");
  });
});
