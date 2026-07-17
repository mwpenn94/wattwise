/**
 * Address-driven cascading imputation (Jul 2026, user-reported Gap 8).
 *
 * One call takes whatever location facts we have (free-text address, state,
 * ZIP) and derives EVERYTHING downstream of them, each field tagged with its
 * provenance so the UI and insights can honestly show "derived from address —
 * override anytime" instead of silently defaulting:
 *
 *   address → state/ZIP/city (parseQuickAddress, no external geocoder)
 *     state/ZIP → climate zone   (ZIP3 table → state-dominant → US-median)
 *     state     → IANA timezone  (dominant zone; split-state disclosed upstream)
 *     state     → eGRID subregion (dominant subregion per state)
 *     state     → candidate utility (largest IOU per state, representative)
 *     zone+type → building priors (archetype calibration medians, not 10k flat)
 *
 * Every derived value is a STARTING POINT the user can override; provenance
 * strings distinguish user_entered / zip_inferred / state_inferred /
 * us_median_fallback so downstream disclosures stay truthful.
 */
import {
  inferClimateZoneWithSource,
  parseQuickAddress,
  QUICK_START_DEFAULTS,
  TZ_BY_STATE,
  type ClimateZoneSource,
} from "../shared/wattwise";
import { STATE_SUBREGION, STATE_UTILITY } from "./seed/nationalData";

export interface DerivedField<T> {
  value: T;
  /** where the value came from — never silently defaulted */
  source: "user_entered" | "zip_inferred" | "state_inferred" | "prior_median" | "us_median_fallback" | "unknown";
  /** human sentence for disclosures / UI hints */
  note: string;
}

export interface AddressCascade {
  state: DerivedField<string | null>;
  zip: DerivedField<string | null>;
  city: DerivedField<string | null>;
  climateZone: DerivedField<string>;
  timezone: DerivedField<string>;
  utilityName: DerivedField<string | null>;
  egridSubregion: DerivedField<string | null>;
  buildingType: DerivedField<string>;
  sqft: DerivedField<number>;
  vintage: DerivedField<number>;
}

/** Building-stock priors by (broad building type) — medians drawn from the
 *  same CBECS/RECS-derived calibration bands the archetype table uses, so the
 *  quick-start prior and the archetype the pipeline picks stay consistent.
 *  These are PRIORS (disclosed, overridable), not measurements. */
export const BUILDING_PRIORS: Record<string, { sqft: number; vintage: number }> = {
  office: { sqft: 15_000, vintage: 1998 },
  retail: { sqft: 9_500, vintage: 1995 },
  warehouse: { sqft: 25_000, vintage: 1990 },
  restaurant: { sqft: 4_500, vintage: 1992 },
  school: { sqft: 60_000, vintage: 1985 },
  hospital: { sqft: 180_000, vintage: 1988 },
  hotel: { sqft: 75_000, vintage: 1994 },
  single_family: { sqft: 2_000, vintage: 1990 },
  multifamily: { sqft: 850, vintage: 1985 },
  grocery: { sqft: 40_000, vintage: 1996 },
  manufacturing: { sqft: 50_000, vintage: 1985 },
  municipal: { sqft: 20_000, vintage: 1980 },
};

const TZ_FALLBACK = "America/Phoenix";

/**
 * Derive everything derivable from a free-text address plus optional explicit
 * overrides (explicit values always win and are tagged user_entered).
 */
