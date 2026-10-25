import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { auditLog, baselines, measureImplementations, meters, opportunities as opportunityTable, recommendationStates, sites } from "../drizzle/schema";
import { savingsRangeFromEstimate, type SavingsConfidence, type SavingsRangeUsd } from "../shared/savingsRange";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { pickSiteAnalysisMeter } from "./virtualTotal";

const DAY_MS = 86_400_000;
export const SAVINGS_BASIS = "Standalone before-change screening estimates, not additive. Combined and post-completion residual savings are not yet modeled; amounts are withheld. Completion is a count of identified actions, not energy savings or a fixed plan percentage.";
export const VERIFICATION_BASIS = "Attribution inconclusive: immutable pre-change evidence and a unique site/commodity/month allocation are required. Whole-site reductions are not credited separately to multiple measures; historical proof amounts are withheld.";
export type RecommendationStatus = "planned" | "in_progress" | "completed" | "deferred" | "dismissed";
type VerdictStatus = "awaiting_data" | "on_track" | "verified" | "underperforming" | "inconclusive";
export interface QueueOpportunity {
  id?: number; analysisId?: number | null; measure: string; title: string; description?: string | null;
  estCostSavingsPerYr?: number | null; paybackBandYears?: string | null; confidence: SavingsConfidence; rank?: number; provenance?: unknown;
}
export interface QueueState {
  id?: number; siteId?: number; userId?: number; measure: string; title?: string | null; status: RecommendationStatus;
  implementationId?: number | null; note?: string | null; savingsLowUsd?: number | null; savingsHighUsd?: number | null;
  deferUntil?: number | null; changedAt?: number; reopened?: boolean; sourceSnapshot?: unknown;
}
export interface QueueImplementation {
  id: number; siteId?: number; measure: string; title: string; expectedSavingsUsd?: number | null; status: VerdictStatus;
  verifiedSavingsUsd?: number | null; implementedAt: number; reopened?: boolean; sourceSnapshot?: unknown;
}
export interface RecommendationItem {
  id?: number; measure: string; title: string; description: string | null; rank: number | null;
  status: RecommendationStatus | "open" | "needs_review"; savingsRangeUsd: SavingsRangeUsd | null; paybackBandYears: string | null;
  confidence: SavingsConfidence; basis: string; disclosures: string[]; commodity: string; audience: string;
  deferUntil: number | null; note: string | null;
  implementation: { id: number; status: VerdictStatus; verifiedSavingsUsd: null; implementedAt: number } | null;
}
export interface RecommendationQueue {
  active: RecommendationItem[]; next: RecommendationItem[]; completed: RecommendationItem[];
  inactive: RecommendationItem[]; needsReview: RecommendationItem[]; landlord: RecommendationItem[];
  progress: {
    totalIdentified: number; planned: number; inProgress: number; completed: number; dismissed: number; deferred: number;
    completionPct: number; projectedRangeUsd: SavingsRangeUsd | null; committedRangeUsd: SavingsRangeUsd | null;
    verifiedSavingsUsd: null; savingsBasis: string; verificationBasis: string;
  };
}
function asConfidence(value: unknown): SavingsConfidence { return value === "high" || value === "low" ? value : "medium"; }
function snapshot(value: unknown): QueueOpportunity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as QueueOpportunity;
  return typeof v.measure === "string" && typeof v.title === "string" ? v : undefined;
}
export function opportunityMeta(opportunity: QueueOpportunity | undefined) {
  const provenance = opportunity?.provenance && typeof opportunity.provenance === "object" ? opportunity.provenance as Record<string, unknown> : {};
  const disclosures = Array.isArray(provenance.disclosures) ? provenance.disclosures.filter((d): d is string => typeof d === "string") : [];
  const basis = ["Standalone before-change estimate; not completion-adjusted.", typeof provenance.basis === "string" ? provenance.basis : null, ...disclosures].filter(Boolean).join(" ");
  const sourceRange = Array.isArray(provenance.savingsRange) && provenance.savingsRange.length === 2 && provenance.savingsRange.every(v => typeof v === "number" && Number.isFinite(v)) && Number(provenance.savingsRange[0]) < Number(provenance.savingsRange[1])
    ? { low: Number(provenance.savingsRange[0]), high: Number(provenance.savingsRange[1]) } : null;
  return { commodity: typeof provenance.commodity === "string" ? provenance.commodity : "unknown", audience: provenance.audience === "landlord" ? "landlord" : "occupant", disclosures, basis, sourceRange };
}
function itemFrom(current: QueueOpportunity | undefined, state: QueueState | undefined, implementation: QueueImplementation | undefined, now: number): RecommendationItem {
  const status = state ? state.reopened ? "open" : state.status : implementation && !implementation.reopened ? "completed" : "open";
  const saved = snapshot(state?.sourceSnapshot) ?? snapshot(implementation?.sourceSnapshot);
  const source = status === "completed" ? saved : current ?? saved;
  const meta = opportunityMeta(source);
  const confidence = asConfidence(source?.confidence);
  const range = source ? meta.sourceRange ?? savingsRangeFromEstimate(source.estCostSavingsPerYr, confidence)
    : state?.savingsLowUsd != null && state.savingsHighUsd != null ? { low: state.savingsLowUsd, high: state.savingsHighUsd } : null;
  return {
    id: current?.id, measure: current?.measure ?? state?.measure ?? implementation!.measure,
    title: source?.title ?? state?.title ?? implementation?.title ?? current!.title,
    description: source?.description ?? null, rank: current?.rank ?? null,
    status: status === "deferred" && state?.deferUntil != null && state.deferUntil <= now ? "open" : status,
    savingsRangeUsd: range, paybackBandYears: source?.paybackBandYears ?? null, confidence,
    basis: source ? meta.basis : "Historical action: original analysis provenance unavailable; reanalysis does not replace its snapshot.",
    disclosures: meta.disclosures, commodity: meta.commodity, audience: meta.audience,
    deferUntil: state?.deferUntil ?? null, note: state?.note ?? null,
    implementation: implementation ? { id: implementation.id, status: implementation.status === "awaiting_data" ? "awaiting_data" : "inconclusive", verifiedSavingsUsd: null, implementedAt: implementation.implementedAt } : null,
  };
}
export function buildRecommendationQueue(opportunities: QueueOpportunity[], states: QueueState[], implementations: QueueImplementation[], now: number): RecommendationQueue {
  const byMeasure = new Map(opportunities.map(o => [o.measure, o]));
  const measures = new Set([...Array.from(byMeasure.keys()), ...states.map(s => s.measure), ...implementations.map(i => i.measure)]);
  const all = Array.from(measures).map(measure => {
    const state = states.filter(s => s.measure === measure).sort((a,b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))[0];
    const impl = implementations.filter(i => i.measure === measure).sort((a,b) => b.implementedAt - a.implementedAt || b.id - a.id)[0];
    const item = itemFrom(byMeasure.get(measure), state, impl, now);
    if (opportunityMeta(byMeasure.get(measure)).audience === "landlord") item.audience = "landlord";
    return item;
  });
  const landlord = all.filter(i => i.audience === "landlord");
  const controlled = all.filter(i => i.audience !== "landlord");
  const completed = controlled.filter(i => i.status === "completed");
  const inactive = controlled.filter(i => i.status === "dismissed" || i.status === "deferred");
  const needsReview = controlled.filter(i => !byMeasure.has(i.measure) && !["completed", "dismissed", "deferred"].includes(i.status)).map(i => ({ ...i, status: "needs_review" as const, basis: `No longer present in the current analysis; review before acting. ${i.basis}` }));
  const active = controlled.filter(i => byMeasure.has(i.measure) && !["completed", "dismissed", "deferred"].includes(i.status)).sort((a,b) => {
    const planned = (i: RecommendationItem) => i.status === "planned" || i.status === "in_progress";
    return Number(planned(b)) - Number(planned(a)) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.measure.localeCompare(b.measure);
  });
  return {
    active, next: active.filter(i => i.status === "open").slice(0,3), completed, inactive, needsReview, landlord,
    progress: {
      totalIdentified: controlled.length, planned: active.filter(i => i.status === "planned").length,
      inProgress: active.filter(i => i.status === "in_progress").length, completed: completed.length,
      dismissed: inactive.filter(i => i.status === "dismissed").length, deferred: inactive.filter(i => i.status === "deferred").length,
      completionPct: controlled.length ? Math.round(completed.length / controlled.length * 100) : 0,
      projectedRangeUsd: null, committedRangeUsd: null, verifiedSavingsUsd: null, savingsBasis: SAVINGS_BASIS, verificationBasis: VERIFICATION_BASIS,
    },
  };
}
export async function getSiteQueue(siteId: number, userId: number, now = Date.now()): Promise<RecommendationQueue> {
  await h.getSite(siteId, userId);
  const db = await getDb(); if (!db) throw new Error("Database unavailable");
  const [opportunities, states, implementations, events] = await Promise.all([
    h.listOpportunities(siteId,userId), db.select().from(recommendationStates).where(and(eq(recommendationStates.siteId,siteId),eq(recommendationStates.userId,userId))),
    h.listMeasureImplementations(siteId,userId), db.select({detail:auditLog.detail}).from(auditLog).where(and(eq(auditLog.userId,userId),eq(auditLog.action,"recommendation_reopened"))),
  ]);
  const reopenedAt = new Map<string,number>();
  for (const event of events) {
    const d = event.detail as {siteId?:number;measure?:string;reopenedAt?:number} | null;
    if (d?.siteId === siteId && typeof d.measure === "string" && typeof d.reopenedAt === "number") reopenedAt.set(d.measure,Math.max(reopenedAt.get(d.measure) ?? 0,d.reopenedAt));
  }
  return buildRecommendationQueue(opportunities, states, implementations.map(i => ({...i,reopened:(reopenedAt.get(i.measure) ?? 0) > i.implementedAt})), now);
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface StateInput {
  userId:number;siteId:number;measure:string;title:string;status:RecommendationStatus;note?:string|null;deferDays?:number|null;implementedAt?:number|null;
}
async function lockSites(tx:Tx, userId:number, ids:number[]) {
  for (const id of Array.from(new Set(ids)).sort((a,b)=>a-b)) {
    const [owned] = await tx.select({id:sites.id}).from(sites).where(and(eq(sites.id,id),eq(sites.userId,userId))).for("update");
    if (!owned) throw new TRPCError({code:"NOT_FOUND",message:"Site not found in your portfolio"});
  }
}
async function transition(tx:Tx,input:StateInput) {
  const now = Date.now();
  const [prior] = await tx.select().from(recommendationStates).where(and(eq(recommendationStates.siteId,input.siteId),eq(recommendationStates.measure,input.measure))).limit(1).for("update");
  // Repeated completion requests are idempotent for the current episode.
  if (input.status === "completed" && prior?.status === "completed" && !prior.reopened) return {implementationId:prior.implementationId,deferUntil:prior.deferUntil,changedAt:prior.changedAt};
  const [opportunity] = await tx.select().from(opportunityTable).where(and(eq(opportunityTable.siteId,input.siteId),eq(opportunityTable.measure,input.measure))).limit(1);
  if (!opportunity) throw new TRPCError({code:"PRECONDITION_FAILED",message:"Recommendation is absent from the current analysis. Reanalyze and review before acting."});
  if (opportunityMeta(opportunity).audience === "landlord") throw new TRPCError({code:"PRECONDITION_FAILED",message:"This is a landlord action, not an occupant-controlled recommendation."});
  if (input.implementedAt != null && input.implementedAt > now) throw new TRPCError({code:"BAD_REQUEST",message:"Implementation date cannot be in the future"});
  const sourceSnapshot = opportunity as unknown as Record<string,unknown>;
  const range = opportunityMeta(opportunity).sourceRange ?? savingsRangeFromEstimate(opportunity.estCostSavingsPerYr,opportunity.confidence);
  let implementationId:number|null = null;
  if (input.status === "completed") {
    const implementedAt = input.implementedAt ?? now;
    const siteMeters = await tx.select().from(meters).where(eq(meters.siteId,input.siteId));
    const commodity = opportunityMeta(opportunity).commodity;
    const meter = pickSiteAnalysisMeter(siteMeters.filter(m => m.commodity === commodity));
    const [baseline] = meter ? await tx.select().from(baselines).where(and(eq(baselines.siteId,input.siteId),eq(baselines.meterId,meter.id),eq(baselines.commodity,meter.commodity),isNotNull(baselines.trainEnd),lte(baselines.trainEnd,implementedAt))).orderBy(desc(baselines.id)).limit(1) : [];
    const [result] = await tx.insert(measureImplementations).values({userId:input.userId,siteId:input.siteId,opportunityId:opportunity.id,measure:input.measure,title:opportunity.title,implementedAt,expectedSavingsUsd:opportunity.estCostSavingsPerYr,status:"awaiting_data",verifiedSavingsUsd:null,baselineId:baseline?.id ?? null,analysisMeterId:meter?.id ?? null,baselineSnapshot:baseline ?? null,sourceSnapshot,episodeKey:randomUUID()});
    implementationId = Number(result.insertId);
  }
  const deferUntil = input.status === "deferred" ? now + (input.deferDays ?? 90)*DAY_MS : null;
  const values = {userId:input.userId,siteId:input.siteId,measure:input.measure,title:opportunity.title,status:input.status,implementationId,note:input.note ?? null,savingsLowUsd:range?.low ?? null,savingsHighUsd:range?.high ?? null,sourceSnapshot,reopened:false,deferUntil,changedAt:now};
  await tx.insert(recommendationStates).values(values).onDuplicateKeyUpdate({set:values});
  await tx.insert(auditLog).values({userId:input.userId,action:"recommendation_state_changed",entity:"recommendation_state",entityId:`${input.siteId}:${input.measure}`,detail:{siteId:input.siteId,measure:input.measure,status:input.status,implementationId,deferUntil}});
  return {implementationId,deferUntil,changedAt:now};
}
export async function setRecommendationStates(inputs:StateInput[]) {
  const unique = Array.from(new Map(inputs.map(i=>[`${i.siteId}:${i.measure}`,i])).values());
  if (!unique.length) return [];
  const userId = unique[0]!.userId;
  if (unique.some(i=>i.userId !== userId)) throw new Error("Mixed user transaction is not supported");
  const db = await getDb(); if (!db) throw new Error("Database unavailable");
  return db.transaction(async tx => {
    await lockSites(tx,userId,unique.map(i=>i.siteId));
    const results = [];
    for (const input of unique) results.push({...input,...await transition(tx,input)});
    return results;
  });
}
export async function setRecommendationState(input:StateInput) { return (await setRecommendationStates([input]))[0]!; }
export async function reopenRecommendation(input:{userId:number;siteId:number;measure:string}) {
  const db = await getDb(); if (!db) throw new Error("Database unavailable");
  return db.transaction(async tx=>{
    await lockSites(tx,input.userId,[input.siteId]);
    const now = Date.now();
    await tx.insert(recommendationStates).values({...input,status:"planned",reopened:true,changedAt:now}).onDuplicateKeyUpdate({set:{reopened:true,implementationId:null,deferUntil:null,changedAt:now}});
    await tx.insert(auditLog).values({userId:input.userId,action:"recommendation_reopened",entity:"recommendation_state",entityId:`${input.siteId}:${input.measure}`,detail:{...input,reopenedAt:now}});
    return {ok:true as const};
  });
}

/** Pipeline replacement shares lifecycle site locks and never exposes an empty queue. */
export async function replaceRecommendationOpportunities(siteId:number,userId:number,rows:typeof opportunityTable.$inferInsert[]) {
  const db = await getDb(); if (!db) throw new Error("Database unavailable");
  await db.transaction(async tx=>{
    await lockSites(tx,userId,[siteId]);
    await tx.delete(opportunityTable).where(eq(opportunityTable.siteId,siteId));
    if(rows.length) await tx.insert(opportunityTable).values(rows);
  });
}
const confidenceRank:Record<SavingsConfidence,number>={low:0,medium:1,high:2};
export function comparePriority(a:RecommendationItem,b:RecommendationItem) {
  const midpoint=(i:RecommendationItem)=>i.savingsRangeUsd ? (i.savingsRangeUsd.low+i.savingsRangeUsd.high)/2 : -1;
  const payback=(s:string|null)=>s === "immediate" ? 0 : Number(s?.match(/[\d.]+/)?.[0] ?? Infinity);
  return midpoint(b)-midpoint(a) || confidenceRank[b.confidence]-confidenceRank[a.confidence] || payback(a.paybackBandYears)-payback(b.paybackBandYears) || a.measure.localeCompare(b.measure);
}
export async function portfolioPriorities(input:{userId:number;siteIds?:number[]|null;groupId?:number|null}) {
  const ownedSites=await h.listSites(input.userId);
  let scopedIds=new Set(ownedSites.map(s=>s.id));
  if(input.groupId != null){
    const group=(await h.listSiteGroups(input.userId)).find(g=>g.id===input.groupId);
    if(!group) throw new TRPCError({code:"NOT_FOUND",message:"Portfolio group not found"});
    scopedIds=new Set(group.siteIds.filter(id=>scopedIds.has(id)));
  }
  if(input.siteIds != null){const requested=new Set(input.siteIds);scopedIds=new Set(Array.from(scopedIds).filter(id=>requested.has(id)));}
  const perSite=await Promise.all(ownedSites.filter(s=>scopedIds.has(s.id)).map(async site=>({site,queue:await getSiteQueue(site.id,input.userId)})));
  const items=perSite.flatMap(({site,queue})=>queue.active.map(item=>({...item,siteId:site.id,siteName:site.name}))).sort(comparePriority);
  const grouped=new Map<string,{measure:string;title:string;savingsRangeUsd:null;sites:Array<{siteId:number;siteName:string;status:RecommendationItem["status"]}>}>();
  for(const item of items){const g=grouped.get(item.measure) ?? {measure:item.measure,title:item.title,savingsRangeUsd:null,sites:[]};g.sites.push({siteId:item.siteId,siteName:item.siteName,status:item.status});grouped.set(item.measure,g);}
  const count=(key:"totalIdentified"|"planned"|"inProgress"|"completed"|"dismissed"|"deferred")=>perSite.reduce((sum,s)=>sum+s.queue.progress[key],0);
  const totalIdentified=count("totalIdentified"), completed=count("completed");
  return {items,byMeasure:Array.from(grouped.values()),siteCount:perSite.length,
    inactive:perSite.flatMap(({site,queue})=>[...queue.inactive,...queue.needsReview,...queue.completed].map(item=>({...item,siteId:site.id,siteName:site.name}))),
    rankingBasis:"Descending standalone range midpoint, then confidence, then numeric payback. Not an additive portfolio forecast.",
    progress:{totalIdentified,completed,planned:count("planned"),inProgress:count("inProgress"),dismissed:count("dismissed"),deferred:count("deferred"),completionPct:totalIdentified ? Math.round(completed/totalIdentified*100):0,projectedRangeUsd:null,committedRangeUsd:null,verifiedSavingsUsd:null,savingsBasis:SAVINGS_BASIS,verificationBasis:VERIFICATION_BASIS},
  };
}
