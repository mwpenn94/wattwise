/**
 * Service-territory awareness (TERR-2/TERR-3).
 *
 * Problem: the tariff sweep and rate comparison previously admitted any
 * eligible rate STATEWIDE, so a Tucson site could see UNS Electric (Mohave /
 * Santa Cruz counties only) rates and a Lake Havasu site could see SRP rates.
 * Utilities are territorial monopolies — a rate from a utility that does not
 * serve the site's area is not switchable-to and showing it is misleading.
 *
 * Model: a code-reviewed territory catalog maps each seeded utility to the
 * places it plausibly serves (city names + zip3 prefixes + county names).
 * Resolution is heuristic by design — territory boundaries are parcel-level
 * in reality — so the result carries a confidence level and every downstream
 * surface discloses the basis. Where genuine overlap exists (metro Phoenix is
 * served by BOTH APS and SRP depending on the block), resolution returns
 * multiple utilities and the UI asks the user to confirm which one serves
 * them rather than guessing.
 *
 * Fail-open contract: if the site has no usable location signal (no city, no
 * zip, no matching utilityName), NO filtering is applied — an unknown
 * territory must never hide the entire rate catalog. The UI then labels the
 * comparison "statewide — territory unconfirmed".
 *
 * Sources (verified Jul 2026):
 * - UES electric territory: Mohave County (Kingman, Lake Havasu City) and
 *   Santa Cruz County (Nogales) — https://www.uesaz.com/about/
 * - TEP: Tucson metro (Pima County) — tep.com
 * - APS: statewide footprint across 11 of 15 counties; overlaps SRP in metro
 *   Phoenix — aps.com service map
 * - SRP: metro Phoenix (Maricopa + NW Pinal) — srpnet.com
 * - Southwest Gas: most of AZ incl. Phoenix, Tucson; UNS Gas covers
 *   Mohave/Yavapai/Coconino/Navajo/Santa Cruz — swgas.com, uesaz.com/about
 */

export type TerritoryConfidence = "city_match" | "zip_match" | "county_match" | "name_match" | "unknown";

export interface TerritoryEntry {
  /** Prefix used to match tariffs.utilityName (case-insensitive substring). */
  utilityMatch: string;
  /** Human name for UI. */
  utilityLabel: string;
  commodity: "electric" | "gas" | "water";
  state: string;
  /** Lowercase city names plausibly inside the territory. */
  cities: string[];
  /** 3-digit zip prefixes plausibly inside the territory. */
  zip3: string[];
  /** Lowercase county names (for future county-carrying sites). */
  counties: string[];
  /** True when this territory overlaps another utility's (user must confirm). */
  overlapsWith?: string[];
}

/**
 * AZ territory catalog. Deliberately coarse: zip3 granularity plus city names.
 * A city listed under two utilities produces an "overlap" resolution.
 */
export const AZ_TERRITORIES: TerritoryEntry[] = [
  {
    utilityMatch: "arizona public service",
    utilityLabel: "Arizona Public Service Co (APS)",
    commodity: "electric",
    state: "AZ",
    // APS serves most of the state OUTSIDE the SRP metro-Phoenix core, plus
    // large parts of metro Phoenix itself (block-level interleaving with SRP).
    cities: [
      "phoenix", "glendale", "scottsdale", "peoria", "surprise", "goodyear", "buckeye", "avondale",
      "flagstaff", "prescott", "prescott valley", "sedona", "payson", "camp verde", "cottonwood",
      "yuma", "somerton", "san luis", "casa grande", "maricopa", "eloy", "coolidge",
      "globe", "miami", "safford", "douglas", "bisbee", "sierra vista", "benson", "willcox",
      "wickenburg", "cave creek", "carefree", "fountain hills", "sun city", "sun city west",
    ],
    zip3: ["850", "851", "852", "853", "856", "857", "859", "860", "863", "864"],
    counties: ["maricopa", "yavapai", "coconino", "navajo", "apache", "gila", "pinal", "yuma", "la paz", "cochise", "graham", "greenlee"],
    overlapsWith: ["Salt River Project (SRP)"],
  },
  {
    utilityMatch: "salt river project",
    utilityLabel: "Salt River Project (SRP)",
    commodity: "electric",
    state: "AZ",
    // SRP core: metro Phoenix east valley + parts of the west valley.
    cities: [
      "phoenix", "tempe", "mesa", "chandler", "gilbert", "scottsdale", "queen creek", "apache junction",
      "guadalupe", "tolleson", "laveen", "ahwatukee", "sun lakes", "fountain hills",
    ],
    zip3: ["850", "851", "852", "853"],
    counties: ["maricopa", "pinal"],
    overlapsWith: ["Arizona Public Service Co (APS)"],
  },
  {
    utilityMatch: "tucson electric",
    utilityLabel: "Tucson Electric Power (TEP)",
    commodity: "electric",
    state: "AZ",
    cities: ["tucson", "south tucson", "oro valley", "marana", "sahuarita", "vail", "catalina", "green valley"],
    zip3: ["857"],
    counties: ["pima"],
  },
  {
    utilityMatch: "unisource",
    utilityLabel: "UniSource Energy Services (UNS Electric)",
    commodity: "electric",
    state: "AZ",
    // Electric ONLY in Mohave + Santa Cruz counties (uesaz.com/about, Jul 2026).
    // NOTE: Bullhead City is Mohave Electric Co-op, not UNS — excluded.
    cities: ["kingman", "lake havasu city", "lake havasu", "golden valley", "nogales", "rio rico", "patagonia", "tubac"],
    zip3: ["864", "865", "856"],
    counties: ["mohave", "santa cruz"],
  },
  {
    utilityMatch: "southwest gas",
    utilityLabel: "Southwest Gas",
    commodity: "gas",
    state: "AZ",
    // SW Gas covers most AZ population centers (Phoenix, Tucson, Yuma...).
    cities: [
      "phoenix", "tempe", "mesa", "chandler", "gilbert", "scottsdale", "glendale", "peoria",
      "tucson", "oro valley", "marana", "sahuarita", "casa grande", "yuma", "sierra vista",
    ],
    zip3: ["850", "851", "852", "853", "856", "857", "859"],
    counties: ["maricopa", "pima", "pinal", "yuma", "cochise"],
  },
  {
    utilityMatch: "city of phoenix water",
    utilityLabel: "City of Phoenix Water Services",
    commodity: "water",
    state: "AZ",
    cities: ["phoenix", "laveen", "ahwatukee"],
    zip3: ["850", "851"],
    counties: ["maricopa"],
  },
];

