/**
 * RATE-7b (Oct 26 2026): a water meter's billed size is saved through
 * sites.updateMeter and selects the filed Phoenix service charge. Isolated
 * fixture user; everything it creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { auditLog, billingAccounts, sites, users } from "../drizzle/schema";
import { costOnTariff } from "./analytics/tariffEngine";
import { PHX_WATER_STRUCTURE } from "./seed/seedData";

let userId = 0;
let openId = "";
let siteId = 0;
function caller() {
  const ctx = {
    user: { id: userId, openId, email: `${openId}@test.local`, name: openId, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

beforeAll(async () => {
  const db = (await getDb())!;
  openId = `metersize-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" });
  const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = u.id;
  await db.insert(billingAccounts).values({ userId, plan: "pro", entitlementTier: "pro", status: "active" });
  const [s] = await db.insert(sites).values({ userId, name: "RATE-7b meter size", city: "Phoenix", state: "AZ", zip: "85004", buildingType: "office", sqft: 5_000 } as never);
  siteId = (s as unknown as { insertId: number }).insertId;
}, 60_000);

afterAll(async () => {
  const db = await getDb();
  if (!db || !userId) return;
  await h.deleteAllUserData(userId);
  await db.delete(auditLog).where(eq(auditLog.userId, userId));
  await db.delete(billingAccounts).where(eq(billingAccounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}, 60_000);

describe("RATE-7b sites.updateMeter serviceSize", () => {
  it("saves a size on a water meter, refuses it on electric, and clears it", async () => {
    const c = caller();
    await c.sites.createMeter({ siteId, label: "Water", commodity: "water" });
    await c.sites.createMeter({ siteId, label: "Electric", commodity: "electric" });
    const list = await c.sites.meters({ siteId });
    const water = list.find((m) => m.commodity === "water")!;
    const elec = list.find((m) => m.commodity === "electric")!;
    expect(water.serviceSize ?? null).toBeNull();

    await c.sites.updateMeter({ meterId: water.id, serviceSize: "1 in." });
    const saved = (await h.getMeter(water.id, userId))!;
    expect(saved.serviceSize).toBe("1 in.");
    // The saved size selects the filed charge in pricing.
    const start = Date.UTC(2025, 0, 1, 7);
    const pts = Array.from({ length: 31 * 24 }, (_, i) => ({ ts: start + i * 3_600_000, usage: 10, demand: 10, durationMin: 60 }));
    expect(costOnTariff(pts, PHX_WATER_STRUCTURE, { tz: "America/Phoenix", meterSize: saved.serviceSize }).breakdown.fixed).toBeCloseTo(8.81, 9);

    await expect(c.sites.updateMeter({ meterId: elec.id, serviceSize: "1 in." })).rejects.toThrow(/water meters only/);
    expect((await h.getMeter(elec.id, userId))!.serviceSize ?? null).toBeNull();
    // Not a filed size string → rejected by the input schema, nothing written.
    await expect(c.sites.updateMeter({ meterId: water.id, serviceSize: "7 in." as never })).rejects.toThrow();
    expect((await h.getMeter(water.id, userId))!.serviceSize).toBe("1 in.");

    await c.sites.updateMeter({ meterId: water.id, serviceSize: null });
    expect((await h.getMeter(water.id, userId))!.serviceSize ?? null).toBeNull();
  }, 60_000);
});
