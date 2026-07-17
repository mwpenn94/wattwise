/**
 * Gap-8 (Jul 2026): address-driven cascade unit tests.
 * The cascade must (a) derive every location-downstream field with honest
 * provenance, (b) let explicit user values win unconditionally, and
 * (c) fall back with DISCLOSED sources — never silently.
 */
import { describe, expect, it } from "vitest";
import { BUILDING_PRIORS, cascadeProvenance, deriveFromAddress } from "./cascade";
import { QUICK_START_DEFAULTS } from "../shared/wattwise";

describe("deriveFromAddress — address-driven cascade", () => {
  it("derives zone/tz/utility/subregion from a full UT address with ZIP", () => {
    const c = deriveFromAddress("135 S State St, Salt Lake City, UT 84111");
    expect(c.state.value).toBe("UT");
    expect(c.zip.value).toBe("84111");
    // UT dominant zone is 5B (state-inferred unless a ZIP3 override exists)
    expect(c.climateZone.value).toBe("5B");
    expect(["zip_inferred", "state_inferred"]).toContain(c.climateZone.source);
    expect(c.timezone.value).toBe("America/Denver");
    expect(c.timezone.source).toBe("state_inferred");
    expect(c.utilityName.value).toBeTruthy();
    expect(c.utilityName.source).toBe("state_inferred");
    expect(c.egridSubregion.value).toBeTruthy();
  });

  it("uses ZIP3 precision over the state-dominant zone when the table has the prefix", () => {
    // 860xx = Flagstaff AZ high country → 5B, NOT the AZ-dominant 2B
    const c = deriveFromAddress("101 W Route 66, Flagstaff, AZ 86001");
    expect(c.climateZone.value).toBe("5B");
    expect(c.climateZone.source).toBe("zip_inferred");
    expect(c.timezone.value).toBe("America/Phoenix");
  });

  it("building priors vary by type — no flat 10k-sqft office default", () => {
    const c = deriveFromAddress("1 Main St, Columbus, OH 43004", { buildingType: "warehouse" });
    expect(c.buildingType.source).toBe("user_entered");
    expect(c.sqft.value).toBe(BUILDING_PRIORS.warehouse.sqft);
    expect(c.vintage.value).toBe(BUILDING_PRIORS.warehouse.vintage);
    expect(c.sqft.source).toBe("prior_median");
    // and the default prior differs from the legacy flat default
    const d = deriveFromAddress("1 Main St, Columbus, OH 43004");
    expect(d.sqft.value).toBe(BUILDING_PRIORS[QUICK_START_DEFAULTS.buildingType].sqft);
    expect(d.sqft.value).not.toBe(10_000);
  });

  it("explicit overrides win over everything and are tagged user_entered", () => {
    const c = deriveFromAddress("135 S State St, Salt Lake City, UT 84111", {
      climateZone: "3c",
      utilityName: "My Local Co-op",
      sqft: 42_000,
      vintage: 2012,
    });
    expect(c.climateZone.value).toBe("3C"); // normalized upper-case
    expect(c.climateZone.source).toBe("user_entered");
    expect(c.utilityName.value).toBe("My Local Co-op");
    expect(c.utilityName.source).toBe("user_entered");
    expect(c.sqft.value).toBe(42_000);
    expect(c.sqft.source).toBe("user_entered");
    expect(c.vintage.value).toBe(2012);
    expect(c.vintage.source).toBe("user_entered");
  });

  it("unknown/empty address falls back with DISCLOSED sources (never silent)", () => {
    const c = deriveFromAddress("somewhere nice");
    expect(c.state.value).toBeNull();
    expect(c.climateZone.value).toBe("4A"); // US-median
    expect(c.climateZone.source).toBe("us_median_fallback");
    expect(c.climateZone.note.toLowerCase()).toContain("us-median");
    expect(c.timezone.source).toBe("us_median_fallback");
    expect(c.utilityName.value).toBeNull();
    expect(c.utilityName.source).toBe("unknown");
    expect(c.egridSubregion.value).toBeNull();
    // every field carries a human-readable note
    for (const f of Object.values(cascadeProvenance(c))) {
      expect(f.source).toBeTruthy();
    }
  });

  it("cascadeProvenance snapshots value+source for every field", () => {
    const p = cascadeProvenance(deriveFromAddress("Austin, TX 78701"));
    for (const key of ["state", "zip", "climateZone", "timezone", "utilityName", "egridSubregion", "buildingType", "sqft", "vintage"]) {
      expect(p).toHaveProperty(key);
      expect(p[key]).toHaveProperty("value");
      expect(p[key]).toHaveProperty("source");
    }
    expect(p.state.value).toBe("TX");
  });
});
