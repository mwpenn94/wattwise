/**
 * UCONV-1 (Oct 26): source-file units are kept as recorded, and gas/water
 * readings are converted to the commodity's model unit (therms / gallons) only
 * where they are modeled or priced.
 *
 * Covers the pure conversion table, the modeling read (getIntervalPoints) vs
 * the raw chart read (intervalsApi.window) and stored rows, the gas/water
 * scenario baseline, bill entry in CCF / kgal, and the parser / commodity-hint
 * rules for volume units that gas and water utilities both use.
 *
 * Fixture: one isolated `@test.local` user; every row is removed afterwards
 * through the account-deletion cascade.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { auditLog, billingAccounts, bills, intervals, meters, sites, uploads, users } from "../drizzle/schema";
import { GAS_THERMS_PER_CCF, toModelUsage, usageConversion } from "../shared/commodity";
import { applyCommodityHint, parseCsvIntervals } from "./ingest/parsers";
import { runCommodityEfficiency } from "./commodityScenario";
import { assessMv } from "./mv";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1, 7);
let userId = 0;
let openId = "";

function caller() {
  const ctx = {
    user: { id: userId, openId, email: `${openId}@test.local`, name: openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

/** A site with one meter of the given commodity/unit and `days` daily readings of `perDay`. */
async function siteWithMeter(label: string, commodity: "electric" | "gas" | "water", usageUnit: string, days: number, perDay: number) {
  const db = (await getDb())!;
  const [s] = await db.insert(sites).values({ userId, name: `UCONV ${label}`, city: "Louisville", state: "KY", zip: "40202", buildingType: "office", sqft: 10_000 } as never);
  const siteId = Number(s.insertId);
  const [m] = await db
    .insert(meters)
    .values({ siteId, userId, label, commodity: commodity as never, meterRole: "main" as never, usageUnit, timezone: "America/New_York" } as never);
  const meterId = Number(m.insertId);
  if (days > 0) {
    const [u] = await db
      .insert(uploads)
      .values({ userId, siteId, filename: `${label}.csv`, sha256: `uconv-${label}-${stamp}`, format: "csv" as never, status: "parsed" as never } as never);
    await db.insert(intervals).values(
      Array.from({ length: days }, (_, i) => ({ meterId, uploadId: Number(u.insertId), ts: T0 + i * DAY, durationMin: 1440, usage: perDay, demand: null })) as never,
    );
  }
  return { siteId, meterId };
}

beforeAll(async () => {
  const db = (await getDb())!;
  openId = `uconv1-${stamp}`;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u!.id;
  await db.insert(billingAccounts).values({ userId, plan: "pro", entitlementTier: "pro", status: "active" });
});

