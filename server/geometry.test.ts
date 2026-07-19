/**
 * GEO — stage 2b geometry & exposure layer specs.
 * Pure math is tested directly; the resolve/confirm endpoints are tested
 * through the router with a seeded site. Overpass is never hit in tests —
 * fetchOsmFootprints takes an injectable fetcher.
 */
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  deriveGeometry,
  exposedWallAreaByOrientation,
  exposureScore,
  fetchOsmFootprints,
  heightFromTags,
  longestEdgeOrientationDeg,
  prismFallback,
  ringAreaSqm,
  type FootprintCandidate,
} from "./geometry";

/** 20m x 10m rectangle near Tucson, long axis east-west. */
function rectRing(lat = 32.2226, lng = -110.9747, wM = 20, hM = 10): [number, number][] {
  const dLat = hM / 2 / 111320;
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
  ];
}

describe("geometry math", () => {
  it("ringAreaSqm computes a 20x10m rectangle as ~200 sqm regardless of winding", () => {
    const ring = rectRing();
    expect(ringAreaSqm(ring)).toBeGreaterThan(190);
    expect(ringAreaSqm(ring)).toBeLessThan(210);
    expect(ringAreaSqm([...ring].reverse())).toBeGreaterThan(190);
  });

  it("longestEdgeOrientationDeg reports the east-west long axis as ~90°", () => {
    const deg = longestEdgeOrientationDeg(rectRing());
    expect(Math.abs(deg - 90)).toBeLessThan(3);
  });

  it("exposedWallAreaByOrientation puts the two long walls on N and S and is winding-invariant", () => {
    const areas = exposedWallAreaByOrientation(rectRing(), 6);
    // long (20m) walls face N and S: 20*6 = 120 sqm ≈ 1292 sqft each
    expect(areas.N).toBeGreaterThan(1100);
    expect(areas.S).toBeGreaterThan(1100);
    expect(areas.E).toBeLessThan(areas.N);
    const flipped = exposedWallAreaByOrientation([...rectRing()].reverse(), 6);
    expect(flipped.N).toBe(areas.N);
    expect(flipped.S).toBe(areas.S);
  });

  it("exposureScore is 0-100, increases with shading factor (less shade = more exposure)", () => {
    const areas = exposedWallAreaByOrientation(rectRing(), 6);
    const shaded = exposureScore(areas, 6, 0.3);
    const open = exposureScore(areas, 6, 1);
    expect(open).toBeGreaterThan(shaded);
    expect(open).toBeLessThanOrEqual(100);
    expect(shaded).toBeGreaterThanOrEqual(0);
  });

  it("bucketOf maps bearings to compass sectors", () => {
    expect(bucketOf(0)).toBe("N");
    expect(bucketOf(92)).toBe("E");
    expect(bucketOf(225)).toBe("SW");
    expect(bucketOf(359)).toBe("N");
  });

  it("heightFromTags prefers explicit height, falls back to levels × 3.2m", () => {
    expect(heightFromTags({ height: "12.5" }).heightM).toBe(12.5);
    expect(heightFromTags({ "building:levels": "3" })).toEqual({ heightM: 3 * 3.2, stories: 3 });
    expect(heightFromTags({}).heightM).toBeNull();
  });

  it("prismFallback synthesizes a footprint whose area ≈ GFA / stories and is honestly sourced", () => {
    const p = prismFallback({ lat: 32.22, lng: -110.97 }, 3200, 2);
    expect(p.source).toBe("prism");
    expect(p.areaSqft).toBeGreaterThan(1400);
    expect(p.areaSqft).toBeLessThan(1800);
    const d = deriveGeometry(p);
    expect(d.heightSource).toBe("stories_estimate");
    expect(d.odblDerived).toBe(false);
    expect(d.footprintSource).toBeUndefined();
  });

  it("deriveGeometry flags OSM candidates as ODbL-derived with dataset height source when tagged", () => {
    const cand: FootprintCandidate = {
      ring: rectRing(),
      areaSqft: 2150,
      heightM: 7,
      stories: 2,
      source: "osm",
      osmId: "way/1",
      distanceM: 5,
    };
    const d = deriveGeometry(cand);
    expect(d.odblDerived).toBe(true);
    expect(d.heightSource).toBe("footprint_dataset");
    expect(d.exposureScore).toBeGreaterThan(0);
  });
});

describe("fetchOsmFootprints (mocked Overpass)", () => {
  it("parses ways into sorted candidates and filters noise", async () => {
    const lat = 32.2226;
    const lng = -110.9747;
    const ringNear = rectRing(lat, lng).map(([x, y]) => ({ lat: y, lon: x }));
    const ringFar = rectRing(lat + 0.0004, lng, 30, 15).map(([x, y]) => ({ lat: y, lon: x }));
    const shed = rectRing(lat, lng, 2, 1.5).map(([x, y]) => ({ lat: y, lon: x }));
    const fetcher = async () => ({
      elements: [
        { type: "way", id: 2, tags: { building: "yes" }, geometry: ringFar },
        { type: "way", id: 1, tags: { building: "house", "building:levels": "1" }, geometry: ringNear },
        { type: "way", id: 3, tags: { building: "shed" }, geometry: shed },
      ],
    });
    const cands = await fetchOsmFootprints({ lat, lng }, fetcher);
    expect(cands).toHaveLength(2); // shed filtered (<10 sqm)
    expect(cands[0].osmId).toBe("way/1"); // nearest first
    expect(cands[0].stories).toBe(1);
    expect(cands[0].areaSqft).toBeGreaterThan(2000);
  });

  it("returns [] when nothing is mapped nearby", async () => {
    const cands = await fetchOsmFootprints({ lat: 32, lng: -110 }, async () => ({ elements: [] }));
    expect(cands).toEqual([]);
  });
});

