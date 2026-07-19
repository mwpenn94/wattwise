/**
 * GEO — geometryConfirm/geometryGet endpoint contracts:
 *  1. Confirm persists derived fields (area, orientation, walls, exposure)
 *     with per-field provenance; user_drawn carries the highest confidence.
 *  2. OSM-sourced confirmations are flagged ODbL-derived with dataset height.
 *  3. The confirmed footprint feeds dimensional receipts (geometry GFA row).
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

function ctxFor(user: { id: number; openId: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: "user",
      tier: "pro",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}

async function makeUser(openId: string) {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: openId } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.update(users).set({ tier: "pro" }).where(eq(users.id, rows[0].id));
  return rows[0];
}

function rect(lat: number, lng: number, wM: number, hM: number): [number, number][] {
  const dLat = hM / 2 / 111320;
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
  ];
}

describe("sites.geometryConfirm / geometryGet", () => {
  it("persists a user-drawn footprint with derived orientation, walls, exposure, and provenance", async () => {
    const user = await makeUser(`geo-${Date.now()}`);
    const caller = appRouter.createCaller(ctxFor(user));
    const site = await caller.sites.quickCreate({ address: "100 Geometry Way, Tucson, AZ", buildingType: "office" });

    // ~30m x 15m drawn ring => ~4843 sqft footprint
    const ring = rect(32.2226, -110.9747, 30, 15);
    const res = await caller.sites.geometryConfirm({ siteId: site.id, ring, source: "user_drawn", stories: 2 });
    expect(res.ok).toBe(true);
    expect(res.derived.footprintSqft).toBeGreaterThan(4300);
    expect(res.derived.footprintSqft).toBeLessThan(5400);
    expect(res.derived.odblDerived).toBe(false);

    const stored = await caller.sites.geometryGet({ siteId: site.id });
    expect(stored?.footprintSource).toBe("user_drawn");
    expect(stored?.stories).toBe(2);
    expect(stored?.heightSource).toBe("stories_estimate");
    expect(stored?.orientationDeg).not.toBeNull();
    expect(stored?.exposureScore).toBeGreaterThan(0);
    const conf = stored?.geometryConfidence as Record<string, { source: string; confidence: number }>;
    expect(conf.footprint.confidence).toBeGreaterThan(0.9);
    expect(stored?.odblDerived).toBe(false);
  });

  it("flags OSM-sourced confirmations as ODbL-derived and feeds dimensional receipts with the geometry GFA", async () => {
    const user = await makeUser(`geo-osm-${Date.now()}`);
    const caller = appRouter.createCaller(ctxFor(user));
    const site = await caller.sites.quickCreate({ address: "200 Footprint Rd, Tucson, AZ", buildingType: "office" });

    const ring = rect(32.2226, -110.9747, 30, 15); // ~4800 sqft footprint
    await caller.sites.geometryConfirm({ siteId: site.id, ring, source: "osm", osmId: "way/42", heightM: 8, stories: 2 });

    const stored = await caller.sites.geometryGet({ siteId: site.id });
    expect(stored?.odblDerived).toBe(true);
    expect(stored?.heightSource).toBe("footprint_dataset");

    const receipts = await caller.sites.dimensionReceipts({ siteId: site.id });
    const geomReceipt = receipts.receipts.find((r) => r.dimension === "geometry_derived_gfa_sqft");
    expect(geomReceipt).toBeTruthy();
    // footprint (~4800) × 2 stories ≈ 9600 GFA
    expect(Number(geomReceipt!.valueInUse)).toBeGreaterThan(8500);
    expect(Number(geomReceipt!.valueInUse)).toBeLessThan(11000);
  });
});
