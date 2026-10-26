/**
 * BILL-1 (Oct 26) — feature access follows the billing account, never the
 * legacy users.tier column.
 *
 * Proven at real protected procedures (appRouter callers backed by real DB
 * rows), for: Free, Founding, Plus, Pro, past-due inside the 7-day grace,
 * past-due after grace, canceled, no billing account, and the owner/admin.
 *  - a user whose users.tier says "pro" but whose billing plan is Free is
 *    refused Pro features (the old self-upgrade hole);
 *  - account.setTier can no longer change access and writes nothing;
 *  - the Plus site and scenario caps come from the one plan map (10 / 20),
 *    and the Free wording is unchanged;
 *  - account.usage reports the billing plan.
 * Every fixture user, billing row, site and scenario is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { auditLog, billingAccounts, scenarios, sites, users } from "../drizzle/schema";
import { PLAN_ENTITLEMENTS, entitlementFor, entitlementForUser, effectiveEntitlement } from "./billing";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
type Fixture = { id: number; openId: string; role: "user" | "admin" };
const made: number[] = [];
const DAY = 24 * 60 * 60 * 1000;

async function makeUser(label: string, billing: { plan: string; status?: string; graceEndsAt?: number | null } | null, opts: { legacyTier?: "free" | "plus" | "pro"; role?: "user" | "admin" } = {}): Promise<Fixture> {
  const db = (await getDb())!;
  const openId = `bill1-${label}-${stamp}`;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: opts.legacyTier ?? "free", role: opts.role ?? "user" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  made.push(u!.id);
  if (billing) {
    const plan = billing.plan;
    await db.insert(billingAccounts).values({
      userId: u!.id,
      plan,
      entitlementTier: plan === "plus" ? "plus" : plan === "pro" || plan === "founding" ? "pro" : "free",
      status: billing.status ?? "active",
      graceEndsAt: billing.graceEndsAt ?? null,
    });
  }
  return { id: u!.id, openId, role: opts.role ?? "user" };
}

/** The session user as the auth layer builds it — including a legacy tier
 * that must be ignored for access. */
function callerFor(f: Fixture, legacyTier: "free" | "plus" | "pro" = "pro") {
  const ctx = {
    user: { id: f.id, openId: f.openId, email: `${f.openId}@test.local`, name: f.openId, loginMethod: "test", role: f.role, tier: legacyTier, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}

const siteInput = (i: number) => ({ name: `BILL-1 probe ${i}`, siteType: "office", sectorClass: "commercial" as const, climateZone: "2B", state: "AZ", zip: "85004", floorAreaSqft: 1000 });

let free: Fixture, founding: Fixture, plus: Fixture, pro: Fixture, graceOk: Fixture, graceOver: Fixture, canceled: Fixture, none: Fixture, admin: Fixture;

beforeAll(async () => {
  const now = Date.now();
  free = await makeUser("free", { plan: "free" }, { legacyTier: "pro" });
  founding = await makeUser("founding", { plan: "founding" });
  plus = await makeUser("plus", { plan: "plus" });
  pro = await makeUser("pro", { plan: "pro" });
  graceOk = await makeUser("grace-ok", { plan: "pro", status: "past_due", graceEndsAt: now + 3 * DAY });
  graceOver = await makeUser("grace-over", { plan: "pro", status: "past_due", graceEndsAt: now - 1000 });
  canceled = await makeUser("canceled", { plan: "pro", status: "canceled" });
  none = await makeUser("none", null, { legacyTier: "pro" });
  admin = await makeUser("admin", null, { role: "admin" });
}, 60_000);

afterAll(async () => {
  const db = await getDb();
  if (!db || made.length === 0) return;
  for (const id of made) {
    for (const s of await h.listSites(id)) await h.deleteSite(s.id, id);
  }
  await db.delete(scenarios).where(inArray(scenarios.userId, made));
  await db.delete(auditLog).where(inArray(auditLog.userId, made));
  await db.delete(billingAccounts).where(inArray(billingAccounts.userId, made));
  await db.delete(users).where(inArray(users.id, made));
}, 60_000);

describe("entitlement resolution (unit)", () => {
  const now = 1_800_000_000_000;
  it("maps plans, grace and non-paying states", () => {
    expect(entitlementFor("user", { plan: "founding", status: "active", graceEndsAt: null }, now).tier).toBe("pro");
    expect(entitlementFor("user", { plan: "plus", status: "trialing", graceEndsAt: null }, now).plan).toBe("plus");
    expect(entitlementFor("user", { plan: "pro", status: "past_due", graceEndsAt: now + 1 }, now).plan).toBe("pro");
    expect(entitlementFor("user", { plan: "pro", status: "past_due", graceEndsAt: now }, now).plan).toBe("free");
    expect(entitlementFor("user", { plan: "pro", status: "past_due", graceEndsAt: null }, now).plan).toBe("free");
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "something_new"]) {
      expect(effectiveEntitlement({ plan: "pro", status, graceEndsAt: null }, now).plan).toBe("free");
    }
    expect(entitlementFor("user", null, now)).toEqual(PLAN_ENTITLEMENTS.free);
    expect(entitlementFor("admin", null, now).tier).toBe("pro");
  });
  it("loads the billing account from the database (and fails closed without a real user id)", async () => {
    expect((await entitlementForUser({ id: plus.id, role: "user" })).plan).toBe("plus");
    expect((await entitlementForUser({ id: none.id, role: "user" })).plan).toBe("free");
    expect((await entitlementForUser({ id: -1, role: "user" })).plan).toBe("free");
  });
});

