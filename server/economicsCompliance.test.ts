/**
 * Batch-2 reconciliation suite — incentives (AC15), compliance (AC16b),
 * cohort 15/15 privacy gate (GAP-I), utility-exposure rollup (GAP-M).
 */
import { describe, expect, it } from "vitest";
import { seedIncentives, matchIncentives, incentiveEconomics } from "./incentives";
import { assessCompliance } from "./compliance";
import { cohortKeyFor, sqftBand, MIN_COHORT_N, cohortInsightFor } from "./cohort";
import { getDb } from "./db";
import { cohortStats } from "../drizzle/schema";
import { sql } from "drizzle-orm";

describe("AC15 incentives", () => {
  it("never returns an expired incentive", async () => {
    await seedIncentives();
    // The expired guard row targets measureKey "solar" — ask for solar and
    // assert the expired row never surfaces.
    const matches = await matchIncentives({
      measureKey: "solar",
      state: "AZ",
      utilityName: null,
      sectorClass: "residential",
      capexUsd: 20000,
    });
    expect(matches.every((m) => m.expiresAt == null || m.expiresAt > Date.now())).toBe(true);
    expect(matches.find((m) => m.code === "expired_example_ev_credit")).toBeUndefined();
  });

  it("solar in AZ matches the federal ITC and paybacks shorten post-incentive", async () => {
    await seedIncentives();
    const econ = await incentiveEconomics({
      measureKey: "solar",
      state: "AZ",
      utilityName: "APS",
      sectorClass: "residential",
      tenure: "own",
      capexUsd: 20000,
      annualSavingsUsd: 2000,
    });
    expect(econ.matches.length).toBeGreaterThan(0);
    expect(econ.paybackPreYears).toBeCloseTo(10, 1);
    expect(econ.paybackPostYears).not.toBeNull();
    expect(econ.paybackPostYears!).toBeLessThan(econ.paybackPreYears!);
    expect(econ.netCapexUsd).toBeLessThan(econ.capexUsd);
    // who-pays/who-benefits framing exists
    expect(econ.matches[0].whoPays).toBeTruthy();
  });

  it("is tenure-honest: renters do not get owner-only capex credits", async () => {
    await seedIncentives();
    const econ = await incentiveEconomics({
      measureKey: "solar",
      state: "AZ",
      utilityName: "APS",
      sectorClass: "residential",
      tenure: "rent",
      capexUsd: 20000,
      annualSavingsUsd: 2000,
    });
    // Renter economics exclude owner-only benefits (e.g. the federal ITC) —
    // never pretend the renter collects the landlord's tax credit.
    expect(econ.matches.every((m) => m.whoBenefits !== "owner")).toBe(true);
    // With the ITC excluded, net capex equals gross capex for the renter.
    expect(econ.netCapexUsd).toBe(econ.capexUsd);
  });

  it("demand-response pays the customer: recurring annual payment surfaces", async () => {
    await seedIncentives();
    const matches = await matchIncentives({
      measureKey: "smart_thermostat",
      state: "AZ",
      utilityName: "APS",
      sectorClass: "residential",
      capexUsd: 0,
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.kind === "dr_payment" && (m.annualUsd ?? 0) > 0)).toBe(true);
    // DR payments benefit the occupant — they-pay-you framing.
    const dr = matches.find((m) => m.kind === "dr_payment")!;
    expect(dr.whoBenefits).toBe("occupant");
  });
});

