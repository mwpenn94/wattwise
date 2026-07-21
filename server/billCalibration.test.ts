/**
 * NEXT-1 "calibrate to my bill" — bill-verified blended-rate derivation.
 *
 * Covers the accuracy guards that make the tier honest:
 *  - estimated reads excluded, superseded bills replaced by latest revision
 *  - blend math = sum(cost)/sum(usage) over the recent window
 *  - commodity isolation (gas bills never contaminate the electric blend)
 *  - null when no qualifying bills (ladder falls through unchanged)
 *  - basis string discloses count + span + tier wording
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { deriveBillVerifiedRate } from "./billCalibration";
import * as h from "./dbHelpers";
import { getDb } from "./db";
import { users, sites, meters, bills } from "../drizzle/schema";
import { eq } from "drizzle-orm";

let userId: number;
let siteId: number;
let elecMeterId: number;
let gasMeterId: number;

const OPEN_ID = "test-billcal-user";

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  await db.insert(users).values({ openId: OPEN_ID, name: "BillCal Tester" });
  const u = await db.select().from(users).where(eq(users.openId, OPEN_ID));
  userId = u[0].id;
  siteId = await h.createSite({ userId, name: "BillCal Site", state: "AZ", buildingType: "office" });
  elecMeterId = await h.createMeter({ siteId, userId, commodity: "electric", usageUnit: "kWh" }, userId);
  gasMeterId = await h.createMeter({ siteId, userId, commodity: "gas", usageUnit: "therms" }, userId);
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(bills).where(eq(bills.meterId, elecMeterId));
  await db.delete(bills).where(eq(bills.meterId, gasMeterId));
  await db.delete(meters).where(eq(meters.siteId, siteId));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.id, userId));
});

async function addBill(meterId: number, start: string, end: string, usage: number, cost: number, extra: Partial<typeof bills.$inferInsert> = {}) {
  const db = await getDb();
  await db!.insert(bills).values({
    meterId,
    periodStart: new Date(start),
    periodEnd: new Date(end),
    usage,
    totalCost: cost,
    readType: "actual",
    billRevision: 0,
    source: "manual",
    ...extra,
  } as typeof bills.$inferInsert);
}

describe("deriveBillVerifiedRate", () => {
  it("returns null when no bills exist (ladder falls through unchanged)", async () => {
    const res = await deriveBillVerifiedRate(siteId, userId, "electric");
    expect(res).toBeNull();
  });

  it("blends sum(cost)/sum(usage) across actual-read bills and discloses count + span", async () => {
    await addBill(elecMeterId, "2026-04-01", "2026-04-30", 1000, 140);
    await addBill(elecMeterId, "2026-05-01", "2026-05-31", 1200, 156);
    const res = await deriveBillVerifiedRate(siteId, userId, "electric");
    expect(res).not.toBeNull();
    // (140+156)/(1000+1200) = 296/2200 ≈ 0.13455
    expect(res!.rate).toBeCloseTo(296 / 2200, 5);
    expect(res!.billCount).toBe(2);
    expect(res!.basis).toContain("bill-verified");
    expect(res!.basis).toContain("2 bills");
    expect(res!.basis).toMatch(/Apr 2026.*May 2026/);
  });

  it("excludes estimated reads from the blend", async () => {
    await addBill(elecMeterId, "2026-06-01", "2026-06-30", 1000, 900, { readType: "estimated" });
    const res = await deriveBillVerifiedRate(siteId, userId, "electric");
    // still only the two actual bills — the $0.90/kWh estimated read must not poison the blend
    expect(res!.billCount).toBe(2);
    expect(res!.rate).toBeCloseTo(296 / 2200, 5);
  });

  it("uses only the latest revision when a corrected bill covers the same period", async () => {
    // correction for the April bill: same period, revision 1, different totals
    await addBill(elecMeterId, "2026-04-01", "2026-04-30", 1000, 120, { billRevision: 1 });
    const res = await deriveBillVerifiedRate(siteId, userId, "electric");
    expect(res!.billCount).toBe(2);
    // (120+156)/(1000+1200) = 276/2200
    expect(res!.rate).toBeCloseTo(276 / 2200, 5);
  });

  it("isolates commodities — gas bills never contaminate the electric blend", async () => {
    await addBill(gasMeterId, "2026-05-01", "2026-05-31", 80, 96); // $1.20/therm
    const elec = await deriveBillVerifiedRate(siteId, userId, "electric");
    expect(elec!.rate).toBeCloseTo(276 / 2200, 5);
    const gas = await deriveBillVerifiedRate(siteId, userId, "gas");
    expect(gas).not.toBeNull();
    expect(gas!.rate).toBeCloseTo(1.2, 5);
    expect(gas!.basis).toContain("/therm");
  });

  it("ignores zero-usage or zero-cost artifact rows", async () => {
    await addBill(elecMeterId, "2026-07-01", "2026-07-31", 0, 45);
    await addBill(elecMeterId, "2026-08-01", "2026-08-31", 500, 0);
    const res = await deriveBillVerifiedRate(siteId, userId, "electric");
    expect(res!.billCount).toBe(2); // unchanged
  });
});
