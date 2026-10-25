import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import * as geo from "./geometry";
import * as places from "./places";
import * as h from "./dbHelpers";
import { registerGeometryCacheDb } from "./geometryCacheDb";
import { analyses, auditLog, geometryResolveCache, insights, siteGeometry, sites, users } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
const ring: [number,number][] = [[-114.051,35.199],[-114.049,35.199],[-114.049,35.201],[-114.051,35.201]];
const empty: geo.ResolvedFootprints = { candidates: [], provider: "none", osmFailed: false, esriFailed: false, cached: false };
const precise: places.AddressGeocode = { kind: "precise", lat: 35.2, lng: -114.05, formattedAddress: "500 Maple St, Kingman, AZ 86401", city: "Kingman", state: "AZ", zip: "86401" };
const owned: { userId: number; siteId: number }[] = [];
function ctx(user: typeof users.$inferSelect) { return { user, req: { protocol: "https", headers: {} }, res: { cookie() {}, clearCookie() {} } } as unknown as TrpcContext; }
async function fixture(extra: Partial<typeof sites.$inferInsert> = {}) {
  const db = (await getDb())!; const openId = `fa-${Date.now()}-${Math.random()}`;
  const inserted = await db.insert(users).values({ openId, name: openId, email: `${openId}@fa.invalid`, tier: "pro" });
  const userId = Number(inserted[0].insertId); const [user] = await db.select().from(users).where(eq(users.id,userId));
  const siteId = await h.createSite({ userId, name: "FA fixture", address: "Old address", city: "Kingman", state: "AZ", zip: "86401", lat: 35.1, lng: -114.1, ...extra });
  owned.push({ userId, siteId }); return { user, siteId, caller: appRouter.createCaller(ctx(user)), db };
}
function deferred<T>() { let resolve!: (v:T)=>void; const promise = new Promise<T>((r)=> { resolve=r; }); return { resolve,promise }; }
afterEach(async () => {
  vi.restoreAllMocks(); geo.setPersistentResolveCache(null); geo._clearResolveCache();
  const db = (await getDb())!;
  for (const {userId,siteId} of owned.splice(0)) {
    for (const table of [siteGeometry, insights, analyses] as const) await db.delete(table).where(eq(table.siteId,siteId));
    await db.delete(sites).where(eq(sites.id,siteId)); await db.delete(auditLog).where(eq(auditLog.userId,userId)); await db.delete(users).where(eq(users.id,userId));
  }
});

describe("R1/R3 location integrity", () => {
  it.each(["failure", "zero", "clear", "whitespace", "city", "state", "zip"])("invalidates prior coordinates and geometry on %s edit", async (mode) => {
    const { caller,siteId,db } = await fixture();
    await caller.sites.geometryConfirm({ siteId,ring,source:"user_drawn",stories:2 });
    await db.insert(analyses).values({ siteId,userId:owned[0].userId,status:"complete" });
    vi.spyOn(places,"geocodeAddress").mockImplementation(async () => { if(mode==="failure") throw new Error("offline"); return {kind:"not_precise"}; });
    const patch = mode==="clear" ? {address:null} : mode==="whitespace" ? {address:"  "} : mode==="city" ? {city:"Dolan Springs"} : mode==="state" ? {state:"NV"} : mode==="zip" ? {zip:"86409"} : {address:"Bad address"};
    await caller.sites.update({siteId,...patch});
    const site = await caller.sites.get({siteId}); expect(site.lat).toBeNull(); expect(site.lng).toBeNull(); expect(site.locationRevision).toBe(1);
    expect(await caller.sites.geometryGet({siteId})).toBeNull();
    const [raw] = await db.select().from(siteGeometry).where(eq(siteGeometry.siteId,siteId)); expect(raw.footprintSource).toBe("user_drawn"); expect(raw.footprint).toEqual({type:"Polygon",coordinates:[ring]});
    const [analysis] = await db.select().from(analyses).where(eq(analyses.siteId,siteId)); expect(analysis.status).toBe("failed"); expect(analysis.error).toMatch(/stale/);
    expect((await db.select().from(insights).where(eq(insights.siteId,siteId)))[0].kind).toBe("location_changed");
  });
  it.each(["provided", "owned", "refined"])("preserves %s user utility when the address cascade runs", async (mode) => {
    const {caller,siteId} = await fixture({utilityName:"User Utility",attrSource:mode==="refined"?"quick_start_defaults":"user_entered",refinedFields: mode==="refined"?["utilityName"]:null});
    vi.spyOn(places,"geocodeAddress").mockResolvedValue(precise);
    await caller.sites.update({siteId,address:"500 Maple St, Kingman, AZ 86401", ...(mode==="provided"?{utilityName:"User Utility"}:{})});
    const site=await caller.sites.get({siteId}); expect(site.utilityName).toBe("User Utility"); expect(site.lat).toBe(35.2);
  });
  it("does not constrain a deliberate relocation to the old state", async () => {
    const {caller,siteId} = await fixture({state:"MA",city:"Springfield",zip:"01109"});
    const geocode=vi.spyOn(places,"geocodeAddress").mockResolvedValue(precise);
    await caller.sites.update({siteId,address:"500 Maple St, Kingman, AZ 86401"});
    expect(geocode.mock.calls[0][1]).toEqual({city:"Kingman",state:"AZ",zip:"86401"});
  });
  it("does not allow an in-flight geocode to overwrite a new address and point", async () => {
    const {caller,siteId,db} = await fixture({lat:null,lng:null});
    const started=deferred<void>(), pending=deferred<places.AddressGeocode>();
    vi.spyOn(places,"geocodeAddress").mockImplementationOnce(()=>{started.resolve();return pending.promise;}).mockResolvedValue(precise);
    const old=caller.sites.geometryResolve({siteId}); const result=expect(old).rejects.toMatchObject({code:"CONFLICT"}); await started.promise;
    await caller.sites.update({siteId,address:"500 Maple St, Kingman, AZ 86401"}); pending.resolve({...precise,lat:42,lng:-72}); await result;
    const [saved]=await db.select().from(sites).where(eq(sites.id,siteId)); expect(saved.lat).toBe(35.2); expect(saved.address).toContain("500 Maple");
  });
  it("two same-site geocodes allow only the first snapshot write", async () => {
    const {caller,siteId}=await fixture({lat:null,lng:null}); const a=deferred<places.AddressGeocode>(),b=deferred<places.AddressGeocode>(),started=deferred<void>(); let calls=0;
    vi.spyOn(geo,"resolveFootprints").mockResolvedValue(empty);
    vi.spyOn(places,"geocodeAddress").mockImplementation(()=>{calls++; if(calls===2)started.resolve(); return calls===1?a.promise:b.promise;});
    const first=caller.sites.geometryResolve({siteId}), second=caller.sites.geometryResolve({siteId}); const rejected=expect(first).rejects.toMatchObject({code:"CONFLICT"}); await started.promise;
    b.resolve(precise); await second; a.resolve({...precise,lat:42}); await rejected; expect((await caller.sites.get({siteId})).lat).toBe(35.2);
  });
  it("rejects candidates when location changes during the footprint provider call", async () => {
    const {caller,siteId}=await fixture(); const done=deferred<geo.ResolvedFootprints>(),started=deferred<void>();
    vi.spyOn(geo,"resolveFootprints").mockImplementation(()=>{started.resolve();return done.promise;});
    const pending=caller.sites.geometryResolve({siteId}); const reject=expect(pending).rejects.toMatchObject({code:"CONFLICT"}); await started.promise;
    await caller.sites.update({siteId,address:null}); done.resolve(empty); await reject;
  });
  it("discloses provider errors distinctly from healthy empty coverage", async () => {
    const {caller,siteId}=await fixture(); vi.spyOn(geo,"resolveFootprints").mockResolvedValue({...empty,esriFailedLayers:["usa_structures"]});
    const r=await caller.sites.geometryResolve({siteId}); expect(r.outcome).toBe("provider_error"); expect(r.fallback).not.toBeNull(); expect(r.note).toMatch(/incomplete/);
  });
  it("returns an explicit missing-address outcome", async () => {
    const {caller,siteId}=await fixture({address:null,lat:null,lng:null});
    const r=await caller.sites.geometryResolve({siteId}); expect(r.outcome).toBe("missing_coordinates"); expect(r.fallback).toBeNull();
  });
});

