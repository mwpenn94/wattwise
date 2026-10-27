/**
 * GAP-K account deletion contract (guardrail §8.2):
 *  1. Wrong confirm phrase is rejected at the input layer (server-enforced).
 *  2. Deletion removes all user-owned rows — sites gone, insights gone,
 *     uploads gone, memberships gone — while OTHER users' data is untouched.
 *  3. One tombstone audit entry survives, evidencing the deletion.
 *  4. The response honestly states what remains.
 *  5. DEL-1 (Oct 26): bulk-import records (batches, files, sheets, site
 *     mappings — they hold filenames, account numbers and raw addresses) are
 *     removed for the deleting user only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users, sites, auditLog, importBatches, importBatchFiles, importBatchSheets, importSiteGroups, siteSchedules, equipmentInventory, siteMembers } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import { deleteAllUserData, deleteSite } from "./dbHelpers";

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
/** One bulk-import trail (batch → file → sheet, plus a site mapping) for a user. */
async function seedImportTrail(userId: number, siteId: number, tag: string) {
  const db = (await getDb())!;
  const [b] = await db.insert(importBatches).values({ userId, status: "complete" }).$returningId();
  const [f] = await db
    .insert(importBatchFiles)
    .values({ batchId: b.id, userId, filename: `${tag}.xlsx`, sha256: tag.padEnd(64, "0").slice(0, 64), sizeBytes: 1234 })
    .$returningId();
  await db.insert(importBatchSheets).values({
    batchId: b.id, fileId: f.id, userId, sheetName: `${tag} sheet`,
    accountNumber: "ACCT-123", servicePointId: "SP-9", addressRaw: "1 Test Way, Kingman, AZ",
  });
  await db.insert(importSiteGroups).values({
    userId, groupingMode: "campus", groupHash: tag.padEnd(64, "x").slice(0, 64), groupKey: "1 test way", siteId, batchId: b.id,
  });
  return b.id;
}
async function importRowCounts(userId: number) {
  const db = (await getDb())!;
  const n = async (t: typeof importBatches | typeof importBatchFiles | typeof importBatchSheets | typeof importSiteGroups) =>
    (await db.select({ id: t.id }).from(t).where(eq(t.userId, userId))).length;
  return { batches: await n(importBatches), files: await n(importBatchFiles), sheets: await n(importBatchSheets), groups: await n(importSiteGroups) };
}
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
  const db = (await getDb())!;
  const victimSiteRows = await db.select({ id: sites.id }).from(sites).where(eq(sites.userId, victim.id));
  await seedImportTrail(victim.id, victimSiteRows[0].id, `del1-victim-${run}`);
  await seedImportTrail(bystander.id, bystanderSite, `del1-bystander-${run}`);
}, 60_000);
afterAll(async () => {
  // Remove both fixture accounts entirely (data, tombstone, identity rows).
  const db = (await getDb())!;
  for (const u of [victim, bystander].filter(Boolean)) {
    await deleteAllUserData(u.id);
    await db.delete(auditLog).where(eq(auditLog.userId, u.id));
  }
  const ids = [victim, bystander].filter(Boolean).map((u) => u.id);
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
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
    expect(await importRowCounts(victim.id)).toEqual({ batches: 1, files: 1, sheets: 1, groups: 1 });
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

    // DEL-1: the victim's bulk-import trail is gone; the bystander's is intact.
    expect(await importRowCounts(victim.id)).toEqual({ batches: 0, files: 0, sheets: 0, groups: 0 });
    expect(await importRowCounts(bystander.id)).toEqual({ batches: 1, files: 1, sheets: 1, groups: 1 });
    // auth identity row survives
    const identity = await db.select().from(users).where(eq(users.id, victim.id));
    expect(identity.length).toBe(1);
  });
});

describe("DEL-1 site deletion cascade", () => {
  it("removes the site's schedules, equipment and other users' access, and nothing of another site", async () => {
    const db = (await getDb())!;
    const bc = appRouter.createCaller(ctxFor(bystander));
    const doomed = await bc.sites.create({ name: "Cascade site", state: "AZ", buildingType: "office", sqft: 2000 });
    const now = Date.now();
    for (const sid of [doomed.id, bystanderSite]) {
      await db.insert(siteSchedules).values({ siteId: sid, name: "Weekdays", days: [1, 2, 3, 4, 5], startHour: 7, endHour: 18 });
      await db.insert(equipmentInventory).values({
        siteId: sid, userId: bystander.id, equipKey: "rtu", label: "Rooftop unit", serviceLifeYears: 15, createdAt: now, updatedAt: now,
      });
    }
    // The victim account (already wiped above, identity kept) is a member of the doomed site.
    await db.insert(siteMembers).values({ siteId: doomed.id, userId: victim.id, role: "read_only", invitedBy: bystander.id, createdAt: now });
    const count = async (sid: number) => ({
      schedules: (await db.select({ id: siteSchedules.id }).from(siteSchedules).where(eq(siteSchedules.siteId, sid))).length,
      equipment: (await db.select({ id: equipmentInventory.id }).from(equipmentInventory).where(eq(equipmentInventory.siteId, sid))).length,
      members: (await db.select({ id: siteMembers.id }).from(siteMembers).where(eq(siteMembers.siteId, sid))).length,
    });
    expect(await count(doomed.id)).toEqual({ schedules: 1, equipment: 1, members: 1 });

    await deleteSite(doomed.id, bystander.id);

    expect(await count(doomed.id)).toEqual({ schedules: 0, equipment: 0, members: 0 });
    // The bystander's other site keeps its rows.
    expect(await count(bystanderSite)).toEqual({ schedules: 1, equipment: 1, members: 0 });
  });
});