describe("fetchEsriFootprints (mocked USA Structures + MSBFP fallback)", () => {
  const lat = 32.2226;
  const lng = -110.9747;

  it("queries USA Structures first and carries HEIGHT into height-bearing candidates", async () => {
    const { fetchEsriFootprints } = await import("./geometry");
    const ringNear = rectRing(lat, lng);
    const ringFar = rectRing(lat + 0.0004, lng, 30, 15);
    const tiny = rectRing(lat, lng, 2, 1.5);
    const fetcher = async (url: string) => {
      expect(url).toContain("esriGeometryPoint");
      expect(url).toContain("USA_Structures");
      return {
        features: [
          { attributes: { BUILD_ID: 22, HEIGHT: 9.6, PRIM_OCC: "Education" }, geometry: { rings: [ringFar] } },
          { attributes: { BUILD_ID: 11, HEIGHT: 6.4, PRIM_OCC: "Residential" }, geometry: { rings: [ringNear] } },
          { attributes: { BUILD_ID: 33, HEIGHT: 3 }, geometry: { rings: [tiny] } },
        ],
      };
    };
    const cands = await fetchEsriFootprints({ lat, lng }, fetcher);
    expect(cands).toHaveLength(2); // tiny (<10 sqm) filtered
    expect(cands[0].osmId).toBe("usastruct/11"); // nearest first
    expect(cands[0].source).toBe("usa_structures");
    expect(cands[0].heightM).toBe(6.4); // measured height flows through
    expect(cands[0].stories).toBe(2); // 6.4 / 3.2
    expect(cands[0].occupancyClass).toBe("Residential");
    expect(cands[0].areaSqft).toBeGreaterThan(2000);
    // deriveGeometry treats the measured height as dataset-sourced
    expect(deriveGeometry(cands[0]).heightSource).toBe("footprint_dataset");
  });

  it("leaves height null when USA Structures has no measurement (honesty preserved)", async () => {
    const { fetchEsriFootprints } = await import("./geometry");
    const fetcher = async () => ({
      features: [{ attributes: { BUILD_ID: 5, HEIGHT: null }, geometry: { rings: [rectRing(lat, lng)] } }],
    });
    const cands = await fetchEsriFootprints({ lat, lng }, fetcher);
    expect(cands[0].heightM).toBeNull();
    expect(cands[0].stories).toBeNull();
    expect(deriveGeometry(cands[0]).heightSource).toBe("stories_estimate");
  });

  it("falls back to MSBFP2 microsoft-source footprints when USA Structures errors", async () => {
    const { fetchEsriFootprints } = await import("./geometry");
    const fetcher = async (url: string) => {
      if (url.includes("USA_Structures")) throw new Error("service down");
      expect(url).toContain("MSBFP2");
      return { features: [{ attributes: { OBJECTID: 11 }, geometry: { rings: [rectRing(lat, lng)] } }] };
    };
    const cands = await fetchEsriFootprints({ lat, lng }, fetcher);
    expect(cands).toHaveLength(1);
    expect(cands[0].source).toBe("microsoft");
    expect(cands[0].osmId).toBe("msbfp/11");
    expect(cands[0].heightM).toBeNull(); // MSBFP carries no heights
  });

  it("falls back to MSBFP2 when USA Structures returns no features nearby", async () => {
    const { fetchEsriFootprints } = await import("./geometry");
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.includes("USA_Structures")) return { features: [] };
      return { features: [{ attributes: { OBJECTID: 7 }, geometry: { rings: [rectRing(lat, lng)] } }] };
    };
    const cands = await fetchEsriFootprints({ lat, lng }, fetcher);
    expect(calls).toHaveLength(2);
    expect(cands[0].source).toBe("microsoft");
  });

  it("returns [] when both services find nothing nearby", async () => {
    const { fetchEsriFootprints } = await import("./geometry");
    const cands = await fetchEsriFootprints({ lat: 32, lng: -110 }, async () => ({ features: [] }));
    expect(cands).toEqual([]);
  });

  it("deriveGeometry keeps microsoft provenance honest: no ODbL flag, stories-estimate height", () => {
    const cand: FootprintCandidate = {
      ring: rectRing(),
      areaSqft: 2150,
      heightM: null,
      stories: null,
      source: "microsoft",
      osmId: "msbfp/11",
      distanceM: 5,
    };
    const d = deriveGeometry(cand);
    expect(d.odblDerived).toBe(false);
    expect(d.footprintSource).toBe("microsoft");
    expect(d.heightSource).toBe("stories_estimate");
  });
});
