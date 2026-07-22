/**
 * NAT-3 (Jul 22) — Nationwide filed-quality electric rate acquisition.
 *
 * The OpenEI Utility Rate Database (URDB) publishes every U.S. utility's filed
 * rates as a public bulk download. A sandbox-side distillation
 * (scripts/distill-urdb.py) reduces the 166k-row bulk CSV to one best
 * residential + one best commercial rate per utility (~4,900 rates), checked
 * in at server/seed/urdbDistilled.json with full provenance (URDB label,
 * rate name, effective date, freshness flags).
 *
 * importUrdbNationwide() joins that distillation against the EIA-861-derived
 * ZIP3 service-territory registry so every registry electric utility gains
 * filed-quality default rates:
 *  - utilityName is stored as the REGISTRY name (so territory partition
 *    matches at analysis time); the URDB utility name is kept in notes.
 *  - hand-modeled rows (source = urdb_snapshot_modeled) always win: any
 *    utility+sector already covered by a hand row is skipped.
 *  - delivery-only rates (deregulated states) carry an explicit disclosure —
 *    supply is priced separately and the total will be higher.
 *  - stale picks (URDB not updated since 2023) import with verifyStatus
 *    "due" so the verification agent re-checks them before they're trusted.
 *  - TOU rates import their first-period rate with a disclosure; the
 *    verification agent upgrades them to full TOU structure over time.
 *
 * This is deliberately idempotent: re-running upgrades nothing silently and
 * inserts only missing utility+sector pairs.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { rateAcquisitionQueue, serviceTerritories, tariffs } from "../drizzle/schema";
import type { TariffStructure, TouPeriod } from "@shared/wattwise";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface DistilledRate {
  label: string;
  eiaid: string;
  utility: string;
  sector: "Residential" | "Commercial";
  name: string;
  isDefault: boolean;
  startdate: string;
  latestUpdate: string;
  fixedMonthly: number;
  fixedUnits: string;
  tiers: { ratePerUnit: number; maxUsage: number | null }[];
  tou: boolean;
  p1Rate: number | null;
  hasDemand: boolean;
  source: string;
  candidateCount: number;
  stale: boolean;
  deliveryOnly: boolean;
}

/** Lazily loaded on first use — the 2.5MB distillation is only needed during
 * the one-time nationwide import, not on every server boot or handler call. */
let distilledCache: DistilledRate[] | null = null;
function loadDistilled(): DistilledRate[] {
  if (distilledCache) return distilledCache;
  const here = dirname(fileURLToPath(import.meta.url));
  // Dev: this module lives at server/urdbImport.ts → server/seed/…
  // Prod: esbuild bundles to dist/index.js → the JSON is NOT bundled, so
  // resolve relative to the project root (cwd) as the fallback.
  const candidates = [
    join(here, "seed", "urdbDistilled.json"),
    join(process.cwd(), "server", "seed", "urdbDistilled.json"),
  ];
  for (const p of candidates) {
    try {
      distilledCache = JSON.parse(readFileSync(p, "utf-8")) as DistilledRate[];
      return distilledCache;
    } catch {
      /* try next */
    }
  }
  // No distillation available (e.g. slim deploy) — import becomes a no-op
  // rather than a crash; acquisition queue still self-heals gaps via agent.
  distilledCache = [];
  return distilledCache;
}

export const URDB_BULK_SOURCE = "urdb_bulk_2026_07";
export const URDB_RATE_URL = (label: string) => `https://apps.openei.org/USURDB/rate/view/${label}`;

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Normalize a utility name for cross-source matching: lowercase, unify
 * and/&, strip corporate suffixes, punctuation, and commodity parentheticals. */
