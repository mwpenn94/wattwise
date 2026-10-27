import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { auditLog, sitePropertyFacts, sites, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import {
  PIMA_PARCEL_LAYER,
  PIMA_PARCEL_LAYER_DIRECT,
  computePropertyFacts,
  needsCountyCoverageRefresh,
  presentPropertyFacts,
  setPropertyFactsFetcher,
  titleCase,
  type JsonFetcher,
  type PropertyFactsResult,
} from "./propertyFacts";

/* Oct 26 PF-2 — Pima County parcel adapter. Pima's "Parcels - Regional"
 * (PAREGION) layer, read from the City of Tucson's public service because the
 * county host answers server requests with a bot challenge. Field meanings
 * from the county's field metadata: LANDUNIT A = acres, F = square feet,
 * S = "site" (a count, not an area); MAIL1 = owner; ADR_STATUS MULTIPLE = the
 * parcel has several street addresses and SITE_ADDRESS is one of them; FCV is
 * published "for analysis" and is not a market value. Network is mocked. */

// 2551 W Orange Grove Rd, Tucson (a real Pima parcel shape, simplified).
const PIN = { lat: 32.3218057, lng: -111.022462 };
const RING: Array<[number, number]> = [
  [-111.0245, 32.3205],
  [-111.0195, 32.3205],
  [-111.0195, 32.3235],
  [-111.0245, 32.3235],
  [-111.0245, 32.3205],
];
const SITE = { id: 1, address: "2551 W Orange Grove Rd, Tucson, AZ 85741, USA", state: "AZ", buildingType: "office" };

function pimaParcel(extra: Record<string, unknown> = {}) {
  return {
    features: [
      {
        attributes: {
          PARCEL: "10109005C",
          SITE_ADDRESS: "2551 W ORANGE GROVE RD",
          ADR_STATUS: "ONE",
          MAIL1: "FAITH COMMUNITY CHURCH INC",
          PARCEL_USE: "1040",
          USE_DESC: "MISC COMMERCIAL                    ",
          LANDMEAS: 420082,
          LANDUNIT: "F",
          GISACRES: 8.64097809,
          FCV: 8612901,
          TAXYR: "2026",
          ...extra,
        },
        geometry: { rings: [RING] },
      },
    ],
  };
}
function structures(list: Array<{ id: number; sq: number; addr: string | null; occ?: string }>) {
  return {
    exceededTransferLimit: false,
    features: list.map((b) => ({
      attributes: {
        BUILD_ID: b.id,
        SQFEET: b.sq,
        PROP_ADDR: b.addr,
        OCC_CLS: b.occ ?? "Commercial",
        PRIM_OCC: "Office",
        HEIGHT: null,
        LATITUDE: PIN.lat,
        LONGITUDE: PIN.lng,
        PROD_DATE: Date.UTC(2022, 5, 1),
        VAL_METHOD: "Imagery",
      },
    })),
  };
}
type Calls = { pima: string[]; pimaCount: number; mohave: number; countyHost: number };
function fetcher(
  opts: { parcel?: unknown; nearCount?: number; failPima?: boolean; failPrimary?: "throw" | "error_json"; femaIn?: unknown; femaNear?: unknown },
  calls?: Calls,
): JsonFetcher {
  return async (url, body) => {
    if (url.includes("gisdata.pima.gov")) {
      if (calls) calls.countyHost++;
      throw new Error("bot challenge");
    }
    if (url.startsWith(PIMA_PARCEL_LAYER) && opts.failPrimary) {
      if (calls) calls.pima.push(url);
      if (opts.failPrimary === "error_json") return { error: { code: 500, message: "Unable to complete operation." } };
      throw new Error("TLS reset");
    }
    if (url.startsWith(PIMA_PARCEL_LAYER) || url.startsWith(PIMA_PARCEL_LAYER_DIRECT)) {
      if (opts.failPima) throw new Error("city host down");
      if (url.includes("returnCountOnly=true")) {
        if (calls) calls.pimaCount++;
        return { count: opts.nearCount ?? 0 };
      }
      if (calls) calls.pima.push(url);
      return opts.parcel ?? { features: [] };
    }
    if (url.includes("mcgis.mohave.gov")) {
      if (calls) calls.mohave++;
      return { features: [] };
    }
    if (url.includes("USA_Structures")) return body ? (opts.femaIn ?? { features: [] }) : (opts.femaNear ?? opts.femaIn ?? { features: [] });
    throw new Error(`unexpected url ${url}`);
  };
}

describe("Pima street-type abbreviations", () => {
  it("matches the county's two-letter street types to the spelled-out address", async () => {
    const { addressKey, sameAddress } = await import("./propertyFacts");
    expect(sameAddress(addressKey("1825 N Alvernon Way, Tucson, AZ"), addressKey("1825 N ALVERNON WY"))).toBe(true);
    expect(sameAddress(addressKey("6471 N La Cholla Blvd"), addressKey("6471 N LA CHOLLA BL"))).toBe(true);
    expect(sameAddress(addressKey("5780 N Sumaya Circle"), addressKey("5780 N SUMAYA CI"))).toBe(true);
    expect(sameAddress(addressKey("6890 N De Chelly Loop"), addressKey("6890 N DE CHELLY LP"))).toBe(true);
    expect(sameAddress(addressKey("985 E Desert Pkwy"), addressKey("985 E DESERT PW"))).toBe(true);
    expect(sameAddress(addressKey("6193 N Yellow Wood Trail"), addressKey("6193 N YELLOW WOOD TR"))).toBe(true);
    expect(sameAddress(addressKey("7068 N Moonsong Terrace"), addressKey("7068 N MOONSONG TE"))).toBe(true);
    expect(sameAddress(addressKey("6803 N Casa Grande Hwy"), addressKey("6803 N CASA GRANDE HY"))).toBe(true);
    expect(sameAddress(addressKey("4027 W Still Canyon Pass"), addressKey("4027 W STILL CANYON PS"))).toBe(true);
    // a different house number or street is still different
    expect(sameAddress(addressKey("1827 N Alvernon Way"), addressKey("1825 N ALVERNON WY"))).toBe(false);
    expect(sameAddress(addressKey("1825 N Columbus Blvd"), addressKey("1825 N ALVERNON WY"))).toBe(false);
  });
});

describe("Pima parcel layer hosts", () => {
  it("uses the ArcGIS Online URL first and the city's own host only if that fails", async () => {
    for (const mode of ["throw", "error_json"] as const) {
      const calls: Calls = { pima: [], pimaCount: 0, mohave: 0, countyHost: 0 };
      const r = await computePropertyFacts({
        site: SITE,
        point: { ...PIN, source: "site_pin" },
        otherSites: [],
        fetcher: fetcher({ failPrimary: mode, parcel: pimaParcel(), femaIn: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }, calls),
      });
      expect(calls.pima[0].startsWith(PIMA_PARCEL_LAYER)).toBe(true);
      expect(calls.pima[1].startsWith(PIMA_PARCEL_LAYER_DIRECT)).toBe(true);
      expect(r.parcel?.parcelId).toBe("10109005C");
      expect(r.sourcesUsed).toContain("pima_assessor_gis");
      expect(r.sourceErrors).not.toContain("pima_assessor_gis");
    }
  });
  it("asks only the primary host when it answers", async () => {
    const calls: Calls = { pima: [], pimaCount: 0, mohave: 0, countyHost: 0 };
    await computePropertyFacts({
      site: SITE,
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: fetcher({ parcel: pimaParcel(), femaIn: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }, calls),
    });
    expect(calls.pima).toHaveLength(1);
    expect(calls.pima[0].startsWith(PIMA_PARCEL_LAYER)).toBe(true);
  });
});

describe("Pima County parcel adapter", () => {
  it("reads the official Pima parcel under the pin with owner, use, land area and the county's value wording", async () => {
    const calls: Calls = { pima: [], pimaCount: 0, mohave: 0, countyHost: 0 };
    const r = await computePropertyFacts({
      site: SITE,
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: fetcher({ parcel: pimaParcel(), femaIn: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }, calls),
    });
    expect(calls.countyHost).toBe(0);
    expect(calls.mohave).toBe(0);
    expect(calls.pima).toHaveLength(1);
    expect(calls.pima[0]).toContain("outFields=PARCEL%2CSITE_ADDRESS%2CADR_STATUS%2CMAIL1");
    expect(calls.pimaCount).toBe(0); // a parcel was found; no follow-up count query
    expect(r.status).toBe("ok");
    expect(r.sourcesUsed).toEqual(["pima_assessor_gis", "fema_usa_structures"]);
    expect(r.countyChecked).toEqual(["pima_assessor_gis"]);
    const p = r.parcel!;
    expect(p.sourceId).toBe("pima_assessor_gis");
    expect(p.parcelId).toBe("10109005C");
    expect(p.relation).toBe("match");
    expect(p.owner).toBe("FAITH COMMUNITY CHURCH INC");
    expect(p.useCode).toBe("1040");
    expect(p.useLabel).toBe("Misc Commercial");
    expect(p.landAcres).toBeCloseTo(420_082 / 43_560, 6); // LANDUNIT F = square feet
    expect(p.fullCashValue).toBe(8_612_901);
    expect(p.landValue).toBeNull();
    expect(p.improvementValue).toBeNull();
    expect(p.taxYear).toBe(2026);
    expect(r.estimate?.sqft).toBe(21_000);
    const view = presentPropertyFacts(
      { sqft: 15_000, locationRevision: 1, address: SITE.address, buildingType: "office", attrSource: "user_entered", refinedFields: ["sqft"] },
      { siteId: 1, userId: 1, locationRevision: 1, status: r.status, facts: r, estimateSqft: r.estimate!.sqft, estimateBasis: r.estimate!.basis, appliedSqft: null, appliedBy: null, appliedAt: null, fetchedAt: r.fetchedAt } as never,
    );
    const rows = Object.fromEntries(view.rows.map((x) => [x.key, x]));
    expect(rows.parcel.value).toBe("10109005C · 9.64 acres");
    expect(rows.parcel.detail).toBe("Recorded address: 2551 W Orange Grove Rd");
    expect(rows.owner.value).toBe("Faith Community Church INC");
    expect(rows.use.detail).toBe("County use code 1040");
    expect(rows.value.value).toBe("$8.61M full cash value (tax year 2026)");
    expect(rows.value.detail).toMatch(/for analysis; it is not a market value/);
    expect(rows.value.detail).not.toMatch(/market-value estimate/);
    expect(view.rows.filter((x) => x.key !== "buildings" && x.key !== "type").every((x) => x.sourceId === "pima_assessor_gis")).toBe(true);
    expect(view.sources.map((s) => s.label)).toEqual(["Pima County Assessor parcel records", "USA Structures"]);
    // a typed floor area stays the site's value; the estimate is only offered
    expect(view.floorArea.siteSqft).toBe(15_000);
    expect(view.floorArea.state).toBe("your_value_differs");
  });

  it("uses the mapped area when the land unit is a site count, and keeps residential codes readable", async () => {
    const r = await computePropertyFacts({
      site: { ...SITE, address: "7846 W Sunstill St, Tucson, AZ 85743", buildingType: "single_family" },
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: fetcher({
        parcel: pimaParcel({ PARCEL: "226061200", SITE_ADDRESS: "7846 W SUNSTILL ST", PARCEL_USE: "0131", USE_DESC: "SFR GRADE 010-3 URBAN SUBDIVIDED            ", LANDMEAS: 1, LANDUNIT: "S", GISACRES: 0.11456831, FCV: 307610, MAIL1: "NA" }),
      }),
    });
    expect(r.parcel?.landAcres).toBeCloseTo(0.11456831, 8); // not "1 acre"
    expect(r.parcel?.useLabel).toBe("SFR Grade 010-3 Urban Subdivided");
    expect(r.parcel?.owner).toBeNull(); // un-audited parcels show "NA"
    expect(titleCase("ASSISTED LIVING FACILITY 1 STY")).toBe("Assisted Living Facility 1 Story");
    expect(titleCase("400 N 2ND AV")).toBe("400 N 2nd Av");
    expect(titleCase("101 W 1ST ST UNIT 12B")).toBe("101 W 1st St Unit 12B");
    // acres as published when the unit is A
    const a = await computePropertyFacts({ site: SITE, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ parcel: pimaParcel({ LANDMEAS: 9.5, LANDUNIT: "A" }) }) });
    expect(a.parcel?.landAcres).toBe(9.5);
    // a zero or missing value is not shown as $0
    const z = await computePropertyFacts({ site: SITE, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ parcel: pimaParcel({ FCV: 0 }) }) });
    expect(z.parcel?.fullCashValue).toBeNull();
  });

  it("treats a parcel the county lists with several addresses as shared, never as a wrong pin or a whole-parcel estimate", async () => {
    const multi = pimaParcel({ PARCEL: "10101633B", SITE_ADDRESS: "2275 W INA RD", ADR_STATUS: "MULTIPLE" });
    const fema = structures([
      { id: 1, sq: 30_000, addr: "2275 W INA RD" },
      { id: 2, sq: 50_000, addr: "2301 W INA RD" },
    ]);
    const other = await computePropertyFacts({ site: { ...SITE, address: "2301 W Ina Rd, Tucson, AZ" }, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ parcel: multi, femaIn: fema }) });
    expect(other.parcelMismatch).toBeNull();
    expect(other.parcel?.relation).toBe("multi");
    expect(other.parcel?.shared).toBe(true);
    expect(other.cautions.some((c) => /is shared by more than one address/.test(c))).toBe(true);
    expect(other.estimate?.basis).not.toBe("parcel_all_buildings");
    expect(other.estimate?.sqft).toBe(50_000); // only the building addressed to this site
    const listed = await computePropertyFacts({ site: { ...SITE, address: "2275 W Ina Rd, Tucson, AZ" }, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ parcel: multi, femaIn: fema }) });
    expect(listed.parcel?.relation).toBe("multi_includes");
    const view = presentPropertyFacts(
      { sqft: null, locationRevision: 1, address: "2275 W Ina Rd", buildingType: "office" },
      { siteId: 1, userId: 1, locationRevision: 1, status: listed.status, facts: listed, estimateSqft: listed.estimate?.sqft ?? null, estimateBasis: listed.estimate?.basis ?? null, appliedSqft: null, appliedBy: null, appliedAt: null, fetchedAt: listed.fetchedAt } as never,
    );
    expect(view.rows.find((x) => x.key === "parcel")?.detail).toBe("Recorded addresses include 2275 W Ina Rd (the county lists several on this parcel)");
    // a different street on a single-address parcel is still a wrong pin
    const wrong = await computePropertyFacts({ site: { ...SITE, address: "400 E Grant Rd, Tucson, AZ" }, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ parcel: pimaParcel() }) });
    expect(wrong.parcel).toBeNull();
    expect(wrong.parcelMismatch?.parcelId).toBe("10109005C");
  });

  it("tells a road inside Pima apart from a pin in a neighboring county", async () => {
    const calls: Calls = { pima: [], pimaCount: 0, mohave: 0, countyHost: 0 };
    const fema = structures([{ id: 1, sq: 8_000, addr: "2551 W ORANGE GROVE RD" }]);
    const road = await computePropertyFacts({ site: SITE, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ nearCount: 26, femaNear: fema }, calls) });
    expect(calls.pimaCount).toBe(1);
    expect(road.sourcesUsed).toContain("pima_assessor_gis");
    expect(road.status).toBe("partial");
    expect(road.cautions.some((c) => /may sit on a road or right-of-way/.test(c))).toBe(true);
    // Patagonia (Santa Cruz County) is inside Pima's bounding box but has no Pima parcel nearby
    const outside = await computePropertyFacts({
      site: { ...SITE, address: "100 Naugle Ave, Patagonia, AZ" },
      point: { lat: 31.5398, lng: -110.7562, source: "site_pin" },
      otherSites: [],
      fetcher: fetcher({ nearCount: 0, femaNear: structures([{ id: 9, sq: 3_000, addr: "100 NAUGLE AVE" }]) }),
    });
    expect(outside.sourcesUsed).toEqual(["fema_usa_structures"]);
    expect(outside.sourceErrors).toEqual([]);
    expect(outside.countyChecked).toEqual(["pima_assessor_gis"]);
    expect(outside.status).toBe("ok");
    expect(outside.cautions.some((c) => /road or right-of-way/.test(c))).toBe(false);
    expect(outside.estimate?.basis).toBe("address_matched_buildings");
  });

  it("stays useful when the Pima service is down and says which source failed", async () => {
    const r = await computePropertyFacts({
      site: SITE,
      point: { ...PIN, source: "site_pin" },
      otherSites: [],
      fetcher: fetcher({ failPima: true, femaNear: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }),
    });
    expect(r.status).toBe("partial");
    expect(r.sourceErrors).toEqual(["pima_assessor_gis"]);
    expect(r.parcel).toBeNull();
    expect(r.estimate?.sqft).toBe(21_000);
    const view = presentPropertyFacts(
      { sqft: null, locationRevision: 1, address: SITE.address, buildingType: "office" },
      { siteId: 1, userId: 1, locationRevision: 1, status: r.status, facts: r, estimateSqft: 21_000, estimateBasis: r.estimate!.basis, appliedSqft: null, appliedBy: null, appliedAt: null, fetchedAt: r.fetchedAt } as never,
    );
    expect(view.sourceErrors).toEqual(["Pima County Assessor parcel records"]);
  });
});

