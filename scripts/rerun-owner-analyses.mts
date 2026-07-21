/**
 * One-off (Jul 21, CONF-1): re-run the analysis pipeline for every site owned
 * by the project owner so their summary insights carry the new ratePricing
 * provenance block. Older summaries predate provenance tracking and show as
 * "unknown" in the Portfolio rate-confidence card; a rerun tiers them.
 *
 * Run: npx tsx scripts/rerun-owner-analyses.mts
 */
import { getDb } from "../server/db";
import { users, sites, meters } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { runAnalysisPipeline } from "../server/analytics/pipeline";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  const ownerOpenId = process.env.OWNER_OPEN_ID;
  if (!ownerOpenId) throw new Error("OWNER_OPEN_ID not set");
  const owner = (await db.select().from(users).where(eq(users.openId, ownerOpenId)))[0];
  if (!owner) throw new Error("owner user not found");
  const ownerSites = await db.select().from(sites).where(eq(sites.userId, owner.id));
  console.log(`Re-running analyses for ${ownerSites.length} sites owned by ${owner.name ?? owner.openId}`);
  for (const site of ownerSites) {
    const siteMeters = await db.select().from(meters).where(eq(meters.siteId, site.id));
    const elec = siteMeters.find((m) => m.commodity === "electric") ?? siteMeters[0] ?? null;
    try {
      const res = await runAnalysisPipeline(site, elec, owner.id, "pro");
      console.log(`  ✓ ${site.name} (site ${site.id}) — analysis ${res.analysisId}, ${res.insightsCount} insights`);
    } catch (e) {
      console.error(`  ✗ ${site.name} (site ${site.id}) — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
