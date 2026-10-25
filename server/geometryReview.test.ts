import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeAddress, ADDRESS_GEOCODE_BUDGET_MS } from "./places";
import { _clearResolveCache, resolveFootprints, setPersistentResolveCache, CACHE_READ_BUDGET_MS, type PersistentResolveCache } from "./geometry";
const point = { lat: 35.2, lng: -114.05 };
const ring: [number, number][] = [[-114.051,35.199],[-114.049,35.199],[-114.049,35.201],[-114.051,35.201]];
const osm = (id: number) => ({ elements: [{ type: "way", id, geometry: ring.map(([lon,lat]) => ({ lon,lat })) }] });
const esri = () => ({ features: [{ attributes: { BUILD_ID: 1, HEIGHT: 6 }, geometry: { rings: [ring] } }] });
function payload() { return { status: "OK", results: [{ partial_match: false, formatted_address: "500 Maple St, Kingman, AZ 86401", types: ["street_address"], geometry: { location_type: "ROOFTOP", location: { lat: 35.2, lng: -114.05 } }, address_components: [
  { long_name: "Kingman", short_name: "Kingman", types: ["locality"] },
  { long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1"] },
  { long_name: "86401", short_name: "86401", types: ["postal_code"] },
] }] }; }
function mockPayload(value: unknown) { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value)))); }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); _clearResolveCache(); setPersistentResolveCache(null); });

describe("R1 precise-address gate", () => {
  it("accepts one consistent precise street result", async () => {
    mockPayload(payload());
    expect(await geocodeAddress("500 Maple", { city: "Kingman", state: "AZ", zip: "86401-0001" })).toMatchObject({ kind: "precise", lat: 35.2 });
  });
  it.each(["partial", "approximate", "locality", "ambiguous", "wrong-city", "wrong-state", "wrong-zip", "infinite", "out-of-range"])("rejects %s without a fabricated point", async (mode) => {
    const p = payload(); const r = p.results[0];
    if (mode === "partial") r.partial_match = true;
    if (mode === "approximate") r.geometry.location_type = "APPROXIMATE";
    if (mode === "locality") r.types = ["locality"];
    if (mode === "ambiguous") p.results.push(r);
    if (mode === "wrong-city") r.address_components[0].long_name = "Springfield";
    if (mode === "wrong-state") r.address_components[1].short_name = "MA";
    if (mode === "wrong-zip") r.address_components[2].long_name = "01109";
    if (mode === "infinite") r.geometry.location.lat = Infinity;
    if (mode === "out-of-range") r.geometry.location.lng = 190;
    mockPayload(p);
    expect(await geocodeAddress("500 Maple", { city: "Kingman", state: "AZ", zip: "86401" })).toEqual({ kind: "not_precise" });
  });
  it("aborts the actual stalled geocode transport and permits retry", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal; signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = geocodeAddress("500 Maple"); const rejection = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(ADDRESS_GEOCODE_BUDGET_MS);
    await rejection; expect(signal?.aborted).toBe(true);
    mockPayload(payload()); expect(await geocodeAddress("500 Maple")).toMatchObject({ kind: "precise" });
  });
});

describe("R1 provider and cache integrity", () => {
  it("fails open after the durable read deadline", async () => {
    vi.useFakeTimers(); const get = vi.fn(() => new Promise<null>(() => {}));
    setPersistentResolveCache({ get, put: vi.fn(async () => {}) });
    const fetcher = vi.fn(async () => osm(10));
    const pending = resolveFootprints(point, { osmFetcher: fetcher, esriFetcher: async () => ({ features: [] }) });
    await vi.advanceTimersByTimeAsync(CACHE_READ_BUDGET_MS);
    expect((await pending).provider).toBe("osm"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["usa_structures", "microsoft"])("does not persist partial Esri failure: %s", async (layer) => {
    const put = vi.fn(async () => {}); setPersistentResolveCache({ get: async () => null, put });
    const r = await resolveFootprints(point, { osmFetcher: async () => ({ elements: [] }), esriFetcher: async (url) => {
      if (url.includes("USA_Structures") === (layer === "usa_structures")) throw new Error("offline");
      return esri();
    }});
    expect(r.provider).toBe("esri"); expect(r.esriFailedLayers).toEqual([layer]); expect(put).not.toHaveBeenCalled();
  });
  it("rejects HTTP-200 provider error envelopes and partial Overpass remarks", async () => {
    const put = vi.fn(async () => {}); setPersistentResolveCache({ get: async () => null, put });
    const r = await resolveFootprints(point, { osmFetcher: async () => ({ ...osm(1), remark: "runtime timeout" }), esriFetcher: async (url) => url.includes("USA_Structures") ? { error: { code: 503 } } : esri() });
    expect(r.osmFailed).toBe(true); expect(r.esriFailedLayers).toEqual(["usa_structures"]); expect(r.provider).toBe("esri"); expect(put).not.toHaveBeenCalled();
  });
  it("never lets an older resolve overwrite a newer refresh in either cache", async () => {
    const rows = new Map<string, { provider: "osm" | "esri"; candidates: any[]; resolvedAt: number }>();
    const cache: PersistentResolveCache = { get: async (key) => rows.get(key) ?? null, put: async (key, provider, candidates, resolvedAt) => { rows.set(key, { provider, candidates, resolvedAt }); } };
    setPersistentResolveCache(cache);
    const old = deferred<ReturnType<typeof osm>>();
    const first = resolveFootprints(point, { skipCache: true, osmFetcher: () => old.promise, esriFetcher: async () => ({ features: [] }) });
    await resolveFootprints(point, { skipCache: true, osmFetcher: async () => osm(222), esriFetcher: async () => ({ features: [] }) });
    old.resolve(osm(111)); await first;
    const next = await resolveFootprints(point);
    expect(next.candidates[0].osmId).toBe("way/222"); expect(Array.from(rows.values())[0].candidates[0].osmId).toBe("way/222");
  });
  it("does not let a slow durable read replace a completed refresh", async () => {
    const read = deferred<any>(); setPersistentResolveCache({ get: () => read.promise, put: async () => {} });
    const older = resolveFootprints(point, { osmFetcher: async () => osm(111), esriFetcher: async () => ({ features: [] }) });
    await resolveFootprints(point, { skipCache: true, osmFetcher: async () => osm(222), esriFetcher: async () => ({ features: [] }) });
    read.resolve({ provider: "osm", candidates: [{ osmId: "way/000" }], resolvedAt: Date.now() }); await older;
    expect((await resolveFootprints(point)).candidates[0].osmId).toBe("way/222");
  });
});
