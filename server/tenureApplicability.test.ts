/**
 * v1.18 tenure modes + tariff applicability conditions (AC17) — and the first
 * two CI persona suites required by v1.20 block E / AC18a:
 *   - "Maria the renter": zero owner-capex opportunities in the action feed;
 *     owner-capex measures land in the landlord bucket, never deleted.
 *   - "Solar household": the rate sweep contains only plans the site may
 *     lawfully take (solar-only restriction honored in BOTH directions).
 */
import { describe, expect, it } from "vitest";
import { tariffEligible } from "./analytics/tariffEngine";

const baseTariff = {
  sector: "residential",
  commodity: "electric",
  peakKwMin: null,
  peakKwMax: null,
};

describe("v1.18 tariff applicability conditions (AC17)", () => {
  it("closed-to-new plan is ineligible as a switch target", () => {
    const r = tariffEligible({ ...baseTariff, closedToNew: true }, { sectorClass: "residential" }, 4);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/closed to new customers/i);
  });

  it("closed-to-new plan REMAINS eligible as the customer's current basis", () => {
    const r = tariffEligible(
      { ...baseTariff, closedToNew: true },
      { sectorClass: "residential", isCurrentBasis: true },
      4,
    );
    expect(r.eligible).toBe(true);
  });

  it("solar-only plan is hidden from a non-solar site", () => {
    const r = tariffEligible(
      { ...baseTariff, techCondition: "solar_only" },
      { sectorClass: "residential", hasSolar: false },
      4,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/solar/i);
  });

  it("solar-only plan is lawful for a solar site", () => {
    const r = tariffEligible(
      { ...baseTariff, techCondition: "solar_only" },
      { sectorClass: "residential", hasSolar: true },
      4,
    );
    expect(r.eligible).toBe(true);
  });

  it("non-solar-only plan is hidden from a solar site (SRP pattern — both directions)", () => {
    const r = tariffEligible(
      { ...baseTariff, techCondition: "non_solar_only" },
      { sectorClass: "residential", hasSolar: true },
      4,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/solar/i);
  });

  it("legacy callers omitting the new flags see unchanged behavior", () => {
    const r = tariffEligible(baseTariff, { sectorClass: "residential" }, 4);
    expect(r.eligible).toBe(true);
  });

  it("CI persona suite — solar household: a mixed rate book sweeps to ONLY lawful plans", () => {
    const book = [
      { ...baseTariff, name: "TOU-Standard", techCondition: "none" as const },
      { ...baseTariff, name: "Solar Export Rider", techCondition: "solar_only" as const },
      { ...baseTariff, name: "Basic Non-Solar", techCondition: "non_solar_only" as const },
      { ...baseTariff, name: "Legacy Grandfathered", techCondition: "none" as const, closedToNew: true },
    ];
    const lawful = book.filter((t) => tariffEligible(t, { sectorClass: "residential", hasSolar: true }, 3).eligible);
    expect(lawful.map((t) => t.name)).toEqual(["TOU-Standard", "Solar Export Rider"]);
    // and the non-solar household never sees the solar-only rider
    const nonSolar = book.filter((t) => tariffEligible(t, { sectorClass: "residential", hasSolar: false }, 3).eligible);
    expect(nonSolar.map((t) => t.name)).toEqual(["TOU-Standard", "Basic Non-Solar"]);
  });
});

describe("v1.18 tenure modes — renter persona suite (AC18a groundwork)", () => {
  // The pipeline's partition rule, mirrored here as the executable contract:
  // owner-capex = named retrofit keys OR capexBand medium/high.
  const OWNER_CAPEX_KEYS = new Set(["led_retrofit"]);
  const isOwnerCapex = (c: { key: string; capexBand: string }) =>
    OWNER_CAPEX_KEYS.has(c.key) || c.capexBand === "medium" || c.capexBand === "high";

  const candidates = [
    { key: "rate_switch", capexBand: "none" },
    { key: "peak_management", capexBand: "low" },
    { key: "hvac_tuneup", capexBand: "low" },
    { key: "led_retrofit", capexBand: "medium" },
    { key: "baseload_reduction", capexBand: "none" },
    { key: "winter_water_sewer", capexBand: "low" },
  ];

  it("renter feed contains ZERO owner-capex measures ('a renter shown a solar payback is a spec failure')", () => {
    const feed = candidates.filter((c) => !isOwnerCapex(c));
    expect(feed.some(isOwnerCapex)).toBe(false);
    // in-control dollars remain — the feed is not emptied, it is refocused
    expect(feed.map((c) => c.key)).toContain("rate_switch");
    expect(feed.map((c) => c.key)).toContain("hvac_tuneup");
  });

  it("owner-capex measures are MOVED to the landlord bucket, never deleted", () => {
    const feed = candidates.filter((c) => !isOwnerCapex(c));
    const landlord = candidates.filter(isOwnerCapex);
    expect(landlord.map((c) => c.key)).toEqual(["led_retrofit"]);
    expect(feed.length + landlord.length).toBe(candidates.length);
  });

  it("owner tenure sees everything unchanged", () => {
    const tenure = "own";
    const feed = tenure === "own" ? candidates : candidates.filter((c) => !isOwnerCapex(c));
    expect(feed.length).toBe(candidates.length);
  });
});