describe("protected procedures follow the billing plan", () => {
  const proGate = (f: Fixture) => callerFor(f).reports.portfolioExport();
  const plusGate = (f: Fixture) => callerFor(f).reports.generate({ siteId: 2147483000, kind: "energy_plan" });

  it("a legacy users.tier of 'pro' no longer unlocks anything (Free billing plan / no account)", async () => {
    for (const f of [free, none]) {
      await expect(proGate(f)).rejects.toThrow(/Portfolio Manager export requires the Pro plan\. Your plan: Free\./);
      await expect(plusGate(f)).rejects.toThrow(/requires the Plus plan/);
      await expect(callerFor(f).ask.question({ siteId: 2147483000, question: "Why was July high?" })).rejects.toThrow(/Ask Meterly requires the Plus plan/);
    }
  });

  it("Founding, Pro, in-grace past-due and the owner pass the Pro gate", async () => {
    for (const f of [founding, pro, graceOk, admin]) {
      const rows = await proGate(f);
      expect(Array.isArray(rows) || typeof rows === "object").toBe(true);
    }
  });

  it("Plus passes Plus gates but not Pro gates", async () => {
    // energy_plan passes the plan gate, then fails on tenancy (site not owned).
    await expect(plusGate(plus)).rejects.toThrow(/Access denied|does not belong|not found/i);
    await expect(proGate(plus)).rejects.toThrow(/requires the Pro plan\. Your plan: Plus\./);
  });

  it("past-due after grace and canceled subscriptions fall back to Free", async () => {
    for (const f of [graceOver, canceled]) {
      await expect(proGate(f)).rejects.toThrow(/requires the Pro plan\. Your plan: Free\./);
      await expect(plusGate(f)).rejects.toThrow(/requires the Plus plan/);
    }
  });

  it("account.usage reports the billing plan, not users.tier", async () => {
    expect(await callerFor(free).account.usage()).toMatchObject({ tier: "free", plan: "free" });
    expect(await callerFor(none).account.usage()).toMatchObject({ tier: "free", plan: "free" });
    expect(await callerFor(founding, "free").account.usage()).toMatchObject({ tier: "pro", plan: "founding" });
    expect(await callerFor(graceOver).account.usage()).toMatchObject({ tier: "free", plan: "free" });
  });
});

describe("account.setTier is closed", () => {
  it("refuses, writes nothing, and audits the attempt", async () => {
    const db = (await getDb())!;
    await expect(callerFor(free, "free").account.setTier({ tier: "pro" })).rejects.toThrow(/Plans can't be switched here\. Your plan \(Free\)/);
    const [u] = await db.select({ tier: users.tier }).from(users).where(eq(users.id, free.id));
    expect(u!.tier).toBe("pro"); // the fixture's legacy value, untouched
    const [b] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, free.id));
    expect(b!.plan).toBe("free");
    const audits = await db.select().from(auditLog).where(eq(auditLog.userId, free.id));
    expect(audits.some((a) => a.action === "tier_change_refused")).toBe(true);
    await expect(proGate()).rejects.toThrow(/requires the Pro plan/);
    function proGate() { return callerFor(free).reports.portfolioExport(); }
  });
  it("still validates input at the schema boundary", async () => {
    // @ts-expect-error — deliberately invalid input
    await expect(callerFor(free).account.setTier({ tier: "enterprise" })).rejects.toThrow();
  });
});

describe("plan-map caps", () => {
  it("Free keeps its exact site message; Plus is capped at 10 sites by the plan map", async () => {
    const fc = callerFor(free);
    for (let i = 0; i < 2; i++) expect((await fc.sites.create(siteInput(i))).id).toBeGreaterThan(0);
    await expect(fc.sites.create(siteInput(2))).rejects.toThrow(/^Free tier is limited to 2 sites\. Upgrade to add more\.$/);

    const pc = callerFor(plus);
    for (let i = 0; i < 10; i++) expect((await pc.sites.create(siteInput(i))).id).toBeGreaterThan(0);
    await expect(pc.sites.create(siteInput(10))).rejects.toThrow(/^The Plus plan is limited to 10 sites\. Upgrade to add more\.$/);
    expect((await h.listSites(plus.id)).length).toBe(10);
  }, 120_000);

  it("Founding is not capped (an 11th site is allowed)", async () => {
    const c = callerFor(founding);
    for (let i = 0; i < 11; i++) expect((await c.sites.create(siteInput(i))).id).toBeGreaterThan(0);
  }, 120_000);

  it("Plus is capped at 20 scenario runs/month; Free keeps its 3-run message", async () => {
    const db = (await getDb())!;
    const [ps] = await h.listSites(plus.id);
    const [fs] = await h.listSites(free.id);
    const fill = async (userId: number, siteId: number, n: number) => {
      for (let i = 0; i < n; i++) {
        await h.saveScenario({ siteId, userId, name: `bill1-fill-${i}`, transform: "led_equipment", params: {}, loadBasis: "archetype_scaled", status: "complete" });
      }
    };
    await fill(plus.id, ps!.id, 20);
    await fill(free.id, fs!.id, 3);
    await expect(callerFor(plus).scenariosApi.run({ siteId: ps!.id, name: "cap probe", kind: "efficiency" })).rejects.toThrow(/^The Plus plan allows 20 scenario runs\/month\.$/);
    await expect(callerFor(free).scenariosApi.run({ siteId: fs!.id, name: "cap probe", kind: "efficiency" })).rejects.toThrow(/^Free tier allows 3 scenario runs\/month\.$/);
    await db.delete(scenarios).where(inArray(scenarios.userId, [plus.id, free.id]));
  }, 60_000);
});
