/**
 * Governance tests — multi-tenancy isolation, tier gating, free-tier cost cap
 * and LLM budget kill-switch, audit logging, and the user data-export endpoint.
 * Runs against the real dev database via the tRPC caller with two fake users.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { FREE_TIER_MAX_COST_USD, FREE_TIER_MAX_SITES, FREE_TIER_MONTHLY_LLM_BUDGET_USD } from "../shared/wattwise";
import { llmBudgetAllows, recordMeterEvent } from "./analytics/costModel";

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

let aliceId = 0;
let bobId = 0;

beforeAll(async () => {
  const db = (await getDb())!;
  for (const openId of ["vitest-alice", "vitest-bob"]) {
    await db
      .insert(users)
      .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
      .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date() } });
  }
  const rows = await db.select().from(users).where(eq(users.openId, "vitest-alice"));
  aliceId = rows[0]!.id;
  const rows2 = await db.select().from(users).where(eq(users.openId, "vitest-bob"));
  bobId = rows2[0]!.id;
}, 30_000);

describe("multi-tenancy isolation", () => {
  it("cross-tenant site access is FORBIDDEN", async () => {
    const alice = appRouter.createCaller(ctxFor({ id: aliceId, openId: "vitest-alice" }));
    const bob = appRouter.createCaller(ctxFor({ id: bobId, openId: "vitest-bob" }));
    // idempotent across runs: reuse an existing site if the free quota is already consumed
    let site: { id: number };
    const existing = await alice.sites.list();
    if (existing.length > 0) {
      site = existing[0]!;
    } else {
      site = await alice.sites.create({
        name: "Alice HQ",
        siteType: "office",
        sectorClass: "commercial",
        climateZone: "2B",
        state: "AZ",
        zip: "85004",
        floorAreaSqft: 20_000,
      });
    }
    // Bob must not be able to read Alice's site detail
    await expect(bob.sites.get({ siteId: site.id })).rejects.toThrow();
    // Bob's site list must not contain Alice's site
    const bobSites = await bob.sites.list();
    expect(bobSites.find((s: { id: number }) => s.id === site.id)).toBeUndefined();
    // And Bob cannot attach a meter to Alice's site
    await expect(
      bob.sites.addMeter({ siteId: site.id, commodity: "electric", label: "sneaky" }),
    ).rejects.toThrow();
  }, 30_000);

  it("data export returns only the calling user's data", async () => {
    const alice = appRouter.createCaller(ctxFor({ id: aliceId, openId: "vitest-alice" }));
    const exportData = await alice.account.exportData();
    const foreignSites = (exportData.sites as Array<{ userId: number }>).filter((s) => s.userId !== aliceId);
    expect(foreignSites.length).toBe(0);
  }, 30_000);
});

describe("tier gating", () => {
  // Batch-17 (pass 300): deterministic, cap-aware quota test. Instead of blindly
  // looping and accepting ANY thrown error as "quota enforced", we (a) read the
  // actual cap constant, (b) fill exactly up to the cap (asserting each in-cap
  // creation SUCCEEDS), then (c) assert the (cap+1)th creation fails with the
  // specific FORBIDDEN quota message — so an unrelated failure (validation, DB)
  // can no longer masquerade as a passing quota check.
  it(`free tier cannot exceed the ${FREE_TIER_MAX_SITES}-site quota`, async () => {
    const alice = appRouter.createCaller(ctxFor({ id: aliceId, openId: "vitest-alice" }));
    const siteInput = (i: number) => ({
      name: `Quota probe ${i}`,
      siteType: "office",
      sectorClass: "commercial" as const,
      climateZone: "2B",
      state: "AZ",
      zip: "85004",
      floorAreaSqft: 1000,
    });
    // Fill remaining headroom up to the cap — these creations must all succeed.
    const existing = await alice.sites.list();
    const headroom = FREE_TIER_MAX_SITES - existing.length;
    for (let i = 0; i < headroom; i++) {
      const created = await alice.sites.create(siteInput(i));
      expect(created.id).toBeGreaterThan(0);
    }
    const atCap = await alice.sites.list();
    expect(atCap.length).toBe(FREE_TIER_MAX_SITES);
    // The (cap+1)th creation must fail with the precise quota error.
    await expect(alice.sites.create(siteInput(headroom))).rejects.toThrow(
      new RegExp(`Free tier is limited to ${FREE_TIER_MAX_SITES} sites`),
    );
    // And it must not have leaked a row past the cap.
    const after = await alice.sites.list();
    expect(after.length).toBe(FREE_TIER_MAX_SITES);
  }, 30_000);
});

describe("cost model — free tier ≤ $0.20 and kill-switch", () => {
  it("cap constant is enforced at ≤ $0.20", () => {
    expect(FREE_TIER_MAX_COST_USD).toBeLessThanOrEqual(0.2);
  });

  it("llmBudgetAllows denies once monthly spend reaches the free-tier budget", async () => {
    // Simulate a user with maxed-out LLM spend — recordMeterEvent derives cost
    // from token counts, so push enough tokens to exceed the monthly budget.
    const probeUser = bobId;
    let spent = 0;
    for (let i = 0; i < 40 && spent <= FREE_TIER_MONTHLY_LLM_BUDGET_USD; i++) {
      spent += await recordMeterEvent({
        userId: probeUser,
        kind: "bill_ocr_llm",
        llmTokensIn: 1_000_000,
        llmTokensOut: 200_000,
        tier: "free",
      });
    }
    expect(spent).toBeGreaterThan(FREE_TIER_MONTHLY_LLM_BUDGET_USD);
    const allowed = await llmBudgetAllows(probeUser, "free");
    expect(allowed).toBe(false);
    // pro tier is not subject to the free kill-switch: same spend still allowed
    const proAllowed = await llmBudgetAllows(probeUser, "pro");
    expect(proAllowed).toBe(true);
  }, 30_000);
});

describe("audit log", () => {
  it("site creation writes an audit entry", async () => {
    const db = (await getDb())!;
    const { auditLog } = await import("../drizzle/schema");
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, aliceId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.action === "site_created")).toBe(true);
  }, 30_000);
});
