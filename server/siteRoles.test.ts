/**
 * GAP-L site-role scoping contract:
 *  1. Owner can add a member by email (existing accounts only — honest error
 *     otherwise) and list/remove members; non-owners cannot manage members.
 *  2. read_only member: CAN view (sites.get, insights list, latest analysis),
 *     CANNOT act (sites.refine rejected with a role-naming error).
 *  3. facility_manager member: CAN view AND act (refine succeeds).
 *  4. Strangers (no membership) remain fully locked out.
 *  5. sharedWithMe lists the shared site with the member's role.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

function ctxFor(user: { id: number; openId: string; email?: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: user.email ?? `${user.openId}@test.local`,
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

let owner: Awaited<ReturnType<typeof makeUser>>;
let reader: Awaited<ReturnType<typeof makeUser>>;
let manager: Awaited<ReturnType<typeof makeUser>>;
let stranger: Awaited<ReturnType<typeof makeUser>>;
let siteId = 0;
beforeAll(async () => {
  const run = Date.now();
  owner = await makeUser(`role-owner-${run}`);
  reader = await makeUser(`role-reader-${run}`);
  manager = await makeUser(`role-mgr-${run}`);
  stranger = await makeUser(`role-stranger-${run}`);
  const oc = appRouter.createCaller(ctxFor(owner));
  const created = await oc.sites.create({ name: "Shared building", state: "AZ", buildingType: "office", sqft: 20_000 });
  siteId = created.id;
  await oc.sites.members.add({ siteId, email: `${reader.openId}@test.local`, role: "read_only" });
  await oc.sites.members.add({ siteId, email: `${manager.openId}@test.local`, role: "facility_manager" });
}, 60_000);

describe("GAP-L site roles", () => {
  it("owner: honest error adding a non-existent account; members list shows both roles", async () => {
    const oc = appRouter.createCaller(ctxFor(owner));
    await expect(oc.sites.members.add({ siteId, email: "nobody-here@example.com", role: "read_only" })).rejects.toThrow(/no wattwise account/i);
    const members = await oc.sites.members.list({ siteId });
    expect(members.length).toBe(2);
    expect(members.map((m) => m.role).sort()).toEqual(["facility_manager", "read_only"]);
  });

  it("read_only member can view but not act", async () => {
    const rc = appRouter.createCaller(ctxFor(reader));
    const site = await rc.sites.get({ siteId });
    expect(site.myRole).toBe("read_only");
    // acting is rejected with a role-naming error
    await expect(rc.sites.refine({ siteId, sqft: 25_000 })).rejects.toThrow(/read-only/i);
    const shared = await rc.sites.sharedWithMe();
    expect(shared.some((s) => s.id === siteId && s.myRole === "read_only")).toBe(true);
  });

  it("facility_manager member can view and act", async () => {
    const mc = appRouter.createCaller(ctxFor(manager));
    const site = await mc.sites.get({ siteId });
    expect(site.myRole).toBe("facility_manager");
    const res = await mc.sites.refine({ siteId, sqft: 22_000 });
    expect(res.ok).toBe(true);
  });

  it("strangers stay locked out of view, act, and member management", async () => {
    const sc = appRouter.createCaller(ctxFor(stranger));
    await expect(sc.sites.get({ siteId })).rejects.toThrow();
    await expect(sc.sites.refine({ siteId, sqft: 1 })).rejects.toThrow();
    await expect(sc.sites.members.list({ siteId })).rejects.toThrow();
    await expect(sc.sites.members.add({ siteId, email: `${stranger.openId}@test.local`, role: "read_only" })).rejects.toThrow();
  });

  it("owner can remove a member; removed member loses access", async () => {
    const oc = appRouter.createCaller(ctxFor(owner));
    const members = await oc.sites.members.list({ siteId });
    const readerRow = members.find((m) => m.userId === reader.id)!;
    await oc.sites.members.remove({ siteId, memberId: readerRow.id });
    const rc = appRouter.createCaller(ctxFor(reader));
    await expect(rc.sites.get({ siteId })).rejects.toThrow();
  });
});
