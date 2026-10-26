import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { opportunities, recommendationStates, measureImplementations, sites, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { buildRecommendationQueue, comparePriority } from "./recommendations";

const NOW = Date.UTC(2026, 9, 24);
const DAY = 86_400_000;

const opportunity = (measure: string, rank: number, savings = 100, confidence: "low" | "medium" | "high" = "medium") => ({
  id: rank,
  measure,
  title: measure.replace(/_/g, " "),
  description: "Test recommendation",
  estCostSavingsPerYr: savings,
  paybackBandYears: "1–3 yr",
  confidence,
  rank,
  provenance: { commodity: "electric", disclosures: ["Basis: test modeled estimate."] },
});

describe("buildRecommendationQueue", () => {
  it("keeps completed measures out of active items and surfaces the next recommendation", () => {
    const result = buildRecommendationQueue(
      [opportunity("lighting", 1), opportunity("thermostat", 2)],
      [{ measure: "lighting", status: "completed", changedAt: NOW }],
      [{ id: 1, measure: "lighting", title: "lighting", status: "awaiting_data", verifiedSavingsUsd: 0, implementedAt: NOW }],
      NOW,
    );
    expect(result.active.map((item) => item.measure)).toEqual(["thermostat"]);
    expect(result.next.map((item) => item.measure)).toEqual(["thermostat"]);
    expect(result.completed.map((item) => item.measure)).toEqual(["lighting"]);
  });

  it("returns a deferred recommendation after its deferral expires", () => {
    const result = buildRecommendationQueue(
      [opportunity("lighting", 1)],
      [{ measure: "lighting", status: "deferred", deferUntil: NOW - DAY, changedAt: NOW - DAY }],
      [],
      NOW,
    );
    expect(result.active).toHaveLength(1);
    expect(result.next).toHaveLength(1);
  });

  it("hides dismissed recommendations", () => {
    const result = buildRecommendationQueue([opportunity("lighting", 1)], [{ measure: "lighting", status: "dismissed", changedAt: NOW }], [], NOW);
    expect(result.active).toHaveLength(0);
    expect(result.next).toHaveLength(0);
  });

  it("treats an implementation without a state row as completed", () => {
    const result = buildRecommendationQueue(
      [opportunity("lighting", 1)],
      [],
      [{ id: 10, measure: "lighting", title: "lighting", status: "verified", verifiedSavingsUsd: 47, implementedAt: NOW }],
      NOW,
    );
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]?.implementation?.status).toBe("inconclusive");
    expect(result.progress.verifiedSavingsUsd).toBeNull();
  });

  it("uses non-collapsing confidence-derived ranges and correct progress totals", () => {
    const result = buildRecommendationQueue(
      [opportunity("lighting", 1, 100, "high"), opportunity("hvac", 2, 200, "low"), opportunity("water", 3, 50)],
      [
        { measure: "lighting", status: "planned", changedAt: NOW },
        { measure: "hvac", status: "in_progress", changedAt: NOW },
        { measure: "water", status: "completed", changedAt: NOW },
      ],
      [{ id: 3, measure: "water", title: "water", status: "verified", verifiedSavingsUsd: 20, implementedAt: NOW }],
      NOW,
    );
    expect(result.active.every((item) => item.savingsRangeUsd == null || item.savingsRangeUsd.low < item.savingsRangeUsd.high)).toBe(true);
    expect(result.progress).toMatchObject({ totalIdentified: 3, planned: 1, inProgress: 1, completed: 1, completionPct: 33, verifiedSavingsUsd: null });
    // OPEN-2: committed = planned + in-progress, combined as an overlap-aware
    // bound (best single low; high adds each high). No open items → null.
    const committedItems = result.active.filter((i) => i.status === "planned" || i.status === "in_progress");
    expect(result.progress.committedRangeUsd).toEqual({
      low: Math.max(...committedItems.map((i) => i.savingsRangeUsd!.low)),
      high: committedItems.reduce((a, i) => a + i.savingsRangeUsd!.high, 0),
    });
    expect(result.progress.projectedRangeUsd).toBeNull();
  });

  it("preserves an analysis pipeline's persisted source range when it is available", () => {
    const result = buildRecommendationQueue(
      [{ ...opportunity("lighting", 1, 100), provenance: { commodity: "electric", savingsRange: [61, 139] } }],
      [],
      [],
      NOW,
    );
    expect(result.active[0]?.savingsRangeUsd).toEqual({ low: 61, high: 139 });
  });
});

