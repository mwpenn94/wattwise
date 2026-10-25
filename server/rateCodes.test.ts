import { describe, expect, it } from "vitest";
import { resolveRateCode } from "./rateCodes";

describe("resolveRateCode", () => {
  it.each([
    ["EGSGS", "uns-egsgs"],
    ["EGMGS", "uns-egmgs"],
    ["EGMGST", "uns-egmgst"],
    ["EGMGSST", "uns-egmgsst"],
    ["EGLGS", "uns-lgs"],
  ])("maps published UNS code %s exactly", (code, urdbId) => {
    expect(resolveRateCode(" UniSource Energy Services ", ` ${code.toLowerCase()} `)).toMatchObject({
      urdbId,
      match: "exact",
    });
  });

  it("maps the unsupported EGMGSQ bill-code family conservatively", () => {
    expect(resolveRateCode("UNS Electric", "egmgsq")).toEqual({
      urdbId: "uns-egmgs",
      match: "family_inferred",
      disclosure:
        "EGMGSQ → EGMGS (inferred, unconfirmed). No official EGMGSQ crosswalk was found in the reviewed UNS/ACC sources. Modeled using EGMGS as an unverified family inference; confirm the actual schedule with UNS Electric before relying on costs or savings.",
      comparisonUrdbIds: ["uns-egmgsst", "uns-egmgst"],
    });
  });

  it("allows a missing utility hint but rejects other utilities and unknown codes", () => {
    expect(resolveRateCode(null, " EGSGS ")).toMatchObject({ urdbId: "uns-egsgs", match: "exact" });
    expect(resolveRateCode("Arizona Public Service", "EGSGS")).toBeNull();
    expect(resolveRateCode("UNS", "UNKNOWN")).toBeNull();
    expect(resolveRateCode("UNS", null)).toBeNull();
  });
});
