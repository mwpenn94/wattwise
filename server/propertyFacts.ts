/**
 * Property facts — automatic, in-app per-address enrichment (Oct 24 2026).
 *
 * Replaces the rejected outbound-link "property records" card. Users should
 * never be sent to another website to look something up: the app fetches what
 * free/public sources publish for the address, turns it into plain-language
 * facts with a source on every figure, and uses the floor-area estimate in
 * analysis with its basis disclosed (Honesty Charter).
 *
 * Sources (free, public, no credentials):
 *  - County assessor parcel GIS via an adapter registry (Mohave County, AZ
 *    first: official layer 38 "ParcelQueryLayer"). Parcel, owner of record,
 *    land use, land area, assessed value, tax year.
 *  - FEMA USA Structures (national): per-building footprint, occupancy class,
 *    situs address, height where measured.
 * CountyOffice.org is NOT a source: its terms forbid automated extraction and
 * commercial reuse. The same county records are read from the official source.
 *
 * Safety rules (settled from the KUSD 17-campus evidence run):
 *  - Buildings belong to a parcel only when their centroid is inside it.
 *  - "All buildings on the parcel" is used only for a single-address parcel
 *    matching the site, holding no other site of the owner, whose addressed
 *    buildings all carry the site's address. Otherwise only buildings that
 *    public records address to this site are counted.
 *  - Shared / mismatched parcels never yield a whole-parcel figure.
 *  - Unknown building height = one story, said out loud.
 *  - A floor area the user typed is never overwritten. An estimate is only
 *    written automatically in lifecycle hooks (bulk import, site creation,
 *    address change, backfill) and only when the site has no floor area yet.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "./db";
import { sitePropertyFacts, sites, type Site, type SitePropertyFacts } from "../drizzle/schema";

type LngLat = [number, number];
/** Injectable JSON fetcher (tests). `body` set = form-encoded POST. */
export type JsonFetcher = (url: string, body?: URLSearchParams) => Promise<unknown>;

const FETCH_UA = "Meterly/1.0 (property facts; https://meterly.manus.space)";
const TIMEOUT_MS = 12_000;
export const MOHAVE_PARCEL_LAYER = "https://mcgis.mohave.gov/arcgis/rest/services/Mohave/MapServer/38";
export const USA_STRUCTURES_LAYER =
  "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0";
const NEARBY_RADIUS_M = 200;
const MAX_STRUCTURES = 1000;
const FACTS_TTL_MS = 90 * 24 * 3600 * 1000;
const UNAVAILABLE_RETRY_MS = 10 * 60 * 1000;
export const ESTIMATE_MIN_SQFT = 200;
export const ESTIMATE_MAX_SQFT = 5_000_000;
export const PROPERTY_FACTS_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */
export type PropertySourceId = "mohave_assessor_gis" | "fema_usa_structures";
export interface PropertySource {
  id: PropertySourceId;
  label: string;
  publisher: string;
  url: string;
  terms: string;
}
export const PROPERTY_SOURCES: Record<PropertySourceId, PropertySource> = {
  mohave_assessor_gis: {
    id: "mohave_assessor_gis",
    label: "Mohave County Assessor parcel records",
    publisher: "Mohave County (official county GIS)",
    url: "https://www.arcgis.com/home/item.html?id=e47d94a4bcae402f8236c93d3b86834c",
    terms: "Public county data for general reference, provided without warranty.",
  },
  fema_usa_structures: {
    id: "fema_usa_structures",
    label: "USA Structures",
    publisher: "FEMA with Oak Ridge National Laboratory",
    url: "https://gis-fema.hub.arcgis.com/pages/usa-structures",
    terms: "Public federal building inventory; footprints are machine-extracted from aerial imagery.",
  },
};

let fetcherOverride: JsonFetcher | null = null;
/** Tests inject a fetcher; production uses the network. */
export function setPropertyFactsFetcher(fetcher: JsonFetcher | null) {
  fetcherOverride = fetcher;
}
function networkDisabled() {
  return Boolean(process.env.VITEST) || process.env.PROPERTY_FACTS_NETWORK === "off";
}
/** Background hooks are no-ops when no network is possible (tests). */
export function propertyFactsNetworkAvailable() {
  return fetcherOverride != null || !networkDisabled();
}
async function networkFetch(url: string, body?: URLSearchParams): Promise<unknown> {
  if (networkDisabled()) throw new Error("Property-facts network access is disabled in this environment");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: {
          "User-Agent": FETCH_UA,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: body?.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Property-facts request failed");
}
function activeFetcher(): JsonFetcher {
  return fetcherOverride ?? networkFetch;
}
type ArcFeature = { attributes?: Record<string, unknown>; geometry?: { rings?: unknown } };
function arcFeatures(data: unknown): { features: ArcFeature[]; exceeded: boolean } {
  if (!data || typeof data !== "object") throw new Error("Malformed ArcGIS response");
  const d = data as { error?: unknown; features?: unknown; exceededTransferLimit?: unknown };
  if (d.error) throw new Error("ArcGIS service error");
  if (!Array.isArray(d.features)) throw new Error("ArcGIS response has no features array");
  return { features: d.features as ArcFeature[], exceeded: d.exceededTransferLimit === true };
}

/* ------------------------------------------------------------------ */
/* Address normalization                                               */
/* ------------------------------------------------------------------ */
const DIRECTIONS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "NORTH", "SOUTH", "EAST", "WEST", "NORTHEAST", "NORTHWEST", "SOUTHEAST", "SOUTHWEST"]);
const SUFFIXES = new Set([
  "ST", "STREET", "AVE", "AVENUE", "AV", "RD", "ROAD", "DR", "DRIVE", "BLVD", "BOULEVARD", "LN", "LANE", "CT", "COURT", "WAY",
  "PL", "PLACE", "HWY", "HIGHWAY", "PKWY", "PARKWAY", "CIR", "CIRCLE", "TRL", "TRAIL", "TER", "TERRACE", "LOOP", "SQ", "PLZ",
]);
const ORDINALS: Record<string, string> = {
  FIRST: "1ST", SECOND: "2ND", THIRD: "3RD", FOURTH: "4TH", FIFTH: "5TH", SIXTH: "6TH", SEVENTH: "7TH", EIGHTH: "8TH", NINTH: "9TH", TENTH: "10TH",
};
const UNIT_MARKERS = new Set(["#", "STE", "SUITE", "UNIT", "APT", "BLDG", "BUILDING", "RM", "ROOM", "SPC", "SPACE"]);
export interface AddressKey {
  numbers: string[];
  core: string;
  /** situs flagged as multiple addresses (MLTPL) without listing them */
  mltpl: boolean;
  /** more than one address (explicit list or MLTPL) */
  multi: boolean;
}
/** House number(s) + street-name core; directionals, the trailing street type,
 * unit designators and city/state are ignored ("4182 N Bank St" ≡ "4182 NORTH
 * BANK STREET"). Returns null without a leading house number. */
