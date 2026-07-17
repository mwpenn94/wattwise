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
}

export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
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
    formatted_address?: string;
    types?: string[];
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  };
  error_message?: string;
}

/** Address-scoped autocomplete, US-biased. Returns up to 5 suggestions. */
export async function placeAutocomplete(query: string): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const resp = await makeRequest<AutocompleteApiResponse>("/maps/api/place/autocomplete/json", {
    input: q,
    types: "address",
    components: "country:us",
  });
  if (resp.status !== "OK" && resp.status !== "ZERO_RESULTS") {
    throw new Error(`Address lookup failed (${resp.status})${resp.error_message ? `: ${resp.error_message}` : ""}`);
  }
  return (resp.predictions ?? []).slice(0, 5).map((p) => ({
    placeId: p.place_id,
    description: p.description,
    mainText: p.structured_formatting?.main_text ?? p.description,
    secondaryText: p.structured_formatting?.secondary_text ?? "",
  }));
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
    fields: "place_id,formatted_address,address_component,geometry,type",
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
  return {
    placeId: r.place_id ?? placeId,
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
