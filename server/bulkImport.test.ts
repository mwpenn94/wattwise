import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import {
  billingAccounts,
  importBatchFiles,
  importBatches,
  importBatchSheets,
  importSiteGroups,
  entities,
  intervals,
  meters,
  tariffs,
  uploads,
  users,
} from "../drizzle/schema";

vi.mock("./places", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./places")>()),
  geocodeAddress: vi.fn(async (address: string) => ({
    kind: "precise" as const,
    lat: 35.1894,
    lng: -114.053,
    formattedAddress: `${address}, AZ, USA`,
    city: "Kingman",
    state: "AZ",
    zip: "86401",
  })),
}));

const sources = vi.hoisted(()=>new Map<string,Buffer>());
vi.mock("./storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storagePut: vi.fn(async (key: string, data: Buffer) => { sources.set(key, data); return { key, url: `/manus-storage/${key}` }; }),
  storageGetSignedUrl: vi.fn(async (key: string) => `data:application/octet-stream;base64,${sources.get(key)!.toString("base64")}`),
}));

const openId = `bulk-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId: number | null = null;

function ctxFor(user: { id: number; openId: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@fe-fixture.invalid`,
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

interface SyntheticSheet {
  name: string;
  account: string;
  agreement: string;
  servicePoint: string;
  rateCode: "EGSGS" | "EGMGS" | "EGMGSQ";
  address: string;
}

