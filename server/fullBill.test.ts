/**
 * Oct 25 (owner decision): estimated full bill shown as a RANGE, separate from
 * the modeled subtotal, from official UNS/Arizona sources only.
 */
import { describe, expect, it } from "vitest";
import { cis2TaxRate, estimateFullBill, isUnsElectric, lfcrRateForMonth } from "./analytics/fullBill";
import type { CostResult } from "./analytics/tariffEngine";

const month = (m: string, parts: Partial<CostResult["monthlyCosts"][number]> = {}) => {
  const base = { month: m, energy: 700, demand: 200, fixed: 100, riders: 50, cp: 0, exportCredit: 0, ...parts };
  return { ...base, total: base.energy + base.demand + base.fixed + base.riders + base.cp };
};
const cost = (months: CostResult["monthlyCosts"], extra: Partial<CostResult> = {}): CostResult => ({
  breakdown: { energy: 0, demand: 0, fixed: 0, cp: null, total: months.reduce((s, m) => s + m.total, 0) } as CostResult["breakdown"],
  monthlyDetails: [], monthlyCosts: months, disclosures: [], ...extra,
});

describe("official tax cascade (UNS CIS-2)", () => {
  it("reproduces the CIS-2 Table 1 Kingman example ($100 → $108.50) with the table's ACC/RUCO", () => {
    // Table 1 uses ACC 0.18% and RUCO 0.03%; reproduce with those to prove the cascade order.
    const B = 1, F = 0.02, acc = 0.0018, ruco = 0.0003;
    const S = (0.005 + 0.056) * (B + F + acc + ruco);
    expect(100 * (F + S + (acc + ruco) * (B + F + S))).toBeCloseTo(8.46, 2);
    // Production cascade with the schedule's text rates (ACC 0.20%, RUCO 0.04%).
    expect(100 * cis2TaxRate({ franchise: 0.02, cityNet: 0.005, county: 0, residential: true })).toBeCloseTo(8.496, 3);
  });
  it("non-residential: no RUCO; inside vs outside Kingman city limits", () => {
    expect(100 * cis2TaxRate({ franchise: 0.02, cityNet: 0.005, county: 0, residential: false })).toBeCloseTo(8.451, 3);
    expect(100 * cis2TaxRate({ franchise: 0, cityNet: 0, county: 0, residential: false })).toBeCloseTo(5.822, 3);
  });
});

describe("dated LFCR (Rider R-8)", () => {
  it.each([
    ["2023-07", null], ["2023-08", 0.014321], ["2025-09", 0.014321], ["2025-10", 0.010998], ["2026-08", 0.010998], ["2026-09", 0.013436],
  ])("%s → %s", (m, rate) => {
    const r = lfcrRateForMonth(m as string);
    if (rate == null) expect(r).toBeNull(); else expect(r).toBeCloseTo(rate as number, 9);
  });
});

