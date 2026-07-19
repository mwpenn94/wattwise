/**
 * GAP-I — de-identified cohort insights with the 15/15 privacy rule.
 *
 * "People like you" comparisons are only lawful/honest when the cohort is
 * large enough that no individual is inferable. The spec's rule (borrowed
 * from utility data-privacy conventions): render NOTHING below n=15.
 *
 * Design:
 *  - cohorts key on (state | buildingType | sqft band) — attributes users
 *    already share with us, never identity;
 *  - the aggregate is computed across ALL sites on the platform from their
 *    latest summary insight (annualized usage per sqft), stored in
 *    cohort_stats, recomputed opportunistically (at most once per week);
 *  - `cohortInsightFor` returns null unless the user's cohort has n≥15 —
 *    the caller renders nothing, not a teaser.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { cohortStats } from "../drizzle/schema";

const MIN_COHORT_N = 15;
const RECOMPUTE_MS = 7 * 24 * 3600 * 1000; // weekly

export function sqftBand(sqft: number | null): string {
  if (sqft == null || sqft <= 0) return "unknown";
  if (sqft < 2_500) return "<2.5k";
  if (sqft < 10_000) return "2.5k-10k";
  if (sqft < 50_000) return "10k-50k";
  if (sqft < 200_000) return "50k-200k";
  return "200k+";
}

export function cohortKeyFor(site: { state: string | null; buildingType: string | null; sqft: number | null }): string {
  return `${site.state ?? "??"}|${site.buildingType ?? "unknown"}|${sqftBand(site.sqft)}`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Recompute cohort stats across all sites (weekly, opportunistic). The
 * metric is annual kWh per sqft derived from each site's latest summary
 * insight — de-identified before it ever lands in cohort_stats. */
export async function recomputeCohorts(now = Date.now()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // Freshness check: skip if any row is newer than a week.
  const fresh = await db
    .select({ computedAt: cohortStats.computedAt })
    .from(cohortStats)
    .orderBy(sql`computedAt DESC`)
    .limit(1);
  if (fresh.length && now - fresh[0].computedAt < RECOMPUTE_MS) return 0;

  // Pull per-site EUI from the latest summary insights joined to sites.
  // Raw SQL keeps this a single de-identifying aggregation pass.
  const rows = (await db.execute(sql`
    SELECT s.state AS state, s.buildingType AS buildingType, s.sqft AS sqft,
           CAST(JSON_EXTRACT(i.metrics, '$.baseline.normalizedAnnualUsage') AS DOUBLE) AS annualKwh
    FROM insights i
    JOIN sites s ON s.id = i.siteId
    WHERE i.kind = 'summary'
      AND s.sqft IS NOT NULL AND s.sqft > 0
      AND JSON_EXTRACT(i.metrics, '$.baseline.normalizedAnnualUsage') IS NOT NULL
  `)) as unknown as [Array<{ state: string | null; buildingType: string | null; sqft: number; annualKwh: number | null }>, unknown];
  const data = Array.isArray(rows) ? (Array.isArray(rows[0]) ? rows[0] : (rows as unknown as typeof rows[0])) : [];

  const byCohort = new Map<string, number[]>();
  for (const r of data as Array<{ state: string | null; buildingType: string | null; sqft: number; annualKwh: number | null }>) {
    if (r.annualKwh == null || r.annualKwh <= 0 || !r.sqft) continue;
    const key = cohortKeyFor(r);
    const eui = r.annualKwh / r.sqft;
    if (!byCohort.has(key)) byCohort.set(key, []);
    byCohort.get(key)!.push(eui);
  }

  let written = 0;
  for (const [key, vals] of Array.from(byCohort.entries())) {
    // Store all cohorts (even small ones) — the RENDER gate is n≥15; storing
    // the count lets the gate be tested and the cohort grow into visibility.
    const sorted = vals.slice().sort((a, b) => a - b);
    await db
      .insert(cohortStats)
      .values({
        cohortKey: key,
        metricKey: "eui_kwh_sqft",
        n: sorted.length,
        p25: quantile(sorted, 0.25),
        median: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        computedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          n: sorted.length,
          p25: quantile(sorted, 0.25),
          median: quantile(sorted, 0.5),
          p75: quantile(sorted, 0.75),
          computedAt: now,
        },
      });
    written++;
  }
  return written;
}

export interface CohortInsight {
  cohortKey: string;
  n: number;
  siteEui: number;
  p25: number;
  median: number;
  p75: number;
  standing: "top_quartile" | "above_median" | "below_median" | "bottom_quartile";
  message: string;
}

/** The 15/15 gate lives HERE: below n=15 this returns null and the caller
 * renders nothing — no teaser, no "almost enough neighbors". */
export async function cohortInsightFor(site: {
  state: string | null;
  buildingType: string | null;
  sqft: number | null;
  annualKwh: number | null;
}): Promise<CohortInsight | null> {
  const db = await getDb();
  if (!db) return null;
  if (site.annualKwh == null || site.annualKwh <= 0 || !site.sqft || site.sqft <= 0) return null;
  const key = cohortKeyFor(site);
  const rows = await db
    .select()
    .from(cohortStats)
    .where(sql`cohortKey = ${key} AND metricKey = 'eui_kwh_sqft'`)
    .limit(1);
  const stat = rows[0];
  if (!stat || stat.n < MIN_COHORT_N) return null; // HARD privacy gate
  const eui = site.annualKwh / site.sqft;
  const standing =
    eui <= stat.p25 ? ("top_quartile" as const) : eui <= stat.median ? ("above_median" as const) : eui <= stat.p75 ? ("below_median" as const) : ("bottom_quartile" as const);
  const verb =
    standing === "top_quartile"
      ? "in the most efficient quarter of"
      : standing === "above_median"
        ? "more efficient than half of"
        : standing === "below_median"
          ? "using more than half of"
          : "in the least efficient quarter of";
  return {
    cohortKey: key,
    n: stat.n,
    siteEui: Math.round(eui * 100) / 100,
    p25: Math.round(stat.p25 * 100) / 100,
    median: Math.round(stat.median * 100) / 100,
    p75: Math.round(stat.p75 * 100) / 100,
    standing,
    message: `Compared with ${stat.n} similar buildings on Meterly (${key.replace(/\|/g, ", ")}), your site is ${verb} the group — ${Math.round(eui * 100) / 100} vs a median ${Math.round(stat.median * 100) / 100} kWh/sqft/yr. De-identified cohort; shown only because the group has at least ${MIN_COHORT_N} members.`,
  };
}

export { MIN_COHORT_N };
