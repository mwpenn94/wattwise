/**
 * §3g Persona fork — residential vs. commercial, detected from building type,
 * never asked. One codebase, one card grammar, two voices: vocabulary
 * (home/facility), hero rotation (rate-check-first vs. demand-story-first),
 * and measure emphasis all flip on this single detection.
 */

export type Persona = "residential" | "commercial";

const RESIDENTIAL_TYPES = new Set(["single_family", "multifamily", "mobile_home", "apartment", "condo"]);

export function detectPersona(buildingType: string | null | undefined): Persona {
  if (!buildingType) return "residential"; // default voice until told otherwise
  return RESIDENTIAL_TYPES.has(buildingType) ? "residential" : "commercial";
}

/** Vocabulary that flips with the persona — same grammar, two voices. */
export function personaVocab(p: Persona) {
  return p === "residential"
    ? {
        building: "home",
        buildingCap: "Home",
        bill: "bill",
        heroOrder: "rate_first" as const,
        heroHint: "Residential voice: plan choice, cooling, and solar lead.",
        digestTone: "friendly",
      }
    : {
        building: "facility",
        buildingCap: "Facility",
        bill: "utility spend",
        heroOrder: "demand_first" as const,
        heroHint: "Facility voice: load factor, demand-charge share, and peak triage lead.",
        digestTone: "operational",
      };
}
