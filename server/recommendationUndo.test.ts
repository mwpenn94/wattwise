import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { auditLog, measureImplementations, opportunities, recommendationStates, sites, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/* Oct 24 Cantex defect + owner question "how does a user undo or reset it":
 *  - every status change is reversible (undo restores the exact prior row)
 *  - an unverified completion can be reset; measured evidence is never deleted
 *  - removing a Prove-it entry withdraws the completion it backed (no dangling
 *    "completed" state pointing at a deleted implementation). */
const openId = `rec-undo-${Date.now()}`;
let userId = 0;
let siteId = 0;
function ctxFor(id: number): TrpcContext {
  return {
    user: { id, openId, email: `${openId}@test.local`, name: openId, loginMethod: "test", role: "user", tier: "pro", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {}, protocol: "http" },
    res: { cookie() {}, clearCookie() {} },
  } as unknown as TrpcContext;
}
afterAll(async () => {
  const db = (await getDb())!;
  if (siteId) {
    await db.delete(recommendationStates).where(eq(recommendationStates.siteId, siteId));
    await db.delete(measureImplementations).where(eq(measureImplementations.siteId, siteId));
    await db.delete(opportunities).where(eq(opportunities.siteId, siteId));
    await db.delete(sites).where(eq(sites.id, siteId));
  }
  if (userId) {
    await db.delete(auditLog).where(eq(auditLog.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("recommendation undo / reset", () => {
  it("undo, reset, evidence guard, and prove-it reconciliation", async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: "pro" });
    const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    userId = u!.id;
    const caller = appRouter.createCaller(ctxFor(userId));
    const site = await caller.sites.create({ name: "Undo Test Site", state: "AZ", zip: "86401", buildingType: "office" });
    siteId = site.id;
    await db.insert(opportunities).values([
      { siteId, measure: "lighting", title: "Lighting retrofit", estCostSavingsPerYr: 100, confidence: "medium", rank: 1, provenance: { commodity: "electric" } },
      { siteId, measure: "hvac", title: "HVAC tune-up", estCostSavingsPerYr: 80, confidence: "medium", rank: 2, provenance: { commodity: "electric" } },
    ]);
    const stateOf = async (measure: string) => (await db.select().from(recommendationStates).where(and(eq(recommendationStates.siteId, siteId), eq(recommendationStates.measure, measure))))[0];
    const implsOf = async (measure: string) => db.select().from(measureImplementations).where(and(eq(measureImplementations.siteId, siteId), eq(measureImplementations.measure, measure)));

    // 1) Undo an accidental completion from untouched -> back to untouched; its unverified record is removed.
    await caller.recommendations.setState({ siteId, measure: "lighting", title: "Lighting retrofit", status: "completed" });
    expect(await implsOf("lighting")).toHaveLength(1);
    const undone = await caller.recommendations.undo({ items: [{ siteId, measure: "lighting" }] });
    expect(undone.results[0]).toMatchObject({ restoredStatus: "open" });
    expect(await stateOf("lighting")).toBeUndefined();
    expect(await implsOf("lighting")).toHaveLength(0);
    let q = await caller.recommendations.queue({ siteId });
    expect(q.active.map((i) => i.measure)).toContain("lighting");
    expect(q.completed).toHaveLength(0);

    // 2) Undo restores the exact prior status (planned -> completed -> undo -> planned).
    await caller.recommendations.setState({ siteId, measure: "hvac", title: "HVAC tune-up", status: "planned" });
    await caller.recommendations.setState({ siteId, measure: "hvac", title: "HVAC tune-up", status: "completed" });
    await caller.recommendations.undo({ items: [{ siteId, measure: "hvac" }] });
    expect((await stateOf("hvac"))?.status).toBe("planned");
    expect(await implsOf("hvac")).toHaveLength(0);
    // Nothing further to undo safely after the undo itself.
    await expect(caller.recommendations.undo({ items: [{ siteId, measure: "hvac" }] })).rejects.toThrow(/no recent change/i);

    // 3) Reset an unverified completion later ("Undo completion" in the Completed list).
    await caller.recommendations.setState({ siteId, measure: "lighting", title: "Lighting retrofit", status: "completed" });
    const reset = await caller.recommendations.reset({ siteId, measure: "lighting" });
    expect(reset.changed).toBe(true);
    expect(await stateOf("lighting")).toBeUndefined();
    expect(await implsOf("lighting")).toHaveLength(0);

    // 4) Measured evidence is never deleted by undo/reset — Reopen is the path, and it keeps history.
    await caller.recommendations.setState({ siteId, measure: "lighting", title: "Lighting retrofit", status: "completed" });
    const [impl] = await implsOf("lighting");
    await db.update(measureImplementations).set({ status: "on_track", lastEvaluatedAt: Date.now(), verdicts: [{ month: "2026-09", verdict: "on_track" }] }).where(eq(measureImplementations.id, impl!.id));
    await expect(caller.recommendations.undo({ items: [{ siteId, measure: "lighting" }] })).rejects.toThrow(/Reopen/);
    await expect(caller.recommendations.reset({ siteId, measure: "lighting" })).rejects.toThrow(/Reopen/);
    expect(await implsOf("lighting")).toHaveLength(1);
    await caller.recommendations.reopen({ siteId, measure: "lighting" });
    expect(await implsOf("lighting")).toHaveLength(1);
    await db.delete(measureImplementations).where(eq(measureImplementations.id, impl!.id));
    await db.delete(recommendationStates).where(and(eq(recommendationStates.siteId, siteId), eq(recommendationStates.measure, "lighting")));

    // 5) Cantex regression: removing the Prove-it entry withdraws the completion it backed.
    await caller.recommendations.setState({ siteId, measure: "lighting", title: "Lighting retrofit", status: "completed" });
    const [cantexImpl] = await implsOf("lighting");
    const removed = await caller.proveIt.remove({ id: cantexImpl!.id });
    expect(removed.withdrawnCompletion).toBe(true);
    expect(await stateOf("lighting")).toBeUndefined();
    q = await caller.recommendations.queue({ siteId });
    expect(q.completed.map((i) => i.measure)).not.toContain("lighting");
    expect(q.active.map((i) => i.measure)).toContain("lighting");

    // Every correction is audited.
    const actions = (await db.select().from(auditLog).where(eq(auditLog.userId, userId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["recommendation_undone", "recommendation_reset"]));
  }, 60_000);
});
