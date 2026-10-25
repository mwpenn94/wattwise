import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { auditLog, sitePropertyFacts, sites, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import {
  addressKey,
  autoApplyDecision,
  computePropertyFacts,
  estimateFloorArea,
  floorAreaBasisOf,
  parcelRelation,
  presentPropertyFacts,
  sameAddress,
  setPropertyFactsFetcher,
  storiesFor,
  type JsonFetcher,
  type StructureRecord,
} from "./propertyFacts";

/* Oct 24 property facts — replaces the rejected outbound-link card with
 * automatic, in-app public-record enrichment. These tests pin the honesty
 * rules: address-matched only, shared parcels never double counted, unknown
 * height disclosed as one story, a typed floor area never overwritten, and
 * facts for an old location never applied. Network is mocked throughout. */

// A square parcel around Kingman High's pin (lng/lat).
const PIN = { lat: 35.2452, lng: -114.0094 };
const RING: Array<[number, number]> = [
  [-114.012, 35.243],
  [-114.007, 35.243],
  [-114.007, 35.247],
  [-114.012, 35.247],
  [-114.012, 35.243],
];
type Bldg = { id: number; sq: number; addr: string | null; occ?: string; prim?: string; h?: number | null; lat?: number; lng?: number };
function structuresJson(list: Bldg[], exceeded = false) {
  return {
    exceededTransferLimit: exceeded,
    features: list.map((b) => ({
      attributes: {
        BUILD_ID: b.id,
        SQFEET: b.sq,
        PROP_ADDR: b.addr,
        OCC_CLS: b.occ ?? "Education",
        PRIM_OCC: b.prim ?? "Pre-K - 12 Schools",
        HEIGHT: b.h ?? null,
        LATITUDE: b.lat ?? PIN.lat,
        LONGITUDE: b.lng ?? PIN.lng,
        PROD_DATE: Date.UTC(2022, 5, 1),
        VAL_METHOD: "Imagery",
      },
    })),
  };
}
function parcelJson(situs: string | null, extra: Record<string, unknown> = {}) {
  return {
    features: [
      {
        attributes: {
          PARCEL: "324-28-004A",
          SITE_ADDRESS: situs,
          OWNER: "KINGMAN UNIFIED SCHOOL DISTRICT #20",
          USE_CODE: "9200 - MUNI SCH PROP",
          PARCEL_SIZE: 52.3,
          UNIT_TYPE: "ACRES",
          FULL_CASH_VALUE: 41_250_000,
          LANDVALUE: 3_100_000,
          IMPVALUE: 38_150_000,
          TAX_YEAR: 2026,
          CLASS_CODE: "Exempt",
          ...extra,
        },
        geometry: { rings: [RING] },
      },
    ],
  };
}
function mockFetcher(opts: { parcel?: unknown; inParcel?: unknown; near?: unknown; failParcel?: boolean; failFema?: boolean }): JsonFetcher {
  return async (url, body) => {
    if (url.includes("mcgis.mohave.gov")) {
      if (opts.failParcel) throw new Error("county down");
      return opts.parcel ?? { features: [] };
    }
    if (url.includes("USA_Structures")) {
      if (opts.failFema) throw new Error("fema down");
      return body ? (opts.inParcel ?? { features: [] }) : (opts.near ?? opts.inParcel ?? { features: [] });
    }
    throw new Error(`unexpected url ${url}`);
  };
}
const SITE = { id: 1, address: "4182 N Bank St, Kingman, AZ", state: "AZ", buildingType: "school" };

describe("address matching", () => {
  it("treats directionals, street types and spelled ordinals as the same address", () => {
    expect(sameAddress(addressKey("4182 N Bank St, Kingman, AZ"), addressKey("4182 NORTH BANK STREET"))).toBe(true);
    expect(sameAddress(addressKey("301 N 1st St"), addressKey("301 NORTH FIRST STREET"))).toBe(true);
    expect(sameAddress(addressKey("4182 N Bank St"), addressKey("4180 N Bank St"))).toBe(false);
    expect(sameAddress(addressKey("4182 N Bank St"), addressKey("4182 Stockton Hill Rd"))).toBe(false);
    expect(addressKey("Jr High Tennis, Kingman")).toBeNull();
  });
  it("classifies a multi-address campus parcel as shared, not as a wrong pin", () => {
    const site = addressKey("3550 Prospector Ave");
    expect(parcelRelation(site, "3500 & 3700 PROSPECTOR")).toBe("multi");
    expect(parcelRelation(addressKey("3500 Prospector St"), "3500 & 3700 PROSPECTOR")).toBe("multi_includes");
    expect(parcelRelation(site, "400 GRANDVIEW AVE")).toBe("mismatch");
    expect(parcelRelation(site, null)).toBe("no_situs");
  });
  it("assumes one story when height is unknown and adds floors only for clearly tall buildings", () => {
    expect(storiesFor(null, false)).toBe(1);
    expect(storiesFor(6, false)).toBe(1);
    expect(storiesFor(12.5, false)).toBe(3);
    expect(storiesFor(6.2, true)).toBe(2);
  });
});

describe("floor-area estimate rules", () => {
  const s = (id: string, sq: number, address: string | null, occ = "Education"): StructureRecord => ({
    id, footprintSqft: sq, occupancyClass: occ, primaryOccupancy: null, address, heightM: null, lat: PIN.lat, lng: PIN.lng, prodDate: null, method: null,
  });
  const base = { siteKey: addressKey("4182 N Bank St"), siteAddressLabel: "4182 N Bank St", buildingType: "school", parcelTruncated: false, duplicateSiteNames: [] as string[] };
  it("never counts other-address buildings on a shared parcel", () => {
    const r = estimateFloorArea({
      ...base,
      parcel: { parcelId: "P", relation: "multi", shared: true },
      inParcel: [s("a", 15_000, "4182 N BANK STREET"), s("b", 70_000, "4200 N BANK STREET")],
      all: [s("a", 15_000, "4182 N BANK STREET"), s("b", 70_000, "4200 N BANK STREET")],
    });
    expect(r.estimate?.basis).toBe("address_matched_buildings");
    expect(r.estimate?.sqft).toBe(15_000);
    expect(r.estimate?.excludedCount).toBe(1);
    expect(r.estimate?.method).toMatch(/1 other building on the same parcel/);
  });
  it("gives no estimate on a shared parcel when no building carries the site address", () => {
    const r = estimateFloorArea({
      ...base,
      siteKey: addressKey("3550 Prospector Ave"),
      parcel: { parcelId: "P", relation: "multi", shared: true },
      inParcel: [s("a", 90_000, "3500 PROSPECTOR STREET")],
      all: [s("a", 90_000, "3500 PROSPECTOR STREET")],
    });
    expect(r.estimate).toBeNull();
    expect(r.reason).toMatch(/double count/);
  });
  it("rejects totals outside the plausible range and blocks auto-use when another site has the same address", () => {
    const tiny = estimateFloorArea({ ...base, parcel: null, inParcel: [], all: [s("a", 120, "4182 N BANK ST")] });
    expect(tiny.estimate).toBeNull();
    expect(tiny.reason).toMatch(/plausible range/);
    const dup = estimateFloorArea({ ...base, parcel: null, inParcel: [], all: [s("a", 20_000, "4182 N BANK ST")], duplicateSiteNames: ["KHS Gym"] });
    expect(dup.estimate?.autoApplyAllowed).toBe(false);
    expect(dup.estimate?.blockers[0]).toMatch(/double count/);
  });
});

describe("computePropertyFacts with official-source responses", () => {
  it("builds parcel facts and a disclosed one-story estimate for a single-address parcel", async () => {
    const r = await computePropertyFacts({
      site: SITE,
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: mockFetcher({
        parcel: parcelJson("4182 N BANK ST"),
        inParcel: structuresJson([
          { id: 1, sq: 200_000, addr: "4182 NORTH BANK STREET" },
          { id: 2, sq: 94_308, addr: "4182 NORTH BANK STREET" },
        ]),
      }),
    });
    expect(r.status).toBe("ok");
    expect(r.parcel?.parcelId).toBe("324-28-004A");
    expect(r.parcel?.relation).toBe("match");
    expect(r.estimate?.sqft).toBe(294_300);
    expect(r.estimate?.basis).toBe("parcel_all_buildings");
    expect(r.estimate?.storiesBasis).toBe("one_story_assumed");
    expect(r.estimate?.method).toMatch(/one story because public records list no building heights/);
    expect(r.estimate?.autoApplyAllowed).toBe(true);
    expect(r.typeCheck?.consistent).toBe(true);
    expect(r.sourcesUsed).toEqual(["mohave_assessor_gis", "fema_usa_structures"]);
  });
  it("does not show a neighboring parcel's record as this site's when the pin is on another address", async () => {
    const r = await computePropertyFacts({
      site: { ...SITE, address: "301 N 1st St, Kingman, AZ" },
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: mockFetcher({ parcel: parcelJson("400 GRANDVIEW AVE"), inParcel: structuresJson([{ id: 1, sq: 60_000, addr: "400 GRANDVIEW AVENUE" }]) }),
    });
    expect(r.parcel).toBeNull();
    expect(r.parcelMismatch?.situsAddress).toBe("400 GRANDVIEW AVE");
    expect(r.estimate).toBeNull();
    expect(r.cautions[0]).toMatch(/recorded as 400 Grandview Ave/);
  });
  it("blocks automatic use when public records classify the buildings differently", async () => {
    const r = await computePropertyFacts({
      site: { ...SITE, address: "515 Beale St, Kingman, AZ" },
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: mockFetcher({ near: structuresJson([{ id: 1, sq: 5_981, addr: "515 EAST BEALE STREET", occ: "Commercial", prim: "Retail Trade" }]) }),
    });
    expect(r.estimate?.sqft).toBe(6_000);
    expect(r.estimate?.autoApplyAllowed).toBe(false);
    expect(r.typeCheck?.consistent).toBe(false);
    expect(r.cautions.some((c) => /classify these buildings as commercial/.test(c))).toBe(true);
  });
  it("stays useful when the county is down and reports unavailable only when every source fails", async () => {
    const partial = await computePropertyFacts({
      site: SITE,
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: mockFetcher({ failParcel: true, near: structuresJson([{ id: 1, sq: 30_000, addr: "4182 N BANK ST" }]) }),
    });
    expect(partial.status).toBe("partial");
    expect(partial.sourceErrors).toEqual(["mohave_assessor_gis"]);
    expect(partial.estimate?.basis).toBe("address_matched_buildings");
    const down = await computePropertyFacts({ site: SITE, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: mockFetcher({ failParcel: true, failFema: true }) });
    expect(down.status).toBe("unavailable");
    expect(down.estimate).toBeNull();
  });
  it("explains why nothing can be matched when the site has no street address", async () => {
    const r = await computePropertyFacts({ site: { ...SITE, address: "Jr High Tennis, Kingman" }, point: null, otherSites: [], fetcher: mockFetcher({}) });
    expect(r.status).toBe("no_location");
    expect(r.noEstimateReason).toMatch(/no street address/);
  });
});

describe("auto-apply and basis labels", () => {
  const facts = { estimate: { sqft: 50_000, autoApplyAllowed: true, blockers: [] } };
  const row = { locationRevision: 3, appliedSqft: null, estimateSqft: 50_000, facts };
  const site = { sqft: null, buildingType: "school", tenure: "own" as const, isHypothetical: false, locationRevision: 3 };
  it("only fills an empty floor area on a current, non-residential, real site", () => {
    expect(autoApplyDecision(site, row).eligible).toBe(true);
    expect(autoApplyDecision({ ...site, sqft: 42_000 }, row)).toEqual({ eligible: false, reason: "site already has a floor area" });
    expect(autoApplyDecision({ ...site, locationRevision: 4 }, row).eligible).toBe(false);
    expect(autoApplyDecision({ ...site, buildingType: "single_family" }, row).eligible).toBe(false);
    expect(autoApplyDecision({ ...site, isHypothetical: true }, row).eligible).toBe(false);
    // our own earlier value may be refreshed; a matching value is a no-op
    expect(autoApplyDecision({ ...site, sqft: 48_000 }, { ...row, appliedSqft: 48_000 }).eligible).toBe(true);
    expect(autoApplyDecision({ ...site, sqft: 50_000 }, { ...row, appliedSqft: 50_000 }).eligible).toBe(false);
  });
  it("labels floor area by basis, including quick-start placeholders", () => {
    const applied = { appliedSqft: 50_000, appliedBy: "auto" as const, locationRevision: 3 };
    expect(floorAreaBasisOf({ sqft: 50_000, locationRevision: 3 }, applied).basis).toBe("public_record_estimate");
    expect(floorAreaBasisOf({ sqft: 50_000, locationRevision: 4 }, applied).basis).toBe("as_entered");
    expect(floorAreaBasisOf({ sqft: 51_000, locationRevision: 3 }, applied).basis).toBe("as_entered");
    expect(floorAreaBasisOf({ sqft: 2_000, locationRevision: 3, attrSource: "quick_start_defaults", refinedFields: null }, null).basis).toBe("placeholder");
    expect(floorAreaBasisOf({ sqft: 2_000, locationRevision: 3, attrSource: "user_entered", refinedFields: ["sqft"] }, null).basis).toBe("as_entered");
    expect(floorAreaBasisOf({ sqft: null, locationRevision: 3 }, null).basis).toBe("none");
  });
});

/* ---------------- DB-backed lifecycle + authorization ---------------- */
const openId = `pf-test-${Date.now()}`;
const otherOpenId = `${openId}-other`;
const userIds: number[] = [];
const siteIds: number[] = [];
function ctxFor(id: number, oid: string): TrpcContext {
  return {
    user: { id, openId: oid, email: `${oid}@test.local`, name: oid, loginMethod: "test", role: "user", tier: "pro", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {}, protocol: "http" },
    res: { cookie() {}, clearCookie() {} },
  } as unknown as TrpcContext;
}
async function makeUser(oid: string) {
  const db = (await getDb())!;
  await db.insert(users).values({ openId: oid, name: oid, email: `${oid}@test.local`, loginMethod: "test", tier: "pro" });
  const [u] = await db.select().from(users).where(eq(users.openId, oid)).limit(1);
  userIds.push(u!.id);
  return u!.id;
}
afterEach(() => setPropertyFactsFetcher(null));
afterAll(async () => {
  setPropertyFactsFetcher(null);
  const db = (await getDb())!;
  for (const id of siteIds) {
    await db.delete(sitePropertyFacts).where(eq(sitePropertyFacts.siteId, id));
    await db.delete(sites).where(eq(sites.id, id));
  }
  for (const id of userIds) {
    await db.delete(auditLog).where(eq(auditLog.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("property facts lifecycle (DB)", () => {
  it("reads facts without writing floor area, applies on request, never overwrites a typed value, and ignores stale locations", async () => {
    const db = (await getDb())!;
    const uid = await makeUser(openId);
    const otherUid = await makeUser(otherOpenId);
    const caller = appRouter.createCaller(ctxFor(uid, openId));
    const stranger = appRouter.createCaller(ctxFor(otherUid, otherOpenId));
    // Created while the network is disabled (vitest): no background enrichment.
    const { id } = await caller.sites.create({ name: "PF Test High", address: "4182 N Bank St", city: "Kingman", state: "AZ", zip: "86409", buildingType: "school" });
    siteIds.push(id);
    await db.update(sites).set({ lat: PIN.lat, lng: PIN.lng }).where(eq(sites.id, id));
    setPropertyFactsFetcher(
      mockFetcher({
        parcel: parcelJson("4182 N BANK ST"),
        inParcel: structuresJson([
          { id: 1, sq: 200_000, addr: "4182 NORTH BANK STREET" },
          { id: 2, sq: 94_308, addr: "4182 NORTH BANK STREET" },
        ]),
      }),
    );
    // 1. the read is read-only: facts appear, floor area is untouched
    const view = await caller.sites.propertyFacts({ siteId: id });
    expect(view.status).toBe("ok");
    expect(view.headline).toMatch(/About 294,300 sqft of floor area across 2 buildings/);
    expect(view.floorArea.state).toBe("estimate_available");
    expect(view.rows.map((r) => r.key)).toEqual(expect.arrayContaining(["buildings", "parcel", "owner", "use", "value", "type"]));
    expect(view.rows.every((r) => !!r.sourceId)).toBe(true);
    expect(view.sources.map((s) => s.id)).toEqual(["mohave_assessor_gis", "fema_usa_structures"]);
    expect((await caller.sites.get({ siteId: id })).sqft).toBeNull();
    // 2. strangers can neither read nor apply
    await expect(stranger.sites.propertyFacts({ siteId: id })).rejects.toThrow();
    await expect(stranger.sites.applyPropertyEstimate({ siteId: id, locationRevision: view.locationRevision })).rejects.toThrow();
    // 3. a stale location revision is refused
    await expect(caller.sites.applyPropertyEstimate({ siteId: id, locationRevision: view.locationRevision + 1 })).rejects.toThrow(/changed since you looked/);
    // 4. one-click use writes the estimate and labels it
    const applied = await caller.sites.applyPropertyEstimate({ siteId: id, locationRevision: view.locationRevision });
    expect(applied.sqft).toBe(294_300);
    const after = await caller.sites.propertyFacts({ siteId: id });
    expect(after.floorArea.state).toBe("estimate_in_use");
    const portfolio = await caller.entities.portfolio();
    expect(portfolio.sites.find((r: { siteId: number }) => r.siteId === id)?.sqftBasis).toBe("public_record_estimate");
    // 5. a typed value takes ownership and is never replaced automatically
    await caller.sites.refine({ siteId: id, sqft: 310_000 });
    const typed = await caller.sites.propertyFacts({ siteId: id });
    expect(typed.floorArea.state).toBe("your_value");
    expect(typed.floorArea.siteSqft).toBe(310_000);
    const { applyPropertyEstimate } = await import("./propertyFacts");
    expect(await applyPropertyEstimate(id, "auto")).toBe(false);
    expect((await caller.sites.get({ siteId: id })).sqft).toBe(310_000);
    expect((await caller.entities.portfolio()).sites.find((r: { siteId: number }) => r.siteId === id)?.sqftBasis).toBe("as_entered");
  });
  it("retires an applied estimate when the address changes, but keeps a typed floor area", async () => {
    const db = (await getDb())!;
    const uid = userIds[0];
    const caller = appRouter.createCaller(ctxFor(uid, openId));
    const { id } = await caller.sites.create({ name: "PF Move Test", address: "4182 N Bank St", city: "Kingman", state: "AZ", zip: "86409", buildingType: "school" });
    siteIds.push(id);
    await db.update(sites).set({ lat: PIN.lat, lng: PIN.lng }).where(eq(sites.id, id));
    setPropertyFactsFetcher(mockFetcher({ parcel: parcelJson("4182 N BANK ST"), inParcel: structuresJson([{ id: 1, sq: 40_000, addr: "4182 N BANK ST" }]) }));
    const v = await caller.sites.propertyFacts({ siteId: id });
    await caller.sites.applyPropertyEstimate({ siteId: id, locationRevision: v.locationRevision });
    expect((await caller.sites.get({ siteId: id })).sqft).toBe(40_000);
    // Network disabled for the update path so geocoding fails closed in tests.
    setPropertyFactsFetcher(null);
    await caller.sites.update({ siteId: id, address: "500 Maple St" }).catch(() => undefined);
    const moved = await caller.sites.get({ siteId: id });
    expect(moved.sqft).toBeNull();
    expect(moved.locationRevision).toBeGreaterThan(v.locationRevision);
    // a typed floor area survives the next move
    await caller.sites.refine({ siteId: id, sqft: 12_345 });
    await caller.sites.update({ siteId: id, address: "4182 N Bank St" }).catch(() => undefined);
    expect((await caller.sites.get({ siteId: id })).sqft).toBe(12_345);
  });
  it("presents a pending state rather than another location's facts", async () => {
    const view = presentPropertyFacts({ sqft: null, locationRevision: 9, address: "1 Main St", buildingType: "office" }, null);
    expect(view.status).toBe("pending");
    expect(view.rows).toEqual([]);
  });
});
