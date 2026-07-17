/**
 * Gap-9 (Jul 2026): entity → sites → meters organizational layer.
 * Invariants under test:
 *  - CRUD + site assignment are tenant-scoped (cross-tenant access throws).
 *  - Deleting an entity DETACHES its sites (entityId nulled) — never deletes.
 *  - Portfolio rollup reports never-analyzed sites as analyzed:false with
 *    null KPIs (no fabricated zeros), and totals are null when no site
 *    contributed a value.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users, sites, insights, entities } from "../drizzle/schema";
import { eq } from "drizzle-orm";

function ctxFor(user: { id: number; openId: string; role?: "user" | "admin" }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: user.role ?? "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  };
}

let ownerId = 0;
let strangerId = 0;
const OWNER = "vitest-entities-owner";
const STRANGER = "vitest-entities-stranger";

async function ensureUser(openId: string): Promise<number> {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", role: "admin" })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date(), role: "admin" } });
  const rows = await db.select().from(users).where(eq(users.openId, openId));
  return rows[0]!.id;
}

beforeAll(async () => {
  const db = (await getDb())!;
  ownerId = await ensureUser(OWNER);
  strangerId = await ensureUser(STRANGER);
  // fresh slate for determinism
  for (const uid of [ownerId, strangerId]) {
    const mine = await db.select().from(sites).where(eq(sites.userId, uid));
    for (const s of mine) {
      await db.delete(insights).where(eq(insights.siteId, s.id));
      await db.delete(sites).where(eq(sites.id, s.id));
    }
    await db.delete(entities).where(eq(entities.userId, uid));
  }
}, 30_000);

describe("entities CRUD + tenancy", () => {
  it("creates, lists, updates, and enforces cross-tenant isolation", async () => {
    const owner = appRouter.createCaller(ctxFor({ id: ownerId, openId: OWNER, role: "admin" }));
    const stranger = appRouter.createCaller(ctxFor({ id: strangerId, openId: STRANGER, role: "admin" }));

    const { id } = await owner.entities.create({ name: "Acme Properties LLC", kind: "company" });
    expect(id).toBeGreaterThan(0);

    const mine = await owner.entities.list();
    expect(mine.some((e) => e.id === id && e.kind === "company")).toBe(true);

    // Stranger cannot see, rename, or delete the owner's entity
    const theirs = await stranger.entities.list();
    expect(theirs.some((e) => e.id === id)).toBe(false);
    await expect(stranger.entities.update({ entityId: id, name: "hijacked" })).rejects.toThrow();
    await expect(stranger.entities.delete({ entityId: id })).rejects.toThrow();

    await owner.entities.update({ entityId: id, name: "Acme Holdings", kind: "property_owner" });
    const renamed = await owner.entities.list();
    expect(renamed.find((e) => e.id === id)?.name).toBe("Acme Holdings");
    expect(renamed.find((e) => e.id === id)?.kind).toBe("property_owner");
  });

  it("assigns sites to an entity; cross-tenant assignment is rejected both ways", async () => {
    const owner = appRouter.createCaller(ctxFor({ id: ownerId, openId: OWNER, role: "admin" }));
    const stranger = appRouter.createCaller(ctxFor({ id: strangerId, openId: STRANGER, role: "admin" }));

    const ent = await owner.entities.create({ name: "Household A", kind: "household" });
    const site = await owner.sites.create({ name: "Ent Test Site", state: "UT", zip: "84111" });

    await owner.entities.assignSite({ siteId: site.id, entityId: ent.id });
    const listed = await owner.sites.list();
    expect(listed.find((s) => s.id === site.id)?.entityId).toBe(ent.id);

    // stranger cannot attach the owner's site to anything…
    await expect(stranger.entities.assignSite({ siteId: site.id, entityId: null })).rejects.toThrow();
    // …and cannot attach their own site to the owner's entity
    const strangerSite = await stranger.sites.create({ name: "Stranger Site", state: "NV" });
    await expect(stranger.entities.assignSite({ siteId: strangerSite.id, entityId: ent.id })).rejects.toThrow();

    // detach works
    await owner.entities.assignSite({ siteId: site.id, entityId: null });
    const after = await owner.sites.list();
    expect(after.find((s) => s.id === site.id)?.entityId).toBeNull();
  });

  it("deleting an entity detaches its sites — never deletes them", async () => {
    const owner = appRouter.createCaller(ctxFor({ id: ownerId, openId: OWNER, role: "admin" }));
    const ent = await owner.entities.create({ name: "Doomed Group", kind: "other" });
    const site = await owner.sites.create({ name: "Survivor Site", state: "CO" });
    await owner.entities.assignSite({ siteId: site.id, entityId: ent.id });

    const res = await owner.entities.delete({ entityId: ent.id });
    expect(res.ok).toBe(true);

    const listed = await owner.sites.list();
    const survivor = listed.find((s) => s.id === site.id);
    expect(survivor).toBeTruthy(); // site survives
    expect(survivor?.entityId).toBeNull(); // but is detached
  });
});

describe("entities.portfolio rollup honesty", () => {
  it("never-analyzed sites roll up analyzed:false with null KPIs, not zeros", async () => {
    const owner = appRouter.createCaller(ctxFor({ id: ownerId, openId: OWNER, role: "admin" }));
    const ent = await owner.entities.create({ name: "Rollup Group", kind: "company" });
    const site = await owner.sites.create({ name: "Unanalyzed Site", state: "TX", zip: "75201" });
    await owner.entities.assignSite({ siteId: site.id, entityId: ent.id });

    const p = await owner.entities.portfolio({ entityId: ent.id });
    expect(p.sites.length).toBe(1);
    const row = p.sites[0]!;
    expect(row.siteId).toBe(site.id);
    expect(row.analyzed).toBe(false);
    // honesty: null, not fabricated 0
    expect(row.annualCostUsd).toBeNull();
    expect(row.peakKw).toBeNull();
    expect(row.annualUsageKwh).toBeNull();
    // totals with zero contributing sites are null, not 0
    expect(p.totals.annualCostUsd).toBeNull();
    expect(p.totals.sumOfSitePeaksKw).toBeNull();
    expect(p.totals.siteCount).toBe(1);
    expect(p.totals.analyzedCount).toBe(0);
  });

  it("entityId:null filter returns only ungrouped sites; undefined returns all", async () => {
    const owner = appRouter.createCaller(ctxFor({ id: ownerId, openId: OWNER, role: "admin" }));
    const all = await owner.entities.portfolio({});
    const ungrouped = await owner.entities.portfolio({ entityId: null });
    expect(all.sites.length).toBeGreaterThanOrEqual(ungrouped.sites.length);
    expect(ungrouped.sites.every((s) => s.entityId === null)).toBe(true);
    // grouped sites exist from previous specs, so the filters must differ
    expect(all.sites.some((s) => s.entityId !== null)).toBe(true);
  });
});
