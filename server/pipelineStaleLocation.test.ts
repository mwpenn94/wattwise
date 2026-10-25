/**
 * FA #3 / R3 #6 regression: an analysis computed for a superseded location must
 * never publish insights/opportunities over the "location changed" state.
 * Uses the dev database with a throwaway user + site; no intervals needed
 * (the pipeline runs its no-meter path, which still reaches the publish stage).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { analyses, insights, sites, users } from "../drizzle/schema";
import * as h from "./dbHelpers";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { ensureSeeded } from "./seed/runSeeders";

let userId = 0;
let siteId = 0;
beforeAll(async () => {
  await ensureSeeded();
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId: "vitest-stale-location", name: "stale", email: "stale@test.local", loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date() } });
  userId = (await db.select().from(users).where(eq(users.openId, "vitest-stale-location")))[0]!.id;
  siteId = await h.createSite({
    userId,
    name: `Stale location ${Date.now()}`,
    siteType: "office",
    sectorClass: "commercial",
    climateZone: "3B",
    state: "AZ",
    city: "Kingman",
    zip: "86401",
    floorAreaSqft: 20_000,
    isHypothetical: true,
  } as Parameters<typeof h.createSite>[0]);
}, 60_000);
afterAll(async () => {
  if (siteId) await h.deleteSite(siteId, userId).catch(() => undefined);
});

describe("pipeline location-revision publish guard", () => {
  it("fails the run and publishes nothing when the site moved after the run started", async () => {
    const db = (await getDb())!;
    const startedWith = await h.getSite(siteId, userId);
    // Simulate a concurrent address edit landing mid-run.
    await db.update(sites).set({ locationRevision: (startedWith.locationRevision ?? 0) + 1 }).where(eq(sites.id, siteId));
    await expect(runAnalysisPipeline(startedWith, null, userId, "pro")).rejects.toThrow(/location changed during analysis/i);
    const published = await db.select().from(insights).where(eq(insights.siteId, siteId));
    expect(published.length).toBe(0);
    const runs = await db.select().from(analyses).where(eq(analyses.siteId, siteId));
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("failed");
  }, 120_000);

  it("publishes normally when the location did not change", async () => {
    const current = await h.getSite(siteId, userId);
    const result = await runAnalysisPipeline(current, null, userId, "pro");
    expect(result.analysisId).toBeGreaterThan(0);
  }, 120_000);
});