describe("refreshing facts saved before a county was added", () => {
  const legacy = (point: { lat: number; lng: number } | null, used: string[], errors: string[] = []) =>
    ({ point: point ? { ...point, source: "site_pin" } : null, sourcesUsed: used, sourceErrors: errors }) as unknown as PropertyFactsResult;
  it("refetches only sites a new county now covers", () => {
    expect(needsCountyCoverageRefresh(legacy(PIN, ["fema_usa_structures"]), "AZ")).toBe(true);
    expect(needsCountyCoverageRefresh(legacy(PIN, ["fema_usa_structures"]), null)).toBe(true);
    expect(needsCountyCoverageRefresh(legacy(PIN, ["pima_assessor_gis", "fema_usa_structures"]), "AZ")).toBe(false);
    expect(needsCountyCoverageRefresh(legacy(PIN, ["fema_usa_structures"], ["pima_assessor_gis"]), "AZ")).toBe(false);
    expect(needsCountyCoverageRefresh({ ...legacy(PIN, ["fema_usa_structures"]), countyChecked: ["pima_assessor_gis"] }, "AZ")).toBe(false);
    // Kingman (Mohave) facts already consulted Mohave; Kentucky has no county adapter
    expect(needsCountyCoverageRefresh(legacy({ lat: 35.2452, lng: -114.0094 }, ["mohave_assessor_gis", "fema_usa_structures"]), "AZ")).toBe(false);
    expect(needsCountyCoverageRefresh(legacy({ lat: 38.25, lng: -85.76 }, ["fema_usa_structures"]), "KY")).toBe(false);
    expect(needsCountyCoverageRefresh(legacy(PIN, ["fema_usa_structures"]), "NM")).toBe(false);
    expect(needsCountyCoverageRefresh(legacy(null, []), "AZ")).toBe(false);
    expect(needsCountyCoverageRefresh(null, "AZ")).toBe(false);
  });
});

