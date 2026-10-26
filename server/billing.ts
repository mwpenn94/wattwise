import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { billingAccounts, type BillingAccount } from "../drizzle/schema";
import { getDb } from "./db";

export type BillingPlan = "free" | "founding" | "plus" | "pro";
export type EntitlementTier = "free" | "plus" | "pro";

export interface PlanEntitlements {
  plan: BillingPlan;
  tier: EntitlementTier;
  maxSites: number | null;
  maxScenariosPerMonth: number | null;
  reports: "site_insights" | "energy_plan" | "all";
  portfolio: boolean;
  continuousMonitoring: boolean;
  conciergeOnboarding: boolean;
}

/** One server-side map. The client may display these values, but must never
 * decide access from them. Founding preserves the current full-access beta
 * behavior without requiring a payment method. */
export const PLAN_ENTITLEMENTS: Record<BillingPlan, PlanEntitlements> = {
  free: { plan: "free", tier: "free", maxSites: 2, maxScenariosPerMonth: 3, reports: "site_insights", portfolio: false, continuousMonitoring: false, conciergeOnboarding: false },
  founding: { plan: "founding", tier: "pro", maxSites: null, maxScenariosPerMonth: null, reports: "all", portfolio: true, continuousMonitoring: true, conciergeOnboarding: true },
  plus: { plan: "plus", tier: "plus", maxSites: 10, maxScenariosPerMonth: 20, reports: "energy_plan", portfolio: true, continuousMonitoring: true, conciergeOnboarding: false },
  pro: { plan: "pro", tier: "pro", maxSites: null, maxScenariosPerMonth: null, reports: "all", portfolio: true, continuousMonitoring: true, conciergeOnboarding: true },
};

export function planEntitlements(plan: string | null | undefined): PlanEntitlements {
  return PLAN_ENTITLEMENTS[(plan as BillingPlan) in PLAN_ENTITLEMENTS ? (plan as BillingPlan) : "free"];
}

export function effectiveEntitlement(account: Pick<BillingAccount, "plan" | "status" | "graceEndsAt"> | null, now = Date.now()): PlanEntitlements {
  if (!account) return PLAN_ENTITLEMENTS.free;
  // BILL-1: an allowlist, so an unknown or non-paying subscription state
  // (canceled, unpaid, incomplete, paused, …) fails closed to Free. Founding
  // and Free accounts are always "active".
  if (account.status === "active" || account.status === "trialing") return planEntitlements(account.plan);
  if (account.status === "past_due" && account.graceEndsAt != null && account.graceEndsAt > now) return planEntitlements(account.plan);
  return PLAN_ENTITLEMENTS.free;
}

/** BILL-1 (Oct 26): the ONE access rule for every protected procedure. The
 * owner/admin role keeps full access (as before); everyone else gets the plan
 * of their billing account (no account → Free). The legacy users.tier column
 * is never read for access, so it cannot be used to self-upgrade. */
export function entitlementFor(role: string | null | undefined, account: Pick<BillingAccount, "plan" | "status" | "graceEndsAt"> | null, now = Date.now()): PlanEntitlements {
  if (role === "admin") return PLAN_ENTITLEMENTS.pro;
  return effectiveEntitlement(account, now);
}

type BillingReader = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

/** Loads the caller's billing account (through `exec` when given, e.g. the
 * capacity-lock transaction) and applies {@link entitlementFor}. Fails closed
 * to Free when there is no database or no real user id (e.g. cron). */
export async function entitlementForUser(user: { id: number; role?: string | null }, exec?: BillingReader): Promise<PlanEntitlements> {
  if (user.role === "admin") return PLAN_ENTITLEMENTS.pro;
  if (!(user.id > 0)) return PLAN_ENTITLEMENTS.free;
  const db = exec ?? (await getDb());
  if (!db) return PLAN_ENTITLEMENTS.free;
  const rows = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, user.id)).limit(1);
  return entitlementFor(user.role, rows[0] ?? null);
}

const PLAN_LABEL: Record<BillingPlan, string> = { free: "Free", founding: "Founding", plus: "Plus", pro: "Pro" };
export function planLabel(plan: BillingPlan): string {
  return PLAN_LABEL[plan] ?? "Free";
}

export function webhookSignature(payload: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

export function verifyWebhookSignature(payload: string, header: string | null | undefined, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = webhookSignature(payload, secret, timestamp);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function loadBillingAccount(userId: number): Promise<BillingAccount | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function ensureBillingAccount(userId: number): Promise<BillingAccount | null> {
  const existing = await loadBillingAccount(userId);
  if (existing) return existing;
  const db = await getDb();
  if (!db) return null;
  await db.insert(billingAccounts).values({ userId, plan: "free", entitlementTier: "free", status: "active" }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  return loadBillingAccount(userId);
}

export function stripeConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return env.STRIPE_SECRET_KEY?.startsWith("sk_test_") === true && Boolean(env.STRIPE_WEBHOOK_SECRET);
}

export function checkoutSetupMessage(): string {
  return "Stripe test billing is not connected yet. Add a test-mode secret and price IDs before enabling checkout; no live account will be used.";
}

export function gracePeriodEndsAt(now = Date.now()): number {
  return now + 7 * 24 * 60 * 60 * 1000;
}