export function deriveFromAddress(
  rawAddress: string | null | undefined,
  explicit?: {
    state?: string | null;
    zip?: string | null;
    city?: string | null;
    buildingType?: string | null;
    sqft?: number | null;
    vintage?: number | null;
    climateZone?: string | null;
    utilityName?: string | null;
  },
): AddressCascade {
  const parse = rawAddress ? parseQuickAddress(rawAddress) : { state: null, zip: null, city: null, raw: rawAddress ?? "" };

  const state = explicit?.state ?? parse.state ?? null;
  const zip = explicit?.zip ?? parse.zip ?? null;
  const city = explicit?.city ?? parse.city ?? null;
  const stateUp = state?.toUpperCase() ?? null;

  const stateField: DerivedField<string | null> = explicit?.state
    ? { value: stateUp, source: "user_entered", note: "State as entered." }
    : parse.state
      ? { value: stateUp, source: "zip_inferred", note: "State parsed from the address text." }
      : { value: null, source: "unknown", note: "No state could be determined — add one to unlock location-specific rates, weather, and emissions." };

  const zipField: DerivedField<string | null> = explicit?.zip
    ? { value: zip, source: "user_entered", note: "ZIP as entered." }
    : parse.zip
      ? { value: zip, source: "zip_inferred", note: "ZIP parsed from the address text." }
      : { value: null, source: "unknown", note: "No ZIP found in the address." };

  // climate zone: explicit → ZIP3 → state → US-median (all disclosed)
  let zone: string;
  let zoneSource: DerivedField<string>["source"];
  let zoneNote: string;
  if (explicit?.climateZone) {
    zone = explicit.climateZone.trim().toUpperCase();
    zoneSource = "user_entered";
    zoneNote = "Climate zone as entered.";
  } else {
    const z = inferClimateZoneWithSource(zip ?? undefined, stateUp ?? undefined);
    zone = z.zone;
    zoneSource = zoneSourceToField(z.source);
    zoneNote =
      z.source === "zip_inferred"
        ? `IECC climate zone ${z.zone} inferred from ZIP prefix ${zip?.slice(0, 3)}.`
        : z.source === "state_inferred"
          ? `IECC climate zone ${z.zone} is ${stateUp}'s dominant zone (ZIP-level precision available with a ZIP).`
          : `No usable location — climate zone defaults to the US-median ${z.zone} (mixed-humid). Weather-driven figures are generic until a state or ZIP is added.`;
  }

  const tz = stateUp && TZ_BY_STATE[stateUp] ? TZ_BY_STATE[stateUp] : TZ_FALLBACK;
  const tzField: DerivedField<string> = stateUp && TZ_BY_STATE[stateUp]
    ? { value: tz, source: "state_inferred", note: `Timezone ${tz} is ${stateUp}'s dominant zone.` }
    : { value: tz, source: "us_median_fallback", note: `No recognized state — timezone defaults to ${TZ_FALLBACK}.` };

  const util = explicit?.utilityName ?? (stateUp ? STATE_UTILITY[stateUp] ?? null : null);
  const utilField: DerivedField<string | null> = explicit?.utilityName
    ? { value: util, source: "user_entered", note: "Utility as entered." }
    : util
      ? { value: util, source: "state_inferred", note: `${util} is ${stateUp}'s largest electric utility — override if yours differs (municipal utilities and co-ops serve many areas).` }
      : { value: null, source: "unknown", note: "No state — no candidate utility could be suggested." };

  const subregion = stateUp ? STATE_SUBREGION[stateUp] ?? null : null;
  const subregionField: DerivedField<string | null> = subregion
    ? { value: subregion, source: "state_inferred", note: `eGRID subregion ${subregion} (dominant for ${stateUp}) sets the emissions factor.` }
    : { value: null, source: "unknown", note: "No state — emissions use the legacy Southwest default until location is added." };

  const bType = explicit?.buildingType ?? QUICK_START_DEFAULTS.buildingType;
  const bTypeField: DerivedField<string> = explicit?.buildingType
    ? { value: bType, source: "user_entered", note: "Building type as entered." }
    : { value: bType, source: "prior_median", note: `Building type assumed '${bType}' (most common commercial type) — pick yours for a matched archetype.` };

  const prior = BUILDING_PRIORS[bType] ?? BUILDING_PRIORS.office;
  const sqftField: DerivedField<number> = explicit?.sqft
    ? { value: explicit.sqft, source: "user_entered", note: "Floor area as entered." }
    : { value: prior.sqft, source: "prior_median", note: `Floor area assumed ${prior.sqft.toLocaleString()} sqft — the national median for a ${bType.replace(/_/g, " ")} (CBECS/RECS-derived prior), not a measurement of this address. Enter actual square footage to scale every figure.` };

  const vintageField: DerivedField<number> = explicit?.vintage
    ? { value: explicit.vintage, source: "user_entered", note: "Vintage as entered." }
    : { value: prior.vintage, source: "prior_median", note: `Construction year assumed ~${prior.vintage} (national median for this type) — refine for vintage-matched archetypes.` };

  return {
    state: stateField,
    zip: zipField,
    city: { value: city, source: city ? (explicit?.city ? "user_entered" : "zip_inferred") : "unknown", note: city ? "City parsed from address." : "No city found." },
    climateZone: { value: zone, source: zoneSource, note: zoneNote },
    timezone: tzField,
    utilityName: utilField,
    egridSubregion: subregionField,
    buildingType: bTypeField,
    sqft: sqftField,
    vintage: vintageField,
  };
}

function zoneSourceToField(s: ClimateZoneSource): DerivedField<string>["source"] {
  if (s === "zip_inferred") return "zip_inferred";
  if (s === "state_inferred") return "state_inferred";
  return "us_median_fallback";
}

/** Compact per-field provenance snapshot for persisting on the site row /
 *  intake insight so the UI can render "derived — override" chips. */
export function cascadeProvenance(c: AddressCascade): Record<string, { value: unknown; source: string }> {
  return Object.fromEntries(
    Object.entries(c).map(([k, f]) => [k, { value: (f as DerivedField<unknown>).value, source: (f as DerivedField<unknown>).source }]),
  );
}
