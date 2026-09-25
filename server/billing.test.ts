import { describe, expect, it } from "vitest";
import {
  PLAN_ENTITLEMENTS,
  checkoutSetupMessage,
  effectiveEntitlement,
  gracePeriodEndsAt,
  stripeConfigured,
  verifyWebhookSignature,
  webhookSignature,
} from "./billing";

describe("billing entitlement map", () => {
  it("keeps Founding full access without a payment method", () => {
    expect(PLAN_ENTITLEMENTS.founding.tier).toBe("pro");
    expect(PLAN_ENTITLEMENTS.founding.maxSites).toBeNull();
    expect(PLAN_ENTITLEMENTS.founding.reports).toBe("all");
  });

  it("returns Free for an account after the seven-day grace window", () => {
    const now = 1_700_000_000_000;
    expect(effectiveEntitlement({ plan: "pro", status: "past_due", graceEndsAt: now + 1000 }, now).plan).toBe("pro");
    expect(effectiveEntitlement({ plan: "pro", status: "past_due", graceEndsAt: now - 1 }, now).plan).toBe("free");
    expect(gracePeriodEndsAt(now)).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });

  it("rejects live keys and explains why checkout is unavailable", () => {
    expect(stripeConfigured({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toBe(false);
    expect(checkoutSetupMessage()).toContain("test billing");
  });
});

describe("Stripe webhook signatures", () => {
  it("accepts a fresh signed payload and rejects tampering/replay", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const timestamp = 1_700_000_000;
    const signature = webhookSignature(payload, "whsec_test", timestamp);
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifyWebhookSignature(payload, header, "whsec_test", 300, timestamp)).toBe(true);
    expect(verifyWebhookSignature(payload + "x", header, "whsec_test", 300, timestamp)).toBe(false);
    expect(verifyWebhookSignature(payload, header, "whsec_test", 300, timestamp + 301)).toBe(false);
  });
});
