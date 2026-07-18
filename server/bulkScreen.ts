/**
 * §3i-2 Bulk site screening (Pro) — paste/upload a list of addresses, get a
 * ranked screening table of estimated annual cost + top opportunity per row.
 *
 * Honesty contract:
 *  - Every row is an archetype-based ESTIMATE (same engine as the public
 *    estimator) — labeled as such, never presented as measured.
 *  - Rows that cannot be parsed or estimated are returned with their error
 *    named, not silently dropped and not zero-filled.
 *  - Hard cap of 50 rows per screen; deterministic (no LLM cost); Pro-gated
 *    and rate-limited at the router.
 *
 * Input format: one address per line, optionally "address, type" where type
 * is a known building type token (defaults to the caller-provided default).
 */
import { computeAddressEstimate } from "./estimate";
import { BUILDING_PRIORS } from "./cascade";

export const BULK_SCREEN_MAX_ROWS = 50;

export interface BulkScreenRow {
  input: string;
  address: string;
  buildingType: string;
  status: "estimated" | "failed";
  error: string | null;
  estimatedAnnualCostUsd: number | null;
  estimatedAnnualKwh: number | null;
  topOpportunity: { title: string; estimatedSavingsUsd: number } | null;
  state: string | null;
  rank: number | null;
}

export interface BulkScreenResult {
  rows: BulkScreenRow[];
  requested: number;
  estimated: number;
  failed: number;
  truncated: boolean;
  disclosure: string;
}

const KNOWN_TYPES = new Set(Object.keys(BUILDING_PRIORS));

/** Parse "address [, type]" lines. The last comma-separated token is treated
    as a building type ONLY when it exactly matches a known type token —
    otherwise it stays part of the address (cities contain commas). */
export function parseBulkLines(text: string, defaultType: string): Array<{ address: string; buildingType: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      const last = parts[parts.length - 1]?.toLowerCase().replace(/\s+/g, "_");
      if (parts.length > 1 && last && KNOWN_TYPES.has(last)) {
        return { address: parts.slice(0, -1).join(", "), buildingType: last };
      }
      return { address: line, buildingType: defaultType };
    });
}

export async function runBulkScreen(text: string, defaultType: string): Promise<BulkScreenResult> {
  const parsed = parseBulkLines(text, defaultType);
  const truncated = parsed.length > BULK_SCREEN_MAX_ROWS;
  const batch = parsed.slice(0, BULK_SCREEN_MAX_ROWS);
  const rows: BulkScreenRow[] = [];
  // Sequential on purpose: each estimate is a few DB reads; 50 rows stays well
  // under the request budget and avoids hammering the DB with 50 parallel
  // archetype/tariff scans.
  for (const item of batch) {
    try {
      const est = await computeAddressEstimate({
        formattedAddress: item.address,
        city: null,
        state: null,
        zip: null,
        placeVerified: false,
        buildingType: item.buildingType,
        sqft: null,
      });
      rows.push({
        input: item.address,
        address: item.address,
        buildingType: item.buildingType,
        status: "estimated",
        error: null,
        estimatedAnnualCostUsd: est.estimatedAnnualCostUsd,
        estimatedAnnualKwh: est.estimatedAnnualKwh,
        topOpportunity: est.topOpportunity ? { title: est.topOpportunity.title, estimatedSavingsUsd: est.topOpportunity.estimatedSavingsUsd } : null,
        state: est.grounding.location.state,
        rank: null,
      });
    } catch (e) {
      rows.push({
        input: item.address,
        address: item.address,
        buildingType: item.buildingType,
        status: "failed",
        error: e instanceof Error ? e.message : "estimate failed",
        estimatedAnnualCostUsd: null,
        estimatedAnnualKwh: null,
        topOpportunity: null,
        state: null,
        rank: null,
      });
    }
  }
  // Rank by top-opportunity dollars (the screening question is "where do I
  // look first", not "who spends most"); estimated rows first, failures last.
  const ranked = rows
    .filter((r) => r.status === "estimated")
    .sort((a, b) => (b.topOpportunity?.estimatedSavingsUsd ?? 0) - (a.topOpportunity?.estimatedSavingsUsd ?? 0));
  ranked.forEach((r, i) => (r.rank = i + 1));
  const failed = rows.filter((r) => r.status === "failed");
  return {
    rows: [...ranked, ...failed],
    requested: parsed.length,
    estimated: ranked.length,
    failed: failed.length,
    truncated,
    disclosure: `Screening estimates only — archetype models priced on seeded rates, not measured data. Addresses are parsed as typed (not geocode-verified). ${truncated ? `List truncated to the first ${BULK_SCREEN_MAX_ROWS} rows. ` : ""}Add a site and upload data to replace any estimate with measured analysis.`,
  };
}