/* ---------------- DB: a pre-PF-2 Tucson site picks up its parcel ---------------- */
const openId = `pf2-pima-test-${Date.now()}`;
const userIds: number[] = [];
const siteIds: number[] = [];
function ctxFor(id: number, oid: string): TrpcContext {
  return {
    user: { id, openId: oid, email: `${oid}@test.local`, name: oid, loginMethod: "test", role: "user", tier: "free", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {}, protocol: "http" },
    res: { cookie() {}, clearCookie() {} },
  } as unknown as TrpcContext;
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

describe("property facts lifecycle for a newly covered county (DB)", () => {
  it("refreshes a Tucson site's older FEMA-only facts with the Pima parcel, never touches a typed floor area, and leaves current Mohave facts alone", async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" });
    const [u] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    userIds.push(u!.id);
    const caller = appRouter.createCaller(ctxFor(u!.id, openId));
    setPropertyFactsFetcher(null);
    const { id: tucson } = await caller.sites.create({ name: "PF2 Tucson Office", address: "2551 W Orange Grove Rd", city: "Tucson", state: "AZ", zip: "85741", buildingType: "office", sqft: 15_000 });
    siteIds.push(tucson);
    const { id: kingman } = await caller.sites.create({ name: "PF2 Kingman School", address: "4182 N Bank St", city: "Kingman", state: "AZ", zip: "86409", buildingType: "school" });
    siteIds.push(kingman);
    await db.update(sites).set({ lat: PIN.lat, lng: PIN.lng }).where(eq(sites.id, tucson));
    await db.update(sites).set({ lat: 35.2452, lng: -114.0094 }).where(eq(sites.id, kingman));
    const [t] = await db.select().from(sites).where(eq(sites.id, tucson)).limit(1);
    const [k] = await db.select().from(sites).where(eq(sites.id, kingman)).limit(1);
    expect(t!.sqft).toBe(15_000);
    // Facts saved before PF-2: FEMA only (no county adapter covered Tucson then).
    const femaOnly = await computePropertyFacts({ site: t!, point: { ...PIN, source: "site_pin" }, otherSites: [], fetcher: fetcher({ failPima: true, femaNear: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }) });
    const oldTucson = { ...femaOnly, sourcesUsed: ["fema_usa_structures"], sourceErrors: [], cautions: [] } as Record<string, unknown>;
    delete oldTucson.countyChecked;
    const kFacts = await computePropertyFacts({ site: k!, point: { lat: 35.2452, lng: -114.0094, source: "site_pin" }, otherSites: [], fetcher: async (url) => (url.includes("USA_Structures") ? { features: [] } : { features: [] }) });
    const oldKingman = { ...kFacts } as Record<string, unknown>;
    delete oldKingman.countyChecked;
    const now = Date.now();
    for (const [siteId, rev, facts] of [[tucson, t!.locationRevision, oldTucson], [kingman, k!.locationRevision, oldKingman]] as const) {
      await db.insert(sitePropertyFacts).values({ siteId, userId: u!.id, locationRevision: rev, status: (facts as { status: string }).status as never, facts, estimateSqft: null, estimateBasis: null, appliedSqft: null, appliedBy: null, appliedAt: null, fetchedAt: now });
    }
    const calls: Calls = { pima: [], pimaCount: 0, mohave: 0, countyHost: 0 };
    setPropertyFactsFetcher(fetcher({ parcel: pimaParcel(), femaIn: structures([{ id: 1, sq: 21_000, addr: "2551 W ORANGE GROVE RD" }]) }, calls));
    const view = await caller.sites.propertyFacts({ siteId: tucson });
    expect(calls.pima).toHaveLength(1);
    expect(view.rows.find((r) => r.key === "parcel")?.value).toBe("10109005C · 9.64 acres");
    expect(view.sources.map((s) => s.id)).toEqual(["pima_assessor_gis", "fema_usa_structures"]);
    expect(view.floorArea.siteSqft).toBe(15_000);
    expect((await caller.sites.get({ siteId: tucson })).sqft).toBe(15_000);
    const [stored] = await db.select().from(sitePropertyFacts).where(eq(sitePropertyFacts.siteId, tucson)).limit(1);
    expect((stored!.facts as PropertyFactsResult).countyChecked).toEqual(["pima_assessor_gis"]);
    // second view is served from the saved facts (no new county call)
    await caller.sites.propertyFacts({ siteId: tucson });
    expect(calls.pima).toHaveLength(1);
    // Kingman facts already consulted Mohave → not refetched
    await caller.sites.propertyFacts({ siteId: kingman });
    expect(calls.mohave).toBe(0);
    expect(calls.countyHost).toBe(0);
  }, 30_000);
});
