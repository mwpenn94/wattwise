import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const makeRequestMock = vi.fn();
vi.mock("./_core/map", () => ({ makeRequest: (...args: unknown[]) => makeRequestMock(...args) }));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as geo from "./geometry";
import * as h from "./dbHelpers";
import { auditLog, siteGeometry, siteMembers, sites, users } from "../drizzle/schema";

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
  await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test", tier: "pro" });
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

async function cleanup(userIds: number[], siteIds: number[]) {
  const db = (await getDb())!;
  for (const siteId of siteIds) {
    await db.delete(siteGeometry).where(eq(siteGeometry.siteId, siteId));
    await db.delete(siteMembers).where(eq(siteMembers.siteId, siteId));
    await db.delete(sites).where(eq(sites.id, siteId));
  }
  for (const userId of userIds) {
    await db.delete(auditLog).where(eq(auditLog.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
}

function preciseGeocode() {
  return {
    status: "OK",
    results: [
      {
        formatted_address: "500 Maple St, Kingman, AZ 86401, USA",
        types: ["street_address"],
        geometry: {
          location: { lat: 35.1935161, lng: -114.050659 },
          location_type: "ROOFTOP",
          viewport: { northeast: { lat: 0, lng: 0 }, southwest: { lat: 0, lng: 0 } },
        },
        address_components: [
          { long_name: "Kingman", short_name: "Kingman", types: ["locality"] },
          { long_name: "Arizona", short_name: "AZ", types: ["administrative_area_level_1"] },
          { long_name: "86401", short_name: "86401", types: ["postal_code"] },
        ],
        place_id: "maple-500",
      },
    ],
  };
}

const EMPTY_RESOLVE: geo.ResolvedFootprints = {
  candidates: [],
  provider: "none",
  osmFailed: false,
  esriFailed: false,
  cached: false,
};

afterEach(() => {
  makeRequestMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("geometry reliability", () => {
  it("geocodes a precise street address on demand, persists missing location fields, and forwards refresh", async () => {
    const run = Date.now();
    const user = await makeUser(`geo-reliability-owner-${run}`);
    const siteId = await h.createSite({ userId: user.id, name: "Maple", address: "500 Maple St", buildingType: "office" });
    const resolver = vi.spyOn(geo, "resolveFootprints").mockResolvedValue(EMPTY_RESOLVE);
    makeRequestMock.mockResolvedValue(preciseGeocode());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(preciseGeocode())));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const caller = appRouter.createCaller(ctxFor(user));
      const result = await caller.sites.geometryResolve({ siteId, refresh: true });
      expect(result.outcome).toBe("no_footprint_found");
      expect(result.fallback).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect((fetchMock.mock.calls[0] as unknown as [URL])[0].searchParams.get("address")).toBe("500 Maple St");
      expect(resolver).toHaveBeenCalledWith(
        { lat: 35.1935161, lng: -114.050659 },
        { skipCache: true },
      );
      const db = (await getDb())!;
      const stored = (await db.select().from(sites).where(eq(sites.id, siteId)).limit(1))[0];
      expect(stored.lat).toBeCloseTo(35.1935161);
      expect(stored.lng).toBeCloseTo(-114.050659);
      expect(stored.city).toBe("Kingman");
      expect(stored.state).toBe("AZ");
      expect(stored.zip).toBe("86401");
    } finally {
      await cleanup([user.id], [siteId]);
    }
  });

  it("rejects a locality-only geocode without persisting a fabricated building point", async () => {
    const run = Date.now();
    const user = await makeUser(`geo-reliability-imprecise-${run}`);
    const siteId = await h.createSite({ userId: user.id, name: "Kingman", address: "Kingman", buildingType: "office" });
    const resolver = vi.spyOn(geo, "resolveFootprints").mockResolvedValue(EMPTY_RESOLVE);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "OK", results: [{
      types: ["locality"], geometry: { location: { lat: 35.1894, lng: -114.053 }, location_type: "APPROXIMATE" },
    }] }))));
    makeRequestMock.mockResolvedValue({
      status: "OK",
      results: [
        {
          formatted_address: "Kingman, AZ, USA",
          types: ["locality", "political"],
          geometry: {
            location: { lat: 35.1894, lng: -114.053 },
            location_type: "APPROXIMATE",
            viewport: { northeast: { lat: 0, lng: 0 }, southwest: { lat: 0, lng: 0 } },
          },
          address_components: [],
          place_id: "kingman",
        },
      ],
    });

    try {
      const result = await appRouter.createCaller(ctxFor(user)).sites.geometryResolve({ siteId });
      expect(result.outcome).toBe("address_not_precise");
      expect(result.fallback).toBeNull();
      expect(resolver).not.toHaveBeenCalled();
      const db = (await getDb())!;
      const stored = (await db.select().from(sites).where(eq(sites.id, siteId)).limit(1))[0];
      expect(stored.lat).toBeNull();
      expect(stored.lng).toBeNull();
    } finally {
      await cleanup([user.id], [siteId]);
    }
  });

  it("allows a facility manager to confirm and a read-only member to view but not mutate, preserving the user-drawn guard", async () => {
    const run = Date.now();
    const owner = await makeUser(`geo-reliability-owner-role-${run}`);
    const manager = await makeUser(`geo-reliability-manager-${run}`);
    const reader = await makeUser(`geo-reliability-reader-${run}`);
    const siteId = await h.createSite({ userId: owner.id, name: "Role Site", buildingType: "office", lat: 35.2, lng: -114.05 });
    const db = (await getDb())!;
    await db.insert(siteMembers).values([
      { siteId, userId: manager.id, role: "facility_manager", invitedBy: owner.id, createdAt: Date.now() },
      { siteId, userId: reader.id, role: "read_only", invitedBy: owner.id, createdAt: Date.now() },
    ]);
    const ring: [number, number][] = [
      [-114.051, 35.199],
      [-114.049, 35.199],
      [-114.049, 35.201],
      [-114.051, 35.201],
    ];

    try {
      const managerCaller = appRouter.createCaller(ctxFor(manager));
      await expect(managerCaller.sites.geometryConfirm({ siteId, ring, source: "user_drawn", stories: 1 })).resolves.toMatchObject({ ok: true });
      const readerCaller = appRouter.createCaller(ctxFor(reader));
      await expect(readerCaller.sites.geometryGet({ siteId })).resolves.toMatchObject({ footprintSource: "user_drawn" });
      await expect(readerCaller.sites.geometryResolve({ siteId })).rejects.toThrow(/read-only/i);
      await expect(readerCaller.sites.geometryConfirm({ siteId, ring, source: "osm", stories: 1 })).rejects.toThrow(/read-only/i);
      await expect(managerCaller.sites.geometryConfirm({ siteId, ring, source: "microsoft", stories: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      await cleanup([owner.id, manager.id, reader.id], [siteId]);
    }
  });
});