function rowsFor(sheet: SyntheticSheet): unknown[][] {
  const rows: unknown[][] = [
    ["ACCT NUMBER", "", "", sheet.account],
    ["SERVICE AGREEMENT ID", "", "", sheet.agreement],
    ["SERVICE POINT ID", "", "", sheet.servicePoint],
    ["RATE SCHEDULE", "", "", sheet.rateCode],
    ["Address", "", "", sheet.address],
    ["", "DATE", "TIME", "KWH_DEL", "KW"],
  ];
  for (const date of [20261020, 20261021, 20261022]) {
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      rows.push(["", date, `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, 1.25, 5]);
    }
  }
  return rows;
}

function workbookBase64(sheets: SyntheticSheet[]): string {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rowsFor(sheet)), sheet.name);
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

const firstWorkbook = workbookBase64([
  { name: "Campus Unit A", account: "ACCT-1", agreement: "SA-1", servicePoint: "SP-1", rateCode: "EGSGS", address: "100 Test Ave, Unit A, Kingman" },
  { name: "Other Campus", account: "ACCT-3", agreement: "SA-3", servicePoint: "SP-3", rateCode: "EGMGSQ", address: "200 Other Rd, Kingman" },
]);
const secondWorkbook = workbookBase64([
  { name: "Campus Unit B", account: "ACCT-2", agreement: "SA-2", servicePoint: "SP-2", rateCode: "EGMGS", address: "100 Test Ave, Unit B, Kingman" },
]);

async function waitForCommit(caller: ReturnType<typeof appRouter.createCaller>, batchId: number) {
  const deadline = Date.now() + 60_000;
  let latest = await caller.bulkImport.status({ batchId });
  while (Date.now() < deadline) {
    latest = await caller.bulkImport.status({ batchId });
    if (!latest.running && latest.batch.status !== "committing") return latest;
    // Commits run in request-sized slices; continue a paused slice exactly as
    // the browser's drive loop does (same plan version, stored options).
    if (latest.paused) { await caller.bulkImport.commit({ batchId, planVersion: latest.batch.planVersion }); continue; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for bulk import ${batchId}: ${latest.batch.status}; ${latest.batch.error ?? "no error"}`);
}

beforeAll(async () => {
  const db = (await getDb())!;
  await db.insert(users).values({ openId, name: openId, email: `${openId}@fe-fixture.invalid`, loginMethod: "test", tier: "pro" });
  const [user] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  userId = user!.id;
  await db.insert(billingAccounts).values({ userId: userId!, plan: "founding", entitlementTier: "pro", status: "active" });
});

afterAll(async () => {
  const db = await getDb();
  if (!db || userId == null) return;
  const ownedSites = await h.listSites(userId);
  for (const site of ownedSites) await h.deleteSite(site.id, userId);
  const batchRows = await db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.userId, userId));
  const batchIds = batchRows.map((batch) => batch.id);
  if (batchIds.length > 0) {
    await db.delete(importBatchSheets).where(inArray(importBatchSheets.batchId, batchIds));
    await db.delete(importBatchFiles).where(inArray(importBatchFiles.batchId, batchIds));
    await db.delete(importBatches).where(inArray(importBatches.id, batchIds));
  }
  await db.delete(importSiteGroups).where(eq(importSiteGroups.userId,userId));
  await db.delete(entities).where(eq(entities.userId,userId));
  await db.delete(uploads).where(eq(uploads.userId, userId));
  await db.delete(billingAccounts).where(eq(billingAccounts.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("bulkImport router lifecycle", () => {
  it("groups two workbooks by campus, assigns tariffs, materializes a total, and re-imports idempotently", async () => {
    expect(userId).not.toBeNull();
    const caller = appRouter.createCaller(ctxFor({ id: userId!, openId }));

    const stagedFirst = await caller.bulkImport.stageFile({ filename: "first.xlsx", contentBase64: firstWorkbook });
    const stagedSecond = await caller.bulkImport.stageFile({ batchId: stagedFirst.batchId, filename: "second.xlsx", contentBase64: secondWorkbook });
    expect(stagedFirst).toMatchObject({ duplicate: false, sheets: 2 });
    expect(stagedSecond).toMatchObject({ duplicate: false, sheets: 1 });

    const preview = await caller.bulkImport.preview({ batchId: stagedFirst.batchId, groupingMode: "campus", stateHint: "AZ" });
    expect(preview.totals).toMatchObject({ files: 2, sheets: 3, sites: 2, newSites: 2, meters: 3, tariffMatched: 3 });
    expect(preview.sites.find((site) => site.meters.length === 2)?.meters.map((meter) => meter.rateScheduleCode).sort()).toEqual(["EGMGS", "EGSGS"]);
    expect(Object.fromEntries(preview.sites.flatMap((site) => site.meters).map((meter) => [meter.rateScheduleCode, meter.tariff?.urdbId]))).toEqual({
      EGSGS: "uns-egsgs",
      EGMGS: "uns-egmgs",
      EGMGSQ: "uns-egmgs",
    });

    const started = await caller.bulkImport.commit({ batchId: stagedFirst.batchId, planVersion: preview.planVersion, clockConfirmed: true, runAnalysis: false });
    expect(started.started).toBe(true);
    const completed = await waitForCommit(caller, stagedFirst.batchId);
    expect(completed.batch.status).toBe("complete");
    expect(completed.sheets).toHaveLength(3);
    expect(completed.sheets.every((sheet) => sheet.status === "imported")).toBe(true);

    const db = (await getDb())!;
    const tariffRows = await db.select({ id: tariffs.id, urdbId: tariffs.urdbId }).from(tariffs).where(inArray(tariffs.urdbId, ["uns-egsgs", "uns-egmgs"]));
    const tariffId = new Map(tariffRows.map((tariff) => [tariff.urdbId, tariff.id]));
    const siteRows = await h.listSites(userId!);
    const meterRows = await db.select().from(meters).where(eq(meters.userId, userId!));
    const mainMeters = meterRows.filter((meter) => meter.meterRole === "main");
    const virtual = meterRows.find((meter) => meter.meterRole === "virtual_total");
    expect(siteRows).toHaveLength(2);
    expect(mainMeters).toHaveLength(3);
    expect(mainMeters.map((meter) => meter.servicePoint).sort()).toEqual(["SP-1", "SP-2", "SP-3"]);
    expect(mainMeters.map((meter) => meter.rateScheduleCode).sort()).toEqual(["EGMGS", "EGMGSQ", "EGSGS"]);
    expect(mainMeters.map((meter) => meter.facilityLabel).sort()).toEqual(["Service point SP-3", "Unit A", "Unit B"]);
    expect(mainMeters.find((meter) => meter.servicePoint === "SP-1")?.currentTariffId).toBe(tariffId.get("uns-egsgs"));
    expect(mainMeters.find((meter) => meter.servicePoint === "SP-2")?.currentTariffId).toBe(tariffId.get("uns-egmgs"));
    expect(mainMeters.find((meter) => meter.servicePoint === "SP-3")?.currentTariffId).toBe(tariffId.get("uns-egmgs"));
    expect(virtual).toBeTruthy();

    const twoMeterSite = siteRows.find((site) => mainMeters.filter((meter) => meter.siteId === site.id).length === 2)!;
    expect(virtual?.siteId).toBe(twoMeterSite.id);
    const mainIds = mainMeters.map((meter) => meter.id);
    const [mainPointCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(intervals).where(inArray(intervals.meterId, mainIds));
    const [virtualPointCount] = await db.select({ count: sql<number>`COUNT(*)` }).from(intervals).where(eq(intervals.meterId, virtual!.id));
    expect(Number(mainPointCount!.count)).toBe(864);
    expect(Number(virtualPointCount!.count)).toBe(288);

    const retryFirst = await caller.bulkImport.stageFile({ filename: "first-again.xlsx", contentBase64: firstWorkbook });
    await caller.bulkImport.stageFile({ batchId: retryFirst.batchId, filename: "second-again.xlsx", contentBase64: secondWorkbook });
    const retryPreview = await caller.bulkImport.preview({ batchId: retryFirst.batchId, groupingMode: "campus", stateHint: "AZ" });
    expect(retryPreview.totals).toMatchObject({ newSites: 0, reusedMeters: 3 });

    await caller.bulkImport.commit({ batchId: retryFirst.batchId, planVersion: retryPreview.planVersion, clockConfirmed: true, runAnalysis: false });
    const retryCompleted = await waitForCommit(caller, retryFirst.batchId);
    expect(retryCompleted.batch.status).toBe("complete");
    expect(retryCompleted.batch.summary).toMatchObject({ metersCreated: 0, pointsWritten: 0, sheetsDuplicate: 3 });
    expect(retryCompleted.sheets.every((sheet) => sheet.status === "duplicate" || sheet.pointsWritten === 0)).toBe(true);
  }, 70_000);
});

// Every fixture is owned by this suite, using a non-global-cleanup address so
// concurrent streams cannot remove it. afterAll explicitly removes all rows.
import * as storage from "./storage";
import * as writer from "./ingest/writer";
import * as bulk from "./bulkImport";
import * as virtualTotal from "./virtualTotal";
import * as pipeline from "./analytics/pipeline";
const sample=(tag:string,patch:Partial<SyntheticSheet>={}):SyntheticSheet=>({name:tag.slice(0,31),account:`AC-${tag}`,agreement:`SA-${tag}`,servicePoint:`SP-${tag}`,rateCode:"EGSGS",address:`300 ${tag} Ave, Kingman, AZ`,...patch});
const callerFor=()=>appRouter.createCaller(ctxFor({id:userId!,openId}));
async function prepared(sheets:SyntheticSheet[],mode:"campus"|"building"="campus") {
  const caller=callerFor();
  const staged=await caller.bulkImport.stageFile({filename:`${sheets[0].name}.xlsx`,contentBase64:workbookBase64(sheets)});
  const preview=await caller.bulkImport.preview({batchId:staged.batchId,groupingMode:mode,timeZone:"America/Phoenix",timestampBasis:"start"});
  return {caller,staged,preview};
}
const start=(fx:Awaited<ReturnType<typeof prepared>>)=>fx.caller.bulkImport.commit({batchId:fx.staged.batchId,planVersion:fx.preview.planVersion,clockConfirmed:true,runAnalysis:false});
describe("bulk hardening",()=>{
  it("stores the file's raw-byte SHA-256 and deduplicates alternate base64 whitespace",async()=>{
    const caller=callerFor(),content=workbookBase64([sample("raw-hash")]);
    const staged=await caller.bulkImport.stageFile({filename:"hash.xlsx",contentBase64:content});
    const d=(await getDb())!;
    try {
      const [file]=await d.select().from(importBatchFiles).where(eq(importBatchFiles.id,staged.fileId));
      expect(file.sha256).toBe(createHash("sha256").update(Buffer.from(content,"base64")).digest("hex"));
      const duplicate=await caller.bulkImport.stageFile({batchId:staged.batchId,filename:"renamed.xlsx",contentBase64:content.replace(/.{80}/g,"$&\n")});
      expect(duplicate).toMatchObject({duplicate:true,fileId:staged.fileId});
      expect(await d.select().from(importBatchFiles).where(eq(importBatchFiles.batchId,staged.batchId))).toHaveLength(1);
      await d.update(importBatchFiles).set({sha256:createHash("sha256").update(content).digest("hex")}).where(eq(importBatchFiles.id,staged.fileId));
      const legacyDuplicate=await caller.bulkImport.stageFile({batchId:staged.batchId,filename:"legacy.xlsx",contentBase64:content});
      expect(legacyDuplicate).toMatchObject({duplicate:true,fileId:staged.fileId});
      const [repaired]=await d.select().from(importBatchFiles).where(eq(importBatchFiles.id,staged.fileId));
      expect(repaired.sha256).toBe(createHash("sha256").update(Buffer.from(content,"base64")).digest("hex"));
    }finally{
      await caller.bulkImport.removeFile({batchId:staged.batchId,fileId:staged.fileId});
      await d.delete(importBatches).where(eq(importBatches.id,staged.batchId));
    }
  }, 30_000);
  it("retries failed totals and analysis independently, clears stale detail, and preserves imported checkpoints",async()=>{
    const fx=await prepared([sample("post-a",{address:"900 Retry Ave, Unit A, Kingman, AZ"}),sample("post-b",{address:"900 Retry Ave, Unit B, Kingman, AZ"})]);
    const totalSpy=vi.spyOn(virtualTotal,"materializeVirtualTotal").mockRejectedValueOnce(new Error("temporary total failure"));
    const analysisSpy=vi.spyOn(pipeline,"runAnalysisPipeline").mockRejectedValueOnce(new Error("temporary analysis failure")).mockResolvedValue(undefined as never);
    const retry=()=>fx.caller.bulkImport.commit({batchId:fx.staged.batchId,planVersion:fx.preview.planVersion,clockConfirmed:true,runAnalysis:true});
    try {
      await retry();const first=await waitForCommit(fx.caller,fx.staged.batchId);
      const siteId=first.batch.summary!.siteIds[0];
      expect(first.batch.status).toBe("partial");
      expect(first.batch.summary!.postProcessing[siteId]).toMatchObject({totals:"failed",detail:expect.stringContaining("temporary total failure")});
      expect(analysisSpy).not.toHaveBeenCalled();
      const checkpoints=first.sheets.map(s=>({id:s.id,meterId:s.meterId,status:s.status,pointsWritten:s.pointsWritten}));
      await retry();const second=await waitForCommit(fx.caller,fx.staged.batchId);
      expect(second.batch.status).toBe("partial");
      expect(second.batch.summary!.postProcessing[siteId]).toMatchObject({totals:"done",analysis:"failed",detail:expect.stringContaining("temporary analysis failure")});
      await start(fx);const deferred=await waitForCommit(fx.caller,fx.staged.batchId);
      expect(deferred.batch.status).toBe("partial");
      expect(deferred.batch.summary!.postProcessing[siteId]).toMatchObject({totals:"done",analysis:"failed",detail:expect.stringContaining("temporary analysis failure")});
      expect(totalSpy).toHaveBeenCalledTimes(2);expect(analysisSpy).toHaveBeenCalledTimes(1);
      await retry();const third=await waitForCommit(fx.caller,fx.staged.batchId);
      expect(third.batch.status).toBe("complete");
      expect(third.batch.summary!.postProcessing[siteId]).toEqual({totals:"done",analysis:"done"});
      expect(third.batch.summary).toMatchObject({sheetsTotal:2,sheetsDone:2,sheetsFailed:0,pointsWritten:576,campusTotals:1,analysesRun:1,analysesFailed:0});
      expect(third.sheets.map(s=>({id:s.id,meterId:s.meterId,status:s.status,pointsWritten:s.pointsWritten}))).toEqual(checkpoints);
      expect(totalSpy).toHaveBeenCalledTimes(2);expect(analysisSpy).toHaveBeenCalledTimes(2);
      expect(await retry()).toMatchObject({started:false});
      expect(totalSpy).toHaveBeenCalledTimes(2);expect(analysisSpy).toHaveBeenCalledTimes(2);
    }finally{totalSpy.mockRestore();analysisSpy.mockRestore();}
  },60_000);
  it("denies foreign batches, foreign sheet targets, and files outside the selected batch",async()=>{
    const a=await prepared([sample("scope-a")]),b=await prepared([sample("scope-b")]);
    const stranger=appRouter.createCaller(ctxFor({id:-987654321,openId:"stranger"}));
    for(const action of [()=>stranger.bulkImport.status({batchId:a.staged.batchId}),()=>stranger.bulkImport.stageFile({batchId:a.staged.batchId,filename:"x.xlsx",contentBase64:firstWorkbook}),()=>stranger.bulkImport.removeFile({batchId:a.staged.batchId,fileId:a.staged.fileId}),()=>stranger.bulkImport.preview({batchId:a.staged.batchId}),()=>stranger.bulkImport.commit({batchId:a.staged.batchId,planVersion:a.preview.planVersion})])await expect(action()).rejects.toMatchObject({code:"NOT_FOUND"});
    expect(await stranger.bulkImport.list()).toEqual([]);
    await expect(a.caller.bulkImport.removeFile({batchId:a.staged.batchId,fileId:b.staged.fileId})).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(a.caller.bulkImport.preview({batchId:a.staged.batchId,overrides:[{sheetId:a.preview.sites[0].meters[0].sheetId,siteId:-98}]})).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(a.caller.bulkImport.preview({batchId:a.staged.batchId,overrides:[{sheetId:b.preview.sites[0].meters[0].sheetId,siteId:null}]})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await a.caller.bulkImport.status({batchId:a.staged.batchId})).batch.planVersion).toBe(a.preview.planVersion);
    await a.caller.bulkImport.removeFile({batchId:a.staged.batchId,fileId:a.staged.fileId});
    await b.caller.bulkImport.removeFile({batchId:b.staged.batchId,fileId:b.staged.fileId});
    // Empty staging fixtures would consume admission; remove only our batches.
    const d=(await getDb())!;await d.delete(importBatches).where(inArray(importBatches.id,[a.staged.batchId,b.staged.batchId]));
  },30_000);
  it("serializes simultaneous commits and rejects stale plan versions",async()=>{
    const fx=await prepared([sample("concurrent")]);
    await expect(fx.caller.bulkImport.commit({batchId:fx.staged.batchId,planVersion:fx.preview.planVersion-1,clockConfirmed:true,runAnalysis:false})).rejects.toMatchObject({code:"CONFLICT"});
    const result=await Promise.allSettled([start(fx),start(fx)]);
    expect(result.filter(r=>r.status==="fulfilled"&&r.value.started)).toHaveLength(1);
    const done=await waitForCommit(fx.caller,fx.staged.batchId);expect(done.batch.status).toBe("complete");
    const d=(await getDb())!;expect(await d.select().from(meters).where(and(eq(meters.userId,userId!),eq(meters.servicePoint,"SP-concurrent")))).toHaveLength(1);
  },30_000);
  it("uses stable agreement identity without a service point across fresh imports",async()=>{
    for(let n=0;n<2;n++){const fx=await prepared([sample("no-sp",{servicePoint:""})]);await start(fx);expect((await waitForCommit(fx.caller,fx.staged.batchId)).batch.status).toBe("complete");}
    const d=(await getDb())!;const ms=await d.select().from(meters).where(and(eq(meters.userId,userId!),eq(meters.serviceAgreementId,"SA-no-sp")));expect(ms).toHaveLength(1);expect(ms[0].importIdentity).toBe("sa:SA-no-sp");
  },30_000);
  it("fails closed for conflicting destinations and identity-less sheets",async()=>{
    const c=callerFor();
    for(const ss of [[sample("same-a",{servicePoint:"same"}),sample("same-b",{servicePoint:"same"})],[sample("no-id",{servicePoint:"",agreement:""})]]){
      const f=await c.bulkImport.stageFile({filename:"conflict.xlsx",contentBase64:workbookBase64(ss)});
      await expect(c.bulkImport.preview({batchId:f.batchId})).rejects.toThrow(/conflicting|durable/);
      await c.bulkImport.removeFile({batchId:f.batchId,fileId:f.fileId});await (await getDb())!.delete(importBatches).where(eq(importBatches.id,f.batchId));
    }
  }, 30_000);
  it("rolls back actual interval inserts and checkpoint creation, then retries without stale counters",async()=>{
    const fx=await prepared([sample("rollback-a"),sample("rollback-b")]);
    const original=writer.writeIntervals;
    let injected=false;
    const spy=vi.spyOn(writer,"writeIntervals").mockImplementation(async(...args)=>{
      if(!injected){injected=true;await original(...args);throw new Error("fault after actual interval chunk, before sheet checkpoint");}
      return original(...args);
    });
    try {await start(fx);const first=await waitForCommit(fx.caller,fx.staged.batchId);expect(first.batch.status).toBe("partial");expect(first.batch.summary).toMatchObject({sheetsTotal:2,sheetsDone:2,sheetsFailed:1});
      const d=(await getDb())!;expect(await d.select().from(meters).where(and(eq(meters.userId,userId!),eq(meters.servicePoint,"SP-rollback-a")))).toHaveLength(0);
    }finally{spy.mockRestore();}
    await start(fx);const done=await waitForCommit(fx.caller,fx.staged.batchId);expect(done.batch.status).toBe("complete");expect(done.batch.summary).toMatchObject({sheetsTotal:2,sheetsDone:2,sheetsFailed:0});
    const d=(await getDb())!;const files=await d.select().from(importBatchFiles).where(eq(importBatchFiles.batchId,fx.staged.batchId));expect(files[0].uploadId).not.toBeNull();
    const [u]=await d.select().from(uploads).where(eq(uploads.id,files[0].uploadId!));expect(u.rowsIngested).toBe(576);expect(u.parseConfidence).toBe(0.5);
  },30_000);
  it("does not publish nondurable sources",async()=>{
    vi.mocked(storage.storagePut).mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(callerFor().bulkImport.stageFile({filename:"storage.xlsx",contentBase64:workbookBase64([sample("s3-fail")])})).rejects.toMatchObject({code:"SERVICE_UNAVAILABLE"});
  });
  it("requires state evidence before automatically merging partial addresses",async()=>{
    const caller=callerFor(),staged=await caller.bulkImport.stageFile({filename:"unknown-state.xlsx",contentBase64:workbookBase64([sample("unknown-state",{address:"100 Main St, Springfield",rateCode:"" as SyntheticSheet["rateCode"]})])});
    try {
      await expect(caller.bulkImport.preview({batchId:staged.batchId})).rejects.toThrow(/state is unknown/);
      const preview=await caller.bulkImport.preview({batchId:staged.batchId,stateHint:"IL"});
      expect(preview.sites[0]).toMatchObject({state:"IL"});
      expect(preview.sites[0].groupKey).toContain("|IL|US");
    }finally{
      await caller.bulkImport.removeFile({batchId:staged.batchId,fileId:staged.fileId});
      await (await getDb())!.delete(importBatches).where(eq(importBatches.id,staged.batchId));
    }
  });
  it("recognizes another worker's live lease and fences stale tokens",async()=>{
    const fx=await prepared([sample("fenced")]),d=(await getDb())!;
    await d.update(importBatches).set({status:"committing",workerToken:"foreign-token",leaseUntil:Date.now()+120_000}).where(eq(importBatches.id,fx.staged.batchId));
    expect(await fx.caller.bulkImport.status({batchId:fx.staged.batchId})).toMatchObject({running:true,stalled:false});
    await expect(d.transaction(tx=>bulk.assertLiveLeaseForUpdate(tx,fx.staged.batchId,userId!,"old-token"))).rejects.toThrow(/fenced/);
    await d.update(importBatches).set({leaseUntil:Date.now()-1}).where(eq(importBatches.id,fx.staged.batchId));
    await start(fx);expect((await waitForCommit(fx.caller,fx.staged.batchId)).batch.status).toBe("complete");
  },30_000);
  it("supports explicit null reset and merging into an unchanged planned campus",async()=>{
    const fx=await prepared([sample("override-a"),sample("override-b")]);
    const a=fx.preview.sites.find(s=>s.siteName.includes("override-a"))!,b=fx.preview.sites.find(s=>s.siteName.includes("override-b"))!;
    const merged=await fx.caller.bulkImport.preview({batchId:fx.staged.batchId,planVersion:fx.preview.planVersion,overrides:[{sheetId:a.meters[0].sheetId,siteId:null,groupKey:b.groupKey}]});expect(merged.sites).toHaveLength(1);
    const reset=await fx.caller.bulkImport.preview({batchId:fx.staged.batchId,planVersion:merged.planVersion,overrides:[{sheetId:a.meters[0].sheetId,siteId:null,groupKey:null}]});expect(reset.sites).toHaveLength(2);
    fx.preview=reset;await start(fx);expect((await waitForCommit(fx.caller,fx.staged.batchId)).batch.status).toBe("complete");
  },30_000);
  it("blocks limited-plan bulk creation instead of racing unrelated legacy quota routes",async()=>{
    const fx=await prepared([sample("quota")]),d=(await getDb())!;
    await d.update(billingAccounts).set({plan:"free",entitlementTier:"free"}).where(eq(billingAccounts.userId,userId!));
    try {await expect(start(fx)).rejects.toMatchObject({code:"FORBIDDEN"});}
    finally{await d.update(billingAccounts).set({plan:"founding",entitlementTier:"pro"}).where(eq(billingAccounts.userId,userId!));}
    await start(fx);await waitForCommit(fx.caller,fx.staged.batchId);
  },30_000);
});

/* Oct 24 property facts: the bulk commit fills floor area from public records
 * BEFORE analysis, and a public-source outage never blocks or fails an import. */
import * as propertyFacts from "./propertyFacts";
import { sitePropertyFacts, sites as sitesTable } from "../drizzle/schema";
describe("bulk import property facts", () => {
  it("auto-fills an address-matched floor area and labels it; an outage leaves the import complete", async () => {
    const structures = (addr: string) => ({ features: [{ attributes: { BUILD_ID: 77, SQFEET: 41_234, PROP_ADDR: addr, OCC_CLS: "Education", PRIM_OCC: "Pre-K - 12 Schools", HEIGHT: null, LATITUDE: 35.1894, LONGITUDE: -114.053 } }] });
    try {
      propertyFacts.setPropertyFactsFetcher(async (url) => {
        if (url.includes("mcgis.mohave.gov")) return { features: [] };
        return structures("300 PFOK AVENUE");
      });
      const ok = await prepared([sample("PfOk")]);
      await ok.caller.bulkImport.commit({ batchId: ok.staged.batchId, planVersion: ok.preview.planVersion, clockConfirmed: true, buildingType: "school", runAnalysis: false });
      const done = await waitForCommit(ok.caller, ok.staged.batchId);
      expect(done.batch.status).toBe("complete");
      expect(done.batch.summary).toMatchObject({ floorAreaEstimated: 1 });
      const siteId = done.batch.summary!.siteIds[0];
      const db = (await getDb())!;
      const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, siteId));
      expect(site.sqft).toBe(41_200);
      const [row] = await db.select().from(sitePropertyFacts).where(eq(sitePropertyFacts.siteId, siteId));
      expect(row.appliedBy).toBe("auto");
      expect(propertyFacts.floorAreaBasisOf(site, row).basis).toBe("public_record_estimate");

      propertyFacts.setPropertyFactsFetcher(async () => { throw new Error("public sources down"); });
      const down = await prepared([sample("PfDown")]);
      await down.caller.bulkImport.commit({ batchId: down.staged.batchId, planVersion: down.preview.planVersion, clockConfirmed: true, buildingType: "school", runAnalysis: false });
      const finished = await waitForCommit(down.caller, down.staged.batchId);
      expect(finished.batch.status).toBe("complete");
      expect(finished.batch.summary).toMatchObject({ floorAreaEstimated: 0 });
      const [downSite] = await db.select().from(sitesTable).where(eq(sitesTable.id, finished.batch.summary!.siteIds[0]));
      expect(downSite.sqft).toBeNull();
    } finally {
      propertyFacts.setPropertyFactsFetcher(null);
    }
  }, 70_000);
});