afterAll(async () => {
  const db = await getDb();
  if (!db || !userId) return;
  await h.deleteAllUserData(userId);
  await db.delete(auditLog).where(eq(auditLog.userId, userId));
  await db.delete(billingAccounts).where(eq(billingAccounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("usageConversion — stated unit → model unit", () => {
  it("is the identity for electric and for the model units", () => {
    expect(usageConversion("electric", "kWh")).toMatchObject({ factor: 1, note: null, shortNote: null });
    expect(usageConversion("electric", "CCF").factor).toBe(1); // electric is never converted
    expect(usageConversion("gas", "therms")).toMatchObject({ factor: 1, toUnit: "therms", note: null });
    expect(usageConversion("gas", "Therm").factor).toBe(1);
    expect(usageConversion("water", "gallons")).toMatchObject({ factor: 1, toUnit: "gallons", note: null });
    expect(usageConversion("water", "gal").factor).toBe(1);
    expect(usageConversion("gas", "").factor).toBe(1);
    expect(usageConversion("water", null).factor).toBe(1);
  });
  it("converts gas volumes with the disclosed 1.037 therms per CCF", () => {
    expect(GAS_THERMS_PER_CCF).toBe(1.037);
    const ccf = usageConversion("gas", "CCF");
    expect(ccf.factor).toBeCloseTo(1.037, 10);
    expect(ccf.note).toMatch(/U\.S\. average of 1\.037 therms per CCF/);
    expect(ccf.note).toMatch(/kept as recorded/);
    expect(ccf.shortNote).toBe("converted from CCF to therms at 1.037 therms per CCF (U.S. average)");
    expect(usageConversion("gas", "HCF").factor).toBeCloseTo(1.037, 10);
    expect(usageConversion("gas", "Mcf").factor).toBeCloseTo(10.37, 10);
    expect(usageConversion("gas", "cf").factor).toBeCloseTo(0.01037, 10);
    expect(usageConversion("gas", "Dth").factor).toBe(10);
    expect(usageConversion("gas", "MMBtu").factor).toBe(10);
    expect(usageConversion("gas", "m³").factor).toBeCloseTo(0.01037 * 35.3147, 8);
  });
  it("converts water volumes exactly (748.052 gal per CCF, 1,000 per kgal)", () => {
    expect(usageConversion("water", "CCF").factor).toBeCloseTo(748.052, 6);
    expect(usageConversion("water", "HCF").factor).toBeCloseTo(748.052, 6);
    expect(usageConversion("water", "kgal").factor).toBe(1000);
    expect(usageConversion("water", "cf").factor).toBeCloseTo(7.48052, 8);
    expect(usageConversion("water", "m3").factor).toBeCloseTo(264.172, 6);
    expect(usageConversion("water", "HCF").shortNote).toBe("converted from HCF to gallons (1 HCF = 748.052 gallons)");
    expect(toModelUsage(2, "water", "kgal")).toBe(2000);
    expect(toModelUsage(100, "gas", "CCF")).toBeCloseTo(103.7, 10);
  });
  it("never invents a factor for an unknown unit: used as-is, with a note", () => {
    const u = usageConversion("water", "acre-ft");
    expect(u).toMatchObject({ factor: 1, recognized: false });
    expect(u.note).toMatch(/does not convert, so they are used as gallons as-is/);
    expect(usageConversion("gas", "liters").recognized).toBe(false);
  });
});

describe("modeling reads convert; stored rows and the chart stay as recorded", () => {
  it("getIntervalPoints returns therms for a CCF gas meter, the chart returns CCF, the rows keep CCF", async () => {
    const { meterId } = await siteWithMeter("gas-ccf", "gas", "CCF", 5, 10);
    const pts = await h.getIntervalPoints(meterId, userId);
    expect(pts).toHaveLength(5);
    for (const p of pts) expect(p.usage).toBeCloseTo(10.37, 10);
    const raw = await caller().intervalsApi.window({ meterId, fromTs: T0 - DAY, toTs: T0 + 10 * DAY });
    expect(raw.map((r) => r.usage)).toEqual([10, 10, 10, 10, 10]);
    const db = (await getDb())!;
    const stored = await db.select({ usage: intervals.usage }).from(intervals).where(eq(intervals.meterId, meterId));
    expect(stored.every((r) => r.usage === 10)).toBe(true);
    const [m] = await db.select({ usageUnit: meters.usageUnit }).from(meters).where(eq(meters.id, meterId));
    expect(m!.usageUnit).toBe("CCF");
    // A second modeling read is not compounded.
    const again = await h.getIntervalPoints(meterId, userId);
    expect(again[0]!.usage).toBeCloseTo(10.37, 10);
  }, 60_000);
  it("returns water in gallons for HCF and kgal meters; kWh and gallons are untouched", async () => {
    const hcf = await siteWithMeter("water-hcf", "water", "HCF", 3, 2);
    expect((await h.getIntervalPoints(hcf.meterId, userId))[0]!.usage).toBeCloseTo(1496.104, 6);
    const kgal = await siteWithMeter("water-kgal", "water", "kgal", 3, 1.5);
    expect((await h.getIntervalPoints(kgal.meterId, userId))[0]!.usage).toBeCloseTo(1500, 9);
    const gal = await siteWithMeter("water-gal", "water", "gallons", 3, 400);
    expect((await h.getIntervalPoints(gal.meterId, userId))[0]!.usage).toBe(400);
    const kwh = await siteWithMeter("elec", "electric", "kWh", 3, 55);
    expect((await h.getIntervalPoints(kwh.meterId, userId))[0]!.usage).toBe(55);
  }, 60_000);
});

describe("gas/water scenario baseline uses the model unit, with the disclosure", () => {
  it("a CCF gas meter's annual baseline is CCF × 1.037 therms", async () => {
    const { siteId } = await siteWithMeter("scn-gas", "gas", "CCF", 300, 10); // 10 CCF/day, 299-day span
    const site = await h.getSite(siteId, userId);
    const run = await runCommodityEfficiency({ site, userId, commodity: "gas", reduction: 0.1 });
    const spanDays = 299;
    const expected = ((300 * 10 * 1.037) / spanDays) * 365;
    expect(run.loadBasis).toBe("measured_intervals");
    const a = run.results.assumptions as { annualBaselineUnits: number };
    expect(a.annualBaselineUnits).toBe(Math.round(expected));
    expect(run.results.disclosures.join(" ")).toMatch(/Readings are in CCF; costs and savings convert them to therms using the U\.S\. average of 1\.037/);
  }, 60_000);
  it("an HCF water meter's annual baseline is HCF × 748.052 gallons; a gallons meter has no unit note", async () => {
    const hcf = await siteWithMeter("scn-water-hcf", "water", "HCF", 300, 1);
    const run = await runCommodityEfficiency({ site: await h.getSite(hcf.siteId, userId), userId, commodity: "water", reduction: 0.1 });
    expect((run.results.assumptions as { annualBaselineUnits: number }).annualBaselineUnits).toBe(Math.round(((300 * 748.052) / 299) * 365));
    expect(run.results.disclosures.join(" ")).toMatch(/Readings are in HCF; costs and savings convert them to gallons \(1 HCF = 748\.052 gallons\)/);
    const gal = await siteWithMeter("scn-water-gal", "water", "gallons", 300, 748.052);
    const run2 = await runCommodityEfficiency({ site: await h.getSite(gal.siteId, userId), userId, commodity: "water", reduction: 0.1 });
    expect((run2.results.assumptions as { annualBaselineUnits: number }).annualBaselineUnits).toBe(
      (run.results.assumptions as { annualBaselineUnits: number }).annualBaselineUnits,
    );
    expect(run2.results.disclosures.join(" ")).not.toMatch(/Readings are in/);
  }, 60_000);
});

describe("bills are stored in the model unit", () => {
  it("a gas bill typed in CCF is saved in therms; a water bill in kgal is saved in gallons; kWh is unchanged", async () => {
    const db = (await getDb())!;
    const gas = await siteWithMeter("bill-gas", "gas", "therms", 0, 0);
    const r = await caller().bills.create({ meterId: gas.meterId, periodStart: "2026-08-01", periodEnd: "2026-08-31", totalUsage: 100, usageUnit: "CCF", totalCostUsd: 150 });
    expect(r.usageSaved).toBeCloseTo(103.7, 9);
    expect(r.usageUnitSaved).toBe("therms");
    expect(r.unitNote).toMatch(/1\.037 therms per CCF/);
    const [gb] = await db.select({ usage: bills.usage, totalCost: bills.totalCost }).from(bills).where(eq(bills.meterId, gas.meterId));
    expect(gb!.usage).toBeCloseTo(103.7, 6);
    expect(gb!.totalCost).toBe(150);
    const water = await siteWithMeter("bill-water", "water", "gallons", 0, 0);
    const w = await caller().bills.create({ meterId: water.meterId, periodStart: "2026-08-01", periodEnd: "2026-08-31", totalUsage: 12.5, usageUnit: "kgal", totalCostUsd: 80 });
    expect(w.usageSaved).toBe(12_500);
    const elec = await siteWithMeter("bill-elec", "electric", "kWh", 0, 0);
    const e = await caller().bills.create({ meterId: elec.meterId, periodStart: "2026-08-01", periodEnd: "2026-08-31", totalUsage: 900, usageUnit: "kWh", totalCostUsd: 120 });
    expect(e.usageSaved).toBe(900);
    expect(e.unitNote).toBeNull();
    const [eb] = await db.select({ usage: bills.usage }).from(bills).where(and(eq(bills.meterId, elec.meterId)));
    expect(eb!.usage).toBe(900);
  }, 60_000);
});

describe("M&V verifies savings in the model unit", () => {
  it("a CCF meter verifies the same therms as the identical readings recorded in therms, with the unit note", async () => {
    const installedAt = T0 + 400 * DAY;
    const usage = (i: number) => (i < 400 ? 10 : 8); // 20% lower after the measure
    const make = async (label: string, unit: string, scale: number) => {
      const { siteId, meterId } = await siteWithMeter(label, "gas", unit, 0, 0);
      const db = (await getDb())!;
      const [u] = await db
        .insert(uploads)
        .values({ userId, siteId, filename: `${label}.csv`, sha256: `uconv-${label}-${stamp}`, format: "csv" as never, status: "parsed" as never } as never);
      await db.insert(intervals).values(
        Array.from({ length: 520 }, (_, i) => ({ meterId, uploadId: Number(u.insertId), ts: T0 + i * DAY, durationMin: 1440, usage: usage(i) * scale, demand: null })) as never,
      );
      return assessMv({ siteId, userId, meterId, installedAt });
    };
    const ccf = await make("mv-ccf", "CCF", 1);
    const thm = await make("mv-therms", "therms", GAS_THERMS_PER_CCF);
    expect(ccf.totalAvoidedUnits).toBeGreaterThan(0);
    expect(ccf.totalAvoidedUnits).toBeCloseTo(thm.totalAvoidedUnits, 6);
    expect(ccf.disclosures.join(" ")).toMatch(/Readings are in CCF; costs and savings convert them to therms/);
    expect(thm.disclosures.join(" ")).not.toMatch(/Readings are in/);
  }, 90_000);
});

describe("parser and commodity choice keep the stated unit", () => {
  it("a water-labeled CCF file is water in CCF; a gas CCF file stays gas in CCF", () => {
    const water = parseCsvIntervals("Date,Water Usage (CCF)\n2026-01-01,3\n2026-01-02,4\n2026-01-03,5\n", "water.csv");
    expect(water[0]).toMatchObject({ commodity: "water", usageUnit: "CCF" });
    const gas = parseCsvIntervals("Date,CCF\n2026-01-01,3\n2026-01-02,4\n2026-01-03,5\n", "gas.csv");
    expect(gas[0]).toMatchObject({ commodity: "gas", usageUnit: "CCF" });
    expect(gas[0]!.points[0]!.usage).toBe(3); // readings are never rescaled at ingest
  });
  it("a kgal column is recorded as kgal, never as gallons", () => {
    const k = parseCsvIntervals("Date,Usage (kgal)\n2026-01-01,1.2\n2026-01-02,1.4\n2026-01-03,1.1\n", "k.csv");
    expect(k[0]).toMatchObject({ commodity: "water", usageUnit: "kgal" });
    expect(k[0]!.points[0]!.usage).toBe(1.2);
  });
  it("a CCF file chosen as water becomes water with the unit kept; therms still win over a water choice", () => {
    const ccf = parseCsvIntervals("Date,CCF\n2026-01-01,3\n2026-01-02,4\n2026-01-03,5\n", "x.csv")[0]!;
    const asWater = applyCommodityHint(ccf, "water");
    expect(asWater).toMatchObject({ commodity: "water", usageUnit: "CCF", demandUnit: null });
    const therms = parseCsvIntervals("Date,Therms\n2026-01-01,3\n2026-01-02,4\n2026-01-03,5\n", "t.csv")[0]!;
    expect(applyCommodityHint(therms, "water")).toMatchObject({ commodity: "gas", usageUnit: "therms" });
  });
});