describe("R1 transactional confirmation", () => {
  it("serializes simultaneous first confirmations with user-drawn precedence", async () => {
    const {caller,siteId,db}=await fixture();
    const results=await Promise.allSettled([caller.sites.geometryConfirm({siteId,ring,source:"user_drawn"}),caller.sites.geometryConfirm({siteId,ring,source:"osm"})]);
    expect(results[0].status).toBe("fulfilled");
    const rows=await db.select().from(siteGeometry).where(eq(siteGeometry.siteId,siteId)); expect(rows).toHaveLength(1); expect(rows[0].footprintSource).toBe("user_drawn");
  });
  it("clears source and stories when replacing mapped/drawn geometry with prism", async () => {
    const {caller,siteId}=await fixture();
    for(const source of ["osm","user_drawn"] as const) {
      await caller.sites.geometryConfirm({siteId,ring,source,stories:3});
      await caller.sites.geometryConfirm({siteId,ring,source:"prism",force:true});
      expect(await caller.sites.geometryGet({siteId})).toMatchObject({footprintSource:null,stories:null});
    }
  });
  it("rejects an old confirmation revision after a location edit", async () => {
    const {caller,siteId}=await fixture(); await caller.sites.update({siteId,address:null});
    await expect(caller.sites.geometryConfirm({siteId,ring,source:"osm",locationRevision:0})).rejects.toMatchObject({code:"CONFLICT"});
    await caller.sites.geometryConfirm({siteId,ring,source:"user_drawn",locationRevision:1});
    expect(await caller.sites.geometryGet({siteId})).toMatchObject({locationRevision:1});
  });
  it("conditional durable upsert cannot regress a newer request on deployed MySQL/TiDB", async () => {
    const db=(await getDb())!; const point={lat:1.2345,lng:2.3456},key="1.2345,2.3456";
    const candidate:geo.FootprintCandidate={ring,areaSqft:100,heightM:null,stories:null,source:"osm",distanceM:0,osmId:"newer"};
    await db.insert(geometryResolveCache).values({gridKey:key,provider:"osm",candidates:[candidate],resolvedAt:Date.now()+60000}).onDuplicateKeyUpdate({set:{candidates:[candidate],resolvedAt:Date.now()+60000}});
    try { registerGeometryCacheDb(); await geo.resolveFootprints(point,{skipCache:true,osmFetcher:async()=>({elements:[{type:"way",id:111,geometry:ring.map(([lon,lat])=>({lon,lat}))}]}),esriFetcher:async()=>({features:[]})});
      await new Promise(r=>setTimeout(r,100)); const [row]=await db.select().from(geometryResolveCache).where(eq(geometryResolveCache.gridKey,key)); expect((row.candidates as any[])[0].osmId).toBe("newer");
    } finally {await db.delete(geometryResolveCache).where(eq(geometryResolveCache.gridKey,key));}
  });
});
