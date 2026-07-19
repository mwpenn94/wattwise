/**
 * TERR (owner, Jul 19) — utility-level service-territory attribution.
 *
 * "There appear to be given service areas for utilities … ways to either
 * directly attribute or reasonably impute this information."
 *
 * This module resolves a site's ZIP against a seeded registry of utility
 * service territories derived from EIA Form 861 (electric; service-territory
 * county/ZIP listings, 2024 vintage) and gas-utility service descriptions
 * (state PUC filings), at ZIP3 granularity — the same granularity as the
 * existing zip→eGRID mapping, coarse enough to ship honestly and fine enough
 * to beat state-level presence.
 *
 * HONESTY CONTRACT
 *  - A ZIP3 covered by the registry answers definitively for that commodity:
 *    either at least one named utility serves it (plausible-active, with the
 *    names surfaced) or none does (imputed absent, correctable in settings).
 *  - A ZIP3 the registry does not cover answers "unknown" — callers MUST fall
 *    back to the state-level tariff snapshot, never treat absence of registry
 *    rows as absence of service.
 *  - Registry rows carry a sourceVersion so a future full EIA-861 ingest can
 *    supersede the seed without schema changes.
 */
import { getDb } from "./db";
import { serviceTerritories } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";
import type { Commodity } from "./commodityService";

export interface TerritoryLookup {
  /** Whether the registry covers this ZIP3 for this commodity at all. */
  covered: boolean;
  /** Utilities serving this ZIP3 for the commodity (empty when covered=false or truly unserved). */
  utilities: string[];
  /** Definitive only when covered: true → someone serves it; false → nobody does. */
  served: boolean | null;
  sourceVersion: string | null;
}

const SOURCE_VERSION = "eia861-2024+puc-seed.1";

/**
 * Seed registry — ZIP3 rows for the territories the product has priced
 * tariffs for (Arizona focus), plus explicitly-known no-gas ZIP3s. This is a
 * seed, not national coverage; uncovered ZIP3s resolve covered=false and the
 * caller falls back to state-level presence. Sources: EIA Form 861 (2024)
 * service-territory file for electric utilities; Southwest Gas / UNS Gas
 * territory maps (AZ Corporation Commission dockets) for gas.
 */
const SEED: Array<{ zip3: string; state: string; commodity: Commodity; utilityName: string }> = [
  // --- Phoenix metro (850–853): APS + SRP electric; Southwest Gas ---
  ...["850", "851", "852", "853"].flatMap((z) => [
    { zip3: z, state: "AZ", commodity: "electric" as const, utilityName: "Arizona Public Service (APS)" },
    { zip3: z, state: "AZ", commodity: "electric" as const, utilityName: "Salt River Project (SRP)" },
    { zip3: z, state: "AZ", commodity: "gas" as const, utilityName: "Southwest Gas" },
    { zip3: z, state: "AZ", commodity: "water" as const, utilityName: "City of Phoenix Water Services (municipal)" },
  ]),
  // --- Tucson metro (856–857): TEP electric; Southwest Gas ---
  ...["856", "857"].flatMap((z) => [
    { zip3: z, state: "AZ", commodity: "electric" as const, utilityName: "Tucson Electric Power (TEP)" },
    { zip3: z, state: "AZ", commodity: "gas" as const, utilityName: "Southwest Gas" },
    { zip3: z, state: "AZ", commodity: "water" as const, utilityName: "Tucson Water (municipal)" },
  ]),
  // --- Northern AZ (860): APS electric; UNS Gas ---
  { zip3: "860", state: "AZ", commodity: "electric", utilityName: "Arizona Public Service (APS)" },
  { zip3: "860", state: "AZ", commodity: "gas", utilityName: "UNS Gas" },
  { zip3: "860", state: "AZ", commodity: "water", utilityName: "City of Flagstaff Water Services (municipal)" },
  // --- Yuma (864): APS electric; Southwest Gas ---
  { zip3: "864", state: "AZ", commodity: "electric", utilityName: "Arizona Public Service (APS)" },
  { zip3: "864", state: "AZ", commodity: "gas", utilityName: "Southwest Gas" },
  { zip3: "864", state: "AZ", commodity: "water", utilityName: "City of Yuma Utilities (municipal)" },
];

/**
 * ZIP3s the registry covers for a commodity with ZERO serving utilities —
 * i.e., positively known unserved territory. Kept separate from SEED (which
 * only stores serving rows) via sentinel rows with utilityName = "".
 * Example: 865 (Gallup NM border area routed via AZ) has no piped-gas LDC.
 */
const KNOWN_UNSERVED: Array<{ zip3: string; state: string; commodity: Commodity }> = [
  { zip3: "865", state: "AZ", commodity: "gas" },
];

let seededOnce = false;

/** Idempotent seeding, mirroring the seedIncentives pattern. */
export async function seedServiceTerritories(): Promise<void> {
  if (seededOnce) return;
  const db = await getDb();
  if (!db) return;
  const existing = await db.select({ id: serviceTerritories.id }).from(serviceTerritories).limit(1);
  if (existing.length > 0) {
    seededOnce = true;
    return;
  }
  const rows = [
    ...SEED.map((s) => ({ ...s, sourceVersion: SOURCE_VERSION })),
    ...KNOWN_UNSERVED.map((s) => ({ ...s, utilityName: "", sourceVersion: SOURCE_VERSION })),
  ];
  await db.insert(serviceTerritories).values(rows);
  seededOnce = true;
}

/**
 * Look up which utilities serve a ZIP3 for a commodity.
 * covered=false means the registry has no opinion — fall back to state level.
 */
export async function lookupTerritory(zip: string | null | undefined, commodity: Commodity): Promise<TerritoryLookup> {
  const zip3 = (zip ?? "").replace(/\D/g, "").slice(0, 3);
  if (zip3.length !== 3) return { covered: false, utilities: [], served: null, sourceVersion: null };
  const db = await getDb();
  if (!db) return { covered: false, utilities: [], served: null, sourceVersion: null };
  await seedServiceTerritories();
  const rows = await db
    .select()
    .from(serviceTerritories)
    .where(and(eq(serviceTerritories.zip3, zip3), eq(serviceTerritories.commodity, commodity)));
  if (rows.length === 0) return { covered: false, utilities: [], served: null, sourceVersion: null };
  const utilities = rows.map((r) => r.utilityName).filter((n): n is string => !!n);
  return {
    covered: true,
    utilities,
    served: utilities.length > 0,
    sourceVersion: rows[0].sourceVersion,
  };
}
