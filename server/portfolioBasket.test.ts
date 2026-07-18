/**
 * §3i-2 Portfolio basket — scenariosApi.portfolioCompose contract.
 *
 * Pins:
 *  1. Pro gate: free callers are rejected.
 *  2. Input contract: fewer than 2 sites is rejected by the zod schema.
 *  3. Rollup: per-site composition through composeMeasures, summed; rollup
 *     confidence inherits the WEAKEST site chip (never the average, never the best).
 *  4. Honesty: the disclosure states no cross-site interaction is modeled.
 *  5. Tenancy: a basket containing another user's site is rejected outright.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

function ctxFor(user: { id: number; openId: string; tier?: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: "user",
      tier: user.tier ?? "free",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}

async function makeUser(openId: string, tier: "free" | "pro") {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: openId } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.update(users).set({ tier }).where(eq(users.id, rows[0].id));
  return { ...rows[0], tier };
}

const MEASURE = {
  key: "led_retrofit",
  label: "LED retrofit",
  kind: "efficiency" as const,
  efficiencyReductions: { lighting: 0.4 },
};

const CONF_RANK = { low: 0, medium: 1, high: 2 } as const;

let pro: Awaited<ReturnType<typeof makeUser>>;
let free: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let proSites: number[] = [];
let otherSite = 0;

beforeAll(async () => {
  const run = Date.now();
  pro = await makeUser(`pbasket-pro-${run}`, "pro");
  free = await makeUser(`pbasket-free-${run}`, "free");
  other = await makeUser(`pbasket-other-${run}`, "pro");
  const proCaller = appRouter.createCaller(ctxFor(pro));
  proSites = [];
  for (let i = 0; i < 2; i++) {
    const created = await proCaller.sites.create({
      name: `Basket site ${i + 1}`,
      state: "AZ",
      zip: "85701",
      buildingType: "office",
      sqft: 8000 + i * 2000,
    });
    proSites.push(created.id);
  }
  const otherCaller = appRouter.createCaller(ctxFor(other));
  const theirs = await otherCaller.sites.create({ name: "Not yours", state: "TX", buildingType: "office" });
  otherSite = theirs.id;
}, 60_000);

describe("§3i-2 portfolio basket (scenariosApi.portfolioCompose)", () => {
  it("rejects non-pro callers (portfolio surface is Pro-gated)", async () => {
    const caller = appRouter.createCaller(ctxFor(free));
    await expect(
      caller.scenariosApi.portfolioCompose({ siteIds: [1, 2], measure: MEASURE }),
    ).rejects.toThrow(/pro|tier|upgrade|forbidden/i);
  });

  it("rejects a basket with fewer than 2 sites at the input layer", async () => {
    const caller = appRouter.createCaller(ctxFor(pro));
    await expect(
      caller.scenariosApi.portfolioCompose({ siteIds: [proSites[0]], measure: MEASURE }),
    ).rejects.toThrow();
  });

  it("composes per site, sums the rollup, and inherits the weakest chip", async () => {
    const caller = appRouter.createCaller(ctxFor(pro));
    const out = await caller.scenariosApi.portfolioCompose({ siteIds: proSites, measure: MEASURE });

    expect(out.perSite.length).toBe(proSites.length);
    const okRows = out.perSite.filter((r) => r.ok);
    expect(okRows.length).toBeGreaterThan(0);

    // Rollup sum equals the sum of per-site parts (float tolerance).
    const sum = okRows.reduce((s, r) => s + (r.annualSavingsUsd ?? 0), 0);
    expect(Math.abs(out.rollup.annualSavingsUsd - sum)).toBeLessThan(0.01);
    expect(out.rollup.sitesComposed).toBe(okRows.length);
    expect(out.rollup.sitesFailed).toBe(out.perSite.length - okRows.length);

    // Weakest-chip inheritance.
    const weakest = okRows.reduce<"low" | "medium" | "high">(
      (acc, r) => (CONF_RANK[r.confidence ?? "low"] < CONF_RANK[acc] ? (r.confidence ?? "low") : acc),
      "high",
    );
    expect(out.rollup.confidence).toBe(weakest);

    // Methodology honesty disclosure.
    expect(out.disclosure).toMatch(/independently|no cross-site/i);
  }, 120_000);

  it("rejects a basket containing another user's site (tenancy boundary)", async () => {
    const caller = appRouter.createCaller(ctxFor(pro));
    // getSite enforces tenancy with a hard TenancyError: a foreign siteId
    // rejects the whole request rather than composing around it.
    await expect(
      caller.scenariosApi.portfolioCompose({
        siteIds: [...proSites, otherSite],
        measure: MEASURE,
      }),
    ).rejects.toThrow();
  }, 120_000);
});
