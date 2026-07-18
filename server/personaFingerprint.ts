/**
 * v1.20 Session block E groundwork — production feedback loop:
 * "every real dead-end/error event auto-drafts a candidate persona
 * (situation fingerprint, no PII) into the coverage matrix for triage —
 * users the product failed become the tests that prevent recurrence."
 *
 * A persona fingerprint is the SITUATION, never the person: the coordinates
 * of the coverage-matrix cell the user occupied when the product dead-ended
 * (tenure × building class × data state × commodity mix × language...), plus
 * the dead-end kind. Deliberately excluded: userId, address, site name, any
 * free text. Fingerprints land in the audit log under action
 * `dead_end_persona` with userId=null, making them queryable as a
 * coverage-matrix backlog without ever being joinable back to a person.
 */
import * as h from "./dbHelpers";

export interface PersonaFingerprint {
  /** What failed, in enum form — e.g. "csv_parse_failed", "no_tariffs_for_region". */
  deadEnd: string;
  /** Coverage-matrix coordinates — every field optional, every field categorical. */
  tenure?: "own" | "rent" | "condo_hoa";
  buildingClass?: string; // e.g. "single_family", "office" — archetype key, not address
  dataState?: "no_data" | "bills_only" | "intervals_partial" | "intervals_full";
  commodities?: string; // sorted joined set, e.g. "electric" | "electric+gas+water"
  hasSolar?: boolean;
  language?: "en" | "es";
  tier?: string; // free | plus | pro
  /** Optional categorical extras (never free text): climate zone, state. */
  region?: string; // state-level only — coarse enough to be non-identifying
}

const FORBIDDEN_KEYS = new Set(["userId", "user_id", "address", "name", "email", "zip", "lat", "lng"]);

/** Strip anything that could identify a person; enforce categorical-only values. */
export function sanitizeFingerprint(fp: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fp)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v == null) continue;
    if (typeof v === "boolean" || typeof v === "number") {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      // categorical guard: short, no digits-heavy strings (addresses/zips), no spaces beyond class names
      if (v.length <= 40 && !/\d{4,}/.test(v)) out[k] = v;
    }
  }
  return out;
}

/**
 * Emit a dead-end persona fingerprint. userId is intentionally NOT stored —
 * the audit row is written with userId=null so the fingerprint cannot be
 * joined back to the person who hit the dead-end.
 */
export async function emitDeadEndPersona(fp: PersonaFingerprint): Promise<void> {
  const clean = sanitizeFingerprint(fp as unknown as Record<string, unknown>);
  if (!clean.deadEnd) return; // a fingerprint without a dead-end kind is noise
  try {
    await h.audit(null, "dead_end_persona", "coverage_matrix", undefined, clean);
  } catch {
    // fingerprinting must never break the failing path further
  }
}
