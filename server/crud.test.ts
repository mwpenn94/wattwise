/**
 * CRUD coverage specs (core usability round, Jul 2026).
 * Verifies the entity lifecycle procedures work end-to-end against the real
 * database: sites.update / sites.delete (cascade), meters create/update/delete
 * with role rules, and site-group create/membership/delete — plus tenancy
 * rejection for cross-user edits.
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
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const OPEN_ID = "vitest-crud";
const OTHER_OPEN_ID = "vitest-crud-other";
let userId = 0;
let otherId = 0;

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
  userId = await ensureUser(OPEN_ID);
  otherId = await ensureUser(OTHER_OPEN_ID);
  // deterministic: clear this user's sites between runs
  for (const uid of [userId, otherId]) {
    const mine = await db.select().from(sites).where(eq(sites.userId, uid));
    for (const s of mine) {
      await db.delete(insights).where(eq(insights.siteId, s.id));
      await db.delete(sites).where(eq(sites.id, s.id));
    }
  }
}, 30_000);

describe("sites CRUD", () => {
  it("creates, updates, and deletes a site (cascade)", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const created = await caller.sites.create({ name: "CRUD Site", state: "KY", buildingType: "single_family" });
    const siteId = created.id;
    expect(siteId).toBeGreaterThan(0);

    // name/address/city/occupancy/utility go through sites.update; building
    // attributes (sqft, type, vintage) flow through sites.refine so they carry
    // provenance and flip attrSource — the Sites page edit dialog says exactly this.
    await caller.sites.update({ siteId, name: "CRUD Site Renamed", city: "Louisville" });
    await caller.sites.refine({ siteId, sqft: 2100 });
    const listed = await caller.sites.list();
    const row = listed.find((s) => s.id === siteId);
    expect(row?.name).toBe("CRUD Site Renamed");
    expect(row?.city).toBe("Louisville");
    expect(row?.sqft).toBe(2100);

    // a meter under the site so delete exercises the cascade
    const meter = await caller.sites.createMeter({ siteId, label: "Main", commodity: "electric" });
    expect(meter.id).toBeGreaterThan(0);

    await caller.sites.delete({ siteId });
    const after = await caller.sites.list();
    expect(after.find((s) => s.id === siteId)).toBeUndefined();
  });

  it("rejects updates and deletes on another user's site", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const otherCaller = appRouter.createCaller(ctxFor({ id: otherId, openId: OTHER_OPEN_ID, role: "admin" }));
    const created = await otherCaller.sites.create({ name: "Not Yours", state: "TX" });
    await expect(caller.sites.update({ siteId: created.id, name: "hijack" })).rejects.toThrow();
    await expect(caller.sites.delete({ siteId: created.id })).rejects.toThrow();
    await otherCaller.sites.delete({ siteId: created.id });
  });
});

describe("meters CRUD + role rules", () => {
  it("creates, edits, sets roles with submeter validation, and deletes", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const site = await caller.sites.create({ name: "Meter Site", state: "KY" });
    const main = await caller.sites.createMeter({ siteId: site.id, label: "Main feed", commodity: "electric" });
    const sub = await caller.sites.createMeter({ siteId: site.id, label: "Kitchen sub", commodity: "electric" });

    await caller.sites.updateMeter({ meterId: sub.id, label: "Kitchen submeter" });

    // a submeter must name its parent
    await expect(caller.sites.setMeterRole({ meterId: sub.id, role: "submeter" })).rejects.toThrow();
    await caller.sites.setMeterRole({ meterId: sub.id, role: "submeter", parentMeterId: main.id });

    // a meter cannot be its own parent
    await expect(
      caller.sites.setMeterRole({ meterId: main.id, role: "submeter", parentMeterId: main.id }),
    ).rejects.toThrow();

    const meters = await caller.sites.meters({ siteId: site.id });
    const subRow = meters.find((m) => m.id === sub.id);
    expect(subRow?.meterRole).toBe("submeter");
    expect(subRow?.parentMeterId).toBe(main.id);

    await caller.sites.deleteMeter({ meterId: sub.id });
    const after = await caller.sites.meters({ siteId: site.id });
    expect(after.find((m) => m.id === sub.id)).toBeUndefined();

    await caller.sites.delete({ siteId: site.id });
  });
});

describe("site groups CRUD", () => {
  it("creates a group, toggles membership, and deletes it", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: userId, openId: OPEN_ID, role: "admin" }));
    const site = await caller.sites.create({ name: "Grouped Site", state: "OH" });
    const group = await caller.sites.createGroup({ name: "Test Region", kind: "region" });
    expect(group.id).toBeGreaterThan(0);

    await caller.sites.setGroupMembership({ groupId: group.id, siteId: site.id, member: true });
    let groups = await caller.sites.groups();
    let g = groups.find((x) => x.id === group.id);
    expect(g?.siteIds).toContain(site.id);

    await caller.sites.setGroupMembership({ groupId: group.id, siteId: site.id, member: false });
    groups = await caller.sites.groups();
    g = groups.find((x) => x.id === group.id);
    expect(g?.siteIds).not.toContain(site.id);

    await caller.sites.deleteGroup({ groupId: group.id });
    groups = await caller.sites.groups();
    expect(groups.find((x) => x.id === group.id)).toBeUndefined();

    await caller.sites.delete({ siteId: site.id });
  });
});
