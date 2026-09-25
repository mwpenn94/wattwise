import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { billingAccounts, billingAudit, billingWebhookEvents } from "../drizzle/schema";
import { getDb } from "./db";
import { gracePeriodEndsAt, stripeConfigured, verifyWebhookSignature } from "./billing";

type StripeEvent = { id: string; type: string; data?: { object?: Record<string, unknown> } };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function metadataUserId(obj: Record<string, unknown>): number | null {
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const value = metadata?.userId;
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

export async function processStripeEvent(event: StripeEvent, now = Date.now()): Promise<{ processed: boolean; reason?: string }> {
  const db = await getDb();
  if (!db) return { processed: false, reason: "database_unavailable" };
  const already = await db.select({ id: billingWebhookEvents.id }).from(billingWebhookEvents).where(eq(billingWebhookEvents.eventId, event.id)).limit(1);
  if (already.length > 0) return { processed: false, reason: "duplicate" };
  await db.insert(billingWebhookEvents).values({ eventId: event.id, eventType: event.type, processedAt: now, status: "processed" });

  const obj = event.data?.object ?? {};
  const customerId = stringValue(obj.customer);
  const subscriptionId = stringValue(obj.id);
  const metadataId = metadataUserId(obj);
  let account = metadataId ? (await db.select().from(billingAccounts).where(eq(billingAccounts.userId, metadataId)).limit(1))[0] : null;
  if (!account && customerId) account = (await db.select().from(billingAccounts).where(eq(billingAccounts.stripeCustomerId, customerId)).limit(1))[0];
  if (!account) return { processed: true, reason: "no_account_mapping" };

  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const plan = stringValue(metadata?.plan);
  const items = obj.items as Record<string, unknown> | undefined;
  const itemData = Array.isArray(items?.data) ? (items?.data as Array<Record<string, unknown>>)[0] : undefined;
  const price = itemData?.price as Record<string, unknown> | undefined;
  const priceId = stringValue(price?.id);
  const periodEnd = numberValue(obj.current_period_end);
  const cancelAtPeriodEnd = obj.cancel_at_period_end === true;
  const status = stringValue(obj.status);

  if (event.type === "checkout.session.completed" || event.type.startsWith("customer.subscription.")) {
    await db.update(billingAccounts).set({
      plan: plan ?? account.plan,
      entitlementTier: plan === "pro" ? "pro" : plan === "plus" ? "plus" : account.entitlementTier,
      status: status ?? "active",
      stripeCustomerId: customerId ?? account.stripeCustomerId,
      stripeSubscriptionId: subscriptionId ?? account.stripeSubscriptionId,
      stripePriceId: priceId ?? account.stripePriceId,
      currentPeriodEnd: periodEnd ? periodEnd * 1000 : account.currentPeriodEnd,
      cancelAtPeriodEnd,
      graceEndsAt: null,
    }).where(eq(billingAccounts.userId, account.userId));
    await db.insert(billingAudit).values({ userId: account.userId, action: event.type, fromPlan: account.plan, toPlan: plan ?? account.plan, source: "stripe", details: { eventId: event.id } });
  } else if (event.type === "invoice.payment_failed") {
    const graceEndsAt = gracePeriodEndsAt(now);
    await db.update(billingAccounts).set({ status: "past_due", graceEndsAt }).where(eq(billingAccounts.userId, account.userId));
    await db.insert(billingAudit).values({ userId: account.userId, action: "payment_failed_grace", fromPlan: account.plan, toPlan: account.plan, source: "stripe", details: { eventId: event.id, graceEndsAt } });
  } else if (event.type === "invoice.paid") {
    await db.update(billingAccounts).set({ status: "active", graceEndsAt: null }).where(eq(billingAccounts.userId, account.userId));
  } else if (event.type === "customer.subscription.deleted") {
    await db.update(billingAccounts).set({ plan: "free", entitlementTier: "free", status: "canceled", stripeSubscriptionId: null, stripePriceId: null, cancelAtPeriodEnd: false }).where(eq(billingAccounts.userId, account.userId));
  }
  return { processed: true };
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
  const result = await processStripeEvent(event);
  res.status(result.reason === "database_unavailable" ? 503 : 200).json({ ok: true, ...result });
}

export async function createHostedCheckoutSession(input: { userId: number; email?: string | null; plan: "plus" | "pro" }): Promise<{ url: string }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const priceId = input.plan === "plus" ? process.env.STRIPE_PRICE_PLUS : process.env.STRIPE_PRICE_PRO;
  if (!secret || !stripeConfigured() || !priceId) throw new Error("Stripe test billing is not configured with a price for this plan");
  const base = process.env.APP_URL ?? process.env.VITE_APP_URL ?? "http://localhost:3000";
  const body = new URLSearchParams({ mode: "subscription", "line_items[0][price]": priceId, "line_items[0][quantity]": "1", success_url: `${base}/app/account?billing=success`, cancel_url: `${base}/app/account?billing=cancelled`, "subscription_data[metadata][userId]": String(input.userId), "subscription_data[metadata][plan]": input.plan });
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
