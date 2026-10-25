/**
 * Regression (Oct 24 school E2E): real Kingman school addresses come back from
 * the geocoder as single, non-partial premise matches with GEOMETRIC_CENTER
 * precision. Those are building centroids and must be pinned — while routes,
 * localities, partial/ambiguous matches and a different house number must still
 * be rejected. Also pins the house-number-as-ZIP parsing bug.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeAddress } from "./places";
import { parseQuickAddress } from "../shared/wattwise";

function premise(overrides: { number?: string; locationType?: string; types?: string[]; partial?: boolean } = {}) {
  return {
    status: "OK",
    results: [{
      partial_match: overrides.partial ?? false,
      formatted_address: `${overrides.number ?? "4182"} N Bank St, Kingman, AZ 86409, USA`,
      types: overrides.types ?? ["premise", "street_address"],
      geometry: { location_type: overrides.locationType ?? "GEOMETRIC_CENTER", location: { lat: 35.237, lng: -114.012 } },
      address_components: [
        { long_name: overrides.number ?? "4182", short_name: overrides.number ?? "4182", types: ["street_number"] },
        { long_name: "North Bank Street", short_name: "N Bank St", types: ["route"] },
        { long_name: "Kingman", short_name: "Kingman", types: ["locality"] },
        { long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1"] },
        { long_name: "86409", short_name: "86409", types: ["postal_code"] },
      ],
    }],
  };
}
const mock = (v: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(v))));
afterEach(() => vi.unstubAllGlobals());

describe("geocode precision — premise centroids", () => {
  it("pins a single non-partial premise GEOMETRIC_CENTER match with the same house number", async () => {
    mock(premise());
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ")).toMatchObject({ kind: "precise", lat: 35.237, city: "Kingman", state: "AZ", zip: "86409" });
  });
  it("rejects GEOMETRIC_CENTER for a route (street-only) match", async () => {
    mock(premise({ types: ["route"] }));
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ")).toEqual({ kind: "not_precise" });
  });
  it("rejects a premise centroid whose house number differs from the query", async () => {
    mock(premise({ number: "4100" }));
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ")).toEqual({ kind: "not_precise" });
  });
  it("rejects a premise centroid when the query has no house number", async () => {
    mock(premise());
    expect(await geocodeAddress("N Bank St, Kingman, AZ")).toEqual({ kind: "not_precise" });
  });
  it("still rejects partial and APPROXIMATE matches", async () => {
    mock(premise({ partial: true }));
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ")).toEqual({ kind: "not_precise" });
    mock(premise({ locationType: "APPROXIMATE" }));
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ")).toEqual({ kind: "not_precise" });
  });
  it("still honors expected city/state/zip consistency", async () => {
    mock(premise());
    expect(await geocodeAddress("4182 N Bank St, Kingman, AZ", { city: "Bullhead City" })).toEqual({ kind: "not_precise" });
  });
});

describe("parseQuickAddress ZIP — never a leading 5-digit house number", () => {
  it("does not read the house number as a ZIP", () => {
    const p = parseQuickAddress("16500 N Pierce Ferry Rd, Dolan Springs, AZ");
    expect(p.zip).toBeNull();
    expect(p.state).toBe("AZ");
  });
  it("still reads a trailing ZIP after a 5-digit house number", () => {
    const p = parseQuickAddress("16500 N Pierce Ferry Rd, Dolan Springs, AZ 86441");
    expect(p.zip).toBe("86441");
    expect(p.state).toBe("AZ");
  });
  it("keeps ordinary addresses unchanged", () => {
    expect(parseQuickAddress("500 Maple St, Kingman, AZ 86401")).toMatchObject({ zip: "86401", state: "AZ" });
    expect(parseQuickAddress("Kingman AZ 86401").zip).toBe("86401");
  });
});
