/**
 * IMP-1/IMP-2 (owner directive Jul 22): per-site dollar-impact estimates when
 * a filed rate changes.
 *
 * When the currency engine records a rate change (auto-applied adjustor update
 * or a flagged larger change), we compute a projected $/yr delta for every
 * site plausibly served by the changed tariff(s):
 *
 *   affected := meters whose commodity matches the tariff AND whose site is in
 *   the tariff's state AND (the meter's assigned tariff IS one of the changed
 *   rows, OR the site's utilityName matches the tariff's utility).
 *
 * Usage basis (honest, best-available ladder):
 *   1. metered  — sum of the meter's most recent ≤365 days of intervals,
 *                 annualized by observed-day coverage
 *   2. billed   — sum of usage on the meter's bills over its most recent
 *                 ≤365-day billed span, annualized
 *   3. none     — site listed as affected with no dollar estimate (we never
 *                 invent usage)
 *
 * Impact math per changed rate row:
 *   ΔUsd/yr = annualUsage × Δ(volumetric $/unit, first-tier/blended label
 *             deltas averaged) + 12 × Δ(fixedMonthly)
 * This is a projection holding usage constant — disclosed as such. TOU-period
 * deltas are averaged unweighted (we do not claim knowledge of the site's
 * TOU split for this estimate).
 *
 * Results persist on the rate_verifications.impact json column so the
 * Dashboard timeline and owner notifications can surface "N sites, ~$X/yr"
 * without recomputation.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { bills, intervals, meters, rateVerifications, sites, tariffs } from "../drizzle/schema";
import { utilityNamesMatch } from "./urdbImport";

const DAY_MS = 86_400_000;

export interface RateDelta {
  urdbId: string;
  /** volumetric deltas in $/unit (kWh, therm, kgal) — signed */
  volumetricDeltas: number[];
  /** signed fixed-monthly delta in $ */
  fixedMonthlyDelta: number;
}

export interface SiteImpact {
  siteId: number;
  siteName: string;
  meterId: number;
  urdbId: string;
  /** projected signed $/yr change; null when no usage basis exists */
  estUsdYrDelta: number | null;
  /** metered | billed | none */
  usageBasis: "metered" | "billed" | "none";
  annualUsage: number | null;
}

export interface ImpactSummary {
  affectedSites: number;
  totalUsdYrDelta: number;
  perSite: SiteImpact[];
  disclosure: string;
}

/** Estimate a meter's annual usage from its own data. Never fabricates. */
async function estimateAnnualUsage(meterId: number): Promise<{ annual: number; basis: "metered" | "billed" } | null> {
  const db = await getDb();
  if (!db) return null;
  const cutoff = Date.now() - 365 * DAY_MS;
  // 1. metered
  const pts = await db
    .select({ ts: intervals.ts, usage: intervals.usage, durationMin: intervals.durationMin })
    .from(intervals)
    .where(and(eq(intervals.meterId, meterId), gte(intervals.ts, cutoff)))
    .orderBy(desc(intervals.ts))
    .limit(40000);
  if (pts.length > 0) {
    const minTs = pts[pts.length - 1].ts;
    const maxTs = pts[0].ts + (pts[0].durationMin ?? 60) * 60_000;
    const spanDays = Math.max(1, (maxTs - minTs) / DAY_MS);
    if (spanDays >= 28) {
      const total = pts.reduce((s, p) => s + (p.usage ?? 0), 0);
      return { annual: (total / spanDays) * 365, basis: "metered" };
    }
  }
  // 2. billed
  const bs = await db
    .select({ periodStart: bills.periodStart, periodEnd: bills.periodEnd, usage: bills.usage })
    .from(bills)
    .where(eq(bills.meterId, meterId))
    .orderBy(desc(bills.periodEnd))
    .limit(14);
  const withUsage = bs.filter((b) => b.usage != null && b.usage > 0);
  if (withUsage.length > 0) {
    const newest = withUsage[0].periodEnd instanceof Date ? withUsage[0].periodEnd.getTime() : new Date(withUsage[0].periodEnd as unknown as string).getTime();
    const oldest = withUsage[withUsage.length - 1].periodStart instanceof Date ? withUsage[withUsage.length - 1].periodStart.getTime() : new Date(withUsage[withUsage.length - 1].periodStart as unknown as string).getTime();
    const spanDays = Math.max(1, (newest - oldest) / DAY_MS);
    if (spanDays >= 28) {
      const total = withUsage.reduce((s, b) => s + (b.usage ?? 0), 0);
      return { annual: (total / spanDays) * 365, basis: "billed" };
    }
  }
  return null;
}

