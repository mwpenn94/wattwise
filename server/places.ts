/**
 * Grounded address intake (user feedback, Jul 17 2026).
 * Google Places autocomplete + place-details resolution through the built-in
 * Maps proxy, so quick-start sites are grounded in a VERIFIED address —
 * state/zip/city come from Google's geocoded address components, not from a
 * free-text regex guess. The old parse path remains as a disclosed fallback
 * for users who type free text and never pick a suggestion.
 */
import { makeRequest } from "./_core/map";

export interface PlaceSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
  /** True when the suggestion is a named place (business, church, school…)
   *  rather than a bare street address — lets the UI show a POI marker and
   *  carry the place NAME onto the created site. */
  isPlaceName?: boolean;
}

export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
  /** Human name of the place when it is a POI/establishment (e.g. "Emmanuel
   *  Baptist Church") — null for plain street addresses. */
  placeName: string | null;
  state: string | null; // USPS 2-letter
  zip: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** Google result types for the place (street_address, premise, subpremise…) */
  types: string[];
  /**
   * Best-effort residential hint from the geocode result. Google address
   * results do NOT reliably distinguish a house from a small office, so this
   * is a HINT for pre-selecting the building-type chip — never a silent
   * classification. `null` = no signal either way.
   */
  residentialHint: boolean | null;
}

interface AutocompleteApiResponse {
  status: string;
  predictions?: Array<{
    place_id: string;
    description: string;
    structured_formatting?: { main_text?: string; secondary_text?: string };
  }>;
  error_message?: string;
}

interface DetailsApiResponse {
  status: string;
  result?: {
    place_id?: string;
    name?: string;
    formatted_address?: string;
    types?: string[];
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  };
  error_message?: string;
}

/**
 * Autocomplete like Google/Apple Maps (owner request Jul 19): accepts BOTH
 * street addresses and place/business names ("Emmanuel Baptist Church",
 * "Google Tucson"). Two parallel Google calls — address-scoped and
 * establishment-scoped — are blended: addresses first (they are exact),
 * then named places, de-duplicated by place_id, capped at 6 total. If one
 * call fails the other's results still return (graceful degradation).
 */
export async function placeAutocomplete(query: string): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const call = (types: string) =>
    makeRequest<AutocompleteApiResponse>("/maps/api/place/autocomplete/json", {
      input: q,
      types,
      components: "country:us",
    });
  const [addrRes, poiRes] = await Promise.allSettled([call("address"), call("establishment")]);
  const usable = (r: PromiseSettledResult<AutocompleteApiResponse>): AutocompleteApiResponse | null =>
    r.status === "fulfilled" && (r.value.status === "OK" || r.value.status === "ZERO_RESULTS") ? r.value : null;
  const addr = usable(addrRes);
  const poi = usable(poiRes);
  if (!addr && !poi) {
    const detail =
      addrRes.status === "rejected"
        ? String((addrRes.reason as Error)?.message ?? addrRes.reason)
        : ((addrRes as PromiseFulfilledResult<AutocompleteApiResponse>).value.error_message ?? (addrRes as PromiseFulfilledResult<AutocompleteApiResponse>).value.status);
    throw new Error(`Address lookup failed${detail ? `: ${detail}` : ""}`);
  }
  const toSuggestion = (
    p: NonNullable<AutocompleteApiResponse["predictions"]>[number],
    isPlaceName: boolean,
  ): PlaceSuggestion => ({
    placeId: p.place_id,
    description: p.description,
    mainText: p.structured_formatting?.main_text ?? p.description,
    secondaryText: p.structured_formatting?.secondary_text ?? "",
    isPlaceName,
  });
  const seen = new Set<string>();
  const out: PlaceSuggestion[] = [];
  // Addresses first (max 4) — they are exact intents; then POIs up to 6 total.
  for (const p of addr?.predictions ?? []) {
    if (out.length >= 4 || seen.has(p.place_id)) continue;
    seen.add(p.place_id);
    out.push(toSuggestion(p, false));
  }
  for (const p of poi?.predictions ?? []) {
    if (out.length >= 6 || seen.has(p.place_id)) continue;
    seen.add(p.place_id);
    out.push(toSuggestion(p, true));
  }
  return out;
}

