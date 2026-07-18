/**
 * §3f/§3i — Monthly digest + alerts engine.
 *
 * Contract (from the UX addendum):
 *  - Quiet by default. Only opted-in users get a digest; alerts batch daily
 *    (one open row per site+kind) and only exist above a $ materiality floor.
 *  - "A dollar figure or it doesn't send": buildDigest returns null when no
 *    material dollar content exists for the cycle — the cron then does
 *    nothing, honestly.
 *  - Delivery today = in-app alert record + owner notification (real channels
 *    that exist). Email delivery remains labeled post-beta in the UI.
 *
 * The digest cron is a per-user Heartbeat job created/destroyed from the
 * digest settings mutation (end-user-driven Heartbeat pattern — see
 * server/_core/heartbeat.ts).
 */
import * as h from "./dbHelpers";

export type DigestContent = {
  headlineUsd: number;
  headline: string;
  lines: string[];
};

/** Assemble the user's monthly digest. Returns null when there is no material
 * dollar figure to report — in which case NOTHING is sent (the rule). */
export async function buildDigest(userId: number): Promise<DigestContent | null> {
  const sites = await h.listSites(userId);
  if (sites.length === 0) return null;

  let verifiedUsd = 0;
  let openOppUsd = 0;
  let bestOpp: { title: string; usd: number; site: string } | null = null;
  const lines: string[] = [];

  for (const site of sites) {
    // cumulative verified savings from the prove-it ledger
    try {
      const impls = await h.listMeasureImplementations(site.id, userId);
      for (const impl of impls) {
        const v = Number((impl as { verifiedSavingsUsd?: unknown }).verifiedSavingsUsd ?? 0);
        if (Number.isFinite(v) && v > 0) verifiedUsd += v;
      }
    } catch {
      /* site without implementations — fine */
    }
    // open opportunity dollars
    try {
      const opps = await h.listOpportunities(site.id, userId);
      for (const o of opps) {
        const usd = Number((o as { estCostSavingsPerYr?: unknown }).estCostSavingsPerYr ?? 0);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        openOppUsd += usd;
        if (!bestOpp || usd > bestOpp.usd) bestOpp = { title: (o as { title: string }).title, usd, site: site.name };
      }
    } catch {
      /* no opportunities yet */
    }
  }

  const headlineUsd = verifiedUsd > 0 ? verifiedUsd : openOppUsd;
  // The rule: a dollar figure or it doesn't send. $25 materiality floor,
  // matching the alert floor — below that we stay silent.
  if (!Number.isFinite(headlineUsd) || headlineUsd < 25) return null;

  const headline =
    verifiedUsd > 0
      ? `$${Math.round(verifiedUsd).toLocaleString()} verified saved to date across ${sites.length} site${sites.length === 1 ? "" : "s"}.`
      : `$${Math.round(openOppUsd).toLocaleString()}/yr in modeled opportunities remains open across ${sites.length} site${sites.length === 1 ? "" : "s"}.`;

  if (verifiedUsd > 0 && openOppUsd > 0) {
    lines.push(`$${Math.round(openOppUsd).toLocaleString()}/yr in modeled opportunities is still open.`);
  }
  if (bestOpp) {
    lines.push(`Biggest single move: ${bestOpp.title} at ${bestOpp.site} (~$${Math.round(bestOpp.usd).toLocaleString()}/yr, modeled).`);
  }
  lines.push("Figures are modeled estimates unless marked verified; verified figures come from the measured prove-it ledger.");

  return { headlineUsd, headline, lines };
}

/** Run one digest cycle for a user: build content, and if material, persist it
 * as an in-app digest alert (batched — refreshes the open row). Returns what
 * happened for cron observability. */
export async function runDigestCycle(userId: number): Promise<{ sent: boolean; reason?: string; headline?: string }> {
  const prefs = await h.getDigestPrefs(userId);
  if (!prefs?.digestOptIn) return { sent: false, reason: "not-opted-in" };
  const content = await buildDigest(userId);
  if (!content) return { sent: false, reason: "no-material-dollar-figure" };

  // attach to the user's first site for the site-scoped alert row (digest is
  // account-level; siteId anchors the record for cascade cleanliness)
  const sites = await h.listSites(userId);
  const anchorSite = sites[0];
  if (!anchorSite) return { sent: false, reason: "no-sites" };

  await h.upsertAlert({
    userId,
    siteId: anchorSite.id,
    kind: "digest",
    title: content.headline,
    body: content.lines.join("\n"),
    dollarImpactUsd: content.headlineUsd,
    confidence: "modeled unless marked verified",
  });
  return { sent: true, headline: content.headline };
}
