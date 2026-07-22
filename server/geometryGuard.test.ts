/**
 * GEO-BUG fixes (Jul 22) — regression specs.
 *
 * 1. Degraded resolves (one source family down) must NOT reach the persistent
 *    cache — that is how a wrong esri ring poisoned the cache and kept
 *    shadowing the correct OSM footprint (Cantex incident).
 * 2. geometryConfirm must refuse to overwrite a user_drawn footprint with a
 *    dataset candidate unless force:true is sent.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  _clearResolveCache,
  resolveFootprints,
  setPersistentResolveCache,
  type FootprintCandidate,
} from "./geometry";

const RING: [number, number][] = [
  [-113.95, 35.27],
  [-113.949, 35.27],
  [-113.949, 35.271],
  [-113.95, 35.271],
];

function cand(source: "osm" | "microsoft" | "usa_structures"): FootprintCandidate {
  return { ring: RING, areaSqft: 320000, heightM: 6, stories: 1, source, distanceM: 5 };
}

describe("persistent geometry cache — degraded-result rule (GEO-BUG-1)", () => {
  const puts: Array<{ gridKey: string; provider: string; candidates: FootprintCandidate[] }> = [];

  beforeAll(() => {
    setPersistentResolveCache({
      async get() {
        return null;
      },
      async put(gridKey, provider, candidates) {
        puts.push({ gridKey, provider, candidates });
      },
    });
  });

  afterAll(() => {
    setPersistentResolveCache(null);
  });

  it("does NOT persist an esri fallback when OSM failed (degraded)", async () => {
    puts.length = 0;
    _clearResolveCache();
    const res = await resolveFootprints(
      { lat: 35.3311, lng: -113.9111 },
      {
        skipCache: false,
        osmFetcher: async () => {
          throw new Error("overpass throttled");
        },
        esriFetcher: async () => ({
          features: [
            {
              attributes: { HEIGHT: 6 },
              geometry: { rings: [RING.map(([lng, lat]) => [lng, lat] as [number, number])] },
            },
          ],
        }),
      },
    );
    expect(res.provider).toBe("esri");
    expect(res.osmFailed).toBe(true);
    // Degraded → nothing written to the persistent layer.
    expect(puts.length).toBe(0);
  });

  it("persists a full-success OSM result", async () => {
    puts.length = 0;
    _clearResolveCache();
    const res = await resolveFootprints(
      { lat: 35.4422, lng: -113.9222 },
      {
        skipCache: false,
        osmFetcher: async () => ({
          elements: [
            {
              type: "way",
              id: 42,
              tags: { building: "yes", height: "6" },
              geometry: RING.map(([lng, lat]) => ({ lat, lon: lng })),
            },
          ],
        }),
        esriFetcher: async () => ({ features: [] }),
      },
    );
    expect(res.provider).toBe("osm");
    expect(res.osmFailed).toBe(false);
    expect(res.esriFailed).toBe(false);
    expect(puts.length).toBe(1);
    expect(puts[0].provider).toBe("osm");
  });

  it("does NOT persist when both sources fail (transport failure)", async () => {
    puts.length = 0;
    _clearResolveCache();
    const res = await resolveFootprints(
      { lat: 35.5533, lng: -113.9333 },
      {
        skipCache: false,
        osmFetcher: async () => {
          throw new Error("down");
        },
        esriFetcher: async () => {
          throw new Error("down");
        },
      },
    );
    expect(res.provider).toBe("none");
    expect(puts.length).toBe(0);
  });
});

describe("geometryConfirm user_drawn guard (GEO-BUG-2)", () => {
  it("rejects a dataset confirm over a user_drawn row without force, allows with force, and always allows user_drawn", async () => {
    const { appRouter } = await import("./routers");
    const { getDb } = await import("./db");
    const h = await import("./dbHelpers");
    const { users, sites, siteGeometry, auditLog } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) throw new Error("no db");

    // Fixture user + site (same pattern as accountDeletion.test.ts).
    const openId = `geoguard-${Date.now()}`;
    await db.insert(users).values({ openId, name: "Geo Guard", email: `${openId}@test.local`, loginMethod: "test" });
    const urows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    const userId = urows[0].id;
    const siteId = await h.createSite({
      userId,
      name: "Guard Test Site",
      state: "AZ",
      city: "Kingman",
      buildingType: "warehouse",
      lat: 35.2761,
      lng: -113.9474,
    });

    const ctx = {
      user: {
        id: userId,
        openId,
        email: `${openId}@test.local`,
        name: "Geo Guard",
        loginMethod: "test",
        role: "user",
        tier: "pro",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      req: { protocol: "https", headers: {} },
      res: { clearCookie: () => {}, cookie: () => {} },
    };
    const caller = appRouter.createCaller(ctx as never);

    try {
      // 1. Establish a user-drawn footprint.
      const drawn = await caller.sites.geometryConfirm({
        siteId,
        ring: RING,
        source: "user_drawn",
        stories: 1,
        heightM: 3.2,
      });
      expect(drawn.ok).toBe(true);

      // 2. A dataset candidate without force must be rejected.
      await expect(
        caller.sites.geometryConfirm({
          siteId,
          ring: RING,
          source: "microsoft",
          stories: 1,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      // 3. Same confirm with force:true succeeds.
      const forced = await caller.sites.geometryConfirm({
        siteId,
        ring: RING,
        source: "microsoft",
        stories: 1,
        force: true,
      });
      expect(forced.ok).toBe(true);

      // 4. Re-drawing (user_drawn) never needs force.
      const redrawn = await caller.sites.geometryConfirm({
        siteId,
        ring: RING,
        source: "user_drawn",
        stories: 2,
        heightM: 6.4,
      });
      expect(redrawn.ok).toBe(true);
    } finally {
      await db.delete(siteGeometry).where(eq(siteGeometry.siteId, siteId));
      await db.delete(auditLog).where(eq(auditLog.userId, userId));
      await db.delete(sites).where(eq(sites.id, siteId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