export function addressKey(raw: string | null | undefined): AddressKey | null {
  if (!raw) return null;
  const line = raw.split(",")[0].toUpperCase();
  const mltpl = /\bMLTPL\b|\bMULTIPLE\b/.test(line);
  const tokens = line
    .replace(/[^A-Z0-9&# ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && t !== "MLTPL" && t !== "MULTIPLE");
  const numbers: string[] = [];
  let i = 0;
  while (i < tokens.length && (/^\d+[A-Z]?$/.test(tokens[i]) || tokens[i] === "&" || tokens[i] === "AND")) {
    const digits = tokens[i].match(/^\d+/);
    if (digits) numbers.push(digits[0]);
    i++;
  }
  if (numbers.length === 0) return null;
  const rest: string[] = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (UNIT_MARKERS.has(t) || t.startsWith("#")) break;
    if (DIRECTIONS.has(t)) continue;
    rest.push(ORDINALS[t] ?? t);
  }
  if (rest.length > 1 && SUFFIXES.has(rest[rest.length - 1])) rest.pop();
  const core = rest.join("");
  if (!core) return null;
  return { numbers, core, mltpl, multi: mltpl || numbers.length > 1 };
}
export function sameAddress(a: AddressKey | null, b: AddressKey | null): boolean {
  return a != null && b != null && a.core === b.core && a.numbers.some((n) => b.numbers.includes(n));
}
export type ParcelRelation = "match" | "multi_includes" | "multi" | "no_situs" | "mismatch";
export function parcelRelation(siteKey: AddressKey | null, situs: string | null | undefined): ParcelRelation {
  const parcelKey = addressKey(situs);
  if (!parcelKey) return "no_situs";
  if (sameAddress(siteKey, parcelKey)) return parcelKey.multi ? "multi_includes" : "match";
  // A multi-address parcel on the same street ("3500 & 3700 Prospector" for a
  // site at 3550 Prospector) is a shared campus parcel, not a wrong pin.
  if (parcelKey.mltpl || (parcelKey.multi && siteKey != null && parcelKey.core === siteKey.core)) return "multi";
  return "mismatch";
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */
export function pointInRings(lng: number, lat: number, rings: LngLat[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function parseRings(raw: unknown): LngLat[][] | null {
  if (!Array.isArray(raw)) return null;
  const rings: LngLat[][] = [];
  for (const ring of raw) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const pts: LngLat[] = [];
    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) return null;
      const [lng, lat] = [Number(p[0]), Number(p[1])];
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      pts.push([lng, lat]);
    }
    rings.push(pts);
  }
  return rings.length ? rings : null;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */
const KEEP_UPPER = new Set(["LLC", "LP", "LLP", "INC", "USA", "US", "II", "III", "IV", "HOA", "PC", "PLLC", "AZ", "KY", "NA"]);
const EXPAND: Record<string, string> = { MUNI: "Municipal", DIST: "District", SCH: "School", PROP: "Property", CO: "Co." };
export function titleCase(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => {
      const up = w.toUpperCase();
      if (KEEP_UPPER.has(up) || /\d/.test(w)) return up;
      if (EXPAND[up]) return EXPAND[up];
      return up.charAt(0) + up.slice(1).toLowerCase();
    })
    .join(" ");
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
export function formatUsd(v: number): string {
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3).toLocaleString("en-US")}K`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}
export function roundEstimate(sqft: number): number {
  return sqft >= 1000 ? Math.round(sqft / 100) * 100 : Math.round(sqft / 10) * 10;
}

/* ------------------------------------------------------------------ */
/* County parcel adapters                                              */
/* ------------------------------------------------------------------ */
export interface ParcelHit {
  sourceId: PropertySourceId;
  parcelId: string;
  situsAddress: string | null;
  owner: string | null;
  useCode: string | null;
  useLabel: string | null;
  landAcres: number | null;
  fullCashValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  taxYear: number | null;
  assessmentClass: string | null;
  rings: LngLat[][];
}
interface CountyAdapter {
  id: PropertySourceId;
  covers(point: { lat: number; lng: number }, state: string | null): boolean;
  fetchParcel(point: { lat: number; lng: number }, fetcher: JsonFetcher): Promise<ParcelHit | null>;
}
function splitUseCode(raw: string | null): { code: string | null; label: string | null } {
  if (!raw) return { code: null, label: null };
  const m = raw.match(/^(\d+)\s*-\s*(.+)$/);
  return m ? { code: m[1], label: titleCase(m[2]) } : { code: null, label: titleCase(raw) };
}
const mohaveAdapter: CountyAdapter = {
  id: "mohave_assessor_gis",
  // Layer extent (EPSG:3857) converted to lon/lat; a point near the edge that
  // is not in Mohave simply returns no parcel and falls back to FEMA only.
  covers: (p, state) => (state == null || state.toUpperCase() === "AZ") && p.lat >= 34.2 && p.lat <= 37.01 && p.lng >= -114.76 && p.lng <= -112.52,
  async fetchParcel(p, fetcher) {
    const params = new URLSearchParams({
      geometry: `${p.lng},${p.lat}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "PARCEL,SITE_ADDRESS,OWNER,USE_CODE,PARCEL_SIZE,UNIT_TYPE,FULL_CASH_VALUE,LANDVALUE,IMPVALUE,TAX_YEAR,CLASS_CODE",
      returnGeometry: "true",
      geometryPrecision: "6",
      f: "json",
    });
    const { features } = arcFeatures(await fetcher(`${MOHAVE_PARCEL_LAYER}/query?${params.toString()}`));
    for (const f of features) {
      const a = f.attributes ?? {};
      const parcelId = str(a.PARCEL);
      const rings = parseRings(f.geometry?.rings);
      if (!parcelId || !rings) continue;
      const use = splitUseCode(str(a.USE_CODE));
      const unit = (str(a.UNIT_TYPE) ?? "ACRES").toUpperCase();
      const size = num(a.PARCEL_SIZE);
      return {
        sourceId: "mohave_assessor_gis",
        parcelId,
        situsAddress: str(a.SITE_ADDRESS),
        owner: str(a.OWNER),
        useCode: use.code,
        useLabel: use.label,
        landAcres: size != null && size > 0 ? (unit.startsWith("SQ") ? size / 43_560 : size) : null,
        fullCashValue: num(a.FULL_CASH_VALUE),
        landValue: num(a.LANDVALUE),
        improvementValue: num(a.IMPVALUE),
        taxYear: num(a.TAX_YEAR),
        assessmentClass: str(a.CLASS_CODE),
        rings,
      };
    }
    return null;
  },
};
const COUNTY_ADAPTERS: CountyAdapter[] = [mohaveAdapter];
export function countyAdapterFor(point: { lat: number; lng: number }, state: string | null): CountyAdapter | null {
  return COUNTY_ADAPTERS.find((a) => a.covers(point, state)) ?? null;
}