export function normalizeUtilityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[.,'’-]/g, " ")
    .replace(/\b(company|co|corp|corporation|inc|incorporated|llc|ltd|holdings|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Registry names often carry state qualifiers or abbreviations that the
 * URDB's legal names don't ("Rocky Mountain Power Wyoming" vs "PacifiCorp";
 * "Con Edison" vs "Consolidated Edison Co-NY Inc"). Aliases map normalized
 * registry tokens to normalized URDB-name fragments. */
const UTILITY_ALIASES: [RegExp, string][] = [
  [/^rocky mountain power\b/, "pacificorp"],
  [/^pacific power\b/, "pacificorp"],
  [/^con edison$/, "consolidated edison"],
  [/^pnm\b/, "public service of new mexico"],
  [/^pso\b/, "public service of oklahoma"],
  [/^nv energy$/, "nevada power"],
  [/^mon power\b/, "monongahela power"],
  [/^jersey central power and light\b/, "jersey central power lt"],
  [/^aes indiana$/, "indianapolis power and light"],
  [/^rhode island energy$/, "narragansett electric"],
  [/^duke energy progress$/, "duke energy progress"],
  [/^appalachian power\b/, "appalachian power"],
  [/^dominion energy south carolina$/, "dominion energy south carolina"],
  [/^entergy arkansas\b/, "entergy arkansas"],
  [/^avista\b/, "avista"],
  [/^eversource\b/, "eversource"],
  [/^xcel energy\b/, "northern states power"],
  [/^alliant energy wisconsin\b/, "wisconsin power and light"],
  [/^black hills energy\b/, "black hills"],
  [/^chugach electric\b/, "chugach electric"],
  [/^duke energy ohio$/, "duke energy ohio"],
  [/^lg and e and ku energy$/, "louisville gas and electric"],
  [/^eversource connecticut$/, "connecticut light and power"],
  [/^eversource massachusetts$/, "nstar electric"],
  [/^eversource new hampshire$/, "public service of new hampshire"],
  [/^national grid massachusetts$/, "massachusetts electric"],
  [/^national grid new york$/, "niagara mohawk power"],
  [/^pse and g$/, "public service elec and gas"],
  [/^aep ohio$/, "ohio power"],
  [/^firstenergy pennsylvania/, "metropolitan edison"],
  [/^comed$/, "commonwealth edison"],
  [/^evergy kansas$/, "westar energy"],
  [/^evergy missouri$/, "kansas city power and light"],
  [/^nyseg$/, "new york state elec and gas"],
  [/^we energies$/, "wisconsin electric power"],
  [/^pepco$/, "potomac electric power"],
  [/^peco$/, "peco energy"],
  [/^seattle city light$/, "city of seattle washington"],
  [/^versant power$/, "bangor hydro electric"],
  [/^alliant energy \(ipl\)$|^alliant energy ipl$/, "interstate power and light"],
  [/^jersey central power and light$/, "jersey central power and lt"],
  [/^og and e\b/, "oklahoma gas and electric"],
  [/^alliant energy$/, "interstate power and light"],
  [/^firstenergy ohio\b/, "ohio edison"],
  [/^appalachian power$/, "appalachian power co"],
  [/^appalachian power west virginia$/, "appalachian power co"],
  [/^dominion energy virginia$/, "virginia electric and power"],
  [/^dominion energy south carolina$/, "south carolina electric and gas"],
];

/** Expand a normalized registry name to candidate match tokens: the name
 * itself, the name with trailing state words stripped, and any alias. */
function candidateTokens(normalized: string): string[] {
  const tokens = [normalized];
  // strip a trailing state qualifier (one or two words) commonly appended in
  // the registry, e.g. "duke energy ohio", "eversource new hampshire"
  const STATE_WORDS =
    /\s+(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/;
  const stripped = normalized.replace(STATE_WORDS, "").trim();
  if (stripped !== normalized && stripped.length >= 4) tokens.push(stripped);
  for (const [pattern, alias] of UTILITY_ALIASES) {
    if (pattern.test(normalized)) tokens.push(alias);
  }
  // drop parenthetical abbreviations already removed by normalize; also add
  // the text before any remaining parenthetical
  return tokens;
}

/** True when two normalized utility names refer to the same utility:
 * exact, alias, or one contains the other (registry names are often shorter). */
export function utilityNamesMatch(a: string, b: string): boolean {
  const na = normalizeUtilityName(a);
  const nb = normalizeUtilityName(b);
  if (!na || !nb) return false;
  const tokensA = candidateTokens(na);
  const tokensB = candidateTokens(nb);
  for (const ta of tokensA) {
    for (const tb of tokensB) {
      if (ta === tb) return true;
      // containment requires the shorter side to be a meaningful name (2+
      // words or 8+ chars) to avoid "salt" matching "salt river project"
      const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
      if (shorter.length < 8 && !shorter.includes(" ")) continue;
      if (longer.includes(shorter)) return true;
    }
  }
  return false;
}

/** Convert a distilled URDB rate to the engine's TariffStructure. Tiered
 * rates are flattened to the first-tier rate with the tier schedule named in
 * the label (the cost engine prices TouPeriod, not usage tiers; the first
 * tier is the rate most usage falls in and the label discloses the rest). */
export function distilledToStructure(r: DistilledRate): TariffStructure {
  const energy: TouPeriod[] = [];
  const t0 = r.tiers[0];
  let label = "All hours";
  if (r.tiers.length > 1) {
    const tierDesc = r.tiers
      .map((t, i) => `tier ${i + 1} $${t.ratePerUnit.toFixed(4)}${t.maxUsage ? ` to ${t.maxUsage}` : ""}`)
      .join(", ");
    label = `First tier shown (${tierDesc})`;
  } else if (r.tou && r.p1Rate != null) {
    label = `First TOU period shown (second period $${r.p1Rate.toFixed(4)}/kWh — full TOU windows pending verification)`;
  }
  energy.push({
    label,
    months: ALL_MONTHS,
    daysOfWeek: ALL_DAYS,
    hourStart: 0,
    hourEnd: 24,
    ratePerUnit: t0.ratePerUnit,
  });
  return { fixedMonthly: r.fixedMonthly, energy, demand: [] };
}

export function importNotes(r: DistilledRate): string {
  const parts = [
    `URDB ${r.label} — ${r.utility}: ${r.name}`,
    r.startdate ? `effective ${r.startdate}` : "",
    r.latestUpdate ? `URDB updated ${r.latestUpdate}` : "",
    r.deliveryOnly
      ? "DELIVERY-ONLY disclosure: this rate covers delivery/distribution; energy supply is priced separately in this market and your all-in cost will be higher."
      : "",
    r.tou ? "TOU rate imported flat (first period); full windows pending agent verification." : "",
    r.stale ? "URDB snapshot predates 2023 — flagged due for re-verification before trusting." : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

export interface UrdbImportResult {
  imported: number;
  skippedExisting: number;
  noMatch: string[];
  errors: string[];
}

/**
 * Import URDB filed-quality electric rates for every utility in the ZIP3
 * service-territory registry that lacks them. Idempotent.
 */
export async function importUrdbNationwide(): Promise<UrdbImportResult> {
  const db = await getDb();
  if (!db) return { imported: 0, skippedExisting: 0, noMatch: [], errors: ["no db"] };

  // 1) registry electric utilities with their dominant state
  const regRows = await db
    .select({
      utilityName: serviceTerritories.utilityName,
      state: serviceTerritories.state,
      n: sql<number>`COUNT(*)`,
    })
    .from(serviceTerritories)
    .where(and(eq(serviceTerritories.commodity, "electric"), sql`${serviceTerritories.utilityName} != ''`))
    .groupBy(serviceTerritories.utilityName, serviceTerritories.state);
  // dominant state per utility (utilities can span states)
  const byUtility = new Map<string, { state: string; n: number }>();
  for (const r of regRows) {
    const cur = byUtility.get(r.utilityName);
    if (!cur || r.n > cur.n) byUtility.set(r.utilityName, { state: r.state, n: r.n });
  }

  // 2) existing electric tariff coverage (any filed-quality source)
  const existing = await db
    .select({ utilityName: tariffs.utilityName, sector: tariffs.sector, source: tariffs.source })
    .from(tariffs)
    .where(eq(tariffs.commodity, "electric"));
  const filedSources = new Set(["urdb_snapshot_modeled", URDB_BULK_SOURCE, "agent_acquired"]);
  const covered = existing.filter((t) => filedSources.has(t.source));

  const result: UrdbImportResult = { imported: 0, skippedExisting: 0, noMatch: [], errors: [] };
  const now = Date.now();

  for (const [regName, info] of Array.from(byUtility.entries())) {
    for (const sector of ["Residential", "Commercial"] as const) {
      const sectorLc = sector.toLowerCase() as "residential" | "commercial";
      // skip when a filed row already covers this utility+sector
      const already = covered.some(
        (t) => t.sector === sectorLc && utilityNamesMatch(t.utilityName, regName),
      );
      if (already) {
        result.skippedExisting++;
        continue;
      }
      const match = loadDistilled().find(
        (d) => d.sector === sector && utilityNamesMatch(d.utility, regName),
      );
      if (!match) {
        if (sector === "Residential" && !result.noMatch.includes(regName)) result.noMatch.push(regName);
        // systemic self-healing: any utility×sector URDB can't fill is queued
        // for the monthly verification agent to acquire from official tariffs
        try {
          await enqueueAcquisition(regName, info.state, "electric");
        } catch {
          /* queue is best-effort */
        }
        continue;
      }
      try {
        await db.insert(tariffs).values({
          urdbId: `urdb-${match.label}`,
          utilityName: regName, // registry name → territory partition matches
          name: `${match.name} (URDB filed snapshot)`,
          sector: sectorLc,
          commodity: "electric",
          state: info.state,
          structure: distilledToStructure(match) as unknown as Record<string, unknown>,
          freshness: match.stale ? "urdb_stale" : "urdb_refreshed_150",
          effectiveDate: match.startdate ? new Date(match.startdate) : null,
          source: URDB_BULK_SOURCE,
          sourceVersion: "2026.07",
          sourceUrl: URDB_RATE_URL(match.label),
          lastVerifiedAt: match.stale ? null : now,
          verifyStatus: match.stale ? "due" : "current",
        });
        result.imported++;
      } catch (e) {
        result.errors.push(`${regName}/${sectorLc}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return result;
}

/**
 * NAT-5 auto-enrollment: record that a site needs filed rates for a utility
 * we don't cover yet. Upserts by utility+state+commodity, bumping demandCount.
 */
export async function enqueueAcquisition(
  utilityName: string,
  state: string,
  commodity: "electric" | "gas" | "water",
  requestedBySiteId?: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db
    .select({ id: rateAcquisitionQueue.id, demandCount: rateAcquisitionQueue.demandCount, status: rateAcquisitionQueue.status })
    .from(rateAcquisitionQueue)
    .where(
      and(
        eq(rateAcquisitionQueue.utilityName, utilityName),
        eq(rateAcquisitionQueue.state, state),
        eq(rateAcquisitionQueue.commodity, commodity),
      ),
    )
    .limit(1);
  if (rows.length > 0) {
    // bump demand on live entries; leave acquired ones alone
    if (rows[0].status === "pending" || rows[0].status === "dispatched" || rows[0].status === "failed") {
      await db
        .update(rateAcquisitionQueue)
        .set({ demandCount: rows[0].demandCount + 1 })
        .where(eq(rateAcquisitionQueue.id, rows[0].id));
    }
    return;
  }
  await db.insert(rateAcquisitionQueue).values({
    utilityName,
    state,
    commodity,
    requestedBySiteId: requestedBySiteId ?? null,
    status: "pending",
    demandCount: 1,
  });
}

/** Pending acquisition targets for the monthly verification agent, highest
 * demand first. */
export async function pendingAcquisitions(limit = 5) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rateAcquisitionQueue)
    .where(inArray(rateAcquisitionQueue.status, ["pending", "failed"]))
    .orderBy(sql`${rateAcquisitionQueue.demandCount} DESC, ${rateAcquisitionQueue.createdAt} ASC`)
    .limit(limit);
}
