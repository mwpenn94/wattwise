/**
 * §3l reports — honesty rules under test:
 *  - chips map confidence → Est./Good/Measured (never fabricated "Measured")
 *  - practitioner CSV carries chips + disclaimer, escapes correctly
 *  - tier gates: energy_plan is Plus+, verified_savings/practitioner are Pro
 *  - verify endpoint: unknown token → found:false (no data leak)
 *  - digest prefs: quiet by default, anchor day clamped to 1–28
 */
import { describe, expect, it } from "vitest";
import { chipForConfidence, practitionerCsv, newReportToken, type ReportData } from "./reports";
import { appRouter } from "./routers";

function caller(tier: "free" | "plus" | "pro", id = 999902) {
  return appRouter.createCaller({
    user: { id, openId: `test-reports-${tier}`, name: "T", role: "user", tier },
  } as never);
}

const baseData: ReportData = {
  site: { id: 1, name: "Test Site", state: "AZ", buildingType: "office", sqft: 10000 },
  generatedAt: Date.now(),
  annualCostUsd: 12000,
  annualCostChip: "Est.",
  measures: [
    {
      title: "Rate switch, with \"quotes\" and, commas",
      measure: "rate_switch",
      what: "Switch plans",
      annualSavingsUsd: 900,
      paybackLabel: "immediate",
      costClass: null,
      confidence: "high",
      chip: "Good",
    },
  ],
  plannedTotalUsd: 900,
  verdicts: [
    { measure: "led_equipment", implementedAt: Date.now(), status: "verified", verifiedSavingsUsd: 300, months: 4, chip: "Measured" },
  ],
  verifiedTotalUsd: 300,
  baseline: { method: "caltrack_monthly", cvrmse: 0.12, r2: 0.91, confidence: "high", monthsUsed: 12 },
  disclaimer: "All outputs are modeled estimates.",
};

describe("§3l chips", () => {
  it("maps confidence to chips without fabricating Measured", () => {
    expect(chipForConfidence("high")).toBe("Good");
    expect(chipForConfidence("medium")).toBe("Est.");
    expect(chipForConfidence("low")).toBe("Est.");
    expect(chipForConfidence(null)).toBe("Est.");
    expect(chipForConfidence("high", true)).toBe("Measured");
  });
});

describe("§3l practitioner CSV", () => {
  it("carries chips, baseline stats, and the disclaimer; escapes quoted/comma fields", () => {
    const csv = practitionerCsv(baseData);
    expect(csv).toContain("confidence_chip");
    expect(csv).toContain("Good");
    expect(csv).toContain("Measured");
    expect(csv).toContain("CVRMSE 12.0%");
    expect(csv).toContain("modeled estimates");
    // RFC4180 escaping: embedded quotes doubled, field wrapped
    expect(csv).toContain('"Rate switch, with ""quotes"" and, commas"');
  });

  it("names missing baseline as an explicit gap rather than inventing stats", () => {
    const csv = practitionerCsv({ ...baseData, baseline: null });
    expect(csv).not.toContain("CVRMSE");
  });
});

describe("§3l tier gates", () => {
  it("free tier cannot generate any report", async () => {
    await expect(caller("free").reports.generate({ siteId: 1, kind: "energy_plan" })).rejects.toThrow(/Plus/i);
    await expect(caller("free").reports.generate({ siteId: 1, kind: "verified_savings" })).rejects.toThrow(/Pro/i);
  });

  it("plus tier gets energy_plan but not the Pro artifacts", async () => {
    // energy_plan passes the tier gate and then fails on tenancy (site 1 not owned) — proving the gate itself passed
    await expect(caller("plus").reports.generate({ siteId: 1, kind: "energy_plan" })).rejects.toThrow(/Access denied|does not belong/i);
    await expect(caller("plus").reports.generate({ siteId: 1, kind: "practitioner" })).rejects.toThrow(/Pro/i);
  });
});

describe("§3l verify endpoint", () => {
  it("unknown token returns found:false with no other fields", async () => {
    const res = await caller("free").reports.verify({ token: "definitely-not-a-real-token-123" });
    expect(res.found).toBe(false);
    expect(Object.keys(res)).toEqual(["found"]);
  });

  it("tokens are unguessable-length and URL-safe", () => {
    const t = newReportToken();
    expect(t).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(newReportToken()).not.toBe(t);
  });
});

describe("§3f digest prefs", () => {
  it("defaults to quiet (opt-out) for a user with no saved prefs", async () => {
    const prefs = await caller("free", 999903).account.digestPrefs();
    expect(prefs.digestOptIn).toBe(false);
  });

  it("rejects anchor days outside 1–28 at the schema boundary", async () => {
    await expect(caller("free").account.setDigestPrefs({ optIn: true, anchorDay: 31 })).rejects.toThrow();
    await expect(caller("free").account.setDigestPrefs({ optIn: true, anchorDay: 0 })).rejects.toThrow();
  });
});