/* ------------------------------------------------------------------ */
/* FEMA USA Structures                                                 */
/* ------------------------------------------------------------------ */
export interface StructureRecord {
  id: string;
  footprintSqft: number;
  occupancyClass: string | null;
  primaryOccupancy: string | null;
  address: string | null;
  heightM: number | null;
  lat: number | null;
  lng: number | null;
  prodDate: number | null;
  method: string | null;
}
const STRUCTURE_FIELDS = "BUILD_ID,OBJECTID,OCC_CLS,PRIM_OCC,PROP_ADDR,SQFEET,HEIGHT,LATITUDE,LONGITUDE,PROD_DATE,VAL_METHOD";
function parseStructures(features: ArcFeature[]): StructureRecord[] {
  const out: StructureRecord[] = [];
  for (const f of features) {
    const a = f.attributes ?? {};
    const sq = num(a.SQFEET);
    const id = a.BUILD_ID ?? a.OBJECTID;
    if (sq == null || sq <= 0 || id == null) continue;
    const h = num(a.HEIGHT);
    out.push({
      id: String(id),
      footprintSqft: sq,
      occupancyClass: str(a.OCC_CLS),
      primaryOccupancy: str(a.PRIM_OCC),
      address: str(a.PROP_ADDR),
      heightM: h != null && h > 0 ? h : null,
      lat: num(a.LATITUDE),
      lng: num(a.LONGITUDE),
      prodDate: num(a.PROD_DATE),
      method: str(a.VAL_METHOD),
    });
  }
  return out;
}
async function fetchStructuresInPolygon(rings: LngLat[][], fetcher: JsonFetcher) {
  const body = new URLSearchParams({
    geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: STRUCTURE_FIELDS,
    returnGeometry: "false",
    resultRecordCount: String(MAX_STRUCTURES),
    f: "json",
  });
  const { features, exceeded } = arcFeatures(await fetcher(`${USA_STRUCTURES_LAYER}/query`, body));
  return { structures: parseStructures(features), exceeded };
}
async function fetchStructuresNear(point: { lat: number; lng: number }, fetcher: JsonFetcher) {
  const params = new URLSearchParams({
    geometry: `${point.lng},${point.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(NEARBY_RADIUS_M),
    units: "esriSRUnit_Meter",
    outFields: STRUCTURE_FIELDS,
    returnGeometry: "false",
    resultRecordCount: String(MAX_STRUCTURES),
    f: "json",
  });
  const { features, exceeded } = arcFeatures(await fetcher(`${USA_STRUCTURES_LAYER}/query?${params.toString()}`));
  return { structures: parseStructures(features), exceeded };
}

/* ------------------------------------------------------------------ */
/* Floor-area estimate                                                 */
/* ------------------------------------------------------------------ */
const RESIDENTIAL_TYPES = new Set(["single_family", "multifamily"]);
const EXPECTED_CLASS: Record<string, string> = {
  school: "Education",
  office: "Commercial",
  retail: "Commercial",
  restaurant: "Commercial",
  grocery: "Commercial",
  hotel: "Commercial",
  warehouse: "Industrial",
  manufacturing: "Industrial",
  municipal: "Government",
  single_family: "Residential",
  multifamily: "Residential",
};
export function expectedOccupancyClass(buildingType: string | null | undefined): string | null {
  return buildingType ? EXPECTED_CLASS[buildingType] ?? null : null;
}
/** Conservative stories: unknown height = 1. A measured height only adds
 * floors when it clearly exceeds a tall single story (gyms, warehouses). */
export function storiesFor(heightM: number | null, residential: boolean): number {
  if (heightM == null) return 1;
  if (residential) return heightM >= 6 ? Math.max(1, Math.round(heightM / 3)) : 1;
  return heightM >= 8 ? Math.max(1, Math.floor(heightM / 4)) : 1;
}
export type EstimateBasis = "parcel_all_buildings" | "address_matched_buildings" | "occupancy_matched_buildings";
export interface StructureFact {
  id: string;
  footprintSqft: number;
  occupancy: string | null;
  occupancyClass: string | null;
  address: string | null;
  heightM: number | null;
  stories: number;
}
export interface FloorAreaEstimate {
  sqft: number;
  rawSqft: number;
  basis: EstimateBasis;
  buildingCount: number;
  storiesBasis: "one_story_assumed" | "measured_height" | "mixed";
  excludedCount: number;
  method: string;
  /** data-quality gate for automatic use; site-state gates apply at apply time */
  autoApplyAllowed: boolean;
  blockers: string[];
}
export interface OtherSiteRef {
  id: number;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}
function occupancyText(s: StructureRecord): string | null {
  if (!s.occupancyClass && !s.primaryOccupancy) return null;
  if (s.occupancyClass && s.primaryOccupancy) return `${s.occupancyClass} — ${s.primaryOccupancy}`;
  return s.occupancyClass ?? s.primaryOccupancy;
}
function toFact(s: StructureRecord, residential: boolean): StructureFact {
  return {
    id: s.id,
    footprintSqft: Math.round(s.footprintSqft),
    occupancy: occupancyText(s),
    occupancyClass: s.occupancyClass,
    address: s.address,
    heightM: s.heightM,
    stories: storiesFor(s.heightM, residential),
  };
}
export function estimateFloorArea(input: {
  siteKey: AddressKey | null;
  siteAddressLabel: string;
  buildingType: string | null;
  parcel: { parcelId: string; relation: ParcelRelation; shared: boolean } | null;
  inParcel: StructureRecord[];
  all: StructureRecord[];
  parcelTruncated: boolean;
  duplicateSiteNames: string[];
}): { estimate: FloorAreaEstimate | null; counted: StructureFact[]; reason: string | null } {
  const residentialSite = input.buildingType != null && RESIDENTIAL_TYPES.has(input.buildingType);
  const expected = expectedOccupancyClass(input.buildingType);
  const matched = input.all.filter((s) => sameAddress(addressKey(s.address), input.siteKey));
  let basis: EstimateBasis | null = null;
  let chosen: StructureRecord[] = [];
  let excluded = 0;
  const p = input.parcel;
  const addressedInParcel = input.inParcel.filter((s) => addressKey(s.address) != null);
  if (
    p && p.relation === "match" && !p.shared && !input.parcelTruncated && input.inParcel.length > 0 &&
    addressedInParcel.every((s) => sameAddress(addressKey(s.address), input.siteKey))
  ) {
    basis = "parcel_all_buildings";
    const byId = new Map<string, StructureRecord>();
    for (const s of [...input.inParcel, ...matched]) byId.set(s.id, s);
    const pool = Array.from(byId.values());
    // A non-residential site never counts residential-class structures that
    // merely share its parcel (caretaker homes etc.).
    chosen = residentialSite ? pool : pool.filter((s) => s.occupancyClass !== "Residential" || addressKey(s.address) != null);
    excluded = pool.length - chosen.length;
  } else if (matched.length > 0) {
    basis = "address_matched_buildings";
    chosen = matched;
    if (p) excluded = input.inParcel.filter((s) => !matched.some((m) => m.id === s.id)).length;
  } else if (p && !p.shared && (p.relation === "no_situs" || p.relation === "match") && expected && !input.parcelTruncated) {
    const occ = input.inParcel.filter((s) => s.occupancyClass === expected && addressKey(s.address) == null);
    if (occ.length > 0) {
      basis = "occupancy_matched_buildings";
      chosen = occ;
      excluded = input.inParcel.length - occ.length;
    }
  }
  if (!basis || chosen.length === 0) {
    const reason = !p && input.all.length === 0
      ? "No public building records were found near this address."
      : p && (p.relation === "multi" || p.relation === "multi_includes" || p.shared)
        ? "This property shares its parcel with other addresses, and no building is addressed to this site in public records — a whole-parcel figure would double count."
        : p && p.relation === "mismatch"
          ? "The map pin lands on a parcel recorded under a different address, and no nearby building is addressed to this site."
          : "No building in public records carries this street address.";
    return { estimate: null, counted: [], reason };
  }
  const counted = chosen.map((s) => toFact(s, residentialSite)).sort((a, b) => b.footprintSqft - a.footprintSqft);
  const rawSqft = counted.reduce((sum, s) => sum + s.footprintSqft * s.stories, 0);
  const heights = counted.filter((s) => s.heightM != null).length;
  const storiesBasis = heights === 0 ? "one_story_assumed" : heights === counted.length ? "measured_height" : "mixed";
  if (rawSqft < ESTIMATE_MIN_SQFT || rawSqft > ESTIMATE_MAX_SQFT) {
    return { estimate: null, counted, reason: `The public-record total (${Math.round(rawSqft).toLocaleString("en-US")} sqft) is outside a plausible range for one site, so it isn't used.` };
  }
  const n = counted.length;
  const bldg = `${n} building${n === 1 ? "" : "s"}`;
  const storyText = storiesBasis === "one_story_assumed"
    ? "counting each as one story because public records list no building heights — multi-story buildings would make the true floor area larger"
    : storiesBasis === "measured_height"
      ? "with stories inferred conservatively from measured building heights"
      : "counting buildings without a measured height as one story";
  const method = basis === "parcel_all_buildings"
    ? `Sum of the ground footprints of all ${bldg} on parcel ${p!.parcelId}, ${storyText}.`
    : basis === "address_matched_buildings"
      ? `Sum of the ground footprints of the ${bldg} that public records address to ${input.siteAddressLabel}, ${storyText}.${excluded > 0 ? ` ${excluded} other building${excluded === 1 ? "" : "s"} on the same parcel carry other addresses and are not counted.` : ""}`
      : `The county parcel record lists no street address, so this counts the ${bldg} on the parcel under your map pin that public records classify as ${expected?.toLowerCase()}, ${storyText}.`;
  const blockers: string[] = [];
  if (basis === "occupancy_matched_buildings") blockers.push("Buildings were matched by use class, not by address.");
  if (input.duplicateSiteNames.length > 0) {
    blockers.push(`Another of your sites (${input.duplicateSiteNames.slice(0, 2).join(", ")}) has the same street address, so using this figure could double count floor area.`);
  }
  if (!residentialSite && counted.some((s) => s.occupancyClass === "Residential")) {
    blockers.push("Some counted buildings are classified as residential, which does not fit this site's building type.");
  }
  return {
    estimate: {
      sqft: roundEstimate(rawSqft),
      rawSqft: Math.round(rawSqft),
      basis,
      buildingCount: n,
      storiesBasis,
      excludedCount: excluded,
      method,
      autoApplyAllowed: blockers.length === 0,
      blockers,
    },
    counted,
    reason: null,
  };
}

/* ------------------------------------------------------------------ */
/* Compute                                                             */
/* ------------------------------------------------------------------ */
export interface ParcelFacts {
  sourceId: PropertySourceId;
  parcelId: string;
  situsAddress: string | null;
  owner: string | null;
  useCode: string | null;
  useLabel: string | null;
  landAcres: number | null;
  fullCashValue: number | null;
  landValue: number | null;
  improvementValue: number | null;
  taxYear: number | null;
  assessmentClass: string | null;
  relation: ParcelRelation;
  shared: boolean;
  sharedWithSiteIds: number[];
}
export interface PropertyFactsResult {
  version: number;
  status: "ok" | "partial" | "no_location" | "unavailable";
  point: { lat: number; lng: number; source: "site_pin" | "geocoded" } | null;
  parcel: ParcelFacts | null;
  parcelMismatch: { parcelId: string; situsAddress: string | null; otherSiteIds: number[] } | null;
  structures: {
    counted: StructureFact[];
    parcelTotal: { count: number; footprintSqft: number } | null;
    nearbyOtherAddresses: string[];
    truncated: boolean;
    vintageYear: number | null;
    method: string | null;
  } | null;
  estimate: FloorAreaEstimate | null;
  noEstimateReason: string | null;
  typeCheck: { expectedClass: string; recordClass: string; consistent: boolean } | null;
  cautions: string[];
  sourcesUsed: PropertySourceId[];
  sourceErrors: PropertySourceId[];
  fetchedAt: number;
  inputKey: string;
}
export interface ComputeInput {
  site: Pick<Site, "id" | "address" | "state" | "buildingType"> & Partial<Pick<Site, "isHypothetical">>;
  point: { lat: number; lng: number; source: "site_pin" | "geocoded" } | null;
  otherSites: OtherSiteRef[];
  fetcher?: JsonFetcher;
  now?: number;
}
function prettyAddress(raw: string | null | undefined): string {
  const line = (raw ?? "").split(",")[0].trim();
  return line ? titleCase(line) : "this address";
}
export async function computePropertyFacts(input: ComputeInput): Promise<PropertyFactsResult> {
  const fetcher = input.fetcher ?? activeFetcher();
  const fetchedAt = input.now ?? Date.now();
  const base: PropertyFactsResult = {
    version: PROPERTY_FACTS_VERSION,
    status: "no_location",
    point: input.point,
    parcel: null,
    parcelMismatch: null,
    structures: null,
    estimate: null,
    noEstimateReason: null,
    typeCheck: null,
    cautions: [],
    sourcesUsed: [],
    sourceErrors: [],
    fetchedAt,
    inputKey: factsInputKey(input.site),
  };
  const siteKey = addressKey(input.site.address);
  if (!input.point || !siteKey) {
    base.noEstimateReason = !siteKey
      ? "This site has no street address, so public records can't be matched to it."
      : "This address couldn't be placed on the map precisely enough to match public records.";
    return base;
  }
  const point = input.point;
  const adapter = countyAdapterFor(point, input.site.state ?? null);
  let parcelHit: ParcelHit | null = null;
  if (adapter) {
    try {
      parcelHit = await adapter.fetchParcel(point, fetcher);
      base.sourcesUsed.push(adapter.id);
    } catch {
      base.sourceErrors.push(adapter.id);
    }
  }
  const [inPoly, near] = await Promise.allSettled([
    parcelHit ? fetchStructuresInPolygon(parcelHit.rings, fetcher) : Promise.resolve({ structures: [] as StructureRecord[], exceeded: false }),
    fetchStructuresNear(point, fetcher),
  ]);
  const femaOk = near.status === "fulfilled" || (parcelHit != null && inPoly.status === "fulfilled");
  if (femaOk) base.sourcesUsed.push("fema_usa_structures");
  else base.sourceErrors.push("fema_usa_structures");
  if (!femaOk && !parcelHit) {
    base.status = "unavailable";
    base.noEstimateReason = "Public property records could not be reached right now.";
    return base;
  }
  const byId = new Map<string, StructureRecord>();
  let truncated = false;
  for (const r of [inPoly, near]) {
    if (r.status !== "fulfilled") continue;
    truncated = truncated || r.value.exceeded;
    for (const s of r.value.structures) byId.set(s.id, s);
  }
  const all = Array.from(byId.values());
  const otherPinsInParcel = parcelHit
    ? input.otherSites.filter((o) => o.lat != null && o.lng != null && pointInRings(o.lng, o.lat, parcelHit!.rings)).map((o) => o.id)
    : [];
  const inParcel = parcelHit
    ? all.filter((s) => s.lat != null && s.lng != null && pointInRings(s.lng, s.lat, parcelHit!.rings))
    : [];
  const parcelTruncated = parcelHit != null && inPoly.status === "fulfilled" && inPoly.value.exceeded;
  let relation: ParcelRelation | null = null;
  if (parcelHit) {
    relation = parcelRelation(siteKey, parcelHit.situsAddress);
    const shared = relation === "multi" || relation === "multi_includes" || otherPinsInParcel.length > 0;
    if (relation === "mismatch") {
      base.parcelMismatch = { parcelId: parcelHit.parcelId, situsAddress: parcelHit.situsAddress, otherSiteIds: otherPinsInParcel };
      const others = otherPinsInParcel.length > 0 ? ` — the same parcel as another of your sites` : "";
      base.cautions.push(
        `The map pin for this site lands on parcel ${parcelHit.parcelId}, recorded as ${prettyAddress(parcelHit.situsAddress)}${others}. Its county record is not shown as this site's. If the pin is off, move it on the footprint map.`,
      );
    } else {
      const { rings: _rings, ...rest } = parcelHit;
      base.parcel = { ...rest, relation, shared, sharedWithSiteIds: otherPinsInParcel };
      if (shared) {
        base.cautions.push(
          `Parcel ${parcelHit.parcelId}${parcelHit.situsAddress ? ` (${prettyAddress(parcelHit.situsAddress)}${relation === "multi" || relation === "multi_includes" ? ", multiple addresses" : ""})` : ""} is shared${otherPinsInParcel.length ? " with another of your sites" : " by more than one address"}. Its land area and assessed value describe the whole parcel, not just this building.`,
        );
      }
      if (relation === "no_situs") {
        base.cautions.push(`The county record for parcel ${parcelHit.parcelId} lists no street address; it is the parcel under this site's map pin.`);
      }
    }
  } else if (adapter && !base.sourceErrors.includes(adapter.id)) {
    base.cautions.push("No county parcel contains this site's map pin (it may sit on a road or right-of-way), so parcel details aren't available.");
  }
  const duplicateSiteNames = input.otherSites.filter((o) => sameAddress(addressKey(o.address), siteKey)).map((o) => o.name);
  const est = estimateFloorArea({
    siteKey,
    siteAddressLabel: prettyAddress(input.site.address),
    buildingType: input.site.buildingType ?? null,
    parcel: base.parcel ? { parcelId: base.parcel.parcelId, relation: base.parcel.relation, shared: base.parcel.shared } : null,
    inParcel: base.parcel ? inParcel : [],
    all,
    parcelTruncated,
    duplicateSiteNames,
  });
  base.estimate = est.estimate;
  base.noEstimateReason = est.reason;
  const prodYears = est.counted
    .map((c) => byId.get(c.id)?.prodDate)
    .filter((d): d is number => d != null)
    .map((d) => new Date(d).getUTCFullYear());
  const methods = new Set(est.counted.map((c) => byId.get(c.id)?.method).filter((m): m is string => !!m));
  const otherAddressCounts = new Map<string, number>();
  for (const s of all) {
    const k = addressKey(s.address);
    if (!k || sameAddress(k, siteKey) || s.occupancyClass === "Residential") continue;
    const label = prettyAddress(s.address);
    otherAddressCounts.set(label, (otherAddressCounts.get(label) ?? 0) + 1);
  }
  base.structures = {
    counted: est.counted.slice(0, 40),
    parcelTotal: base.parcel ? { count: inParcel.length, footprintSqft: Math.round(inParcel.reduce((s, x) => s + x.footprintSqft, 0)) } : null,
    nearbyOtherAddresses: Array.from(otherAddressCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k),
    truncated,
    vintageYear: prodYears.length ? Math.max(...prodYears) : null,
    method: methods.size === 1 ? Array.from(methods)[0] : methods.size > 1 ? "Mixed" : null,
  };
  const expected = expectedOccupancyClass(input.site.buildingType);
  if (expected && est.counted.length > 0) {
    const counts = new Map<string, number>();
    for (const c of est.counted) if (c.occupancyClass && c.occupancyClass !== "Unclassified") counts.set(c.occupancyClass, (counts.get(c.occupancyClass) ?? 0) + 1);
    const dominant = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dominant) {
      base.typeCheck = { expectedClass: expected, recordClass: dominant, consistent: dominant === expected };
      if (dominant !== expected) {
        if (base.estimate) {
          base.estimate = {
            ...base.estimate,
            autoApplyAllowed: false,
            blockers: [...base.estimate.blockers, `Public records classify these buildings as ${dominant.toLowerCase()}, not ${expected.toLowerCase()}.`],
          };
        }
        base.cautions.push(
          `Public records classify these buildings as ${dominant.toLowerCase()}, but this site is set as ${(input.site.buildingType ?? "").replace(/_/g, " ")}. If the building type is wrong, update it — it changes benchmark peers.`,
        );
      }
    }
  }
  base.status = base.sourceErrors.length > 0 || (adapter != null && !parcelHit) || !adapter ? "partial" : "ok";
  if (!adapter && base.status === "partial") {
    // Not an error: no county adapter yet for this location. FEMA still applies.
    base.status = femaOk ? "ok" : "partial";
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Persistence + lifecycle                                             */
/* ------------------------------------------------------------------ */
async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}
export async function getPropertyFactsRow(siteId: number): Promise<SitePropertyFacts | null> {
  const db = await requireDb();
  const [row] = await db.select().from(sitePropertyFacts).where(eq(sitePropertyFacts.siteId, siteId)).limit(1);
  return row ?? null;
}
function isFresh(row: SitePropertyFacts, site: Site, now: number): boolean {
  if (row.locationRevision !== site.locationRevision) return false;
  const facts = row.facts as PropertyFactsResult | null;
  if (!facts || facts.version !== PROPERTY_FACTS_VERSION) return false;
  if (facts.inputKey !== factsInputKey(site)) return false;
  const ttl = row.status === "unavailable" ? UNAVAILABLE_RETRY_MS : FACTS_TTL_MS;
  return now - row.fetchedAt < ttl;
}
/** Facts depend on the address and building type (matching + type check). */
export function factsInputKey(site: Pick<Site, "address" | "buildingType">): string {
  return `${(site.address ?? "").trim().toUpperCase()}|${site.buildingType ?? ""}`;
}
type Geocoder = (site: Site) => Promise<{ lat: number; lng: number } | null>;
async function defaultGeocoder(site: Site): Promise<{ lat: number; lng: number } | null> {
  if (!site.address?.trim() || networkDisabled()) return null;
  const { geocodeAddress } = await import("./places");
  const g = await geocodeAddress([site.address, site.city, site.state, site.zip].filter(Boolean).join(", "), {
    city: site.city,
    state: site.state,
    zip: site.zip,
  });
  return g.kind === "precise" ? { lat: g.lat, lng: g.lng } : null;
}
let geocoderOverride: Geocoder | null = null;
export function setPropertyFactsGeocoder(g: Geocoder | null) {
  geocoderOverride = g;
}
const inflight = new Map<number, Promise<SitePropertyFacts | null>>();
/**
 * Compute (or reuse) the current facts for a site and persist them. Callers
 * authorize. `allowAutoApply` is only passed by lifecycle hooks/backfill.
 */
export async function refreshPropertyFacts(
  siteId: number,
  opts: { allowAutoApply?: boolean; force?: boolean } = {},
): Promise<SitePropertyFacts | null> {
  const existing = inflight.get(siteId);
  if (existing) {
    const row = await existing;
    if (opts.allowAutoApply && row) await maybeAutoApply(siteId);
    return getPropertyFactsRow(siteId);
  }
  const job = (async () => {
    const db = await requireDb();
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return null;
    const now = Date.now();
    const current = await getPropertyFactsRow(siteId);
    if (!opts.force && current && isFresh(current, site, now)) return current;
    let point: ComputeInput["point"] = null;
    if (site.lat != null && site.lng != null) point = { lat: site.lat, lng: site.lng, source: "site_pin" };
    else if (site.address?.trim() && propertyFactsNetworkAvailable()) {
      try {
        const g = await (geocoderOverride ?? defaultGeocoder)(site);
        if (g) point = { ...g, source: "geocoded" };
      } catch {
        point = null;
      }
    }
    const others = await db
      .select({ id: sites.id, name: sites.name, address: sites.address, lat: sites.lat, lng: sites.lng })
      .from(sites)
      .where(and(eq(sites.userId, site.userId), ne(sites.id, site.id)));
    const result = propertyFactsNetworkAvailable() || point == null
      ? await computePropertyFacts({ site, point, otherSites: others })
      : { ...(await computePropertyFacts({ site, point: null, otherSites: [] })), status: "unavailable" as const };
    // Compare-and-set on the location revision: a concurrent address change
    // makes this result stale, so it is not persisted.
    const [after] = await db.select({ rev: sites.locationRevision }).from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!after || after.rev !== site.locationRevision) return getPropertyFactsRow(siteId);
    const sameRevision = current != null && current.locationRevision === site.locationRevision;
    const values = {
      siteId,
      userId: site.userId,
      locationRevision: site.locationRevision,
      status: result.status,
      facts: result,
      estimateSqft: result.estimate?.sqft ?? null,
      estimateBasis: result.estimate?.basis ?? null,
      appliedSqft: sameRevision ? current!.appliedSqft : null,
      appliedBy: sameRevision ? current!.appliedBy : null,
      appliedAt: sameRevision ? current!.appliedAt : null,
      fetchedAt: result.fetchedAt,
    };
    // A failed refresh never discards previously good facts for this revision.
    if (result.status === "unavailable" && sameRevision && current!.status !== "unavailable") {
      await db.update(sitePropertyFacts).set({ fetchedAt: now - FACTS_TTL_MS + UNAVAILABLE_RETRY_MS }).where(eq(sitePropertyFacts.siteId, siteId));
      return getPropertyFactsRow(siteId);
    }
    await db.insert(sitePropertyFacts).values(values).onDuplicateKeyUpdate({
      set: {
        userId: values.userId,
        locationRevision: values.locationRevision,
        status: values.status,
        facts: values.facts,
        estimateSqft: values.estimateSqft,
        estimateBasis: values.estimateBasis,
        appliedSqft: values.appliedSqft,
        appliedBy: values.appliedBy,
        appliedAt: values.appliedAt,
        fetchedAt: values.fetchedAt,
      },
    });
    return getPropertyFactsRow(siteId);
  })();
  inflight.set(siteId, job);
  try {
    await job;
  } finally {
    inflight.delete(siteId);
  }
  if (opts.allowAutoApply) await maybeAutoApply(siteId);
  return getPropertyFactsRow(siteId);
}
export type AutoApplyDecision = { eligible: true } | { eligible: false; reason: string };
export function autoApplyDecision(
  site: Pick<Site, "sqft" | "buildingType" | "tenure" | "isHypothetical" | "locationRevision">,
  row: Pick<SitePropertyFacts, "locationRevision" | "appliedSqft" | "estimateSqft"> & { facts: unknown },
): AutoApplyDecision {
  const facts = row.facts as PropertyFactsResult | null;
  const est = facts?.estimate;
  if (row.locationRevision !== site.locationRevision) return { eligible: false, reason: "facts are for a previous location" };
  if (!est || row.estimateSqft == null) return { eligible: false, reason: "no estimate" };
  if (!est.autoApplyAllowed) return { eligible: false, reason: est.blockers[0] ?? "estimate needs review" };
  if (site.isHypothetical) return { eligible: false, reason: "hypothetical site" };
  if (!site.buildingType || RESIDENTIAL_TYPES.has(site.buildingType) || site.tenure === "condo_hoa") {
    return { eligible: false, reason: "residential or unknown building type — offered as a suggestion only" };
  }
  const ours = row.appliedSqft != null && site.sqft != null && Math.abs(site.sqft - row.appliedSqft) < 0.5;
  if (site.sqft != null && !ours) return { eligible: false, reason: "site already has a floor area" };
  if (ours && Math.abs((site.sqft ?? 0) - row.estimateSqft) < 0.5) return { eligible: false, reason: "already applied" };
  return { eligible: true };
}
/** Lifecycle-only automatic use; returns true when sites.sqft was written. */
export async function maybeAutoApply(siteId: number): Promise<boolean> {
  return applyPropertyEstimate(siteId, "auto");
}
/**
 * Write the current estimate to sites.sqft. "auto" obeys autoApplyDecision;
 * "user" (explicit one-click acceptance by an authorized actor) may replace an
 * existing value. Location revision is checked under a row lock.
 */
