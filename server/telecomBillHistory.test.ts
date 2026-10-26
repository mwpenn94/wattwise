/**
 * TEL-1 (Oct 26) — connectivity bill history, end to end through the real
 * tRPC procedures on isolated fixture users.
 *
 *  - telecom.addObservation stores a bill's INCLUSIVE service period exactly
 *    (UTC day boundaries, time-zone independent) and normalizes it to a
 *    standard month; re-entering the same period replaces, never duplicates;
 *  - impossible or implausible periods/amounts are refused in plain words;
 *  - another user can neither read, add to, nor remove a service's bills;
 *  - two bills rising by >= $5 and >= 10% a month produce the price-increase
 *    finding with both bill periods named, a range, and the basis disclosed;
 *  - the first bill can be saved with the service (dates as YYYY-MM-DD);
 *  - the recommendation queue flags connectivity changes made after the
 *    latest analysis (so the ranked list can be refreshed);
 *  - Portfolio reports connectivity $/sq ft/yr from entered spend;
 *  - removing a service, deleting a site, or deleting all account data also
 *    removes connectivity services and their bills.
 * Every fixture row is removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { analyses, auditLog, billingAccounts, sites, telecomPriceHistory, telecomServices, users } from "../drizzle/schema";
import { billObservationProblem, billPeriodFromDates, billPeriodLabel, normalizeMonthlyPrice } from "./telecomPriceHistory";
import { ensureSeeded } from "./seed/runSeeders";

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 86_400_000;
const made: number[] = [];
type Fixture = { id: number; openId: string };

async function makeUser(label: string): Promise<Fixture> {
  const db = (await getDb())!;
  const openId = `tel1-${label}-${stamp}`;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  made.push(u!.id);
  await db.insert(billingAccounts).values({ userId: u!.id, plan: "pro", entitlementTier: "pro", status: "active" });
  return { id: u!.id, openId };
}
function callerFor(f: Fixture) {
  const ctx = {
    user: { id: f.id, openId: f.openId, email: `${f.openId}@test.local`, name: f.openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

let owner: Fixture;
let other: Fixture;
let siteId: number;
let serviceId: number;

beforeAll(async () => {
  await ensureSeeded();
  owner = await makeUser("owner");
  other = await makeUser("other");
  siteId = await h.createSite({ userId: owner.id, name: `TEL-1 site ${stamp}`, state: "AZ", zip: "85004", buildingType: "office", sqft: 10_000 });
  serviceId = await callerFor(owner).telecom.upsert({ siteId, serviceType: "internet", provider: "TestNet", monthlyCostUsd: 100, downloadMbps: 300, isBusiness: true });
}, 60_000);

afterAll(async () => {
  const db = await getDb();
  if (!db || made.length === 0) return;
  await db.delete(telecomPriceHistory).where(inArray(telecomPriceHistory.userId, made));
  await db.delete(telecomServices).where(inArray(telecomServices.userId, made));
  await db.delete(analyses).where(inArray(analyses.userId, made));
  await db.delete(sites).where(inArray(sites.userId, made));
  await db.delete(auditLog).where(inArray(auditLog.userId, made));
  await db.delete(billingAccounts).where(inArray(billingAccounts.userId, made));
  await db.delete(users).where(inArray(users.id, made));
});

describe("TEL-1 bill period arithmetic", () => {
  it("stores an inclusive period on exact UTC day boundaries", () => {
    const p = billPeriodFromDates("2026-09-05", "2026-10-04");
    expect(p.periodStart).toBe(Date.UTC(2026, 8, 5));
    expect(p.periodEnd).toBe(Date.UTC(2026, 9, 5));
    expect((p.periodEnd - p.periodStart) / DAY).toBe(30);
    expect(billPeriodLabel(p.periodStart, p.periodEnd)).toBe("Sep 5, 2026 – Oct 4, 2026");
    // a 30-day bill of $100 is a little more per standard (30.44-day) month
    expect(normalizeMonthlyPrice(100, p.periodStart, p.periodEnd)).toBeCloseTo(100 * (365.2425 / 12) / 30, 6);
  });
  it("rejects impossible dates and implausible periods with plain messages", () => {
    const now = Date.UTC(2026, 9, 26);
    const bad = billPeriodFromDates("2026-02-30", "2026-03-29");
    expect(Number.isNaN(bad.periodStart)).toBe(true);
    expect(billObservationProblem(bad.periodStart, bad.periodEnd, 50, now)).toMatch(/two valid dates/);
    const rev = billPeriodFromDates("2026-10-04", "2026-09-05");
    expect(billObservationProblem(rev.periodStart, rev.periodEnd, 50, now)).toMatch(/on or after its first day/);
    const long = billPeriodFromDates("2025-01-01", "2026-03-01");
    expect(billObservationProblem(long.periodStart, long.periodEnd, 50, now)).toMatch(/check the year/);
    const ok = billPeriodFromDates("2026-09-05", "2026-10-04");
    expect(billObservationProblem(ok.periodStart, ok.periodEnd, 0, now)).toMatch(/more than \$0/);
    expect(billObservationProblem(ok.periodStart, ok.periodEnd, 89.99, now)).toBeNull();
    // a single-day bill is a valid 1-day period
    const one = billPeriodFromDates("2026-10-01", "2026-10-01");
    expect(billObservationProblem(one.periodStart, one.periodEnd, 3, now)).toBeNull();
  });
});

describe("TEL-1 bill history through the router", () => {
  it("adds, replaces the same period, and lists bills in date order", async () => {
    const c = callerFor(owner);
    const a = await c.telecom.addObservation({ serviceId, startDate: "2026-08-05", endDate: "2026-09-04", billedUsd: 100 });
    expect(a.replaced).toBe(false);
    const again = await c.telecom.addObservation({ serviceId, startDate: "2026-08-05", endDate: "2026-09-04", billedUsd: 101 });
    expect(again.replaced).toBe(true);
    const hist = await c.telecom.history({ siteId });
    expect(hist).toHaveLength(1);
    expect(hist[0]!.billedUsd).toBe(101);
    expect(hist[0]!.periodLabel).toBe("Aug 5, 2026 – Sep 4, 2026");
    expect(hist[0]!.source).toBe("entered_bill");
  });

  it("refuses bad input from the router in plain words", async () => {
    const c = callerFor(owner);
    await expect(c.telecom.addObservation({ serviceId, startDate: "2026-09-04", endDate: "2026-08-05", billedUsd: 50 })).rejects.toThrow(/on or after its first day/);
    await expect(c.telecom.addObservation({ serviceId, startDate: "2026-02-30", endDate: "2026-03-29", billedUsd: 50 })).rejects.toThrow(/two valid dates/);
  });

  it("keeps another account out of this service's bills", async () => {
    const intruder = callerFor(other);
    await expect(intruder.telecom.addObservation({ serviceId, startDate: "2026-09-05", endDate: "2026-10-04", billedUsd: 1 })).rejects.toThrow(/not found/i);
    await expect(intruder.telecom.history({ siteId })).rejects.toThrow();
    const [row] = await callerFor(owner).telecom.history({ siteId });
    await expect(intruder.telecom.removeObservation({ id: row!.id })).rejects.toThrow(/not found/i);
    expect(await callerFor(owner).telecom.history({ siteId })).toHaveLength(1);
  });

  it("names both bill periods and discloses the basis when the price rises", async () => {
    const c = callerFor(owner);
    await c.telecom.addObservation({ serviceId, startDate: "2026-09-05", endDate: "2026-10-04", billedUsd: 125 });
    const res = await c.telecom.analyze({ siteId });
    const f = res.findings.find((x) => x.kind === "price_creep" && x.serviceId === serviceId);
    expect(f).toBeTruthy();
    expect(f!.body).toContain("Aug 5, 2026 – Sep 4, 2026");
    expect(f!.body).toContain("Sep 5, 2026 – Oct 4, 2026");
    expect(f!.estAnnualSavingsLo).toBeGreaterThan(0);
    expect(f!.estAnnualSavingsHi!).toBeGreaterThan(f!.estAnnualSavingsLo!);
    expect(f!.disclosures.join(" ")).toMatch(/standard 30\.4-day month/);
    expect(f!.disclosures.join(" ")).toMatch(/not a carrier quote/);
  });

  it("removes one bill, and the finding goes away with it", async () => {
    const c = callerFor(owner);
    const hist = await c.telecom.history({ siteId });
    const latest = hist[hist.length - 1]!;
    await c.telecom.removeObservation({ id: latest.id });
    expect(await c.telecom.history({ siteId })).toHaveLength(1);
    const res = await c.telecom.analyze({ siteId });
    expect(res.findings.some((x) => x.kind === "price_creep" && x.serviceId === serviceId)).toBe(false);
  });

  it("saves the first bill together with a new service (dates as YYYY-MM-DD)", async () => {
    const c = callerFor(owner);
    const mobileId = await c.telecom.upsert({
      siteId, serviceType: "mobile", provider: "TestCell", monthlyCostUsd: 60, lines: 1, unlimitedData: true,
      billStartDate: "2026-09-10", billEndDate: "2026-10-09", billedUsd: 60, billSource: "ocr_confirmed",
    });
    const rows = (await c.telecom.history({ siteId })).filter((r) => r.serviceId === mobileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.periodStart).toBe(Date.UTC(2026, 8, 10));
    expect(rows[0]!.periodEnd).toBe(Date.UTC(2026, 9, 10));
    expect(rows[0]!.source).toBe("ocr_confirmed");
    // half a bill is refused, nothing written
    await expect(c.telecom.upsert({ siteId, serviceType: "internet", provider: "Half", monthlyCostUsd: 40, billStartDate: "2026-09-01" })).rejects.toThrow(/first day, last day and amount/);
    expect((await c.telecom.list({ siteId })).some((s) => s.provider === "Half")).toBe(false);
    // removing the service removes its bills
    await c.telecom.remove({ id: mobileId });
    const db = (await getDb())!;
    expect(await db.select().from(telecomPriceHistory).where(eq(telecomPriceHistory.serviceId, mobileId))).toHaveLength(0);
  });
});

describe("TEL-1 refresh notice and Portfolio league value", () => {
  it("flags connectivity changes made after the latest analysis, and only then", async () => {
    const db = (await getDb())!;
    const c = callerFor(owner);
    // an analysis that started after every change so far → no notice
    await db.insert(analyses).values({ siteId, userId: owner.id, status: "complete", createdAt: new Date(Date.now() + 5_000) });
    expect((await c.recommendations.queue({ siteId })).connectivityChanged).toBe(false);
    await db.delete(analyses).where(eq(analyses.siteId, siteId));
    // an analysis that started before the latest change → notice
    await db.insert(analyses).values({ siteId, userId: owner.id, status: "complete", createdAt: new Date(Date.now() - 3_600_000) });
    await c.telecom.addObservation({ serviceId, startDate: "2026-07-05", endDate: "2026-08-04", billedUsd: 99 });
    expect((await c.recommendations.queue({ siteId })).connectivityChanged).toBe(true);
  });

  it("reports connectivity $/sq ft/yr on Portfolio from entered spend", async () => {
    const p = await callerFor(owner).entities.portfolio({});
    const row = p.sites.find((s) => s.siteId === siteId)!;
    expect(row.telecomServiceCount).toBe(1);
    expect(row.telecomAnnualUsd).toBe(1200);
    expect(row.connectivityUsdPerSqft).toBe(0.12); // $100/mo × 12 ÷ 10,000 sq ft
  });
});

describe("TEL-1 deletion removes connectivity rows", () => {
  it("deleting a site removes its services and bills", async () => {
    const c = callerFor(owner);
    const s2 = await h.createSite({ userId: owner.id, name: `TEL-1 site B ${stamp}`, state: "AZ", buildingType: "office" });
    const svc = await c.telecom.upsert({ siteId: s2, serviceType: "internet", provider: "GoneNet", monthlyCostUsd: 50, billStartDate: "2026-09-01", billEndDate: "2026-09-30", billedUsd: 50 });
    await h.deleteSite(s2, owner.id);
    const db = (await getDb())!;
    expect(await db.select().from(telecomServices).where(eq(telecomServices.id, svc))).toHaveLength(0);
    expect(await db.select().from(telecomPriceHistory).where(eq(telecomPriceHistory.siteId, s2))).toHaveLength(0);
  });

  it("deleting all account data removes every connectivity row", async () => {
    const temp = await makeUser("wipe");
    const s3 = await h.createSite({ userId: temp.id, name: `TEL-1 site C ${stamp}`, state: "AZ", buildingType: "office" });
    await callerFor(temp).telecom.upsert({ siteId: s3, serviceType: "internet", provider: "WipeNet", monthlyCostUsd: 70, billStartDate: "2026-09-01", billEndDate: "2026-09-30", billedUsd: 70 });
    await h.deleteAllUserData(temp.id);
    const db = (await getDb())!;
    expect(await db.select().from(telecomServices).where(eq(telecomServices.userId, temp.id))).toHaveLength(0);
    expect(await db.select().from(telecomPriceHistory).where(eq(telecomPriceHistory.userId, temp.id))).toHaveLength(0);
  });
});
