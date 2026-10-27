import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import type { TrpcContext } from "./_core/context";
import { billingAccounts, entities, importBatches, importBatchFiles, importBatchSheets, importSiteGroups, intervals, meters, sites, uploads, users } from "../drizzle/schema";
const store=vi.hoisted(()=>({dir:"",url:""}));
vi.mock("./storage",()=>({
 storagePut:vi.fn(async(key:string,data:Buffer)=>{const {writeFileSync}=await import("node:fs");const name=key.split("/").pop()!;writeFileSync(`${store.dir}/${name}`,data);return {key:name,url:`${store.url}/${name}`};}),
 storageGetSignedUrl:vi.fn(async(key:string)=>`${store.url}/${key}`),
}));
vi.mock("./places",async original=>({...await original<typeof import("./places")>(),geocodeAddress:vi.fn(async()=>({kind:"not_precise",reason:"offline fixture"}))}));
const paths=["/home/ubuntu/upload/1026KUSD-IntervalDataRequestPLL10202026firsthalf(3).xlsx","/home/ubuntu/upload/1026KUSD-IntervalDataRequestPLL10202026secondhalf.xlsx"];
const openId=`fe-real-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
let userId:number|undefined,server:Server;
let caller:ReturnType<typeof appRouter.createCaller>;
// A run that is killed mid-test (e.g. a superseded full-suite run) never
// reaches afterAll, so each run first purges this test's own fixture accounts
// left by earlier runs. Only rows whose openId AND email carry this fixture's
// markers, and that are over 3 hours old (no concurrent run lasts that long).
async function purgeFixture(id:number){const d=(await getDb())!;for(const site of await h.listSites(id))await h.deleteSite(site.id,id);
 for(const table of [importBatchSheets,importBatchFiles,importBatches,importSiteGroups,uploads,entities,billingAccounts])await d.delete(table).where(eq(table.userId,id));
 await d.delete(users).where(eq(users.id,id));}
async function purgeStaleFixtures(){const d=(await getDb())!;
 const stale=await d.select({id:users.id}).from(users).where(and(like(users.openId,"fe-real-%"),like(users.email,"%@fe-fixture.invalid"),lt(users.createdAt,new Date(Date.now()-3*3600_000))));
 for(const u of stale)await purgeFixture(u.id);}
beforeAll(async()=>{
 if(!paths.every(existsSync))return;
 await purgeStaleFixtures();
 store.dir=mkdtempSync(path.join(tmpdir(),"meterly-fe-"));
 server=createServer((req,res)=>{const filename=path.basename(req.url??"");const file=path.join(store.dir,filename);if(!existsSync(file)){res.writeHead(404).end();return;}res.writeHead(200,{"Content-Type":"application/octet-stream"});createReadStream(file).pipe(res);});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));store.url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const d=(await getDb())!;const [r]=await d.insert(users).values({openId,name:"Isolated FE real workbook fixture",email:`${openId}@fe-fixture.invalid`,tier:"pro"});userId=Number(r.insertId);
 await d.insert(billingAccounts).values({userId,plan:"founding",entitlementTier:"pro",status:"active"});
 caller=appRouter.createCaller({user:{id:userId,openId,role:"user",tier:"pro",name:openId,email:`${openId}@fe-fixture.invalid`,loginMethod:"test",createdAt:new Date(),updatedAt:new Date(),lastSignedIn:new Date()},req:{headers:{},protocol:"http"},res:{cookie(){},clearCookie(){}}} as unknown as TrpcContext);
},300_000);
afterAll(async()=>{
 if(userId)await purgeFixture(userId);
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(store.dir)rmSync(store.dir,{recursive:true,force:true});
},120_000);
async function stageBoth(){let batchId:number|undefined;for(const file of paths){const r=await caller.bulkImport.stageFile({batchId,filename:path.basename(file),contentBase64:readFileSync(file).toString("base64")});batchId=r.batchId;}return batchId!;}
async function drain(batchId:number){const deadline=Date.now()+1_200_000;let last=-1,lastState="";
 while(Date.now()<deadline){const s=await caller.bulkImport.status({batchId});
  // TEST-2: log every state change (running / paused / stalled) so a stall under load is diagnosable.
  const state=s.running?"running":s.paused?"paused":s.stalled?"stalled":s.batch.status;
  if(s.batch.summary?.sheetsDone!==last||state!==lastState){last=s.batch.summary?.sheetsDone??0;lastState=state;console.log(`Real workbook batch ${batchId}: ${last}/38 sheets; ${s.batch.summary?.phase??s.batch.status}; ${state}${s.batch.error?`; error ${s.batch.error.slice(0,200)}`:""}`);}
  if(!s.running&&s.batch.status!=="committing")return s;
  // Same rule as the Upload page (BulkImportPanel): a paused slice, or a stalled one whose lease
  // expired with no worker, is driven again. The lease protocol prevents double work.
  if(s.paused||s.stalled){await caller.bulkImport.commit({batchId,planVersion:s.batch.planVersion});continue;}
  await new Promise(r=>setTimeout(r,1000));}
 throw new Error("Real workbook commit timed out");}
describe.skipIf(!paths.every(existsSync))("real KUSD end-to-end bulk proof",()=>{
 it("stages both real files, previews 38→18/37, fences concurrent commit, preserves Phoenix interval-end placement and re-imports idempotently",async()=>{
  const d=(await getDb())!,batchId=await stageBoth();
  const building=await caller.bulkImport.preview({batchId,groupingMode:"building",timeZone:"America/Phoenix",timestampBasis:"end"});expect(building.totals).toMatchObject({files:2,sheets:38,sites:37});
  const campus=await caller.bulkImport.preview({batchId,planVersion:building.planVersion,groupingMode:"campus",timeZone:"America/Phoenix",timestampBasis:"end"});expect(campus.totals).toMatchObject({files:2,sheets:38,sites:18,meters:38});
  const launches=await Promise.allSettled([0,1].map(()=>caller.bulkImport.commit({batchId,planVersion:campus.planVersion,clockConfirmed:true,runAnalysis:false,buildingType:"school",entityName:"FE fixture district"})));
  expect(launches.filter(r=>r.status==="fulfilled"&&r.value.started)).toHaveLength(1);
  const done=await drain(batchId);console.log("Real workbook first result",done.batch.status,done.batch.error,done.sheets.filter(s=>s.status==="failed").map(s=>s.detail));
  expect(done.batch.status).toBe("complete");expect(done.batch.summary).toMatchObject({sheetsDone:38,sheetsTotal:38,sheetsFailed:0,sitesCreated:18,metersCreated:38});
  expect(await h.listSites(userId!)).toHaveLength(18);
  const ms=await d.select().from(meters).where(and(eq(meters.userId,userId!),eq(meters.meterRole,"main")));expect(ms).toHaveLength(38);expect(new Set(ms.map(m=>m.importIdentity)).size).toBe(38);expect(ms.every(m=>m.timezone==="America/Phoenix"&&m.timestampBasis==="end")).toBe(true);
  const manifest=JSON.parse(readFileSync("/home/ubuntu/work/school_portfolio_manifest_2026-10-24.json","utf8"));expect(ms.map(m=>m.servicePoint).sort()).toEqual(manifest.sheets.map((s:{servicePointId:string})=>s.servicePointId).sort());
  const ids=ms.map(m=>m.id);const [count]=await d.select({n:sql<number>`COUNT(*)`,min:sql<number>`MIN(ts)`,max:sql<number>`MAX(ts)`}).from(intervals).where(inArray(intervals.meterId,ids));
  expect(Number(count.n)).toBe(1_331_520);expect(Number(count.min)).toBe(Date.parse("2025-10-01T07:00:00Z"));expect(Number(count.max)).toBe(Date.parse("2026-10-01T06:45:00Z"));
  const monthly=await d.execute(sql`SELECT COUNT(DISTINCT DATE_FORMAT(FROM_UNIXTIME((ts-25200000)/1000),'%Y-%m')) AS n FROM intervals WHERE meterId=${ids[0]}`);expect(Number((monthly as unknown as [Array<{n:number}>])[0][0].n)).toBe(12);
  const retry=await stageBoth(),rp=await caller.bulkImport.preview({batchId:retry,groupingMode:"campus",timeZone:"America/Phoenix",timestampBasis:"end"});expect(rp.totals).toMatchObject({newSites:0,reusedMeters:38});
  await caller.bulkImport.commit({batchId:retry,planVersion:rp.planVersion,clockConfirmed:true,runAnalysis:false});
  const again=await drain(retry);expect(again.batch.status).toBe("complete");expect(again.batch.summary).toMatchObject({sheetsDuplicate:38,metersCreated:0,pointsWritten:0,sheetsFailed:0});
  expect((await d.select({id:meters.id}).from(meters).where(and(eq(meters.userId,userId!),eq(meters.meterRole,"main")))).map(m=>m.id).sort()).toEqual(ids.sort());
  const [unchanged]=await d.select({n:sql<number>`COUNT(*)`}).from(intervals).where(inArray(intervals.meterId,ids));expect(Number(unchanged.n)).toBe(1_331_520);
  writeFileSync("/home/ubuntu/work/fixes/FE_real_proof.json",JSON.stringify({fixtureUser:userId,firstBatch:batchId,reimportBatch:retry,sites:18,buildingPreviewSites:37,mainMeters:38,intervals:Number(count.n),firstUtc:new Date(Number(count.min)).toISOString(),lastUtc:new Date(Number(count.max)).toISOString(),localMonths:12,concurrentLaunches:1,reimport:again.batch.summary,first:done.batch.summary},null,2));
 },1_800_000);
});