export async function applyPropertyEstimate(
  siteId: number,
  by: "auto" | "user",
  expectedRevision?: number,
): Promise<boolean> {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const [site] = await tx.select().from(sites).where(eq(sites.id, siteId)).for("update");
    if (!site) return false;
    if (expectedRevision != null && site.locationRevision !== expectedRevision) return false;
    const [row] = await tx.select().from(sitePropertyFacts).where(eq(sitePropertyFacts.siteId, siteId)).limit(1);
    if (!row || row.locationRevision !== site.locationRevision || row.estimateSqft == null) return false;
    if (by === "auto" && !autoApplyDecision(site, row).eligible) return false;
    const refined = Array.isArray(site.refinedFields) ? (site.refinedFields as string[]) : null;
    await tx
      .update(sites)
      .set({
        sqft: row.estimateSqft,
        ...(by === "user" && refined && !refined.includes("sqft") ? { refinedFields: [...refined, "sqft"] } : {}),
      })
      .where(eq(sites.id, siteId));
    await tx
      .update(sitePropertyFacts)
      .set({ appliedSqft: row.estimateSqft, appliedBy: by, appliedAt: Date.now() })
      .where(eq(sitePropertyFacts.siteId, siteId));
    return true;
  });
}
/** A user-typed floor area owns the field from then on. */
export async function releaseAppliedEstimate(siteId: number) {
  const db = await requireDb();
  await db.update(sitePropertyFacts).set({ appliedSqft: null, appliedBy: null, appliedAt: null }).where(eq(sitePropertyFacts.siteId, siteId));
}
/** Background lifecycle hook (site created, address changed). Never throws. */
export function enrichSiteInBackground(siteId: number) {
  if (!propertyFactsNetworkAvailable()) return;
  void refreshPropertyFacts(siteId, { allowAutoApply: true, force: true }).catch((error) => {
    console.warn(`[property-facts] background enrichment failed site=${siteId}: ${error instanceof Error ? error.message : "unknown"}`);
  });
}