describe("AC16b compliance", () => {
  const now = new Date("2026-07-18T00:00:00Z").getTime();

  it("WA office at 120k sqft gets the Tier-1 mid card with countdown and penalty exposure when over target", async () => {
    const rows = await assessCompliance({
      state: "WA",
      buildingType: "office",
      sqft: 120_000,
      annualKwh: 2_400_000, // EUI = 68.24 kBtu/sqft > 47 target
      euiBasis: "measured",
      now,
    });
    expect(rows.length).toBe(1);
    const a = rows[0];
    expect(a.programCode).toBe("wa_clean_buildings_t1_mid");
    expect(a.bindingTarget).toBe(true);
    expect(a.monthsToDeadline).toBeGreaterThan(0);
    expect(a.gapPct).not.toBeNull();
    expect(a.gapPct!).toBeGreaterThan(0);
    expect(a.onTrack).toBe(false);
    // penalty = 5000 + $1/sqft
    expect(a.penaltyExposureUsd).toBe(5000 + 120_000);
    expect(a.disclosure).toContain("measured");
  });

  it("under-target site is on track with zero penalty exposure", async () => {
    const rows = await assessCompliance({
      state: "WA",
      buildingType: "office",
      sqft: 120_000,
      annualKwh: 1_200_000, // EUI = 34 kBtu/sqft < 47
      euiBasis: "measured",
      now,
    });
    expect(rows[0].onTrack).toBe(true);
    expect(rows[0].penaltyExposureUsd).toBe(0);
  });

  it("Tier 2 (20k-50k) is reporting-only: no binding target, no penalty", async () => {
    const rows = await assessCompliance({
      state: "WA",
      buildingType: "retail",
      sqft: 30_000,
      annualKwh: 600_000,
      euiBasis: "estimated",
      now,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].programCode).toBe("wa_clean_buildings_t2");
    expect(rows[0].bindingTarget).toBe(false);
    expect(rows[0].penaltyExposureUsd).toBeNull();
    expect(rows[0].disclosure).toContain("ESTIMATE");
  });

  it("never renders for residential, out-of-state, or small sites", async () => {
    expect(await assessCompliance({ state: "AZ", buildingType: "office", sqft: 120_000, annualKwh: 1e6, euiBasis: "measured", now })).toHaveLength(0);
    expect(await assessCompliance({ state: "WA", buildingType: "single_family", sqft: 120_000, annualKwh: 1e6, euiBasis: "measured", now })).toHaveLength(0);
    expect(await assessCompliance({ state: "WA", buildingType: "office", sqft: 10_000, annualKwh: 1e6, euiBasis: "measured", now })).toHaveLength(0);
  });
});

describe("GAP-I cohort 15/15 privacy gate", () => {
  it("sqft bands and cohort keys are stable", () => {
    expect(sqftBand(1800)).toBe("<2.5k");
    expect(sqftBand(30_000)).toBe("10k-50k");
    expect(cohortKeyFor({ state: "AZ", buildingType: "office", sqft: 30_000 })).toBe("AZ|office|10k-50k");
  });

  it("returns NOTHING below the 15-member floor (hard gate)", async () => {
    const db = await getDb();
    expect(db).not.toBeNull();
    const key = `ZZ|test_cohort_gate|10k-50k`;
    // Seed a small cohort (n=5) directly.
    await db!
      .insert(cohortStats)
      .values({ cohortKey: key, metricKey: "eui_kwh_sqft", n: 5, p25: 4, median: 6, p75: 9, computedAt: Date.now() })
      .onDuplicateKeyUpdate({ set: { n: 5, computedAt: Date.now() } });
    const below = await cohortInsightFor({ state: "ZZ", buildingType: "test_cohort_gate", sqft: 30_000, annualKwh: 150_000 });
    expect(below).toBeNull();
    // Raise it to the floor — now it renders, and says so honestly.
    await db!.execute(sql`UPDATE cohort_stats SET n = ${MIN_COHORT_N} WHERE cohortKey = ${key} AND metricKey = 'eui_kwh_sqft'`);
    const at = await cohortInsightFor({ state: "ZZ", buildingType: "test_cohort_gate", sqft: 30_000, annualKwh: 150_000 });
    expect(at).not.toBeNull();
    expect(at!.n).toBe(MIN_COHORT_N);
    expect(at!.message).toContain("De-identified");
  });
});
