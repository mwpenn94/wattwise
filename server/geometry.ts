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
  source: "osm" | "user_drawn" | "prism";
  osmId?: string;
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

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Injectable fetcher for tests. */
export type OverpassFetcher = (query: string) => Promise<{ elements: OverpassElement[] }>;

async function defaultOverpassFetch(query: string): Promise<{ elements: OverpassElement[] }> {
  let lastErr: unknown;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`Overpass ${ep} HTTP ${res.status}`);
      return (await res.json()) as { elements: OverpassElement[] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Overpass unavailable");
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
    footprintSource: (cand.source === "prism" ? undefined : cand.source) as "osm" | "user_drawn" | undefined,
    odblDerived: cand.source === "osm",
  };
}
