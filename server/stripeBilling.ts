import type { Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { billingAccounts, billingAudit, billingWebhookEvents, users } from "../drizzle/schema";
import { getDb } from "./db";
import { gracePeriodEndsAt, planEntitlements, stripeConfigured, verifyWebhookSignature } from "./billing";

type StripeEvent = { id: string; type: string; created?: number; data?: { object?: Record<string, unknown> } };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positiveInt(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}
function metadataOf(obj: Record<string, unknown>): Record<string, unknown> {
  const metadata = obj.metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}
function isDuplicateKey(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const x = e as { errno?: number; code?: string; message?: string };
    if (x.errno === 1062 || x.code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(x.message ?? "")) return true;
  }
  return false;
}
type PaidPlan = "plus" | "pro";
/** Plan from the configured test-mode price IDs first (a plan switch in the
 * Customer Portal changes the price, not our metadata), then from metadata. */
export function planFromStripe(priceId: string | null, metadataPlan: unknown, env: Record<string, string | undefined> = process.env): PaidPlan | null {
  if (priceId && env.STRIPE_PRICE_PLUS && priceId === env.STRIPE_PRICE_PLUS) return "plus";
  if (priceId && env.STRIPE_PRICE_PRO && priceId === env.STRIPE_PRICE_PRO) return "pro";
  return metadataPlan === "plus" || metadataPlan === "pro" ? metadataPlan : null;
}
function firstItem(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const items = obj.items as Record<string, unknown> | undefined;
  return Array.isArray(items?.data) ? (items!.data as Array<Record<string, unknown>>)[0] : undefined;
}
class DuplicateEvent extends Error {}

type StripeEventResult = { processed: boolean; reason?: string };

/**
 * Applies one verified Stripe event to the account's billing mirror.
 * BILL-1 (Oct 26):
 * - Exactly once: the event id is recorded in the same transaction as the
 *   account change, so a crash rolls both back and Stripe's retry is applied;
 *   a concurrent duplicate delivery hits the unique key and is skipped.
 * - Founding accounts keep their no-charge plan; Stripe ids are linked and
 *   the event is audited, but plan/status are not changed.
 * - customer.subscription.deleted (previously unreachable) returns the
 *   account to Free; a deleted event for an older subscription is ignored.
 * - Repeated payment failures do not extend the 7-day grace window.
 * - Subscription events older than the last applied one are ignored.
 */
