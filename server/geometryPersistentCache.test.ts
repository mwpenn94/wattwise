/**
 * NEXT-3 — persistent footprint-resolve cache behavior.
 *
 * geometry.ts takes an injected PersistentResolveCache; these specs verify the
 * read-through / write-through / TTL / fail-open contract with an in-memory
 * fake, no database needed.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PERSISTENT_RESOLVE_TTL_MS,
  _clearResolveCache,
  resolveFootprints,
  setPersistentResolveCache,
  type FootprintCandidate,
  type PersistentResolveCache,
} from "./geometry";

const POINT = { lat: 33.4152, lng: -111.8315 };
const GRID_KEY = `${POINT.lat.toFixed(4)},${POINT.lng.toFixed(4)}`;

function candidate(): FootprintCandidate {
  return {
    ring: [
      [-111.8316, 33.4151],
      [-111.8314, 33.4151],
      [-111.8314, 33.4153],
      [-111.8316, 33.4153],
    ],
    areaSqft: 4800,
    heightM: 6.4,
    stories: 2,
    source: "osm",
    osmId: "way/123",
    distanceM: 5,
  };
}

/** Overpass fetcher that returns one building way. */
const okOsmFetcher = async () => ({
  elements: [
    {
      type: "way",
      id: 123,
      tags: { building: "yes", "building:levels": "2" },
      geometry: [
        { lat: 33.4151, lon: -111.8316 },
        { lat: 33.4151, lon: -111.8314 },
        { lat: 33.4153, lon: -111.8314 },
        { lat: 33.4153, lon: -111.8316 },
      ],
    },
  ],
});
const failingOsmFetcher = async () => {
  throw new Error("mirror down");
};
const failingEsriFetcher = async () => {
  throw new Error("esri down");
};

function fakeStore() {
  const rows = new Map<string, { provider: "osm" | "esri" | "none"; candidates: FootprintCandidate[]; resolvedAt: number }>();
  const cache: PersistentResolveCache = {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(key, provider, candidates) {
      rows.set(key, { provider, candidates, resolvedAt: Date.now() });
    },
  };
  return { rows, cache };
}

afterEach(() => {
  setPersistentResolveCache(null);
  _clearResolveCache();
});

describe("persistent resolve cache", () => {
  it("writes through to the persistent layer on a full-success resolve (both sources up)", async () => {
    const { rows, cache } = fakeStore();
    setPersistentResolveCache(cache);
    // GEO-BUG-1: persistence requires BOTH upstreams healthy — a degraded
    // (single-source) result must never be written to the durable layer.
    const okEsriFetcher = async () => ({ features: [] });
    const out = await resolveFootprints(POINT, { osmFetcher: okOsmFetcher, esriFetcher: okEsriFetcher });
    expect(out.provider).toBe("osm");
    // write-through is fire-and-forget; let the microtask drain
    await new Promise((r) => setTimeout(r, 10));
    expect(rows.has(GRID_KEY)).toBe(true);
    expect(rows.get(GRID_KEY)!.provider).toBe("osm");
    expect(rows.get(GRID_KEY)!.candidates.length).toBeGreaterThan(0);
  });

  it("GEO-BUG-1: degraded (single-source) resolves are NOT persisted", async () => {
    const { rows, cache } = fakeStore();
    setPersistentResolveCache(cache);
    const out = await resolveFootprints(POINT, { osmFetcher: okOsmFetcher, esriFetcher: failingEsriFetcher });
    expect(out.provider).toBe("osm"); // resolve still succeeds for the user
    await new Promise((r) => setTimeout(r, 10));
    expect(rows.has(GRID_KEY)).toBe(false); // but never poisons the durable cache
  });

  it("serves from the persistent layer when upstreams are down (cold-start survival)", async () => {
    const { rows, cache } = fakeStore();
    rows.set(GRID_KEY, { provider: "osm", candidates: [candidate()], resolvedAt: Date.now() - 1000 });
    setPersistentResolveCache(cache);
    _clearResolveCache(); // simulate a fresh instance: in-memory map empty
    const out = await resolveFootprints(POINT, { osmFetcher: failingOsmFetcher, esriFetcher: failingEsriFetcher });
    expect(out.cached).toBe(true);
    expect(out.provider).toBe("osm");
    expect(out.candidates[0].osmId).toBe("way/123");
  });

  it("ignores persistent rows older than the 180-day TTL", async () => {
    const { rows, cache } = fakeStore();
    rows.set(GRID_KEY, { provider: "osm", candidates: [candidate()], resolvedAt: Date.now() - PERSISTENT_RESOLVE_TTL_MS - 1000 });
    setPersistentResolveCache(cache);
    _clearResolveCache();
    const out = await resolveFootprints(POINT, { osmFetcher: failingOsmFetcher, esriFetcher: failingEsriFetcher });
    // stale row skipped → both transports failed → provider none, not cached
    expect(out.provider).toBe("none");
    expect(out.osmFailed).toBe(true);
    expect(out.esriFailed).toBe(true);
  });

  it("does not persist transport failures", async () => {
    const { rows, cache } = fakeStore();
    setPersistentResolveCache(cache);
    await resolveFootprints(POINT, { osmFetcher: failingOsmFetcher, esriFetcher: failingEsriFetcher });
    await new Promise((r) => setTimeout(r, 10));
    expect(rows.size).toBe(0);
  });

  it("fails open when the persistent layer itself errors", async () => {
    setPersistentResolveCache({
      async get() {
        throw new Error("db exploded");
      },
      async put() {
        throw new Error("db exploded");
      },
    });
    const out = await resolveFootprints(POINT, { osmFetcher: okOsmFetcher, esriFetcher: failingEsriFetcher });
    expect(out.provider).toBe("osm"); // resolve still succeeds
  });
});
