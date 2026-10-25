/**
 * Oct 2026 localization regression (school-portfolio E2E finding):
 * bulk-created Kingman, AZ school sites were stored with the statewide
 * default utility (APS), so every rate view showed APS rates even though
 * Kingman is UNS Electric territory and the bills carry UNS schedule codes.
 * Also, "350 Eastern Ave, Kingman" geocoded to Springfield, MA.
 */
import { describe, expect, it } from "vitest";
import { deriveFromAddress, deriveUtilityTriple, territoryUtilityCandidate } from "./cascade";
import { geocodeIsPlausible, utilityFromRateCodes } from "./bulkImport";
import { resolveTerritory } from "./serviceTerritory";

describe("territory-aware utility derivation", () => {
  it("Kingman, AZ resolves to UNS Electric, not the statewide APS default", () => {
    const c = deriveFromAddress("500 Maple St, Kingman, AZ 86401");
    expect(c.utilityName.value).toBe("UniSource Energy Services (UNS Electric)");
    expect(c.utilityName.source).toBe("territory_inferred");
    expect(c.utilityName.note).toMatch(/not read from a bill/i);
  });

  it("Tucson resolves to TEP by territory", () => {
    const c = deriveFromAddress("255 W Alameda St, Tucson, AZ 85701");
    expect(c.utilityName.value).toBe("Tucson Electric Power (TEP)");
    expect(c.utilityName.source).toBe("territory_inferred");
  });

  it("overlapping territory (Phoenix APS/SRP) keeps the disclosed statewide candidate", () => {
    const c = deriveFromAddress("200 W Washington St, Phoenix, AZ 85003");
    expect(c.utilityName.source).toBe("state_inferred");
    expect(c.utilityName.note).toMatch(/override if yours differs/i);
  });

  it("explicit utility always wins", () => {
    const c = deriveFromAddress("500 Maple St, Kingman, AZ 86401", { utilityName: "Mohave Electric Cooperative" });
    expect(c.utilityName.value).toBe("Mohave Electric Cooperative");
    expect(c.utilityName.source).toBe("user_entered");
  });

  it("states without a territory catalog keep the statewide candidate", () => {
    const c = deriveFromAddress("135 S State St, Salt Lake City, UT 84111");
    expect(c.utilityName.source).toBe("state_inferred");
    expect(territoryUtilityCandidate("electric", { state: "UT", city: "Salt Lake City", zip: "84111" })).toBeNull();
  });

  it("the three-utility reveal is territory-aware for electric and gas", () => {
    const t = deriveUtilityTriple("AZ", "Kingman", "86401");
    expect(t.electric.value).toBe("UniSource Energy Services (UNS Electric)");
    expect(t.gas.value).toBe("UniSource Energy Services (UNS Gas)");
    expect(t.gas.note).toMatch(/no gas service/i);
  });

  it("territory basis no longer claims the stored utility was confirmed", () => {
    const r = resolveTerritory({ state: "AZ", city: "Kingman", utilityName: "UniSource Energy Services (UNS Electric)" }, "electric");
    expect(r.basis).not.toMatch(/confirmed/i);
  });
});

describe("bulk import utility evidence from bill rate codes", () => {
  it("UNS schedule codes imply UNS Electric in AZ", () => {
    const u = utilityFromRateCodes(["EGSGS", "EGMGSQ", null, "egmgs"]);
    expect(u?.utilityName).toBe("UniSource Energy Services (UNS Electric)");
    expect(u?.state).toBe("AZ");
    expect(u?.codes.sort()).toEqual(["EGMGS", "EGMGSQ", "EGSGS"]);
  });

  it("unrecognized codes give no utility evidence", () => {
    expect(utilityFromRateCodes(["E-32 M", null])).toBeNull();
    expect(utilityFromRateCodes([])).toBeNull();
  });
});

describe("geocode plausibility", () => {
  it("rejects a match in another state (the Springfield, MA case)", () => {
    const r = geocodeIsPlausible({ city: "Springfield", state: "MA" }, { city: "KINGMAN", state: "AZ" });
    expect(r.ok).toBe(false);
  });

  it("rejects a match in another city of the same state", () => {
    const r = geocodeIsPlausible({ city: "Phoenix", state: "AZ" }, { city: "Kingman", state: "AZ" });
    expect(r.ok).toBe(false);
  });

  it("accepts a matching city regardless of case and punctuation", () => {
    expect(geocodeIsPlausible({ city: "Dolan Springs", state: "AZ" }, { city: "DOLAN SPRINGS", state: "AZ" }).ok).toBe(true);
  });

  it("accepts when the sheet gives no city or state to contradict", () => {
    expect(geocodeIsPlausible({ city: "Kingman", state: "AZ" }, { city: null, state: null }).ok).toBe(true);
  });
});
