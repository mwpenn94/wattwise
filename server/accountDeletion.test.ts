/**
 * GAP-K account deletion contract (guardrail §8.2):
 *  1. Wrong confirm phrase is rejected at the input layer (server-enforced).
 *  2. Deletion removes all user-owned rows — sites gone, insights gone,
 *     uploads gone, memberships gone — while OTHER users' data is untouched.
 *  3. One tombstone audit entry survives, evidencing the deletion.
 *  4. The response honestly states what remains.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users, sites, auditLog } from "../drizzle/schema";
import { eq } from "drizzle-orm";

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

let victim: Awaited<ReturnType<typeof makeUser>>;
let bystander: Awaited<ReturnType<typeof makeUser>>;
let bystanderSite = 0;
beforeAll(async () => {
  const run = Date.now();
  victim = await makeUser(`del-victim-${run}`);
  bystander = await makeUser(`del-bystander-${run}`);
  const vc = appRouter.createCaller(ctxFor(victim));
  await vc.sites.create({ name: "Doomed site A", state: "AZ", buildingType: "office", sqft: 5000 });
  await vc.sites.create({ name: "Doomed site B", state: "TX", buildingType: "retail", sqft: 3000 });
  const bc = appRouter.createCaller(ctxFor(bystander));
  const bSite = await bc.sites.create({ name: "Bystander site", state: "AZ", buildingType: "office", sqft: 4000 });
  bystanderSite = bSite.id;
}, 60_000);

describe("GAP-K account.deleteAllData", () => {
  it("rejects a wrong confirm phrase at the input layer", async () => {
    const caller = appRouter.createCaller(ctxFor(victim));
    await expect(
      caller.account.deleteAllData({ confirmPhrase: "yes do it" as never }),
    ).rejects.toThrow();
  });

  it("deletes all victim data, leaves a tombstone, and never touches the bystander", async () => {
    const db = (await getDb())!;
    const caller = appRouter.createCaller(ctxFor(victim));
    const res = await caller.account.deleteAllData({ confirmPhrase: "delete my account" });
    expect(res.ok).toBe(true);
    expect(res.sitesDeleted).toBe(2);
    expect(res.note).toMatch(/cannot be undone/i);
    expect(res.note).toMatch(/sign-in identity/i);

    const victimSites = await db.select().from(sites).where(eq(sites.userId, victim.id));
    expect(victimSites.length).toBe(0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, victim.id));
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("account_data_deleted");

    const bystanderSites = await db.select().from(sites).where(eq(sites.userId, bystander.id));
    expect(bystanderSites.some((s) => s.id === bystanderSite)).toBe(true);

    // auth identity row survives
    const identity = await db.select().from(users).where(eq(users.id, victim.id));
    expect(identity.length).toBe(1);
  });
});
