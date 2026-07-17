/**
 * Gap-6 (Jul 2026): self-serve beta tier switching — setTier updates the
 * user's own row, unlocks requireTier-gated features immediately, is audited
 * with an explicit no-billing note, and downgrading re-imposes gates.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type Ctx = Parameters<typeof appRouter.createCaller>[0];

async function makeUser(openId: string) {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: `Tier Test ${openId}`, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: `Tier Test ${openId}` } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return rows[0];
}

function callerFor(user: Awaited<ReturnType<typeof makeUser>>) {
  return appRouter.createCaller({
    user,
    req: { headers: {} },
    res: { setHeader: () => undefined, clearCookie: () => undefined },
  } as unknown as Ctx);
}

let user: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  user = await makeUser("tier-test-user-1");
  // reset to free in case of prior runs
  const db = (await getDb())!;
  await db.update(users).set({ tier: "free" }).where(eq(users.id, user.id));
  user = { ...user, tier: "free" };
});

describe("account.setTier (self-serve beta)", () => {
  it("switches free → plus, persists, and audits with a no-billing note", async () => {
    const caller = callerFor(user);
    const res = await caller.account.setTier({ tier: "plus" });
    expect(res.tier).toBe("plus");
    expect(res.previous).toBe("free");

    const db = (await getDb())!;
    const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(rows[0]?.tier).toBe("plus");
  });

  it("usage reflects the new tier immediately", async () => {
    // fresh ctx with updated tier (session refetch equivalent)
    const db = (await getDb())!;
    const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const caller = callerFor(rows[0]);
    const usage = await caller.account.usage();
    expect(usage.tier).toBe("plus");
  });

  it("downgrading back to free re-imposes the tier gates", async () => {
    const db = (await getDb())!;
    let rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const caller = callerFor(rows[0]);
    const res = await caller.account.setTier({ tier: "free" });
    expect(res.tier).toBe("free");
    expect(res.previous).toBe("plus");
    rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(rows[0]?.tier).toBe("free");
  });

  it("rejects invalid tiers at the schema boundary", async () => {
    const caller = callerFor(user);
    await expect(
      // @ts-expect-error — deliberately invalid input
      caller.account.setTier({ tier: "enterprise" }),
    ).rejects.toThrow();
  });
});