export interface SiteLocation {
  state?: string | null;
  city?: string | null;
  zip?: string | null;
  county?: string | null;
  utilityName?: string | null;
}

export interface TerritoryResolution {
  /** Utility labels plausibly serving the site for this commodity. Empty = unknown (fail open). */
  plausibleUtilities: string[];
  /** utilityMatch prefixes for filtering tariff rows. Empty = no filtering. */
  matchPrefixes: string[];
  confidence: TerritoryConfidence;
  /** True when >1 utility plausibly serves the location (e.g. metro Phoenix APS/SRP). */
  overlap: boolean;
  /** Human-readable basis for disclosures. */
  basis: string;
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Resolve which utilities plausibly serve a site for a commodity.
 * Precedence: explicit site.utilityName (the user/refinement said so) →
 * city match → zip3 match → county match → unknown (fail open, no filter).
 */
export function resolveTerritory(site: SiteLocation, commodity: "electric" | "gas" | "water"): TerritoryResolution {
  const state = norm(site.state).toUpperCase();
  const catalog = AZ_TERRITORIES.filter((t) => t.commodity === commodity && t.state === state);
  if (catalog.length === 0) {
    return {
      plausibleUtilities: [],
      matchPrefixes: [],
      confidence: "unknown",
      overlap: false,
      basis: `No territory catalog for ${state || "unknown state"} ${commodity} — statewide comparison shown.`,
    };
  }

  // 1) Explicit utility on the site record wins outright (user-confirmed or refined).
  const siteUtil = norm(site.utilityName);
  if (siteUtil) {
    const named = catalog.filter((t) => siteUtil.includes(t.utilityMatch) || t.utilityLabel.toLowerCase().includes(siteUtil.split(" ")[0]));
    if (named.length > 0) {
      return {
        plausibleUtilities: named.map((t) => t.utilityLabel),
        matchPrefixes: named.map((t) => t.utilityMatch),
        confidence: "name_match",
        overlap: false,
        basis: `Utility confirmed on the site record (${site.utilityName}).`,
      };
    }
  }

  // 2) City match.
  const city = norm(site.city);
  if (city) {
    const byCity = catalog.filter((t) => t.cities.includes(city));
    if (byCity.length > 0) {
      return {
        plausibleUtilities: byCity.map((t) => t.utilityLabel),
        matchPrefixes: byCity.map((t) => t.utilityMatch),
        confidence: "city_match",
        overlap: byCity.length > 1,
        basis:
          byCity.length > 1
            ? `${site.city} is served by multiple utilities depending on the block — confirm which serves you.`
            : `Territory inferred from city (${site.city}).`,
      };
    }
  }

  // 3) zip3 match.
  const zip3 = norm(site.zip).slice(0, 3);
  if (zip3.length === 3) {
    const byZip = catalog.filter((t) => t.zip3.includes(zip3));
    if (byZip.length > 0) {
      return {
        plausibleUtilities: byZip.map((t) => t.utilityLabel),
        matchPrefixes: byZip.map((t) => t.utilityMatch),
        confidence: "zip_match",
        overlap: byZip.length > 1,
        basis:
          byZip.length > 1
            ? `ZIP ${zip3}xx spans multiple utility territories — confirm which serves you.`
            : `Territory inferred from ZIP prefix (${zip3}xx).`,
      };
    }
  }

  // 4) County match (sites don't carry county today; future-proofing).
  const county = norm(site.county);
  if (county) {
    const byCounty = catalog.filter((t) => t.counties.includes(county));
    if (byCounty.length > 0) {
      return {
        plausibleUtilities: byCounty.map((t) => t.utilityLabel),
        matchPrefixes: byCounty.map((t) => t.utilityMatch),
        confidence: "county_match",
        overlap: byCounty.length > 1,
        basis: `Territory inferred from county (${site.county}).`,
      };
    }
  }

  // Fail open: unknown location → no filtering.
  return {
    plausibleUtilities: [],
    matchPrefixes: [],
    confidence: "unknown",
    overlap: false,
    basis: "Site location did not match the territory catalog — statewide comparison shown.",
  };
}

/**
 * Partition tariff rows into in-territory and out-of-territory sets for a
 * resolution. With an unknown resolution everything is in-territory (fail open).
 */
export function partitionByTerritory<T extends { utilityName: string }>(
  rows: T[],
  res: TerritoryResolution,
): { inTerritory: T[]; outOfTerritory: T[] } {
  if (res.matchPrefixes.length === 0) return { inTerritory: rows, outOfTerritory: [] };
  const inT: T[] = [];
  const outT: T[] = [];
  for (const r of rows) {
    const u = r.utilityName.toLowerCase();
    (res.matchPrefixes.some((p) => u.includes(p)) ? inT : outT).push(r);
  }
  return { inTerritory: inT, outOfTerritory: outT };
}
