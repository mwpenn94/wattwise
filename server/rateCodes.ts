import { eq } from "drizzle-orm";
import { tariffs } from "../drizzle/schema";
import { getDb } from "./db";
import * as h from "./dbHelpers";

export type RateCodeResolution = {
  urdbId: string;
  match: "exact" | "family_inferred";
  disclosure: string;
  comparisonUrdbIds?: string[];
};

const EXACT_UNS_CODES: Record<string, string> = {
  EGSGS: "uns-egsgs",
  EGMGS: "uns-egmgs",
  EGMGST: "uns-egmgst",
  EGMGSST: "uns-egmgsst",
  EGLGS: "uns-lgs",
};

const EGMGSQ_DISCLOSURE =
  "EGMGSQ → EGMGS (inferred, unconfirmed). No official EGMGSQ crosswalk was found in the reviewed UNS/ACC sources. Modeled using EGMGS as an unverified family inference; confirm the actual schedule with UNS Electric before relying on costs or savings.";

function isUnsElectricHint(utilityHint: string | null): boolean {
  if (utilityHint == null) return true;
  const normalized = utilityHint.trim().toLowerCase();
  return normalized.includes("uns") || normalized.includes("unisource");
}

/** Resolve published UNS Electric bill codes without asserting an unsupported
 * tariff crosswalk. Code families are utility-specific, so other utilities
 * always return null. */
export function resolveRateCode(utilityHint: string | null, code: string | null): RateCodeResolution | null {
  if (!code || !isUnsElectricHint(utilityHint)) return null;
  const normalizedCode = code.trim().toUpperCase();
  const urdbId = EXACT_UNS_CODES[normalizedCode];
  if (urdbId) {
    return {
      urdbId,
      match: "exact",
      disclosure: `Matched published UNS Electric schedule ${normalizedCode}.`,
    };
  }
  if (normalizedCode === "EGMGSQ") {
    return {
      urdbId: "uns-egmgs",
      match: "family_inferred",
      disclosure: EGMGSQ_DISCLOSURE,
      comparisonUrdbIds: ["uns-egmgsst", "uns-egmgst"],
    };
  }
  return null;
}

export async function assignTariffForMeter(
  meterId: number,
  userId: number,
  code: string | null,
  utilityHint: string | null,
): Promise<
  | { assigned: true; tariffId: number; urdbId: string; match: "exact" | "family_inferred"; disclosure: string }
  | { assigned: false; reason: string }
> {
  const resolution = resolveRateCode(utilityHint, code);
  if (!resolution) return { assigned: false, reason: "unrecognized_rate_code" };

  const db = await getDb();
  if (!db) return { assigned: false, reason: "database_unavailable" };
  const [tariff] = await db
    .select({ id: tariffs.id })
    .from(tariffs)
    .where(eq(tariffs.urdbId, resolution.urdbId))
    .limit(1);
  if (!tariff) return { assigned: false, reason: "tariff_not_found" };

  await h.setMeterTariff(meterId, tariff.id, userId);
  return {
    assigned: true,
    tariffId: tariff.id,
    urdbId: resolution.urdbId,
    match: resolution.match,
    disclosure: resolution.disclosure,
  };
}
