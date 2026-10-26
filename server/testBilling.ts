/**
 * Test-only helper (BILL-1, Oct 26): feature access now follows the billing
 * account, so a fixture user that needs Plus/Pro features must have a real
 * billing row — setting users.tier no longer grants anything. Callers remove
 * the row in their cleanup with clearTestPlan (or by deleting the user's
 * billing_accounts rows).
 */
import { eq, inArray } from "drizzle-orm";
import { billingAccounts } from "../drizzle/schema";
import { getDb } from "./db";

export type TestPlan = "free" | "founding" | "plus" | "pro";

export async function grantTestPlan(userId: number, plan: TestPlan = "pro"): Promise<void> {
  const db = (await getDb())!;
  const entitlementTier = plan === "plus" ? "plus" : plan === "free" ? "free" : "pro";
  await db
    .insert(billingAccounts)
    .values({ userId, plan, entitlementTier, status: "active" })
    .onDuplicateKeyUpdate({ set: { plan, entitlementTier, status: "active", graceEndsAt: null } });
}

export async function clearTestPlan(userIds: number | number[]): Promise<void> {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter((id) => id > 0);
  if (ids.length === 0) return;
  const db = await getDb();
  if (!db) return;
  await db.delete(billingAccounts).where(ids.length === 1 ? eq(billingAccounts.userId, ids[0]) : inArray(billingAccounts.userId, ids));
}
