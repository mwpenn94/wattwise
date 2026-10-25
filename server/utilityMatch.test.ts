import { describe, expect, it } from "vitest";
import { tariffMatchesSiteUtility, utilityToken } from "./utilityMatch";
import { resolveRateCode } from "./rateCodes";
import { resolveTerritory } from "./serviceTerritory";
const UNSE = "UniSource Energy Services (UNS Electric)";
describe("utility name matching (Oct 24 Joel demo regression)", () => {
  it.each(["UES", "ues", "UNSE", "UNS Electric", "UniSource", "UniSource Energy Services"])("%s matches the filed UNS Electric name", (n) => {
    expect(utilityToken(n)).toBe("unisource");
    expect(tariffMatchesSiteUtility(UNSE, n)).toBe(true);
  });
  it("does not cross utilities", () => {
    expect(tariffMatchesSiteUtility("Arizona Public Service", "UES")).toBe(false);
    expect(tariffMatchesSiteUtility(UNSE, "APS")).toBe(false);
    expect(tariffMatchesSiteUtility("Arizona Public Service", "APS")).toBe(true);
    expect(tariffMatchesSiteUtility(UNSE, null)).toBe(true);
  });
  it("resolves bill rate codes for an abbreviated UNS Electric site and never for UNS Gas", () => {
    expect(resolveRateCode("UES", "EGMGSQ")?.urdbId).toBe("uns-egmgs");
    expect(resolveRateCode("UES", "EGSGS")?.match).toBe("exact");
    expect(resolveRateCode("UNS Gas", "EGSGS")).toBeNull();
    expect(resolveRateCode("Arizona Public Service", "EGSGS")).toBeNull();
  });
  it("territory resolution honors the abbreviation per commodity", () => {
    const site = { state: "AZ", city: "Kingman", zip: "86401", utilityName: "UES" };
    expect(resolveTerritory(site, "electric").plausibleUtilities).toEqual([UNSE]);
    expect(resolveTerritory(site, "electric").confidence).toBe("name_match");
  });
});
