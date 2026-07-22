/**
 * TERR + TELX specs — service-territory resolution, tariff partitioning,
 * and the cron-facing telecom expiry sweep.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { partitionByTerritory, resolveTerritory } from "./serviceTerritory";
import { checkTelecomExpiries } from "./telecom";
import { getDb } from "./db";
import { sites, telecomServices, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const DAY_MS = 86_400_000;

describe("resolveTerritory", () => {
  it("explicit site utilityName wins with name_match confidence (Tucson TEP)", () => {
    const r = resolveTerritory({ state: "AZ", city: "Tucson", utilityName: "Tucson Electric Power" }, "electric");
    expect(r.confidence).toBe("name_match");
    expect(r.plausibleUtilities).toEqual(["Tucson Electric Power (TEP)"]);
    expect(r.overlap).toBe(false);
  });

  it("city match: Kingman resolves to UNS Electric (UES) only", () => {
    const r = resolveTerritory({ state: "AZ", city: "Kingman" }, "electric");
    expect(r.confidence).toBe("city_match");
    expect(r.plausibleUtilities).toEqual(["UniSource Energy Services (UNS Electric)"]);
    expect(r.overlap).toBe(false);
  });

  it("overlap: metro Phoenix city matches both APS and SRP and flags overlap", () => {
    const r = resolveTerritory({ state: "AZ", city: "Phoenix" }, "electric");
    expect(r.overlap).toBe(true);
    expect(r.plausibleUtilities).toContain("Arizona Public Service Co (APS)");
    expect(r.plausibleUtilities).toContain("Salt River Project (SRP)");
    expect(r.basis).toContain("confirm");
  });

  it("zip3 fallback when city is absent (857xx → TEP possibly + others sharing 857)", () => {
    const r = resolveTerritory({ state: "AZ", zip: "85719" }, "electric");
    expect(r.confidence).toBe("zip_match");
    expect(r.plausibleUtilities).toContain("Tucson Electric Power (TEP)");
  });

  it("fails open outside the catalog: unknown state yields no filtering", () => {
    const r = resolveTerritory({ state: "TN", city: "Nashville" }, "electric");
    expect(r.confidence).toBe("unknown");
    expect(r.matchPrefixes).toEqual([]);
    const rows = [{ utilityName: "Nashville Electric Service" }, { utilityName: "Middle Tennessee EMC" }];
    const p = partitionByTerritory(rows, r);
    expect(p.inTerritory).toHaveLength(2);
    expect(p.outOfTerritory).toHaveLength(0);
  });

  it("KY: Louisville resolves to LG&E for electric AND gas (RATE-LGE)", () => {
    const e = resolveTerritory({ state: "KY", city: "Louisville" }, "electric");
    expect(e.confidence).toBe("city_match");
    expect(e.plausibleUtilities).toEqual(["Louisville Gas and Electric (LG&E)"]);
    const g = resolveTerritory({ state: "KY", city: "Louisville" }, "gas");
    expect(g.confidence).toBe("city_match");
    expect(g.plausibleUtilities).toEqual(["Louisville Gas and Electric (LG&E)"]);
  });

  it("KY fails open outside the LG&E metro (Lexington = KU, not seeded)", () => {
    const r = resolveTerritory({ state: "KY", city: "Lexington" }, "electric");
    expect(r.confidence).toBe("unknown");
    expect(r.matchPrefixes).toEqual([]);
  });

  it("AZ gas: Kingman resolves to UNS Gas, not Southwest Gas (RATE-UES-GAS)", () => {
    const r = resolveTerritory({ state: "AZ", city: "Kingman" }, "gas");
    expect(r.confidence).toBe("city_match");
    expect(r.plausibleUtilities).toEqual(["UniSource Energy Services (UNS Gas)"]);
    const rows = [{ utilityName: "UniSource Energy Services (UNS Gas)" }, { utilityName: "Southwest Gas" }];
    const p = partitionByTerritory(rows, r);
    expect(p.inTerritory.map((x) => x.utilityName)).toEqual(["UniSource Energy Services (UNS Gas)"]);
    expect(p.outOfTerritory.map((x) => x.utilityName)).toEqual(["Southwest Gas"]);
  });

  it("AZ gas: Phoenix stays Southwest Gas (UNS Gas does not serve Maricopa)", () => {
    const r = resolveTerritory({ state: "AZ", city: "Phoenix" }, "gas");
    expect(r.plausibleUtilities).toEqual(["Southwest Gas"]);
    expect(r.overlap).toBe(false);
  });

  it("fails open when the AZ location matches nothing (unincorporated)", () => {
    const r = resolveTerritory({ state: "AZ", city: "Nowhereville", zip: "00000" }, "electric");
    expect(r.confidence).toBe("unknown");
    expect(r.matchPrefixes).toEqual([]);
  });
});

describe("partitionByTerritory", () => {
  it("splits tariff rows by utilityName prefix, case-insensitively", () => {
    const r = resolveTerritory({ state: "AZ", city: "Tucson" }, "electric");
    const rows = [
      { utilityName: "Tucson Electric Power (TEP)" },
      { utilityName: "Arizona Public Service Co (APS)" },
      { utilityName: "UniSource Energy Services (UNS Electric)" },
    ];
    const p = partitionByTerritory(rows, r);
    expect(p.inTerritory.map((x) => x.utilityName)).toEqual(["Tucson Electric Power (TEP)"]);
    expect(p.outOfTerritory).toHaveLength(2);
  });
});

describe("checkTelecomExpiries (TELX-2)", () => {
  let userId: number;
  let siteId: number;
  const NOW = Date.now();

  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    const openId = `terr-telx-${Date.now()}`;
    await db.insert(users).values({ openId, name: "Terr TELX Fixture" });
    const u = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    userId = u[0]!.id;
    const res = await db.insert(sites).values({
      userId,
      name: "TELX expiry fixture site",
      siteType: "single_family",
      state: "AZ",
      city: "Tucson",
    });
    siteId = Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0);

    // promo ending inside the 30d window, with a price jump
    await db.insert(telecomServices).values({
      siteId,
      userId,
      serviceType: "internet",
      provider: "TestISP",
      planName: "Fiber 500",
      monthlyCostUsd: 50,
      postPromoCostUsd: 80,
      promoEndsAt: NOW + 10 * DAY_MS,
      source: "manual",
    });
    // contract window ending inside 30d
    await db.insert(telecomServices).values({
      siteId,
      userId,
      serviceType: "mobile",
      provider: "TestCarrier",
      monthlyCostUsd: 120,
      lines: 2,
      unlimitedData: true,
      contractEndsAt: NOW + 25 * DAY_MS,
      source: "manual",
    });
    // promo far in the future — must NOT be reported
    await db.insert(telecomServices).values({
      siteId,
      userId,
      serviceType: "tv_bundle",
      provider: "TestTV",
      monthlyCostUsd: 90,
      postPromoCostUsd: 120,
      promoEndsAt: NOW + 200 * DAY_MS,
      source: "manual",
    });
    // already-lapsed promo — must NOT be reported (not an upcoming window)
    await db.insert(telecomServices).values({
      siteId,
      userId,
      serviceType: "phone_landline",
      provider: "TestLandline",
      monthlyCostUsd: 30,
      postPromoCostUsd: 45,
      promoEndsAt: NOW - 5 * DAY_MS,
      source: "manual",
    });
  });

  it("reports only windows opening within the horizon, with jump amounts", async () => {
    const out = await checkTelecomExpiries(NOW, 30);
    const mine = out.filter((e) => e.userId === userId);
    expect(mine).toHaveLength(2);
    const promo = mine.find((e) => e.kind === "promo_expiry");
    expect(promo).toBeDefined();
    expect(promo!.summary).toContain("TestISP");
    expect(promo!.summary).toContain("$50→$80");
    const contract = mine.find((e) => e.kind === "contract_window");
    expect(contract).toBeDefined();
    expect(contract!.summary).toContain("TestCarrier");
    expect(contract!.summary).toContain("early-termination");
  });

  it("horizon is respected: a 5-day window excludes the 10-day promo", async () => {
    const out = await checkTelecomExpiries(NOW, 5);
    expect(out.filter((e) => e.userId === userId)).toHaveLength(0);
  });
});
