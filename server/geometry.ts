/**
 * Geometry & exposure layer (handoff v1.22 stage 2b, cycle 4/8/10).
 *
 * Sourcing order (free tier, spec "geometry gating"):
 *   1. OSM via Overpass API — building footprint polygon + height/levels tags.
 *      Free, no key. ODbL share-alike → rows flagged odblDerived=true (S8 rule).
 *   2. Prism fallback — when no footprint found, synthesize a rectangular
 *      prism from the site's GFA + stories (heightSource="stories_estimate").
 *      A prism estimate is NEVER presented with dataset/LiDAR confidence:
 *      per-field geometryConfidence carries source + confidence for honesty.
 *   3. User-drawn footprint (client draws polygon on map) — highest precedence
 *      user_confirmed source, handled by the confirm endpoint.
 *
 * All math here is pure and unit-tested: polygon area (spherical-corrected
 * shoelace), longest-edge orientation, exposed wall area by orientation
 * bucket, and a 0-100 exposure score heuristic.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface FootprintCandidate {
  /** GeoJSON-style ring: [[lng,lat], ...] closed or open */
  ring: [number, number][];
  areaSqft: number;
  heightM: number | null;
  stories: number | null;
  source: "osm" | "microsoft" | "usa_structures" | "user_drawn" | "prism";
  osmId?: string;
  /** USA Structures primary occupancy class (e.g. "Education/Pre-K - 12 Schools") */
  occupancyClass?: string;
  /** distance from query point to polygon centroid, meters */
  distanceM: number;
  tags?: Record<string, string>;
}

const EARTH_R = 6371000; // meters
const SQM_TO_SQFT = 10.7639;
const M_PER_DEG_LAT = 111320;

/** meters per degree of longitude at a latitude */
function mPerDegLng(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/** Project a ring of [lng,lat] to local planar meters around its centroid. */
export function projectRing(ring: [number, number][]): { xy: [number, number][]; centroid: LatLng } {
  const lats = ring.map((p) => p[1]);
  const lngs = ring.map((p) => p[0]);
  const cLat = lats.reduce((a, b) => a + b, 0) / ring.length;
  const cLng = lngs.reduce((a, b) => a + b, 0) / ring.length;
  const kx = mPerDegLng(cLat);
  const xy = ring.map(([lng, lat]) => [(lng - cLng) * kx, (lat - cLat) * M_PER_DEG_LAT] as [number, number]);
  return { xy, centroid: { lat: cLat, lng: cLng } };
}

/** Shoelace area of a lng/lat ring, in square meters (planar local projection). */
export function ringAreaSqm(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const { xy } = projectRing(ring);
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/**
 * Building orientation from the longest edge of the footprint, degrees
 * clockwise from north in [0, 180) (an edge has no direction, so 190° ≡ 10°).
 */
export function longestEdgeOrientationDeg(ring: [number, number][]): number {
  if (ring.length < 2) return 0;
  const { xy } = projectRing(ring);
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > bestLen) {
      bestLen = len;
      // bearing from north: atan2(dx, dy)
      let deg = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
      deg = ((deg % 180) + 180) % 180;
      best = deg;
    }
  }
  return best;
}

export type OrientationBucket = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** Bucket an outward wall normal bearing (0-360) into 8 compass sectors. */
export function bucketOf(bearingDeg: number): OrientationBucket {
  const buckets: OrientationBucket[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return buckets[idx];
}

/**
 * Exposed wall area (sqft) by outward-normal orientation bucket.
 * Walls are footprint edges extruded to height; the outward normal of each
 * edge determines which compass sector its area belongs to. Ring winding is
 * normalized to counter-clockwise so normals point outward consistently.
 */
export function exposedWallAreaByOrientation(
  ring: [number, number][],
  heightM: number,
): Record<OrientationBucket, number> {
  const out: Record<OrientationBucket, number> = { N: 0, NE: 0, E: 0, SE: 0, S: 0, SW: 0, W: 0, NW: 0 };
  if (ring.length < 3 || heightM <= 0) return out;
  const { xy } = projectRing(ring);
  // signed area > 0 → CCW
  let signed = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    signed += x1 * y2 - x2 * y1;
  }
  const ccw = signed > 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    // outward normal: for CCW ring it's (dy, -dx); for CW it's (-dy, dx)
    const nx = ccw ? dy : -dy;
    const ny = ccw ? -dx : dx;
    const bearing = ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360;
    out[bucketOf(bearing)] += len * heightM * SQM_TO_SQFT;
  }
  for (const k of Object.keys(out) as OrientationBucket[]) out[k] = Math.round(out[k]);
  return out;
}