/** Compute per-site impact for a set of changed tariff rows.
 *  `deltas` carries the signed rate movements captured while applying/observing
 *  the change. Projection holds each site's usage constant. */
export async function computeRateChangeImpact(deltas: RateDelta[], opts?: { maxSites?: number }): Promise<ImpactSummary | null> {
  const db = await getDb();
  if (!db) return null;
  const urdbIds = deltas.map((d) => d.urdbId);
  if (urdbIds.length === 0) return null;
  const rows = await db.select().from(tariffs).where(inArray(tariffs.urdbId, urdbIds));
  if (rows.length === 0) return null;
  const deltaByUrdb = new Map(deltas.map((d) => [d.urdbId, d]));

  const perSite: SiteImpact[] = [];
  const seenMeter = new Set<string>();
  const cap = opts?.maxSites ?? 200;

  for (const t of rows) {
    const d = deltaByUrdb.get(t.urdbId ?? "");
    if (!d) continue;
    // candidate meters: commodity match, site state match, utility/assignment match
    const candidates = await db
      .select({
        meterId: meters.id,
        siteId: sites.id,
        siteName: sites.name,
        siteState: sites.state,
        siteUtility: sites.utilityName,
        currentTariffId: meters.currentTariffId,
      })
      .from(meters)
      .innerJoin(sites, eq(meters.siteId, sites.id))
      .where(eq(meters.commodity, t.commodity as "electric" | "gas" | "water"))
      .limit(2000);
    for (const c of candidates) {
      if (perSite.length >= cap) break;
      const key = `${c.meterId}:${t.urdbId}`;
      if (seenMeter.has(key)) continue;
      const assignedMatch = c.currentTariffId === t.id;
      const stateMatch = (c.siteState ?? "").toUpperCase() === (t.state ?? "").toUpperCase();
      const utilityMatch = stateMatch && c.siteUtility != null && c.siteUtility.length > 1 && utilityNamesMatch(c.siteUtility, t.utilityName);
      if (!assignedMatch && !utilityMatch) continue;
      seenMeter.add(key);
      const usage = await estimateAnnualUsage(c.meterId);
      const avgVolDelta = d.volumetricDeltas.length > 0 ? d.volumetricDeltas.reduce((s, x) => s + x, 0) / d.volumetricDeltas.length : 0;
      const est = usage ? usage.annual * avgVolDelta + 12 * d.fixedMonthlyDelta : d.fixedMonthlyDelta !== 0 ? 12 * d.fixedMonthlyDelta : null;
      perSite.push({
        siteId: c.siteId,
        siteName: c.siteName,
        meterId: c.meterId,
        urdbId: t.urdbId ?? "",
        estUsdYrDelta: est == null ? null : Math.round(est * 100) / 100,
        usageBasis: usage?.basis ?? "none",
        annualUsage: usage ? Math.round(usage.annual) : null,
      });
    }
  }

  const uniqueSites = new Set(perSite.map((p) => p.siteId));
  const total = perSite.reduce((s, p) => s + (p.estUsdYrDelta ?? 0), 0);
  return {
    affectedSites: uniqueSites.size,
    totalUsdYrDelta: Math.round(total * 100) / 100,
    perSite,
    disclosure:
      "Projected impact holds each site's recent usage constant (metered or billed basis; sites without usage data are listed without a dollar estimate). TOU-period deltas are averaged unweighted — actual impact depends on when energy is used.",
  };
}

/** Attach an impact summary to the most recent verification rows for a source.
 *  Called by the currency engine right after it records a change. */
export async function attachImpactToVerifications(sourceKey: string, sinceTs: number, impact: ImpactSummary): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const recent = await db
    .select({ id: rateVerifications.id })
    .from(rateVerifications)
    .where(and(eq(rateVerifications.sourceKey, sourceKey), gte(rateVerifications.checkedAt, sinceTs)))
    .limit(50);
  if (recent.length === 0) return 0;
  await db
    .update(rateVerifications)
    .set({ impact: impact as unknown as object })
    .where(inArray(rateVerifications.id, recent.map((r) => r.id)));
  return recent.length;
}