function ctxFor(user: { id: number; openId: string }): TrpcContext {
  return {
    user: { id: user.id, openId: user.openId, email: `${user.openId}@test.local`, name: user.openId, loginMethod: "test", role: "user", tier: "pro", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}

const openId = `recommendations-${Date.now()}`;
let createdUserId: number | null = null;
let createdSiteId: number | null = null;

afterAll(async () => {
  const db = await getDb();
  if (!db || createdUserId == null) return;
  if (createdSiteId != null) {
    await db.delete(recommendationStates).where(eq(recommendationStates.siteId, createdSiteId));
    await db.delete(measureImplementations).where(eq(measureImplementations.siteId, createdSiteId));
    await db.delete(opportunities).where(eq(opportunities.siteId, createdSiteId));
    await db.delete(sites).where(eq(sites.id, createdSiteId));
  }
  await db.delete(users).where(eq(users.id, createdUserId));
});

describe("recommendations router lifecycle", () => {
  it("persists completion, immediately exposes the next item, and never deletes prove-it history on reopen", async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: "pro" });
    const [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    createdUserId = user!.id;
    const caller = appRouter.createCaller(ctxFor(user!));
    const site = await caller.sites.create({ name: "Recommendation Test Site", state: "AZ", zip: "85701", buildingType: "office" });
    createdSiteId = site.id;
    await db.insert(opportunities).values([
      { siteId: site.id, measure: "lighting", title: "Lighting retrofit", estCostSavingsPerYr: 100, confidence: "medium", rank: 1, provenance: { commodity: "electric" } },
      { siteId: site.id, measure: "hvac", title: "HVAC tune-up", estCostSavingsPerYr: 80, confidence: "medium", rank: 2, provenance: { commodity: "electric" } },
    ]);

    await caller.recommendations.setState({ siteId: site.id, measure: "lighting", title: "Lighting retrofit", status: "completed" });
    const queue = await caller.recommendations.queue({ siteId: site.id });
    expect(queue.active[0]?.measure).toBe("hvac");
    expect(queue.completed[0]?.measure).toBe("lighting");
    const implementationId = queue.completed[0]?.implementation?.id;
    expect(implementationId).toBeTruthy();

    await caller.recommendations.reopen({ siteId: site.id, measure: "lighting" });
    const implementationRows = await db.select().from(measureImplementations).where(and(eq(measureImplementations.siteId, site.id), eq(measureImplementations.measure, "lighting")));
    expect(implementationRows).toHaveLength(1);
    const reopenedQueue = await caller.recommendations.queue({ siteId: site.id });
    expect(reopenedQueue.active.map((item) => item.measure)).toContain("lighting");
    expect(reopenedQueue.completed.map((item) => item.measure)).not.toContain("lighting");
  });
});

