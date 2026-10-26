/**
 * BILL-1 (Oct 26) — Stripe webhook boundary (test mode only; no network).
 *
 * processStripeEvent is exercised against real billing rows of isolated
 * fixture users; the Express handler is exercised with a fake req/res and a
 * locally computed signature. Covers: duplicate delivery (sequential and
 * concurrent), missing account mapping, checkout completion via
 * client_reference_id, plan from the configured price id (portal switch),
 * past-due grace that is not extended by repeated failures, invoice.paid
 * restoring access, customer.subscription.deleted returning to Free (it was
 * unreachable before), a deleted event for an older subscription, stale
 * out-of-order events, Founding preservation, signature rejection, the
 * not-configured 503 and live-key fail-closed paths, and Founding checkout
 * refusal. All fixture rows are removed afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { Request, Response } from "express";
import { getDb } from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { billingAccounts, billingAudit, billingWebhookEvents, users } from "../drizzle/schema";
import { effectiveEntitlement, webhookSignature } from "./billing";
import { createHostedCheckoutSession, planFromStripe, processStripeEvent, stripeWebhookHandler } from "./stripeBilling";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const evtPrefix = `evt_bill1_${stamp}_`;
const made: number[] = [];
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const evt = (type: string, object: Record<string, unknown>, created?: number) => ({ id: `${evtPrefix}${++seq}`, type, created, data: { object } });

async function makeUser(label: string, plan: string | null, extra: Partial<typeof billingAccounts.$inferInsert> = {}) {
  const db = (await getDb())!;
  const openId = `bill1-stripe-${label}-${stamp}`;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  made.push(u!.id);
  if (plan) await db.insert(billingAccounts).values({ userId: u!.id, plan, entitlementTier: plan === "founding" || plan === "pro" ? "pro" : plan === "plus" ? "plus" : "free", status: "active", ...extra });
  return { id: u!.id, openId };
}
async function account(userId: number) {
  const db = (await getDb())!;
  const [a] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId));
  return a!;
}

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PLUS", "STRIPE_PRICE_PRO"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});
afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(billingWebhookEvents).where(like(billingWebhookEvents.eventId, `${evtPrefix}%`));
  if (made.length === 0) return;
  await db.delete(billingAudit).where(inArray(billingAudit.userId, made));
  await db.delete(billingAccounts).where(inArray(billingAccounts.userId, made));
  await db.delete(users).where(inArray(users.id, made));
}, 60_000);

describe("planFromStripe", () => {
  it("prefers the configured price id over metadata", () => {
    const env = { STRIPE_PRICE_PLUS: "price_plus", STRIPE_PRICE_PRO: "price_pro" };
    expect(planFromStripe("price_pro", "plus", env)).toBe("pro");
    expect(planFromStripe("price_plus", null, env)).toBe("plus");
    expect(planFromStripe("price_other", "pro", env)).toBe("pro");
    expect(planFromStripe("price_other", "enterprise", env)).toBeNull();
  });
});

describe("processStripeEvent", () => {
  it("ignores duplicate deliveries, sequentially and concurrently", async () => {
    const u = await makeUser("dup", "free");
    const e = evt("invoice.payment_failed", { customer: "cus_x", metadata: { userId: String(u.id) } });
    expect(await processStripeEvent(e)).toEqual({ processed: true });
    expect(await processStripeEvent(e)).toEqual({ processed: false, reason: "duplicate" });
    const e2 = evt("invoice.paid", { metadata: { userId: String(u.id) } });
    const results = await Promise.all([processStripeEvent(e2), processStripeEvent(e2), processStripeEvent(e2)]);
    expect(results.filter((r) => r.processed).length).toBe(1);
    expect(results.filter((r) => r.reason === "duplicate").length).toBe(2);
  });

  it("records an event with no matching account without changing anything", async () => {
    const r = await processStripeEvent(evt("customer.subscription.updated", { id: "sub_nobody", customer: `cus_nobody_${stamp}`, status: "active" }));
    expect(r).toEqual({ processed: true, reason: "no_account_mapping" });
  });

  it("checkout completion maps via client_reference_id and grants the paid plan", async () => {
    const u = await makeUser("checkout", null); // never opened Billing: no mirror row yet
    const r = await processStripeEvent(evt("checkout.session.completed", { id: "cs_test_1", customer: `cus_co_${stamp}`, subscription: `sub_co_${stamp}`, client_reference_id: String(u.id), payment_status: "paid", metadata: { plan: "plus" } }));
    expect(r).toEqual({ processed: true });
    const a = await account(u.id);
    expect(a).toMatchObject({ plan: "plus", entitlementTier: "plus", status: "active", stripeCustomerId: `cus_co_${stamp}`, stripeSubscriptionId: `sub_co_${stamp}` });
    expect(effectiveEntitlement(a).maxSites).toBe(10);
  });

  it("a portal plan switch follows the configured price id", async () => {
    process.env.STRIPE_PRICE_PLUS = "price_test_plus";
    process.env.STRIPE_PRICE_PRO = "price_test_pro";
    const u = await makeUser("switch", "plus", { stripeCustomerId: `cus_sw_${stamp}`, stripeSubscriptionId: `sub_sw_${stamp}` });
    await processStripeEvent(evt("customer.subscription.updated", { id: `sub_sw_${stamp}`, customer: `cus_sw_${stamp}`, status: "active", metadata: { userId: String(u.id), plan: "plus" }, items: { data: [{ price: { id: "price_test_pro" }, current_period_end: 1_900_000_000 }] } }, 1000));
    const a = await account(u.id);
    expect(a).toMatchObject({ plan: "pro", entitlementTier: "pro", stripePriceId: "price_test_pro", currentPeriodEnd: 1_900_000_000_000 });
  });

  it("payment failure starts a 7-day grace that repeat failures do not extend; invoice.paid restores", async () => {
    const u = await makeUser("grace", "pro", { stripeCustomerId: `cus_gr_${stamp}` });
    const t0 = Date.now();
    await processStripeEvent(evt("invoice.payment_failed", { customer: `cus_gr_${stamp}` }), t0);
    const first = await account(u.id);
    expect(first.status).toBe("past_due");
    expect(first.graceEndsAt).toBe(t0 + 7 * DAY);
    expect(effectiveEntitlement(first, t0 + 6 * DAY).plan).toBe("pro");
    expect(effectiveEntitlement(first, t0 + 7 * DAY + 1).plan).toBe("free");
    await processStripeEvent(evt("invoice.payment_failed", { customer: `cus_gr_${stamp}` }), t0 + 3 * DAY);
    expect((await account(u.id)).graceEndsAt).toBe(t0 + 7 * DAY);
    // A subscription.updated reporting past_due keeps the same grace deadline.
    await processStripeEvent(evt("customer.subscription.updated", { id: "sub_gr", customer: `cus_gr_${stamp}`, status: "past_due", metadata: { plan: "pro" } }), t0 + 4 * DAY);
    expect((await account(u.id)).graceEndsAt).toBe(t0 + 7 * DAY);
    await processStripeEvent(evt("invoice.paid", { customer: `cus_gr_${stamp}` }), t0 + 5 * DAY);
    expect(await account(u.id)).toMatchObject({ status: "active", graceEndsAt: null });
  });

  it("customer.subscription.deleted returns the account to Free (only for the current subscription)", async () => {
    const u = await makeUser("cancel", "pro", { stripeCustomerId: `cus_ca_${stamp}`, stripeSubscriptionId: `sub_ca_new_${stamp}` });
    const old = await processStripeEvent(evt("customer.subscription.deleted", { id: `sub_ca_old_${stamp}`, customer: `cus_ca_${stamp}`, status: "canceled" }));
    expect(old.reason).toBe("not_current_subscription");
    expect((await account(u.id)).plan).toBe("pro");
    await processStripeEvent(evt("customer.subscription.deleted", { id: `sub_ca_new_${stamp}`, customer: `cus_ca_${stamp}`, status: "canceled" }));
    const a = await account(u.id);
    expect(a).toMatchObject({ plan: "free", entitlementTier: "free", status: "canceled", stripeSubscriptionId: null });
    expect(effectiveEntitlement(a).plan).toBe("free");
  });

  it("ignores subscription events older than the last one applied", async () => {
    process.env.STRIPE_PRICE_PLUS = "price_test_plus";
    process.env.STRIPE_PRICE_PRO = "price_test_pro";
    const u = await makeUser("order", "plus", { stripeCustomerId: `cus_or_${stamp}`, stripeSubscriptionId: `sub_or_${stamp}` });
    const sub = (price: string) => ({ id: `sub_or_${stamp}`, customer: `cus_or_${stamp}`, status: "active", items: { data: [{ price: { id: price } }] } });
    await processStripeEvent(evt("customer.subscription.updated", sub("price_test_pro"), 2000));
    const stale = await processStripeEvent(evt("customer.subscription.updated", sub("price_test_plus"), 1500));
    expect(stale.reason).toBe("stale_event");
    expect((await account(u.id)).plan).toBe("pro");
  });

  it("never changes a Founding account's plan or status", async () => {
    const u = await makeUser("founding", "founding", { stripeCustomerId: `cus_fo_${stamp}` });
    for (const e of [
      evt("checkout.session.completed", { customer: `cus_fo_${stamp}`, subscription: "sub_fo", client_reference_id: String(u.id), payment_status: "paid", metadata: { plan: "plus" } }),
      evt("customer.subscription.updated", { id: "sub_fo", customer: `cus_fo_${stamp}`, status: "unpaid", metadata: { plan: "plus" } }),
      evt("invoice.payment_failed", { customer: `cus_fo_${stamp}` }),
      evt("customer.subscription.deleted", { id: "sub_fo", customer: `cus_fo_${stamp}`, status: "canceled" }),
    ]) {
      expect((await processStripeEvent(e)).reason).toBe("founding_preserved");
    }
    const a = await account(u.id);
    expect(a).toMatchObject({ plan: "founding", status: "active", graceEndsAt: null });
    expect(effectiveEntitlement(a).tier).toBe("pro");
  });
});

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  } as unknown as Response;
  return { res, out };
}
function fakeReq(raw: string, signature?: string) {
  return { body: Buffer.from(raw, "utf8"), header: (n: string) => (n.toLowerCase() === "stripe-signature" ? signature : undefined) } as unknown as Request;
}

describe("stripeWebhookHandler", () => {
  it("answers 503 when test billing is not configured, and fails closed on a live key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const a = fakeRes();
    await stripeWebhookHandler(fakeReq("{}"), a.res);
    expect(a.out.status).toBe(503);
    process.env.STRIPE_SECRET_KEY = "sk_live_should_never_be_used";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const b = fakeRes();
    await stripeWebhookHandler(fakeReq("{}"), b.res);
    expect(b.out.status).toBe(503);
  });

  it("rejects a bad signature and accepts a correctly signed event once", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_local_only";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local_only";
    const u = await makeUser("hook", "free");
    const raw = JSON.stringify(evt("invoice.paid", { metadata: { userId: String(u.id) } }));
    const bad = fakeRes();
    await stripeWebhookHandler(fakeReq(raw, "t=1,v1=deadbeef"), bad.res);
    expect(bad.out.status).toBe(400);
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${webhookSignature(raw, "whsec_local_only", t)}`;
    const ok = fakeRes();
    await stripeWebhookHandler(fakeReq(raw, sig), ok.res);
    expect(ok.out).toMatchObject({ status: 200, body: { ok: true, processed: true } });
    const again = fakeRes();
    await stripeWebhookHandler(fakeReq(raw, sig), again.res);
    expect(again.out).toMatchObject({ status: 200, body: { processed: false, reason: "duplicate" } });
  });
});

describe("checkout boundary", () => {
  it("refuses a live key and missing prices before any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.STRIPE_SECRET_KEY = "sk_live_should_never_be_used";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    process.env.STRIPE_PRICE_PLUS = "price_plus";
    await expect(createHostedCheckoutSession({ userId: 1, plan: "plus" })).rejects.toThrow(/not configured/);
    process.env.STRIPE_SECRET_KEY = "sk_test_local_only";
    delete process.env.STRIPE_PRICE_PRO;
    await expect(createHostedCheckoutSession({ userId: 1, plan: "pro" })).rejects.toThrow(/not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the user id on the session (client_reference_id + metadata) for attribution", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_local_only";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    process.env.STRIPE_PRICE_PLUS = "price_plus";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ url: "https://checkout.stripe.test/s" }), { status: 200 }));
    await createHostedCheckoutSession({ userId: 4242, plan: "plus" });
    const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as URLSearchParams;
    expect(body.get("client_reference_id")).toBe("4242");
    expect(body.get("metadata[userId]")).toBe("4242");
    expect(body.get("subscription_data[metadata][userId]")).toBe("4242");
  });

  it("never sends a Founding account to a paid checkout", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_local_only";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    process.env.STRIPE_PRICE_PLUS = "price_plus";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const u = await makeUser("co-founding", "founding");
    const caller = appRouter.createCaller({
      user: { id: u.id, openId: u.openId, email: null, name: u.openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
    } as TrpcContext);
    await expect(caller.account.billingCheckout({ plan: "plus" })).rejects.toThrow(/Founding access already includes every feature/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
