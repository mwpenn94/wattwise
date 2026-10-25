/**
 * Oct 24 (RC3, Joel demo regression): editing a site's address retires the
 * live analysis (location-dependent figures are stale) — and previously
 * NOTHING re-ran, so Explore showed an empty site mid-presentation. A location
 * change now queues one background pass, in order:
 *   1. refresh public-record property facts for the NEW address (may fill a
 *      floor-area estimate under the conservative auto-apply rules), then
 *   2. re-run the analysis on the same meter selection Explore would use.
 * Fail-open: any error leaves the disclosed "rerun analysis" state, never a
 * crash. One in-flight pass per site; a second edit during a pass schedules
 * exactly one follow-up pass.
 */
import * as h from "./dbHelpers";
import { materializeVirtualTotal, pickSiteAnalysisMeter } from "./virtualTotal";

type Tier = Parameters<typeof import("./analytics/pipeline").runAnalysisPipeline>[3];
const inFlight = new Map<number, Promise<ReanalysisResult>>();
const followUp = new Map<number, { userId: number; tier: Tier }>();

export interface ReanalysisResult {
  ran: boolean;
  analysisId?: number;
  reason?: string;
}

export async function reanalyzeSite(siteId: number, userId: number, tier: Tier): Promise<ReanalysisResult> {
  const before = await h.getSite(siteId, userId);
  if (!before) return { ran: false, reason: "site_not_found" };
  try {
    const pf = await import("./propertyFacts");
    if (pf.propertyFactsNetworkAvailable()) await pf.refreshPropertyFacts(siteId, { allowAutoApply: true, force: true });
  } catch {
    /* property facts are enrichment only */
  }
  const site = await h.getSite(siteId, userId);
  if (!site) return { ran: false, reason: "site_not_found" };
  await materializeVirtualTotal(siteId, userId).catch(() => null);
  const meter = pickSiteAnalysisMeter(await h.listMeters(siteId, userId));
  const { runAnalysisPipeline } = await import("./analytics/pipeline");
  const result = await runAnalysisPipeline(site, meter, userId, tier);
  return { ran: true, analysisId: result.analysisId };
}

/** Fire-and-forget wrapper used by sites.update. Returns true when queued. */
export function queueSiteReanalysis(siteId: number, userId: number, tier: Tier): boolean {
  if (process.env.VITEST && process.env.WW_BACKGROUND_REANALYSIS !== "1") return false;
  if (inFlight.has(siteId)) {
    followUp.set(siteId, { userId, tier });
    return true;
  }
  const run = reanalyzeSite(siteId, userId, tier)
    .catch((error) => {
      console.warn(`[reanalysis] site=${siteId} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return { ran: false, reason: "error" } as ReanalysisResult;
    })
    .finally(() => {
      inFlight.delete(siteId);
      const next = followUp.get(siteId);
      if (next) {
        followUp.delete(siteId);
        queueSiteReanalysis(siteId, next.userId, next.tier);
      }
    });
  inFlight.set(siteId, run);
  return true;
}

export function reanalysisInFlight(siteId: number): boolean {
  return inFlight.has(siteId);
}
