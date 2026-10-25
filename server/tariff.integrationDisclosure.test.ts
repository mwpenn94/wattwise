import { describe, expect, it } from "vitest";
import { priceAccountsSeparately, perMeterRateReview, type AccountPricingComponent } from "./analytics/multiMeter";
import { geocodeIsPlausible } from "./bulkImport";
import { SEED_TARIFFS } from "./seed/seedData";
import { resolveRateCode } from "./rateCodes";
const current = SEED_TARIFFS.find((t) => t.urdbId === "uns-egmgs")!;
const account: AccountPricingComponent = { meterId: 1, label: "EGMGSQ test", tariffId: 1, tariffName: current.name, utilityName: current.utilityName, timezone: "America/Phoenix", structure: current.structure,
  points: [{ ts: Date.parse("2026-08-15T12:00:00-07:00"), durationMin: 15, usage: 50, demand: 200 }], rateCodeResolution: resolveRateCode(current.utilityName, "EGMGSQ")! };
describe("tariff review cross-file disclosure integration", () => {
  it("normal combined and per-account review output preserve inferred-code and rider caveats", () => {
    const priced = priceAccountsSeparately([account]);
    expect(priced.combined.disclosures.join(" ")).toContain("EGMGSQ → EGMGS (inferred, unconfirmed)");
    expect(priced.combined.disclosures.join(" ")).toContain("excludes LFCR");
    expect(priced.combined.switchRecommendationAllowed).toBe(false);
    const review = perMeterRateReview([account], [{ id: 2, name: "cheap candidate", utilityName: current.utilityName, structure: { fixedMonthly: 0, energy: [], demand: [] }, freshness: "verified", eligibleFor: () => true }]);
    expect(review.perMeter[0].rateCodeResolution?.match).toBe("family_inferred");
    // Oct 24 owner directive: an inferred bill code WIDENS the range and adds a
    // confirm-first note; the comparison is never withheld when data exists.
    const best = review.perMeter[0].bestAlternative!;
    expect(best).not.toBeNull();
    expect(best.indicative).toBe(true);
    expect(best.savingsRangeUsd.low).toBeCloseTo(best.savingsRangeUsd.high * 0.4, 6);
    expect(best.basis).toContain("Indicative");
    expect(review.perMeter[0].period.calendarMonths).toBe(1);
    expect(review.perMeter[0].disclosures.join(" ")).toContain("confirm your exact rate");
  });
  it("existing plausibility guard rejects the exact Springfield MA match for Kingman AZ", () => {
    expect(geocodeIsPlausible({ city: "Springfield", state: "MA" }, { city: "Kingman", state: "AZ" }).ok).toBe(false);
    expect(geocodeIsPlausible({ city: "Kingman", state: "AZ" }, { city: "Kingman", state: "AZ" }).ok).toBe(true);
  });
});
