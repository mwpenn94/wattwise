/**
 * TELECOM extension — service CRUD, benchmark matching, and the analyzer's
 * finding kinds + savings-capping honesty rules.
 *
 * Key honesty invariants covered:
 *  - unlimited mobile compares against POSTPAID tier (never MVNO as if
 *    like-for-like), MVNO shows only as a disclosed switch option
 *  - per-service savings are the MAX finding, never additive across
 *    overlapping findings on the same service
 *  - ownership enforced on upsert/remove/list
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  analyzeTelecomServices,
  listTelecomServices,
  matchBenchmark,
  removeTelecomService,
  upsertTelecomService,
} from "./telecom";
import { ensureSeeded } from "./seed/runSeeders";
import * as h from "./dbHelpers";
import { getDb } from "./db";
import { users, sites, telecomServices, telecomBenchmarks } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";
import type { TelecomBenchmark, TelecomService } from "../drizzle/schema";

let userId: number;
let otherUserId: number;
let siteId: number;
let catalog: TelecomBenchmark[];
const OPEN_ID = "test-telecom-user";
const OPEN_ID_2 = "test-telecom-other";
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 22); // fixed "now" for deterministic windows

beforeAll(async () => {
  await ensureSeeded();
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  await db.insert(users).values({ openId: OPEN_ID, name: "Telecom Tester" });
  await db.insert(users).values({ openId: OPEN_ID_2, name: "Telecom Other" });
  const u = await db.select().from(users).where(inArray(users.openId, [OPEN_ID, OPEN_ID_2]));
  userId = u.find((x) => x.openId === OPEN_ID)!.id;
  otherUserId = u.find((x) => x.openId === OPEN_ID_2)!.id;
  siteId = await h.createSite({ userId, name: "Telecom Site", state: "AZ", buildingType: "office" });
  catalog = await db.select().from(telecomBenchmarks);
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(telecomServices).where(inArray(telecomServices.userId, [userId, otherUserId]));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
});

const svc = (over: Partial<TelecomService>): TelecomService =>
  ({
    id: 1,
    siteId,
    userId,
    serviceType: "internet",
    provider: "TestCo",
    planName: null,
    monthlyCostUsd: 80,
    promoEndsAt: null,
    postPromoCostUsd: null,
    contractEndsAt: null,
    downloadMbps: null,
    isBusiness: false,
    lines: null,
    dataAllowanceGb: null,
    unlimitedData: false,
    actualDataUsedGb: null,
    actualDownloadNeedMbps: null,
    notes: null,
    source: "manual",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as TelecomService;

describe("benchmark seeding + matching", () => {
  it("seeds the published benchmark catalog", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(10);
    const keys = catalog.map((b) => b.tierKey);
    for (const k of [
      "internet_res_300_600",
      "internet_biz_under_500",
      "mobile_unlimited_postpaid",
      "mobile_unlimited_prepaid_mvno",
      "mobile_limited_data",
      "tv_bundle_standard",
      "phone_landline_standard",
    ]) {
      expect(keys).toContain(k);
    }
    // every tier carries a basis (source disclosure) string
    for (const b of catalog) expect((b.basis ?? "").length).toBeGreaterThan(10);
  });

  it("matches residential internet by speed window and business flag", () => {
    expect(matchBenchmark(svc({ downloadMbps: 500 }), catalog)?.tierKey).toBe("internet_res_300_600");
    expect(matchBenchmark(svc({ downloadMbps: 1200 }), catalog)?.tierKey).toBe("internet_res_gigabit_plus");
    expect(matchBenchmark(svc({ downloadMbps: 500, isBusiness: true }), catalog)?.tierKey).toBe("internet_biz_500_plus");
    // no speed → cannot tier
    expect(matchBenchmark(svc({ downloadMbps: null }), catalog)).toBeNull();
  });

  it("matches unlimited mobile to the POSTPAID tier (conservative, never MVNO)", () => {
    const m = matchBenchmark(svc({ serviceType: "mobile", unlimitedData: true, lines: 2 }), catalog);
    expect(m?.tierKey).toBe("mobile_unlimited_postpaid");
    const capped = matchBenchmark(svc({ serviceType: "mobile", unlimitedData: false, dataAllowanceGb: 10 }), catalog);
    expect(capped?.tierKey).toBe("mobile_limited_data");
  });
});

describe("analyzer findings", () => {
  it("flags promo expiry within 60 days at high confidence with 50-100% jump range", async () => {
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "PromoCo",
      monthlyCostUsd: 50,
      downloadMbps: 400,
      promoEndsAt: NOW + 30 * DAY_MS,
      postPromoCostUsd: 90, // $40/mo jump
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const f = a.findings.find((x) => x.serviceId === id && x.kind === "promo_expiry");
    expect(f).toBeDefined();
    expect(f!.confidence).toBe("high");
    expect(f!.estAnnualSavingsHi).toBe(480); // 40*12
    expect(f!.estAnnualSavingsLo).toBe(240); // 50%
    await removeTelecomService(id, userId);
  });

  it("flags market delta only when above typicalHigh, at low confidence", async () => {
    // 500 Mbps res tier: typicalHigh=85, median=65
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "PriceyCo",
      monthlyCostUsd: 120,
      downloadMbps: 500,
    });
    const inRangeId = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "FairCo",
      monthlyCostUsd: 70,
      downloadMbps: 500,
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const flagged = a.findings.find((x) => x.serviceId === id && x.kind === "market_delta");
    expect(flagged).toBeDefined();
    expect(flagged!.confidence).toBe("low");
    expect(flagged!.estAnnualSavingsHi).toBe(Math.round((120 - 65) * 12));
    expect(flagged!.estAnnualSavingsLo).toBe(Math.round((120 - 85) * 12));
    // address-availability disclosure always present on market comparisons
    expect(flagged!.disclosures.join(" ")).toMatch(/address/i);
    expect(a.findings.find((x) => x.serviceId === inRangeId && x.kind === "market_delta")).toBeUndefined();
    await removeTelecomService(id, userId);
    await removeTelecomService(inRangeId, userId);
  });

  it("offers the MVNO switch option for pricey unlimited postpaid, with tradeoff disclosure", async () => {
    // $70/line unlimited > mvno typicalHigh ($40)
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "mobile",
      provider: "BigCarrier",
      monthlyCostUsd: 280,
      lines: 4,
      unlimitedData: true,
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const mvno = a.findings.filter((x) => x.serviceId === id && x.kind === "market_delta");
    const withTradeoffs = mvno.find((x) => x.disclosures.join(" ").match(/deprioritization/i));
    expect(withTradeoffs).toBeDefined();
    expect(withTradeoffs!.body).toMatch(/tradeoffs/i);
    await removeTelecomService(id, userId);
  });

  it("right-sizes internet speed only when plan is >=2x the entered need", async () => {
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "OverProvisionedCo",
      monthlyCostUsd: 80,
      downloadMbps: 1200, // gigabit-plus tier (median 90)
      actualDownloadNeedMbps: 200, // needs 100-300 tier (median 55)
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const f = a.findings.find((x) => x.serviceId === id && x.kind === "right_size_speed");
    expect(f).toBeDefined();
    expect(f!.confidence).toBe("medium");
    expect(f!.estAnnualSavingsHi).toBe(Math.round((90 - 55) * 12));
    await removeTelecomService(id, userId);
  });

  it("right-sizes unlimited mobile data on light entered usage", async () => {
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "mobile",
      provider: "LightUseCo",
      monthlyCostUsd: 140,
      lines: 2, // $70/line
      unlimitedData: true,
      actualDataUsedGb: 8, // 4 GB/line < 10
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const f = a.findings.find((x) => x.serviceId === id && x.kind === "right_size_data");
    expect(f).toBeDefined();
    expect(f!.disclosures.join(" ")).toMatch(/usage you entered/i);
    await removeTelecomService(id, userId);
  });

  it("raises a contract-window alert with no dollar claim", async () => {
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "tv_bundle",
      provider: "CableCo",
      monthlyCostUsd: 95,
      contractEndsAt: NOW + 20 * DAY_MS,
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const f = a.findings.find((x) => x.serviceId === id && x.kind === "contract_window");
    expect(f).toBeDefined();
    expect(f!.estAnnualSavingsLo).toBeNull();
    expect(f!.estAnnualSavingsHi).toBeNull();
    await removeTelecomService(id, userId);
  });

  it("caps total savings at the single largest finding per service (never additive)", async () => {
    // One service that triggers BOTH promo expiry ($480/yr hi) and market
    // delta: $120 vs 500Mbps tier median 65 → $660/yr hi. Total must be the
    // max (660), not the sum (1140).
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "DoubleTroubleCo",
      monthlyCostUsd: 120,
      downloadMbps: 500,
      promoEndsAt: NOW + 10 * DAY_MS,
      postPromoCostUsd: 160,
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    const mine = a.findings.filter((x) => x.serviceId === id && x.estAnnualSavingsHi != null);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const maxHi = Math.max(...mine.map((x) => x.estAnnualSavingsHi!));
    const sumHi = mine.reduce((s, x) => s + x.estAnnualSavingsHi!, 0);
    expect(a.totalAnnualSavingsHi).toBe(maxHi);
    expect(a.totalAnnualSavingsHi).toBeLessThan(sumHi);
    await removeTelecomService(id, userId);
  });

  it("totals monthly/annual spend across services", async () => {
    const a1 = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "A",
      monthlyCostUsd: 60,
      downloadMbps: 300,
    });
    const a2 = await upsertTelecomService(userId, {
      siteId,
      serviceType: "phone_landline",
      provider: "B",
      monthlyCostUsd: 25,
    });
    const a = await analyzeTelecomServices(userId, siteId, NOW);
    expect(a.monthlyTotalUsd).toBe(85);
    expect(a.annualTotalUsd).toBe(1020);
    await removeTelecomService(a1, userId);
    await removeTelecomService(a2, userId);
  });
});

describe("ownership enforcement", () => {
  it("rejects upsert to a site the user does not own", async () => {
    await expect(
      upsertTelecomService(otherUserId, {
        siteId, // owned by userId
        serviceType: "internet",
        provider: "IntruderCo",
        monthlyCostUsd: 50,
      }),
    ).rejects.toThrow();
  });

  it("scopes list and blocks cross-user update/remove", async () => {
    const id = await upsertTelecomService(userId, {
      siteId,
      serviceType: "internet",
      provider: "MineCo",
      monthlyCostUsd: 55,
      downloadMbps: 200,
    });
    // other user sees nothing on this site (ownership assert throws)
    await expect(listTelecomServices(siteId, otherUserId)).rejects.toThrow();
    // other user cannot update the row
    await expect(
      upsertTelecomService(otherUserId, {
        id,
        siteId,
        serviceType: "internet",
        provider: "HijackCo",
        monthlyCostUsd: 1,
      }),
    ).rejects.toThrow();
    // other user's remove is a silent no-op scoped by userId
    await removeTelecomService(id, otherUserId);
    const still = await listTelecomServices(siteId, userId);
    expect(still.find((s) => s.id === id)).toBeDefined();
    await removeTelecomService(id, userId);
  });
});
