/**
 * GAP-J dimensional receipts contract:
 *  1. Every dimension the model uses comes back with its SOURCE named
 *     (user/assessor/prior) plus what it feeds.
 *  2. Geometry-derived GFA (footprint × stories) appears as a cross-check row
 *     when geometry exists — labeled cross-check-only, never an override.
 *  3. >20% profile-vs-geometry divergence surfaces a QUESTION with an honest
 *     disclosure that geometry is an estimate too.
 *  4. ≤20% divergence (or missing geometry) surfaces NO question.
 *  5. Tenancy: another user's site is rejected.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import * as h from "./dbHelpers";

function ctxFor(user: { id: number; openId: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: "user",
      tier: "pro",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
async function makeUser(openId: string) {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: openId } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.update(users).set({ tier: "pro" }).where(eq(users.id, rows[0].id));
  return rows[0];
}

let user: Awaited<ReturnType<typeof makeUser>>;
let stranger: Awaited<ReturnType<typeof makeUser>>;
let siteId = 0;
beforeAll(async () => {
  const run = Date.now();
  user = await makeUser(`dimrec-${run}`);
  stranger = await makeUser(`dimrec-x-${run}`);
  const caller = appRouter.createCaller(ctxFor(user));
  const created = await caller.sites.create({ name: "Receipts site", state: "AZ", buildingType: "office", sqft: 10_000 });
  siteId = created.id;
}, 60_000);

describe("GAP-J dimensional receipts (sites.dimensionReceipts)", () => {
  it("names the source of the floor area in use and asks no question without geometry", async () => {
    const caller = appRouter.createCaller(ctxFor(user));
    const out = await caller.sites.dimensionReceipts({ siteId });
    const floor = out.receipts.find((r) => r.dimension === "floor_area_sqft");
    expect(floor).toBeDefined();
    expect(floor!.valueInUse).toBe(10_000);
    expect(floor!.source.length).toBeGreaterThan(3);
    expect(out.divergence).toBeNull();
    expect(out.thresholdPct).toBe(20);
  });

  it("surfaces the >20% divergence question with geometry cross-check and disclosure", async () => {
    // geometry implies 18,000 sqft GFA vs 10,000 profile → 80% divergence
    await h.upsertSiteGeometry(siteId, user.id, { footprintSqft: 9_000, stories: 2, footprintSource: "microsoft" });
    const caller = appRouter.createCaller(ctxFor(user));
    const out = await caller.sites.dimensionReceipts({ siteId });
    const geomRow = out.receipts.find((r) => r.dimension === "geometry_derived_gfa_sqft");
    expect(geomRow).toBeDefined();
    expect(geomRow!.valueInUse).toBe(18_000);
    expect(geomRow!.usedBy).toMatch(/cross-check/i);
    expect(out.divergence).not.toBeNull();
    expect(out.divergence!.pct).toBe(80);
    expect(out.divergence!.question).toMatch(/which is closer to right/i);
    expect(out.divergence!.disclosure).toMatch(/estimate too/i);
  });

  it("asks no question when divergence is within 20%", async () => {
    await h.upsertSiteGeometry(siteId, user.id, { footprintSqft: 5_500, stories: 2, footprintSource: "microsoft" });
    const caller = appRouter.createCaller(ctxFor(user));
    const out = await caller.sites.dimensionReceipts({ siteId });
    // 11,000 vs 10,000 = 10% — inside the threshold
    expect(out.divergence).toBeNull();
  });

  it("rejects another user's site (tenancy)", async () => {
    const caller = appRouter.createCaller(ctxFor(stranger));
    await expect(caller.sites.dimensionReceipts({ siteId })).rejects.toThrow();
  });
});
