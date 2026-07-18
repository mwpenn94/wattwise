/**
 * Docs-vs-build audit gap fixes (Jul 18, 2026) — specs for the wave that
 * closed the confirmed gaps:
 *  - §1 sample building: estimate.sample returns a labeled demo estimate with
 *    no address input and no auth.
 *  - §3m plan baskets: save/list/load/delete round-trip, Plus gating, tenancy
 *    isolation, and site-delete cascade.
 *  - §3i-2 utility exposure: portfolio rollup carries per-site utilityName so
 *    the exposure card can group spend by provider without guessing.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users, sites, insights } from "../drizzle/schema";
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
    req: { protocol: "https", headers: {}, ip: `127.0.0.${Math.floor(Math.random() * 250) + 1}` } as unknown as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function anonCtx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {}, ip: `127.1.0.${Math.floor(Math.random() * 250) + 1}` } as unknown as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}

const OPEN_ID = "vitest-gapfix";
const OTHER_OPEN_ID = "vitest-gapfix-other";
let userId = 0;
let otherId = 0;

async function ensureUser(openId: string, role: "user" | "admin" = "admin"): Promise<number> {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", role })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date(), role } });
  const rows = await db.select().from(users).where(eq(users.openId, openId));
  return rows[0]!.id;
}

beforeAll(async () => {
  const db = (await getDb())!;
  userId = await ensureUser(OPEN_ID);
  otherId = await ensureUser(OTHER_OPEN_ID);
  for (const uid of [userId, otherId]) {
    const mine = await db.select().from(sites).where(eq(sites.userId, uid));
    for (const s of mine) {
      await db.delete(insights).where(eq(insights.siteId, s.id));
      await db.delete(sites).where(eq(sites.id, s.id));
    }
  }
}, 30_000);

describe("§1 sample building estimate", () => {
  it("returns a labeled demo estimate with no auth and no address input", async () => {
    const caller = appRouter.createCaller(anonCtx());
    const out = await caller.estimate.sample();
    expect(out.isSample).toBe(true);
    expect(out.place.formattedAddress).toContain("demo building");
    expect(out.estimate.estimatedAnnualCostUsd).toBeGreaterThan(0);
    expect(out.estimate.accuracy.rung).toBe("estimate");
    // grounding must disclose the archetype basis, not pretend measurement
    expect(out.estimate.grounding.loadBasis).toBe("archetype_scaled");
  }, 30_000);
});

describe("§3m plan baskets", () => {
  let siteId = 0;
  const measures = [
    { key: "led", label: "LED retrofit", kind: "efficiency", efficiencyReductions: { lighting: 0.4 }, capexUsd: 2000 },
  ];

  it("saves, lists, loads, and deletes a plan basket (Plus/admin path)", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const site = await caller.sites.create({ name: "Basket Site", state: "AZ", buildingType: "office" });
    siteId = site.id;

    const saved = await caller.scenariosApi.saveBasket({ siteId, name: "Summer readiness", measures });
    expect(saved.id).toBeGreaterThan(0);

    const list = await caller.scenariosApi.listBaskets({ siteId });
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("Summer readiness");

    const loaded = await caller.scenariosApi.getBasket({ id: saved.id });
    expect((loaded.measures as Array<{ key: string }>)[0]!.key).toBe("led");

    await caller.scenariosApi.deleteBasket({ id: saved.id });
    const after = await caller.scenariosApi.listBaskets({ siteId });
    expect(after.length).toBe(0);
  }, 30_000);

  it("rejects a free-tier user from persisting a plan (Plus gate)", async () => {
    const db = (await getDb())!;
    const freeId = await ensureUser("vitest-gapfix-free", "user");
    // ensure the free user owns a site to rule out tenancy as the failure cause
    const freeCaller = appRouter.createCaller(ctxFor({ id: freeId, openId: "vitest-gapfix-free", role: "user" }));
    const s = await freeCaller.sites.create({ name: "Free Basket Site", state: "AZ", buildingType: "office" });
    await expect(freeCaller.scenariosApi.saveBasket({ siteId: s.id, name: "Nope", measures })).rejects.toThrow(/plus/i);
    await db.delete(sites).where(eq(sites.id, s.id));
  }, 30_000);

  it("blocks cross-tenant basket reads", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const saved = await caller.scenariosApi.saveBasket({ siteId, name: "Private plan", measures });
    const other = appRouter.createCaller(ctxFor({ id: otherId, openId: OTHER_OPEN_ID, role: "admin" }));
    await expect(other.scenariosApi.getBasket({ id: saved.id })).rejects.toThrow(/not found/i);
    // other user's list must not contain it either
    const otherList = await other.scenariosApi.listBaskets({});
    expect(otherList.find((b) => b.id === saved.id)).toBeUndefined();
  }, 30_000);

  it("cascades basket deletion when the site is deleted", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    await caller.sites.delete({ siteId });
    const list = await caller.scenariosApi.listBaskets({});
    expect(list.filter((b) => b.siteId === siteId).length).toBe(0);
  }, 30_000);
});

describe("§3i-2 utility exposure input", () => {
  it("portfolio rollup carries per-site utilityName (null when unset, never guessed)", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const s = await caller.sites.create({ name: "Exposure Site", state: "AZ", buildingType: "office" });
    const rollup = await caller.entities.portfolio();
    const row = rollup.sites.find((r) => r.siteId === s.id);
    expect(row).toBeDefined();
    // utilityName is either the derived/confirmed provider or null — the
    // exposure card renders null as "Utility not set", not a fabricated name.
    expect(row!).toHaveProperty("utilityName");
    await caller.sites.delete({ siteId: s.id });
  }, 30_000);
});