/** Sublocality-aware city extraction: locality > sublocality > admin_level_3. */
function extractCity(components: Array<{ long_name: string; short_name: string; types: string[] }>): string | null {
  const byType = (t: string) => components.find((c) => c.types.includes(t));
  return byType("locality")?.long_name ?? byType("sublocality_level_1")?.long_name ?? byType("administrative_area_level_3")?.long_name ?? null;
}

/** Resolve a selected suggestion into verified address components. */
export async function resolvePlace(placeId: string): Promise<ResolvedPlace> {
  const resp = await makeRequest<DetailsApiResponse>("/maps/api/place/details/json", {
    place_id: placeId,
    fields: "place_id,name,formatted_address,address_component,geometry,type",
  });
  if (resp.status !== "OK" || !resp.result) {
    throw new Error(`Address resolution failed (${resp.status})${resp.error_message ? `: ${resp.error_message}` : ""}`);
  }
  const r = resp.result;
  const comps = r.address_components ?? [];
  const state = comps.find((c) => c.types.includes("administrative_area_level_1"))?.short_name ?? null;
  const zip = comps.find((c) => c.types.includes("postal_code"))?.long_name ?? null;
  const city = extractCity(comps);
  const types = r.types ?? [];
  // Honest hint semantics: 'premise'/'subpremise'/'street_address' alone say
  // nothing about residential vs commercial; only an explicit subpremise unit
  // on a street address weakly suggests multifamily. We deliberately return
  // null (no signal) in the common case — the UI asks the user to confirm.
  const residentialHint = types.includes("subpremise") ? true : null;
  // A POI/establishment result carries a human name distinct from the first
  // address line; bare street addresses have name === first address line.
  const isPoi = types.some((t) => t === "establishment" || t === "point_of_interest" || t === "church" || t === "school" || t === "store");
  const firstLine = (r.formatted_address ?? "").split(",")[0]?.trim().toLowerCase();
  const placeName = isPoi && r.name && r.name.trim().toLowerCase() !== firstLine ? r.name.trim() : null;
  return {
    placeId: r.place_id ?? placeId,
    placeName,
    formattedAddress: r.formatted_address ?? "",
    state: state && /^[A-Z]{2}$/.test(state) ? state : null,
    zip: zip && /^\d{5}/.test(zip) ? zip.slice(0, 5) : null,
    city,
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
    types,
    residentialHint,
  };
}

/* ------------------------------------------------------------------ */
/* Reverse geocode (§1b use-my-location — tap-triggered only, never on  */
/* load; the coordinate is used once for address lookup and discarded,  */
/* honoring the GPS-never-stored privacy rule).                         */
/* ------------------------------------------------------------------ */
interface ReverseGeocodeApiResponse {
  status: string;
  results?: Array<{
    place_id?: string;
    formatted_address?: string;
    types?: string[];
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  }>;
  error_message?: string;
}

/** Resolve device coordinates to the nearest street address. Returns null when
 *  Google has no addressable result (rural parcels, mid-block drops). */
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceSuggestion | null> {
  const resp = await makeRequest<ReverseGeocodeApiResponse>("/maps/api/geocode/json", {
    latlng: `${lat},${lng}`,
    result_type: "street_address|premise|subpremise",
  });
  if (resp.status === "ZERO_RESULTS") return null;
  if (resp.status !== "OK" || !resp.results?.length) {
    throw new Error(`Location lookup failed (${resp.status})${resp.error_message ? `: ${resp.error_message}` : ""}`);
  }
  const r = resp.results[0];
  if (!r.place_id || !r.formatted_address) return null;
  return {
    placeId: r.place_id,
    description: r.formatted_address,
    mainText: r.formatted_address.split(",")[0] ?? r.formatted_address,
    secondaryText: r.formatted_address.split(",").slice(1).join(",").trim(),
  };
}