export async function processStripeEvent(event: StripeEvent & { created?: number }, now = Date.now()): Promise<StripeEventResult> {
  const db = await getDb();
  if (!db) return { processed: false, reason: "database_unavailable" };
  try {
    return await db.transaction(async (tx) => {
      try {
        await tx.insert(billingWebhookEvents).values({ eventId: event.id, eventType: event.type, processedAt: now, status: "processed" });
      } catch (err) {
        if (isDuplicateKey(err)) throw new DuplicateEvent();
        throw err;
      }
      const obj = event.data?.object ?? {};
      const meta = metadataOf(obj);
      const customerId = stringValue(obj.customer);
      const isCheckout = event.type === "checkout.session.completed";
      const subscriptionId = isCheckout ? stringValue(obj.subscription) : event.type.startsWith("customer.subscription.") ? stringValue(obj.id) : stringValue(obj.subscription);
      const mappedUserId = positiveInt(meta.userId) ?? (isCheckout ? positiveInt(obj.client_reference_id) : null);

      let account = mappedUserId ? (await tx.select().from(billingAccounts).where(eq(billingAccounts.userId, mappedUserId)).for("update").limit(1))[0] : undefined;
      if (!account && mappedUserId) {
        // The checkout belongs to a real user who never opened Billing: create
        // their (Free) mirror row so the subscription is not lost.
        const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, mappedUserId)).limit(1);
        if (u) {
          await tx.insert(billingAccounts).values({ userId: u.id, plan: "free", entitlementTier: "free", status: "active" }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
          account = (await tx.select().from(billingAccounts).where(eq(billingAccounts.userId, u.id)).for("update").limit(1))[0];
        }
      }
      if (!account && customerId) account = (await tx.select().from(billingAccounts).where(eq(billingAccounts.stripeCustomerId, customerId)).for("update").limit(1))[0];
      if (!account) return { processed: true, reason: "no_account_mapping" };

      const userId = account.userId;
      const audit = (action: string, toPlan: string, details: Record<string, unknown> = {}) =>
        tx.insert(billingAudit).values({ userId, action, fromPlan: account!.plan, toPlan, source: "stripe", details: { eventId: event.id, eventCreated: event.created ?? null, ...details } });
      const founding = account.plan === "founding";
      const linkIds = {
        stripeCustomerId: customerId ?? account.stripeCustomerId,
        stripeSubscriptionId: subscriptionId ?? account.stripeSubscriptionId,
      };

      if (isCheckout) {
        const plan = planFromStripe(null, meta.plan);
        const paid = obj.payment_status === "paid" || obj.payment_status === "no_payment_required";
        if (founding || !plan) {
          await tx.update(billingAccounts).set(linkIds).where(eq(billingAccounts.userId, userId));
          await audit(event.type, account.plan, { reason: founding ? "founding_preserved" : "unknown_plan" });
          return { processed: true, reason: founding ? "founding_preserved" : "unknown_plan" };
        }
        await tx.update(billingAccounts).set({
          ...linkIds,
          plan,
          entitlementTier: planEntitlements(plan).tier,
          status: paid ? "active" : "incomplete",
          graceEndsAt: null,
        }).where(eq(billingAccounts.userId, userId));
        await audit(event.type, plan, { paymentStatus: obj.payment_status ?? null });
        return { processed: true };
      }

      if (event.type.startsWith("customer.subscription.")) {
        // Ignore events older than the newest subscription event already applied.
        if (typeof event.created === "number") {
          const [last] = await tx
            .select({ c: sql<number | null>`MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(${billingAudit.details}, '$.eventCreated')) AS SIGNED))` })
            .from(billingAudit)
            .where(and(eq(billingAudit.userId, userId), eq(billingAudit.source, "stripe"), sql`${billingAudit.action} LIKE 'customer.subscription.%'`));
          if (last?.c != null && Number(last.c) > event.created) {
            await audit("stale_event_ignored", account.plan, { type: event.type });
            return { processed: true, reason: "stale_event" };
          }
        }
        const deleted = event.type === "customer.subscription.deleted";
        if (deleted && account.stripeSubscriptionId && subscriptionId && subscriptionId !== account.stripeSubscriptionId) {
          await audit(event.type, account.plan, { reason: "not_current_subscription", subscriptionId });
          return { processed: true, reason: "not_current_subscription" };
        }
        if (founding) {
          await tx.update(billingAccounts).set(deleted ? { stripeSubscriptionId: null, stripePriceId: null } : linkIds).where(eq(billingAccounts.userId, userId));
          await audit(event.type, account.plan, { reason: "founding_preserved", status: obj.status ?? null });
          return { processed: true, reason: "founding_preserved" };
        }
        if (deleted) {
          await tx.update(billingAccounts).set({ plan: "free", entitlementTier: "free", status: "canceled", stripeSubscriptionId: null, stripePriceId: null, cancelAtPeriodEnd: false, graceEndsAt: null }).where(eq(billingAccounts.userId, userId));
          await audit(event.type, "free");
          return { processed: true };
        }
        const item = firstItem(obj);
        const priceId = stringValue((item?.price as Record<string, unknown> | undefined)?.id);
        const plan = planFromStripe(priceId, meta.plan) ?? (account.plan === "plus" || account.plan === "pro" ? account.plan : null);
        const status = stringValue(obj.status) ?? "active";
        const periodEnd = numberValue(obj.current_period_end) ?? numberValue(item?.current_period_end);
        const keepGrace = account.graceEndsAt != null && account.graceEndsAt > now ? account.graceEndsAt : null;
        await tx.update(billingAccounts).set({
          ...linkIds,
          plan: plan ?? "free",
          entitlementTier: planEntitlements(plan ?? "free").tier,
          status,
          stripePriceId: priceId ?? account.stripePriceId,
          currentPeriodEnd: periodEnd ? periodEnd * 1000 : account.currentPeriodEnd,
          cancelAtPeriodEnd: obj.cancel_at_period_end === true,
          graceEndsAt: status === "past_due" ? keepGrace ?? gracePeriodEndsAt(now) : null,
        }).where(eq(billingAccounts.userId, userId));
        await audit(event.type, plan ?? "free", { status, priceId, ...(plan ? {} : { reason: "unknown_price" }) });
        return { processed: true, ...(plan ? {} : { reason: "unknown_price" }) };
      }

      if (event.type === "invoice.payment_failed") {
        if (founding) {
          await audit("payment_failed_ignored", account.plan, { reason: "founding_preserved" });
          return { processed: true, reason: "founding_preserved" };
        }
        const graceEndsAt = account.graceEndsAt != null && account.graceEndsAt > now ? account.graceEndsAt : gracePeriodEndsAt(now);
        await tx.update(billingAccounts).set({ status: "past_due", graceEndsAt }).where(eq(billingAccounts.userId, userId));
        await audit("payment_failed_grace", account.plan, { graceEndsAt });
        return { processed: true };
      }

      if (event.type === "invoice.paid") {
        if (!founding && account.status === "past_due") {
          await tx.update(billingAccounts).set({ status: "active", graceEndsAt: null }).where(eq(billingAccounts.userId, userId));
          await audit("invoice_paid_restored", account.plan);
        }
        return { processed: true };
      }

      return { processed: true, reason: "ignored_event_type" };
    });
  } catch (err) {
    if (err instanceof DuplicateEvent) return { processed: false, reason: "duplicate" };
    throw err;
  }
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeConfigured() || !secret) {
    res.status(503).json({ error: "Stripe test billing is not configured" });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
  if (!verifyWebhookSignature(raw, req.header("stripe-signature"), secret)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  if (!event.id || !event.type) {
    res.status(400).json({ error: "Invalid event" });
    return;
  }
  try {
    const result = await processStripeEvent(event);
    res.status(result.reason === "database_unavailable" ? 503 : 200).json({ ok: true, ...result });
  } catch (err) {
    // Nothing was recorded (the transaction rolled back), so Stripe's retry
    // will be applied. No error detail is returned to the caller.
    console.error("[stripe] webhook processing failed", event.type, event.id, err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

export async function createHostedCheckoutSession(input: { userId: number; email?: string | null; plan: "plus" | "pro" }): Promise<{ url: string }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const priceId = input.plan === "plus" ? process.env.STRIPE_PRICE_PLUS : process.env.STRIPE_PRICE_PRO;
  if (!secret || !stripeConfigured() || !priceId) throw new Error("Stripe test billing is not configured with a price for this plan");
  const base = process.env.APP_URL ?? process.env.VITE_APP_URL ?? "http://localhost:3000";
  const body = new URLSearchParams({ mode: "subscription", "line_items[0][price]": priceId, "line_items[0][quantity]": "1", success_url: `${base}/app/account?billing=success`, cancel_url: `${base}/app/account?billing=cancelled`, "subscription_data[metadata][userId]": String(input.userId), "subscription_data[metadata][plan]": input.plan, client_reference_id: String(input.userId), "metadata[userId]": String(input.userId), "metadata[plan]": input.plan });
  if (input.email) body.set("customer_email", input.email);
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Stripe Checkout setup failed (${response.status})`);
  const data = (await response.json()) as { url?: string };
  if (!data.url) throw new Error("Stripe did not return a Checkout URL");
  return { url: data.url };
}

export async function createCustomerPortalSession(customerId: string): Promise<{ url: string }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !stripeConfigured()) throw new Error("Stripe test billing is not configured");
  const base = process.env.APP_URL ?? process.env.VITE_APP_URL ?? "http://localhost:3000";
  const body = new URLSearchParams({ customer: customerId, return_url: `${base}/app/account` });
  const response = await fetch("https://api.stripe.com/v1/billing_portal/sessions", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Stripe Customer Portal setup failed (${response.status})`);
  const data = (await response.json()) as { url?: string };
  if (!data.url) throw new Error("Stripe did not return a Portal URL");
  return { url: data.url };
}
