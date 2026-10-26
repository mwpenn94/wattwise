/**
 * Gap-6 (Jul 2026) self-serve beta tier switching was retired by BILL-1
 * (Oct 26): account.setTier no longer changes the plan or the legacy
 * users.tier column, and access follows the billing account. Detailed
 * plan/grace coverage lives in entitlementGates.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { auditLog, billingAccounts, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type Ctx = Parameters<typeof appRouter.createCaller>[0];

const openId = `tier-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let user: typeof users.$inferSelect;

function callerFor(u: typeof users.$inferSelect) {
  return appRouter.createCaller({
    user: u,
    req: { headers: {} },
    res: { setHeader: () => undefined, clearCookie: () => undefined },
  } as unknown as Ctx);
}

beforeAll(async () => {
  const db = (await getDb())!;
  await db.insert(users).values({ openId, name: `Tier Test ${openId}`, email: `${openId}@test.local`, loginMethod: "test", tier: "free" });
  [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.insert(billingAccounts).values({ userId: user.id, plan: "free", entitlementTier: "free", status: "active" });
});

afterAll(async () => {
  const db = await getDb();
  if (!db || !user) return;
  await db.delete(auditLog).where(eq(auditLog.userId, user.id));
  await db.delete(billingAccounts).where(eq(billingAccounts.userId, user.id));
  await db.delete(users).where(eq(users.id, user.id));
});

describe("account.setTier (retired)", () => {
  it("refuses free → plus and changes nothing", async () => {
    await expect(callerFor(user).account.setTier({ tier: "plus" })).rejects.toThrow(/Plans can't be switched here/);
    const db = (await getDb())!;
    const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(u?.tier).toBe("free");
    const [b] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, user.id)).limit(1);
    expect(b?.plan).toBe("free");
  });

  it("usage still reports the billing plan", async () => {
    const usage = await callerFor(user).account.usage();
    expect(usage).toMatchObject({ tier: "free", plan: "free" });
  });

  it("a session row edited to tier 'pro' still gets Free access", async () => {
    await expect(callerFor({ ...user, tier: "pro" }).reports.portfolioExport()).rejects.toThrow(/requires the Pro plan\. Your plan: Free\./);
  });

  it("rejects invalid tiers at the schema boundary", async () => {
    await expect(
      // @ts-expect-error — deliberately invalid input
      callerFor(user).account.setTier({ tier: "enterprise" }),
    ).rejects.toThrow();
  });
});