describe("review regression safety", () => {
  it("never sums repeated whole-site proof credit or overlapping standalone savings", () => {
    const q=buildRecommendationQueue([opportunity("led",1),opportunity("hvac",2)],[],["led","hvac"].map((measure,i)=>({id:i+1,measure,title:measure,status:"verified" as const,verifiedSavingsUsd:150,implementedAt:NOW})),NOW);
    expect(q.progress.verifiedSavingsUsd).toBeNull();
    // Both measures are completed: nothing is open, so no combined open amount.
    expect(q.active).toHaveLength(0);
    expect(q.progress.projectedRangeUsd).toBeNull();
    expect(q.progress.committedRangeUsd).toBeNull();
    // Two open, overlapping same-utility measures: the low end is never summed.
    const open2 = buildRecommendationQueue([opportunity("led",1,100),opportunity("hvac",2,200)],[],[],NOW);
    const lows = open2.active.map((i) => i.savingsRangeUsd!.low);
    expect(open2.progress.projectedRangeUsd!.low).toBe(Math.max(...lows));
    expect(open2.progress.projectedRangeUsd!.low).toBeLessThan(lows.reduce((a, b) => a + b, 0));
    expect(open2.progress.projectedRangeUsd!.high).toBe(open2.active.reduce((a, i) => a + i.savingsRangeUsd!.high, 0));
    expect(q.progress.verificationBasis).toContain("inconclusive");
    expect(q.completed.every(i=>i.implementation?.status==="inconclusive")).toBe(true);
  });
  it("keeps absent planned history in needsReview, not active, retaining exact provenance",()=>{
    const source={...opportunity("gas",1),confidence:"low" as const,provenance:{commodity:"gas",savingsRange:[61,139],disclosures:["first","second"]}};
    const q=buildRecommendationQueue([],[{measure:"gas",status:"planned",sourceSnapshot:source}],[],NOW);
    expect(q.active).toHaveLength(0);expect(q.progress.planned).toBe(0);
    expect(q.needsReview[0]).toMatchObject({commodity:"gas",confidence:"low",savingsRangeUsd:{low:61,high:139},disclosures:["first","second"]});
  });
  it("does not overwrite completed source snapshots after reanalysis",()=>{
    const original={...opportunity("led",1),provenance:{commodity:"electric",savingsRange:[61,139],disclosures:["original basis"]}};
    const q=buildRecommendationQueue([opportunity("led",1,999)],[{measure:"led",status:"completed",sourceSnapshot:original}],[],NOW);
    expect(q.completed[0]?.savingsRangeUsd).toEqual({low:61,high:139});
    expect(q.completed[0]?.basis).toContain("original basis");
  });
  it("exposes inactive items for undo and labels expired deferrals open",()=>{
    const q=buildRecommendationQueue([opportunity("a",1),opportunity("b",2),opportunity("c",3)],[{measure:"a",status:"dismissed"},{measure:"b",status:"deferred",deferUntil:NOW+DAY},{measure:"c",status:"deferred",deferUntil:NOW-DAY}],[],NOW);
    expect(q.inactive.map(i=>i.measure)).toEqual(["a","b"]);
    expect(q.active[0]?.status).toBe("open");expect(q.progress.deferred).toBe(1);
  });
  it("excludes landlord measures from executable progress even after they disappear",()=>{
    const o={...opportunity("roof",1),provenance:{audience:"landlord",commodity:"electric"}};
    for(const current of [[o],[]]){
      const q=buildRecommendationQueue(current,[{measure:"roof",status:"planned",sourceSnapshot:o}],[],NOW);
      expect(q.landlord).toHaveLength(1);expect(q.active).toHaveLength(0);expect(q.progress.totalIdentified).toBe(0);
    }
  });
  it("sorts numeric payback, not lexicographic",()=>{
    const q=buildRecommendationQueue([{...opportunity("ten",1),paybackBandYears:"10–12 yr"},{...opportunity("two",2),paybackBandYears:"2–3 yr"}],[],[],NOW);
    expect([...q.active].sort(comparePriority)[0]?.measure).toBe("two");
  });
});

describe("atomic lifecycle and portfolio scope",()=>{
  it("deduplicates concurrent completion, preserves snapshots, rejects foreign bulk before writing and starts a new episode after reopen",async()=>{
    const db=(await getDb())!;
    const [user]=await db.select().from(users).where(eq(users.id,createdUserId!)).limit(1);
    const caller=appRouter.createCaller(ctxFor(user!));const siteId=createdSiteId!;
    await caller.recommendations.reopen({siteId,measure:"lighting"});
    const before=await db.select().from(measureImplementations).where(eq(measureImplementations.siteId,siteId));
    await Promise.all([1,2].map(()=>caller.recommendations.setState({siteId,measure:"lighting",title:"Lighting",status:"completed"})));
    const after=await db.select().from(measureImplementations).where(eq(measureImplementations.siteId,siteId));
    expect(after.length).toBe(before.length+1);
    expect(after.at(-1)?.sourceSnapshot).toBeTruthy();expect(after.at(-1)?.episodeKey).toBeTruthy();
    await expect(caller.recommendations.bulkSetState({status:"dismissed",items:[{siteId,measure:"hvac",title:"HVAC"},{siteId:-1,measure:"foreign",title:"No"}]})).rejects.toThrow();
    expect((await caller.recommendations.queue({siteId})).active.some(i=>i.measure==="hvac")).toBe(true);
    const bulk=await caller.recommendations.bulkSetState({status:"planned",items:[{siteId,measure:"hvac",title:"HVAC"},{siteId,measure:"hvac",title:"HVAC"}]});
    expect(bulk.results).toHaveLength(1);
    const custom=await caller.recommendations.portfolioPriorities({siteIds:[siteId,siteId,-1]});
    expect(custom.siteCount).toBe(1);expect(custom.progress.projectedRangeUsd).toEqual((await caller.recommendations.queue({siteId})).progress.projectedRangeUsd);
    expect((await caller.recommendations.portfolioPriorities({siteIds:[]})).siteCount).toBe(0);
    await expect(caller.recommendations.portfolioPriorities({groupId:-1})).rejects.toThrow("Portfolio group not found");
  });
});
