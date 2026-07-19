/**
 * LOOKUP place-name search (owner request Jul 19 2026): the address box must
 * accept business/POI names like Google/Apple Maps. Contracts pinned here:
 *  1. autocomplete blends address + establishment predictions, addresses first
 *  2. POI rows carry isPlaceName=true; addresses false
 *  3. de-dup by place_id, cap 6 total (max 4 addresses)
 *  4. graceful degradation — establishment call failing must not kill results
 *  5. resolvePlace extracts placeName for POIs, null for bare street addresses
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const makeRequestMock = vi.fn();
vi.mock("./_core/map", () => ({ makeRequest: (...a: unknown[]) => makeRequestMock(...a) }));

import { placeAutocomplete, resolvePlace } from "./places";

function pred(id: string, main: string, secondary = "Tucson, AZ, USA") {
  return {
    place_id: id,
    description: `${main}, ${secondary}`,
    structured_formatting: { main_text: main, secondary_text: secondary },
  };
}

beforeEach(() => {
  makeRequestMock.mockReset();
});

describe("place-name lookup — blended autocomplete", () => {
  it("blends addresses first, then POIs flagged isPlaceName, deduped and capped at 6", async () => {
    makeRequestMock.mockImplementation((_path: string, params: Record<string, string>) => {
      if (params.types === "address") {
        return Promise.resolve({ status: "OK", predictions: [pred("a1", "1825 N Alvernon Way"), pred("a2", "1826 N Alvernon Way"), pred("dup", "1827 N Alvernon Way")] });
      }
      return Promise.resolve({
        status: "OK",
        predictions: [pred("dup", "1827 N Alvernon Way"), pred("p1", "Emmanuel Baptist Church"), pred("p2", "City Church"), pred("p3", "Alvernon Cafe"), pred("p4", "Extra POI")],
      });
    });
    const out = await placeAutocomplete("emmanuel");
    expect(out.length).toBe(6);
    // addresses first, not flagged
    expect(out[0].placeId).toBe("a1");
    expect(out[0].isPlaceName).toBe(false);
    expect(out[2].placeId).toBe("dup");
    // POIs follow, flagged, dup removed
    const poiIds = out.filter((s) => s.isPlaceName).map((s) => s.placeId);
    expect(poiIds).toEqual(["p1", "p2", "p3"]);
    expect(out.filter((s) => s.placeId === "dup").length).toBe(1);
  });

  it("still returns address results when the establishment call fails (graceful degradation)", async () => {
    makeRequestMock.mockImplementation((_path: string, params: Record<string, string>) => {
      if (params.types === "address") {
        return Promise.resolve({ status: "OK", predictions: [pred("a1", "1825 N Alvernon Way")] });
      }
      return Promise.reject(new Error("quota"));
    });
    const out = await placeAutocomplete("1825 N Alvernon");
    expect(out.length).toBe(1);
    expect(out[0].placeId).toBe("a1");
  });

  it("throws only when BOTH scopes fail", async () => {
    makeRequestMock.mockRejectedValue(new Error("proxy down"));
    await expect(placeAutocomplete("anything at all")).rejects.toThrow(/Address lookup failed/);
  });
});

describe("place-name lookup — resolvePlace placeName extraction", () => {
  it("returns placeName for a POI whose name differs from the address first line", async () => {
    makeRequestMock.mockResolvedValue({
      status: "OK",
      result: {
        place_id: "p1",
        name: "Emmanuel Baptist Church",
        formatted_address: "1825 N Alvernon Way, Tucson, AZ 85712, USA",
        types: ["church", "place_of_worship", "point_of_interest", "establishment"],
        geometry: { location: { lat: 32.24, lng: -110.91 } },
        address_components: [
          { long_name: "Tucson", short_name: "Tucson", types: ["locality"] },
          { long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1"] },
          { long_name: "85712", short_name: "85712", types: ["postal_code"] },
        ],
      },
    });
    const r = await resolvePlace("p1");
    expect(r.placeName).toBe("Emmanuel Baptist Church");
    expect(r.state).toBe("AZ");
    expect(r.zip).toBe("85712");
  });

  it("returns null placeName for a bare street address (name === first address line)", async () => {
    makeRequestMock.mockResolvedValue({
      status: "OK",
      result: {
        place_id: "a1",
        name: "1825 N Alvernon Way",
        formatted_address: "1825 N Alvernon Way, Tucson, AZ 85712, USA",
        types: ["street_address"],
        geometry: { location: { lat: 32.24, lng: -110.91 } },
        address_components: [{ long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1"] }],
      },
    });
    const r = await resolvePlace("a1");
    expect(r.placeName).toBeNull();
  });
});
