/**
 * Raced footprint resolver — regression coverage for the Jul 19 incident
 * ("building geometry keeps failing even on addresses where it worked
 * before"): the serial Overpass mirror walk stalled 8s per throttled mirror.
 * The resolver now races OSM and Esri in parallel with failure isolation and
 * a per-point cache. All fetchers injected — no live network in tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveFootprints,
  _clearResolveCache,
  type OverpassFetcher,
  type EsriFetcher,
} from "./geometry";

const POINT = { lat: 38.2527, lng: -85.7585 };

/** Minimal square ~20x20m near the point — passes the 10 sqm noise filter. */
function osmElements(id = 1) {
  const d = 0.0002;
  return {
    elements: [
      {
        type: "way",
        id,
        tags: { building: "yes", "building:levels": "2" },
        geometry: [
          { lat: POINT.lat - d, lon: POINT.lng - d },
          { lat: POINT.lat - d, lon: POINT.lng + d },
          { lat: POINT.lat + d, lon: POINT.lng + d },
          { lat: POINT.lat + d, lon: POINT.lng - d },
        ],
      },
    ],
  };
}

function esriPayload() {
  const d = 0.0002;
  const ring: [number, number][] = [
    [POINT.lng - d, POINT.lat - d],
    [POINT.lng + d, POINT.lat - d],
    [POINT.lng + d, POINT.lat + d],
    [POINT.lng - d, POINT.lat + d],
  ];
  return { features: [{ attributes: { BUILD_ID: 77, HEIGHT: 8.5, PRIM_OCC: "Residential" }, geometry: { rings: [ring] } }] };
}

const okOsm: OverpassFetcher = async () => osmElements();
const emptyOsm: OverpassFetcher = async () => ({ elements: [] });
const failOsm: OverpassFetcher = async () => {
  throw new Error("Overpass throttled");
};
const okEsri: EsriFetcher = async () => esriPayload();
const emptyEsri: EsriFetcher = async () => ({ features: [] });
const failEsri: EsriFetcher = async () => {
  throw new Error("Esri down");
};

beforeEach(() => _clearResolveCache());

describe("resolveFootprints — provider selection", () => {
  it("prefers OSM when both sources return candidates", async () => {
    const r = await resolveFootprints(POINT, { osmFetcher: okOsm, esriFetcher: okEsri });
    expect(r.provider).toBe("osm");
    expect(r.candidates[0]?.source).toBe("osm");
    expect(r.osmFailed).toBe(false);
    expect(r.esriFailed).toBe(false);
  });

  it("falls to Esri when OSM transport fails (throttled mirrors)", async () => {
    const r = await resolveFootprints(POINT, { osmFetcher: failOsm, esriFetcher: okEsri });
    expect(r.provider).toBe("esri");
    expect(r.osmFailed).toBe(true);
    expect(r.candidates[0]?.source).toBe("usa_structures");
    expect(r.candidates[0]?.heightM).toBeCloseTo(8.5, 1);
  });

  it("falls to Esri when OSM succeeds but has no mapped building", async () => {
    const r = await resolveFootprints(POINT, { osmFetcher: emptyOsm, esriFetcher: okEsri });
    expect(r.provider).toBe("esri");
    expect(r.osmFailed).toBe(false);
  });

  it("returns provider none with both flags when both transports fail", async () => {
    const r = await resolveFootprints(POINT, { osmFetcher: failOsm, esriFetcher: failEsri });
    expect(r.provider).toBe("none");
    expect(r.osmFailed).toBe(true);
    expect(r.esriFailed).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("returns provider none (unmapped building) when both reachable but empty", async () => {
    const r = await resolveFootprints(POINT, { osmFetcher: emptyOsm, esriFetcher: emptyEsri });
    expect(r.provider).toBe("none");
    expect(r.osmFailed).toBe(false);
    expect(r.esriFailed).toBe(false);
  });
});

describe("resolveFootprints — parallel race, not serial walk", () => {
  it("does not wait for a slow OSM source longer than the race requires", async () => {
    // OSM takes 5s; Esri answers instantly. Total time must be ~OSM-bound at
    // worst (they run concurrently), NOT osm+esri serially. We assert both
    // were started concurrently by checking wall time < osmDelay + margin.
    const osmDelay = 300;
    const slowOsm: OverpassFetcher = async () => {
      await new Promise((r) => setTimeout(r, osmDelay));
      return osmElements();
    };
    let esriStartedAt = -1;
    const timedEsri: EsriFetcher = async (url) => {
      if (esriStartedAt < 0) esriStartedAt = Date.now();
      return esriPayload();
    };
    const t0 = Date.now();
    const r = await resolveFootprints(POINT, { osmFetcher: slowOsm, esriFetcher: timedEsri });
    const wall = Date.now() - t0;
    expect(r.provider).toBe("osm"); // OSM still preferred once it arrives
    expect(esriStartedAt - t0).toBeLessThan(100); // Esri started immediately, not after OSM finished
    expect(wall).toBeLessThan(osmDelay + 200);
  });
});

describe("resolveFootprints — cache semantics", () => {
  it("caches a success and serves retries without re-hitting upstreams", async () => {
    let osmCalls = 0;
    const countingOsm: OverpassFetcher = async () => {
      osmCalls++;
      return osmElements();
    };
    const r1 = await resolveFootprints(POINT, { osmFetcher: countingOsm, esriFetcher: okEsri });
    const r2 = await resolveFootprints(POINT, { osmFetcher: countingOsm, esriFetcher: okEsri });
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(r2.provider).toBe("osm");
    expect(osmCalls).toBe(1);
  });

  it("nearby pin jitter (<11m) hits the same cache cell", async () => {
    let calls = 0;
    const countingOsm: OverpassFetcher = async () => {
      calls++;
      return osmElements();
    };
    await resolveFootprints(POINT, { osmFetcher: countingOsm, esriFetcher: okEsri });
    const jittered = { lat: POINT.lat + 0.00002, lng: POINT.lng - 0.00002 };
    const r = await resolveFootprints(jittered, { osmFetcher: countingOsm, esriFetcher: okEsri });
    expect(r.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it("NEVER caches transport failures — the retry goes back upstream", async () => {
    const r1 = await resolveFootprints(POINT, { osmFetcher: failOsm, esriFetcher: failEsri });
    expect(r1.provider).toBe("none");
    // Upstreams recover; the retry must not be poisoned by a cached failure.
    const r2 = await resolveFootprints(POINT, { osmFetcher: okOsm, esriFetcher: okEsri });
    expect(r2.cached).toBe(false);
    expect(r2.provider).toBe("osm");
  });

  it("caches a confirmed unmapped-building result (both reachable, both empty)", async () => {
    let calls = 0;
    const countingEmptyOsm: OverpassFetcher = async () => {
      calls++;
      return { elements: [] };
    };
    await resolveFootprints(POINT, { osmFetcher: countingEmptyOsm, esriFetcher: emptyEsri });
    const r = await resolveFootprints(POINT, { osmFetcher: countingEmptyOsm, esriFetcher: emptyEsri });
    expect(r.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it("skipCache bypasses the cache when explicitly requested", async () => {
    let calls = 0;
    const countingOsm: OverpassFetcher = async () => {
      calls++;
      return osmElements();
    };
    await resolveFootprints(POINT, { osmFetcher: countingOsm, esriFetcher: okEsri });
    const r = await resolveFootprints(POINT, { osmFetcher: countingOsm, esriFetcher: okEsri, skipCache: true });
    expect(r.cached).toBe(false);
    expect(calls).toBe(2);
  });
});