/* ------------------------------------------------------------------ */
/* Floor-area basis (for analysis, portfolio, reports)                 */
/* ------------------------------------------------------------------ */
export type FloorAreaBasis = "public_record_estimate" | "placeholder" | "as_entered" | "none";
/** Quick-start sites start with a typical-size placeholder floor area. */
export function isPlaceholderSqft(site: Partial<Pick<Site, "attrSource" | "refinedFields">>): boolean {
  if (Array.isArray(site.refinedFields)) return !(site.refinedFields as string[]).includes("sqft");
  return site.attrSource === "quick_start_defaults";
}
export interface FloorAreaBasisInfo {
  basis: FloorAreaBasis;
  appliedBy: "auto" | "user" | null;
  label: string;
}
export function floorAreaBasisOf(
  site: Pick<Site, "sqft" | "locationRevision"> & Partial<Pick<Site, "attrSource" | "refinedFields">>,
  row: Pick<SitePropertyFacts, "appliedSqft" | "appliedBy" | "locationRevision"> | null | undefined,
): FloorAreaBasisInfo {
  if (site.sqft == null || site.sqft <= 0) return { basis: "none", appliedBy: null, label: "no floor area" };
  if (row && row.appliedSqft != null && row.locationRevision === site.locationRevision && Math.abs(row.appliedSqft - site.sqft) < 0.5) {
    const by = row.appliedBy === "user" ? "user" : "auto";
    return {
      basis: "public_record_estimate",
      appliedBy: by,
      label: by === "user" ? "public-record estimate you accepted" : "public-record estimate (building footprints)",
    };
  }
  if (isPlaceholderSqft(site)) return { basis: "placeholder", appliedBy: null, label: "typical-size placeholder, not this building's floor area" };
  return { basis: "as_entered", appliedBy: null, label: "floor area on the site profile" };
}
export async function floorAreaBasisForSites(siteRows: Array<Pick<Site, "id" | "sqft" | "locationRevision"> & Partial<Pick<Site, "attrSource" | "refinedFields">>>): Promise<Map<number, FloorAreaBasisInfo>> {
  const out = new Map<number, FloorAreaBasisInfo>();
  if (siteRows.length === 0) return out;
  const db = await requireDb();
  const rows = await db
    .select({ siteId: sitePropertyFacts.siteId, appliedSqft: sitePropertyFacts.appliedSqft, appliedBy: sitePropertyFacts.appliedBy, locationRevision: sitePropertyFacts.locationRevision })
    .from(sitePropertyFacts)
    .where(inArray(sitePropertyFacts.siteId, siteRows.map((s) => s.id)));
  const byId = new Map(rows.map((r) => [r.siteId, r]));
  for (const s of siteRows) out.set(s.id, floorAreaBasisOf(s, byId.get(s.id)));
  return out;
}