/**
 * Exposure score 0-100 (heuristic, honestly labeled as such in UI):
 * weights west+south wall share (cooling-dominant Southwest priority),
 * height (taller = more exposed), and shading factor (1 = unshaded).
 */
export function exposureScore(
  wallAreas: Record<OrientationBucket, number>,
  heightM: number,
  neighborShadingFactor: number,
): number {
  const total = Object.values(wallAreas).reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const hot = wallAreas.S + wallAreas.SW + wallAreas.W + 0.5 * (wallAreas.SE + wallAreas.NW);
  const hotShare = hot / total; // 0..~0.75 typical
  const heightTerm = Math.min(1, heightM / 20); // saturates at ~5 stories
  const shade = Math.max(0, Math.min(1, neighborShadingFactor));
  const score = 100 * (0.55 * hotShare + 0.2 * heightTerm + 0.25 * shade);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Height from OSM tags: height=X m preferred, else building:levels × 3.2m. */
export function heightFromTags(tags: Record<string, string>): { heightM: number | null; stories: number | null } {
  const rawH = tags["height"] ?? tags["building:height"];
  const rawL = tags["building:levels"] ?? tags["levels"];
  const stories = rawL != null && Number.isFinite(parseFloat(rawL)) ? Math.max(1, Math.round(parseFloat(rawL))) : null;
  if (rawH != null) {
    const h = parseFloat(String(rawH).replace(/m$/i, "").trim());
    if (Number.isFinite(h) && h > 0) return { heightM: h, stories };
  }
  if (stories != null) return { heightM: stories * 3.2, stories };
  return { heightM: null, stories: null };
}

/**
 * Prism fallback: rectangular footprint synthesized from GFA + stories,
 * 1.6:1 aspect ratio, centered at the site point, aligned north.
 * heightSource="stories_estimate", NEVER presented as measured.
 */
export function prismFallback(center: LatLng, gfaSqft: number | null, stories: number | null): FootprintCandidate {
  const st = Math.max(1, stories ?? 1);
  const gfa = gfaSqft && gfaSqft > 0 ? gfaSqft : 1800; // national residential median-ish default
  const footprintSqm = gfa / SQM_TO_SQFT / st;
  const w = Math.sqrt(footprintSqm / 1.6); // meters, short side
  const l = 1.6 * w;
  const dLat = w / 2 / M_PER_DEG_LAT;
  const dLng = l / 2 / mPerDegLng(center.lat);
  const ring: [number, number][] = [
    [center.lng - dLng, center.lat - dLat],
    [center.lng + dLng, center.lat - dLat],
    [center.lng + dLng, center.lat + dLat],
    [center.lng - dLng, center.lat + dLat],
  ];
  return {
    ring,
    areaSqft: Math.round(footprintSqm * SQM_TO_SQFT),
    heightM: st * 3.2,
    stories: st,
    source: "prism",
    distanceM: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Overpass fetch                                                      */
/* ------------------------------------------------------------------ */

/**
 * Mirror health is volatile (re-verified Jul 19 2026): mail.ru throttles after
 * ~1 request/min then hangs; kumi.systems hard-429s from this runtime class;
 * overpass-api.de answers in ~2s with the Meterly UA (the old 406 was
 * browser-UA-specific). No single mirror can be trusted to stay healthy, so
 * they are RACED IN PARALLEL — first success wins — instead of walked
 * serially, which previously burned 8s per dead mirror and made resolves
 * "fail on addresses that worked before" once the lead mirror throttled.
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const FETCH_UA = "Meterly/1.0 (building-footprint resolver; https://meterly.manus.space)";

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Injectable fetcher for tests. */
export type OverpassFetcher = (query: string) => Promise<{ elements: OverpassElement[] }>;

const OVERPASS_TIMEOUT_MS = 6000;

async function overpassFetchOne(ep: string, query: string): Promise<{ elements: OverpassElement[] }> {
  const res = await fetch(ep, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": FETCH_UA,
      Accept: "application/json",
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Overpass ${ep} HTTP ${res.status}`);
  return (await res.json()) as { elements: OverpassElement[] };
}

/** Race all mirrors in parallel; first successful JSON wins. Total wall time
 * is bounded by the slowest single mirror (6s), not the sum of all three. */
async function defaultOverpassFetch(query: string): Promise<{ elements: OverpassElement[] }> {
  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map((ep) => overpassFetchOne(ep, query)));
  } catch (e) {
    const first = e instanceof AggregateError ? e.errors[0] : e;
    throw first instanceof Error ? first : new Error("Overpass unavailable");
  }
}

/**
 * Fetch OSM building footprint candidates near a point (radius ~60m),
 * sorted by centroid distance. Returns [] on total miss (caller falls back
 * to prism). Throws only if the transport itself failed on all mirrors.
 */
export async function fetchOsmFootprints(
  point: LatLng,
  fetcher: OverpassFetcher = defaultOverpassFetch,
): Promise<FootprintCandidate[]> {
  const q = `[out:json][timeout:10];way(around:60,${point.lat},${point.lng})["building"];out tags geom 8;`;
  const data = await fetcher(q);
  const candidates: FootprintCandidate[] = [];
  for (const el of data.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const ring = el.geometry.map((g) => [g.lon, g.lat] as [number, number]);
    const areaSqm = ringAreaSqm(ring);
    if (areaSqm < 10) continue; // sheds/noise
    const { centroid } = projectRing(ring);
    const { heightM, stories } = heightFromTags(el.tags ?? {});
    candidates.push({
      ring,
      areaSqft: Math.round(areaSqm * SQM_TO_SQFT),
      heightM,
      stories,
      source: "osm",
      osmId: `way/${el.id}`,
      distanceM: Math.round(haversineM(point, centroid)),
      tags: el.tags,
    });
  }
  candidates.sort((a, b) => a.distanceM - b.distanceM);
  return candidates.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Microsoft Building Footprints via Esri feature service              */
/* ------------------------------------------------------------------ */

const ESRI_MSBFP_URL =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query";

/** FEMA USA Structures — the height-bearing national footprint layer (the same
 * data family behind Esri's 3D Buildings layer the owner referenced). Public,
 * point-queryable, returns HEIGHT in meters (LiDAR/NGA where available) plus
 * occupancy class. Primary Esri-family source; MSBFP2 stays as the footprints-
 * only fallback when this service errors. */
const USA_STRUCTURES_URL =
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query";

interface EsriFeature {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: [number, number][][] };
}

/** Injectable fetcher for tests. */
export type EsriFetcher = (url: string) => Promise<{ features?: EsriFeature[] }>;

async function defaultEsriFetch(url: string): Promise<{ features?: EsriFeature[] }> {
  const res = await fetch(url, {
    headers: { "User-Agent": FETCH_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Esri footprints HTTP ${res.status}`);
  return (await res.json()) as { features?: EsriFeature[] };
}

function esriQueryParams(point: LatLng, outFields: string): URLSearchParams {
  return new URLSearchParams({
    where: "1=1",
    geometry: `${point.lng},${point.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: "60",
    units: "esriSRUnit_Meter",
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "8",
    f: "json",
  });
}

function esriFeaturesToCandidates(
  features: EsriFeature[],
  point: LatLng,
  source: "microsoft" | "usa_structures",
): FootprintCandidate[] {
  const candidates: FootprintCandidate[] = [];
  for (const f of features) {
    const ring = f.geometry?.rings?.[0];
    if (!ring || ring.length < 3) continue;
    const typedRing = ring.map((p) => [p[0], p[1]] as [number, number]);
    const areaSqm = ringAreaSqm(typedRing);
    if (areaSqm < 10) continue;
    const { centroid } = projectRing(typedRing);
    // USA Structures carries HEIGHT in meters (LiDAR/NGA where available);
    // absent or non-positive values stay null so heightSource honesty holds.
    const rawH = f.attributes?.HEIGHT;
    const heightM = source === "usa_structures" && typeof rawH === "number" && rawH > 0 ? Math.round(rawH * 100) / 100 : null;
    const occ = typeof f.attributes?.PRIM_OCC === "string" && f.attributes.PRIM_OCC ? String(f.attributes.PRIM_OCC) : undefined;
    const rawId = f.attributes?.BUILD_ID ?? f.attributes?.OBJECTID;
    candidates.push({
      ring: typedRing,
      areaSqft: Math.round(areaSqm * SQM_TO_SQFT),
      heightM,
      stories: heightM != null ? Math.max(1, Math.round(heightM / 3.2)) : null,
      source,
      occupancyClass: occ,
      osmId: rawId != null ? `${source === "usa_structures" ? "usastruct" : "msbfp"}/${rawId}` : undefined,
      distanceM: Math.round(haversineM(point, centroid)),
    });
  }
  candidates.sort((a, b) => a.distanceM - b.distanceM);
  return candidates.slice(0, 5);
}

/**
 * Esri-family footprints, height-aware. Primary: FEMA USA Structures (HEIGHT
 * meters + occupancy class — the queryable sibling of the ArcGIS 3D Buildings
 * layer). Fallback: Microsoft US Building Footprints via MSBFP2 (footprints
 * only, no height — heightSource stays stories_estimate for those).
 */
export async function fetchEsriFootprints(
  point: LatLng,
  fetcher: EsriFetcher = defaultEsriFetch,
): Promise<FootprintCandidate[]> {
  try {
    const params = esriQueryParams(point, "BUILD_ID,HEIGHT,PRIM_OCC,SQFEET");
    const data = await fetcher(`${USA_STRUCTURES_URL}?${params.toString()}`);
    const withHeights = esriFeaturesToCandidates(data.features ?? [], point, "usa_structures");
    if (withHeights.length > 0) return withHeights;
  } catch {
    // fall through to MSBFP2 — footprints-only is better than nothing
  }
  const params = esriQueryParams(point, "OBJECTID");
  const data = await fetcher(`${ESRI_MSBFP_URL}?${params.toString()}`);
  return esriFeaturesToCandidates(data.features ?? [], point, "microsoft");
}

/* ------------------------------------------------------------------ */
/* Combined raced resolver + short-lived cache                         */
/* ------------------------------------------------------------------ */

export interface ResolvedFootprints {
  candidates: FootprintCandidate[];
  /** which source family produced the winning candidates */
  provider: "osm" | "esri" | "none";
  /** true when the OSM transport failed entirely (all mirrors) */
  osmFailed: boolean;
  /** true when the Esri transport failed entirely (both services) */
  esriFailed: boolean;
  /** true when this result came from the in-memory cache */
  cached: boolean;
}

/** In-memory per-point cache. Footprints change on the timescale of years;
 * 6h TTL means a user re-opening the panel (or retrying after a flaky first
 * attempt) never re-hits throttled upstreams. Keyed to ~11m grid so tiny
 * pin jitter still hits. Bounded to 500 entries (FIFO eviction). */
const RESOLVE_CACHE = new Map<string, { at: number; value: ResolvedFootprints }>();
const RESOLVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RESOLVE_CACHE_MAX = 500;

function cacheKey(p: LatLng): string {
  return `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
}

/** test hook */
export function _clearResolveCache(): void {
  RESOLVE_CACHE.clear();
}

/* NEXT-3 (Jul 21) — persistent DB cache layer. Autoscale cold starts wipe the
 * in-memory map; footprints change on the timescale of YEARS. Successful
 * resolves are also written to geometry_resolve_cache (same ~11m grid key)
 * and consulted before hitting upstreams. 180-day TTL at read time. The DB
 * layer is injected (not imported) so this module stays dependency-free and
 * unit-testable without a database. Fail-open in both directions: a cache
 * read/write error never blocks a resolve. */
export interface PersistentResolveCache {
  get(gridKey: string): Promise<{ provider: "osm" | "esri" | "none"; candidates: FootprintCandidate[]; resolvedAt: number } | null>;
  put(gridKey: string, provider: "osm" | "esri" | "none", candidates: FootprintCandidate[]): Promise<void>;
}
let persistentCache: PersistentResolveCache | null = null;
export function setPersistentResolveCache(c: PersistentResolveCache | null): void {
  persistentCache = c;
}
export const PERSISTENT_RESOLVE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/**
 * Resolve footprints by racing BOTH source families in parallel:
 *   - OSM Overpass (itself a parallel mirror race) — richest tags, ODbL
 *   - Esri (FEMA USA Structures → MSBFP2) — LiDAR heights, reliable transport
 * OSM wins ties (height/levels tags + established ODbL flagging); Esri fills
 * in whenever OSM is throttled, slow, or has no building mapped. Neither
 * failing blocks the other; only a dual transport failure yields provider
 * "none" (caller then shows the prism estimate). Successful results are
 * cached ~6h per ~11m grid cell so retries never depend on upstream mood.
 */
export async function resolveFootprints(
  point: LatLng,
  opts: { osmFetcher?: OverpassFetcher; esriFetcher?: EsriFetcher; skipCache?: boolean } = {},
): Promise<ResolvedFootprints> {
  const key = cacheKey(point);
  if (!opts.skipCache) {
    const hit = RESOLVE_CACHE.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_CACHE_TTL_MS) {
      return { ...hit.value, cached: true };
    }
    // NEXT-3: persistent layer — survives cold starts. On hit, rehydrate the
    // in-memory map too so subsequent calls in this instance stay local.
    if (persistentCache) {
      try {
        const row = await persistentCache.get(key);
        if (row && Date.now() - row.resolvedAt < PERSISTENT_RESOLVE_TTL_MS) {
          const value: ResolvedFootprints = { candidates: row.candidates, provider: row.provider, osmFailed: false, esriFailed: false, cached: false };
          RESOLVE_CACHE.set(key, { at: row.resolvedAt, value });
          return { ...value, cached: true };
        }
      } catch {
        /* fail-open: cache trouble never blocks a resolve */
      }
    }
  }

  const osmP: Promise<FootprintCandidate[] | null> = fetchOsmFootprints(point, opts.osmFetcher ?? defaultOverpassFetch)
    .then((c) => c)
    .catch(() => null);
  const esriP: Promise<FootprintCandidate[] | null> = (
    opts.esriFetcher ? fetchEsriFootprints(point, opts.esriFetcher) : fetchEsriFootprints(point)
  ).catch(() => null);

  const [osm, esri] = await Promise.all([osmP, esriP]);
  const osmFailed = osm === null;
  const esriFailed = esri === null;

  let candidates: FootprintCandidate[] = [];
  let provider: ResolvedFootprints["provider"] = "none";
  if (osm && osm.length > 0) {
    candidates = osm;
    provider = "osm";
  } else if (esri && esri.length > 0) {
    candidates = esri;
    provider = "esri";
  }

  const value: ResolvedFootprints = { candidates, provider, osmFailed, esriFailed, cached: false };
  // Cache successes AND confirmed empty-with-both-sources-reachable results
  // (a genuinely unmapped building); never cache transport failures.
  if (provider !== "none" || (!osmFailed && !esriFailed)) {
    if (RESOLVE_CACHE.size >= RESOLVE_CACHE_MAX) {
      const oldest = RESOLVE_CACHE.keys().next().value;
      if (oldest != null) RESOLVE_CACHE.delete(oldest);
    }
    RESOLVE_CACHE.set(key, { at: Date.now(), value });
    // NEXT-3: write-through to the persistent layer (never on transport
    // failure — same rule as the in-memory cache). Fire-and-forget.
    if (persistentCache) {
      persistentCache.put(key, provider, candidates).catch(() => {
        /* fail-open */
      });
    }
  }
  return value;
}

/**
 * Full derivation bundle for a chosen footprint — everything the UI and the
 * dimensional-receipts panel need, computed from the ring + height.
 */
export function deriveGeometry(cand: FootprintCandidate, neighborShadingFactor = 1) {
  const heightM = cand.heightM ?? (cand.stories ?? 1) * 3.2;
  const orientationDeg = longestEdgeOrientationDeg(cand.ring);
  const wallAreas = exposedWallAreaByOrientation(cand.ring, heightM);
  const score = exposureScore(wallAreas, heightM, neighborShadingFactor);
  return {
    footprintSqft: cand.areaSqft,
    heightM,
    stories: cand.stories,
    orientationDeg: Math.round(orientationDeg * 10) / 10,
    exposedWallAreaByOrientation: wallAreas,
    exposureScore: score,
    heightSource: (cand.source !== "prism" && cand.heightM != null ? "footprint_dataset" : "stories_estimate") as
      | "footprint_dataset"
      | "stories_estimate",
    footprintSource: (cand.source === "prism" ? undefined : cand.source) as
      | "osm"
      | "microsoft"
      | "usa_structures"
      | "user_drawn"
      | undefined,
    odblDerived: cand.source === "osm",
  };
}