describe("estimateFullBill", () => {
  it("is null for other utilities and for UNS Gas", () => {
    expect(estimateFullBill({ accounts: [cost([month("2026-07")])], utilityName: "Arizona Public Service Co (APS)", city: "Phoenix", state: "AZ" })).toBeNull();
    expect(isUnsElectric("UNS Gas")).toBe(false);
    expect(isUnsElectric("UniSource Energy Services (UNS Electric)")).toBe(true);
    expect(isUnsElectric("UES")).toBe(true);
  });
  it("Kingman: LFCR on charges (low) vs whole subtotal (high); tax outside vs inside city limits with the Sep 2026 city rate", () => {
    const r = estimateFullBill({ accounts: [cost([month("2026-08"), month("2026-09")])], utilityName: "UniSource Energy Services (UNS Electric)", city: "Kingman", state: "AZ" })!;
    expect(r.basis).toBe("estimated_not_bill_confirmed");
    expect(r.subtotal).toBe(2100);
    expect(r.lfcr.low).toBeCloseTo(1000 * 0.010998 + 1000 * 0.013436, 6);
    expect(r.lfcr.high).toBeCloseTo(1050 * 0.010998 + 1050 * 0.013436, 6);
    const out = cis2TaxRate({ franchise: 0, cityNet: 0, county: 0, residential: false });
    const inAug = cis2TaxRate({ franchise: 0.02, cityNet: 0.005, county: 0, residential: false });
    const inSep = cis2TaxRate({ franchise: 0.02, cityNet: 0.01, county: 0, residential: false });
    expect(r.taxes!.low).toBeCloseTo(out * (1050 + 1000 * 0.010998) + out * (1050 + 1000 * 0.013436), 6);
    expect(r.taxes!.high).toBeCloseTo(inAug * (1050 + 1050 * 0.010998) + inSep * (1050 + 1050 * 0.013436), 6);
    expect(r.total.low).toBeCloseTo(r.subtotal + r.lfcr.low + r.taxes!.low, 6);
    expect(r.total.high).toBeCloseTo(r.subtotal + r.lfcr.high + r.taxes!.high, 6);
    expect(r.summary).toMatch(/^Estimated full bill with LFCR and taxes: \$/);
    expect(r.assumptions.join(" ")).toMatch(/not confirmed against a utility bill/);
  });
  it("unincorporated Mohave places get the same tax at both ends", () => {
    const r = estimateFullBill({ accounts: [cost([month("2026-07")])], utilityName: "UNS Electric", city: "Golden Valley", state: "AZ" })!;
    const out = cis2TaxRate({ franchise: 0, cityNet: 0, county: 0, residential: false });
    expect(r.taxes!.low).toBeCloseTo(out * (1050 + r.lfcr.low), 6);
    expect(r.taxes!.high).toBeCloseTo(out * (1050 + r.lfcr.high), 6);
    expect(r.jurisdiction?.label).toMatch(/unincorporated/);
  });
  it("an unknown jurisdiction omits taxes and says so instead of guessing", () => {
    const r = estimateFullBill({ accounts: [cost([month("2026-07")])], utilityName: "UNS Electric", city: "Nogales", state: "AZ" })!;
    expect(r.taxes).toBeNull();
    expect(r.summary).toMatch(/before taxes/);
    expect(r.assumptions.join(" ")).toMatch(/tax rates for Nogales are not on file/);
  });
  it("bounds the unconfirmed pre-June-2026 demand TCA by ±$0.13 per billed kW", () => {
    const c = cost([month("2026-03"), month("2026-07")], {
      missingRiderCoverage: [{ month: "2026-03", labels: ["TCA"] }],
      monthlyDetails: [{ month: "2026-03", actualPeakKw: 80, billedDemandKw: 100, ratchetApplied: false, peakTimestamp: 0 } as CostResult["monthlyDetails"][number]],
    });
    const r = estimateFullBill({ accounts: [c], utilityName: "UNS Electric", city: "Kingman", state: "AZ" })!;
    expect(r.unconfirmedTca.high).toBeCloseTo(13, 6);
    expect(r.unconfirmedTca.low).toBeCloseTo(-13, 6);
    expect(r.assumptions.join(" ")).toMatch(/±\$13 over 1 account-month/);
  });
  it("sums separately billed accounts month by month", () => {
    const a = cost([month("2026-07")]);
    const b = cost([month("2026-07", { energy: 100, demand: 0, fixed: 20, riders: 5 })]);
    const one = estimateFullBill({ accounts: [a], utilityName: "UNS Electric", city: "Kingman", state: "AZ" })!;
    const two = estimateFullBill({ accounts: [b], utilityName: "UNS Electric", city: "Kingman", state: "AZ" })!;
    const both = estimateFullBill({ accounts: [a, b], utilityName: "UNS Electric", city: "Kingman", state: "AZ" })!;
    expect(both.total.low).toBeCloseTo(one.total.low + two.total.low, 6);
    expect(both.total.high).toBeCloseTo(one.total.high + two.total.high, 6);
  });
});
