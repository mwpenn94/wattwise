/**
 * Grounded intake (Jul 17): places module tests — the Maps proxy is mocked so
 * these verify OUR parsing/extraction logic, not Google's uptime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const makeRequestMock = vi.fn();
vi.mock("./_core/map", () => ({
  makeRequest: (...args: unknown[]) => makeRequestMock(...args),
}));

import { placeAutocomplete, resolvePlace } from "./places";

beforeEach(() => makeRequestMock.mockReset());

describe("placeAutocomplete", () => {
  it("returns [] without calling the API for short queries", async () => {
    expect(await placeAutocomplete("ab")).toEqual([]);
    expect(makeRequestMock).not.toHaveBeenCalled();
  });

  it("maps predictions to suggestions (top 5, address-scoped, US-biased)", async () => {
    makeRequestMock.mockResolvedValue({
      status: "OK",
      predictions: Array.from({ length: 7 }, (_, i) => ({
        place_id: `pid-${i}`,
        description: `${i} Main St, Phoenix, AZ, USA`,
        structured_formatting: { main_text: `${i} Main St`, secondary_text: "Phoenix, AZ, USA" },
      })),
    });
    const out = await placeAutocomplete("main st");
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ placeId: "pid-0", description: "0 Main St, Phoenix, AZ, USA", mainText: "0 Main St", secondaryText: "Phoenix, AZ, USA" });
    const [endpoint, params] = makeRequestMock.mock.calls[0] as [string, Record<string, string>];
    expect(endpoint).toBe("/maps/api/place/autocomplete/json");
    expect(params.types).toBe("address");
    expect(params.components).toBe("country:us");
  });

  it("returns [] on ZERO_RESULTS and throws on hard API errors", async () => {
    makeRequestMock.mockResolvedValueOnce({ status: "ZERO_RESULTS", predictions: [] });
    expect(await placeAutocomplete("nowhere xyz")).toEqual([]);
    makeRequestMock.mockResolvedValueOnce({ status: "REQUEST_DENIED", error_message: "bad key" });
    await expect(placeAutocomplete("main st")).rejects.toThrow(/REQUEST_DENIED/);
  });
});

describe("resolvePlace", () => {
  it("extracts verified state/zip/city from address components", async () => {
    makeRequestMock.mockResolvedValue({
      status: "OK",
      result: {
        place_id: "pid-1",
        formatted_address: "500 N Central Ave, Phoenix, AZ 85004, USA",
        types: ["street_address"],
        geometry: { location: { lat: 33.452, lng: -112.073 } },
        address_components: [
          { long_name: "500", short_name: "500", types: ["street_number"] },
          { long_name: "Phoenix", short_name: "Phoenix", types: ["locality", "political"] },
          { long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1", "political"] },
          { long_name: "85004", short_name: "85004", types: ["postal_code"] },
        ],
      },
    });
    const p = await resolvePlace("pid-1");
    expect(p.state).toBe("AZ");
    expect(p.zip).toBe("85004");
    expect(p.city).toBe("Phoenix");
    expect(p.lat).toBeCloseTo(33.452);
    expect(p.formattedAddress).toContain("85004");
    // street_address alone gives NO residential signal — the UI must ask.
    expect(p.residentialHint).toBeNull();
  });

  it("falls back to sublocality for city and truncates ZIP+4", async () => {
    makeRequestMock.mockResolvedValue({
      status: "OK",
      result: {
        place_id: "pid-2",
        formatted_address: "10 Elm St, Brooklyn, NY 11201-1234, USA",
        types: ["premise"],
        address_components: [
          { long_name: "Brooklyn", short_name: "Brooklyn", types: ["sublocality_level_1", "political"] },
          { long_name: "New York", short_name: "NY", types: ["administrative_area_level_1", "political"] },
          { long_name: "11201-1234", short_name: "11201-1234", types: ["postal_code"] },
        ],
      },
    });
    const p = await resolvePlace("pid-2");
    expect(p.city).toBe("Brooklyn");
    expect(p.zip).toBe("11201");
    expect(p.state).toBe("NY");
  });

  it("throws a diagnostic error when the place cannot be resolved", async () => {
    makeRequestMock.mockResolvedValue({ status: "NOT_FOUND" });
    await expect(resolvePlace("gone")).rejects.toThrow(/NOT_FOUND/);
  });
});
