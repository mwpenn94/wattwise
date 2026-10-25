import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { IntervalPoint } from "../shared/wattwise";
import { intervals, meters, sites, uploads, type Meter } from "../drizzle/schema";
import { getDb } from "./db";

export type ComponentIntervalSeries = Array<Pick<IntervalPoint,"ts"|"durationMin"|"usage"|"demand">>;
export interface SummedComponentSeries { points:IntervalPoint[];notes:string[] }
export function sumComponentSeries(series:ComponentIntervalSeries[]):SummedComponentSeries {
  if (!series.length) return {points:[],notes:["No component interval series were available."]};
  const maps=series.map(s=>new Map(s.map(p=>[`${p.ts}:${p.durationMin}`,p])));
  const shared=Array.from(maps[0]!.keys()).filter(k=>maps.every(m=>m.has(k)));
  const points=shared.map(k=>{
    const rows=maps.map(m=>m.get(k)!);const first=rows[0]!;
    return {ts:first.ts,durationMin:first.durationMin,usage:rows.reduce((s,p)=>s+p.usage,0),demand:rows.every(p=>p.demand!=null)?rows.reduce((s,p)=>s+(p.demand??0),0):null};
  }).sort((a,b)=>a.ts-b.ts||a.durationMin-b.durationMin);
  const union=new Set(maps.flatMap(m=>Array.from(m.keys())));const dropped=union.size-shared.length;
  const notes=[`Summed ${series.length} separately billed electric service agreements; only timestamp/duration points shared by every account are included.`];
  if(dropped) notes.push(`Excluded ${dropped} unmatched timestamp/duration points; no mixed-duration intervals were summed.`);
  const missing=points.filter(p=>p.demand==null).length;
  if(missing) notes.push(`Demand is null for ${missing} points because at least one contributing service agreement did not report demand.`);
  return {points,notes};
}
/** Conservative publication gate: no partial, overlapping or duplicated source series. */
export function requireAlignedCampusSeries(series:ComponentIntervalSeries[]):SummedComponentSeries {
  const summed=sumComponentSeries(series);
  const union=new Set(series.flatMap(s=>s.map(p=>`${p.ts}:${p.durationMin}`)));
  const invalid=series.some(s=>{
    const sorted=[...s].sort((a,b)=>a.ts-b.ts);
    return !sorted.length || sorted.some((p,i)=>!Number.isFinite(p.usage)||p.durationMin<=0||(i>0&&p.ts!==sorted[i-1]!.ts+sorted[i-1]!.durationMin*60_000));
  });
  if(invalid||!summed.points.length||summed.points.length!==union.size) throw new Error("Incomplete campus alignment: normalize durations and continuous coverage before publishing a campus total; component data and the previous total are retained.");
  return summed;
}
export function pickSiteAnalysisMeter<T extends Pick<Meter,"commodity"|"meterRole">>(rows:T[]):T|null {
  return rows.find(m=>m.commodity==="electric"&&m.meterRole==="virtual_total")??rows.find(m=>m.commodity==="electric"&&m.meterRole==="main")??rows.find(m=>m.meterRole==="main")??null;
}
export function isVirtualTotalMeter(meter:Pick<Meter,"meterRole">){return meter.meterRole==="virtual_total";}
export function componentFingerprint(components:Array<{id:number;timezone:string}>,series:ComponentIntervalSeries[]) {
  const hash=createHash("sha256");
  components.forEach((c,i)=>{hash.update(JSON.stringify(c));for(const p of series[i]!) hash.update(JSON.stringify([p.ts,p.durationMin,p.usage,p.demand]));});
  return hash.digest("hex");
}
export async function materializeVirtualTotal(siteId:number,userId:number):Promise<{meterId:number|null;componentCount:number;points:number;skippedReason?:string}> {
  const db=await getDb();if(!db)throw new Error("Database unavailable while materializing campus total.");
  return db.transaction(async tx=>{
    const [site]=await tx.select({id:sites.id}).from(sites).where(and(eq(sites.id,siteId),eq(sites.userId,userId))).for("update");
    if(!site)throw new Error("Site not found in your portfolio");
    const rows=await tx.select().from(meters).where(eq(meters.siteId,siteId)).orderBy(asc(meters.id)).for("update");
    const components=rows.filter(m=>m.commodity==="electric"&&m.meterRole==="main");
    const virtuals=rows.filter(m=>m.commodity==="electric"&&m.meterRole==="virtual_total");
    if(components.length<2){
      for(const v of virtuals){await tx.delete(intervals).where(eq(intervals.meterId,v.id));await tx.delete(meters).where(eq(meters.id,v.id));}
      return {meterId:null,componentCount:components.length,points:0,skippedReason:"Fewer than two MAIN-role electric service agreements are available to total."};
    }
    const series:ComponentIntervalSeries[]=[];
    for(const c of components){
      series.push(await tx.select({ts:intervals.ts,durationMin:intervals.durationMin,usage:intervals.usage,demand:intervals.demand}).from(intervals).where(and(eq(intervals.meterId,c.id),sql`(${intervals.qcFlags} IS NULL OR ${intervals.qcFlags} != 'superseded_overlap')`)).orderBy(asc(intervals.ts),asc(intervals.durationMin)));
    }
    const summed=requireAlignedCampusSeries(series);
    const timezone=components[0]!.timezone;
    if(new Set(components.map(c=>c.timezone)).size>1) summed.notes.push("Component timezones differ. UTC physical alignment is preserved; each account must be priced in its own timezone.");
    const label=`Campus total (sum of ${components.length} service agreements)`;
    let virtualId=virtuals[0]?.id;
    if(virtualId==null){const [res]=await tx.insert(meters).values({siteId,userId,commodity:"electric",label,usageUnit:"kWh",demandUnit:"kW",timezone,meterRole:"virtual_total"});virtualId=Number(res.insertId);}
    else await tx.update(meters).set({label,timezone}).where(eq(meters.id,virtualId));
    const hash=componentFingerprint(components.map(c=>({id:c.id,timezone:c.timezone})),series);
    const validation={ingestedUsageSum:summed.points.reduce((s,p)=>s+p.usage,0),ingestedMaxDemand:null,pass:true,notes:summed.notes,componentIds:components.map(c=>c.id),unionPoints:summed.points.length,intersectionPoints:summed.points.length};
    const [up]=await tx.insert(uploads).values({siteId,userId,filename:"virtual-total",sha256:hash,format:"manual",parser:"virtual_total_v2",parserVersion:"2",status:"parsed",rowsIngested:summed.points.length,rowsSkipped:0,footerTotals:{raw:[]},validation});
    await tx.delete(intervals).where(eq(intervals.meterId,virtualId));
    for(let i=0;i<summed.points.length;i+=1000) await tx.insert(intervals).values(summed.points.slice(i,i+1000).map(p=>({...p,meterId:virtualId!,uploadId:Number(up.insertId),precedence:3})));
    // Legacy duplicate totals are retired only after the replacement has been fully written.
    for(const duplicate of virtuals.slice(1)){await tx.delete(intervals).where(eq(intervals.meterId,duplicate.id));await tx.delete(meters).where(eq(meters.id,duplicate.id));}
    return {meterId:virtualId,componentCount:components.length,points:summed.points.length};
  });
}