/* ------------------------------------------------------------------ */
/* Presentation (plain language, source on every row)                  */
/* ------------------------------------------------------------------ */
export interface FactRow {
  key: string;
  label: string;
  value: string;
  detail: string | null;
  sourceId: PropertySourceId;
  kind: "record" | "estimate";
}
export interface PropertyFactsView {
  status: PropertyFactsResult["status"] | "pending";
  locationRevision: number;
  fetchedAt: number | null;
  headline: string;
  rows: FactRow[];
  floorArea: {
    estimateSqft: number | null;
    method: string | null;
    state: "estimate_in_use" | "estimate_available" | "placeholder_in_use" | "your_value" | "your_value_differs" | "no_estimate";
    siteSqft: number | null;
    differencePct: number | null;
    autoApplyBlocker: string | null;
    noEstimateReason: string | null;
  };
  cautions: string[];
  sources: PropertySource[];
  sourceErrors: string[];
}
export function presentPropertyFacts(
  site: Pick<Site, "sqft" | "locationRevision" | "address" | "buildingType"> & Partial<Pick<Site, "attrSource" | "refinedFields">>,
  row: SitePropertyFacts | null,
): PropertyFactsView {
  const facts = row && row.locationRevision === site.locationRevision ? (row.facts as PropertyFactsResult | null) : null;
  if (!row || !facts) {
    return {
      status: "pending",
      locationRevision: site.locationRevision,
      fetchedAt: null,
      headline: "Looking up public records for this address…",
      rows: [],
      floorArea: { estimateSqft: null, method: null, state: "no_estimate", siteSqft: site.sqft ?? null, differencePct: null, autoApplyBlocker: null, noEstimateReason: null },
      cautions: [],
      sources: [],
      sourceErrors: [],
    };
  }
  const rows: FactRow[] = [];
  const est = facts.estimate;
  const s = facts.structures;
  if (s && s.counted.length > 0) {
    const occ = new Map<string, number>();
    for (const c of s.counted) if (c.occupancy) occ.set(c.occupancy, (occ.get(c.occupancy) ?? 0) + 1);
    const occList = Array.from(occ.entries()).sort((a, b) => b[1] - a[1]);
    const occText = occList.length === 0
      ? null
      : occList.length === 1
        ? `${s.counted.length === 1 ? "Classified" : "All classified"} as ${occList[0][0]}`
        : `Mostly ${occList[0][0]} (${occList[0][1]} of ${s.counted.length})`;
    const footprint = s.counted.reduce((sum, c) => sum + c.footprintSqft, 0);
    rows.push({
      key: "buildings",
      label: "Buildings",
      value: `${s.counted.length} building${s.counted.length === 1 ? "" : "s"} · ${Math.round(footprint).toLocaleString("en-US")} sqft of ground footprint`,
      detail: [occText, s.vintageYear ? `mapped from ${s.vintageYear} imagery${s.method ? ` (${s.method.toLowerCase()} extraction)` : ""}` : null].filter(Boolean).join(" · ") || null,
      sourceId: "fema_usa_structures",
      kind: "record",
    });
  }
  const p = facts.parcel;
  if (p) {
    rows.push({
      key: "parcel",
      label: "Parcel",
      value: `${p.parcelId}${p.landAcres != null ? ` · ${p.landAcres.toLocaleString("en-US", { maximumFractionDigits: 2 })} acres` : ""}`,
      detail: p.situsAddress ? `Recorded address: ${titleCase(p.situsAddress)}` : "No street address on the county record",
      sourceId: p.sourceId,
      kind: "record",
    });
    if (p.owner) rows.push({ key: "owner", label: "Owner of record", value: titleCase(p.owner), detail: null, sourceId: p.sourceId, kind: "record" });
    if (p.useLabel) {
      rows.push({
        key: "use",
        label: "Recorded land use",
        value: p.useLabel,
        detail: [p.useCode ? `County use code ${p.useCode}` : null, p.assessmentClass ? `assessment class: ${p.assessmentClass}` : null].filter(Boolean).join(" · ") || null,
        sourceId: p.sourceId,
        kind: "record",
      });
    }
    if (p.fullCashValue != null && p.fullCashValue > 0) {
      const parts = [
        p.landValue != null ? `land ${formatUsd(p.landValue)}` : null,
        p.improvementValue != null ? `buildings and improvements ${formatUsd(p.improvementValue)}` : null,
      ].filter(Boolean);
      rows.push({
        key: "value",
        label: "Assessed value",
        value: `${formatUsd(p.fullCashValue)} full cash value${p.taxYear ? ` (tax year ${p.taxYear})` : ""}`,
        detail: `${parts.length ? `${parts.join(" · ")}. ` : ""}The assessor's market-value estimate for the whole parcel.`,
        sourceId: p.sourceId,
        kind: "record",
      });
    }
  }
  if (facts.typeCheck?.consistent) {
    rows.push({
      key: "type",
      label: "Building type check",
      value: `Public records agree: ${facts.typeCheck.recordClass.toLowerCase()} buildings`,
      detail: `Matches this site's building type (${(site.buildingType ?? "").replace(/_/g, " ")}).`,
      sourceId: "fema_usa_structures",
      kind: "record",
    });
  }
  const siteSqft = site.sqft ?? null;
  const applied = floorAreaBasisOf(site, row);
  let state: PropertyFactsView["floorArea"]["state"] = "no_estimate";
  let differencePct: number | null = null;
  if (est) {
    if (applied.basis === "public_record_estimate" && siteSqft != null && Math.abs(siteSqft - est.sqft) < 0.5) state = "estimate_in_use";
    else if (siteSqft == null || siteSqft <= 0) state = "estimate_available";
    else if (applied.basis === "placeholder") {
      differencePct = Math.round(((siteSqft - est.sqft) / est.sqft) * 100);
      state = "placeholder_in_use";
    } else {
      differencePct = Math.round(((siteSqft - est.sqft) / est.sqft) * 100);
      state = Math.abs(differencePct) <= 10 ? "your_value" : "your_value_differs";
    }
  } else if (siteSqft != null) state = applied.basis === "placeholder" ? "placeholder_in_use" : "your_value";
  const decision = row ? autoApplyDecision({ ...site, tenure: "own", isHypothetical: false, sqft: null }, row) : null;
  const sources = Array.from(new Set(facts.sourcesUsed)).map((id) => PROPERTY_SOURCES[id]);
  const headline = est
    ? `About ${est.sqft.toLocaleString("en-US")} sqft of floor area across ${est.buildingCount} building${est.buildingCount === 1 ? "" : "s"}`
    : facts.status === "no_location"
      ? "Add a street address to see property facts"
      : facts.status === "unavailable"
        ? "Public property records are temporarily unreachable"
        : p
          ? `Parcel ${p.parcelId}${p.owner ? ` · ${titleCase(p.owner)}` : ""}`
          : "Limited public records for this address";
  return {
    status: facts.status,
    locationRevision: row!.locationRevision,
    fetchedAt: row!.fetchedAt,
    headline,
    rows,
    floorArea: {
      estimateSqft: est?.sqft ?? null,
      method: est?.method ?? null,
      state,
      siteSqft,
      differencePct,
      autoApplyBlocker: decision && !decision.eligible && est && !est.autoApplyAllowed ? decision.reason : null,
      noEstimateReason: facts.noEstimateReason,
    },
    cautions: facts.cautions,
    sources,
    sourceErrors: facts.sourceErrors.map((id) => PROPERTY_SOURCES[id].label),
  };
}
