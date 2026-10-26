import type { CostBreakdown, IntervalPoint, TariffStructure } from "../../shared/wattwise";
import { addSavingsRanges, type SavingsRangeUsd } from "../../shared/savingsRange";
import { computeDemandAnalytics, costOnTariff, notAFitReason, type CostResult } from "./tariffEngine";

export interface AccountPricingComponent {
  meterId:number;label:string;points:IntervalPoint[];structure:TariffStructure;tariffId:number;tariffName:string;
  utilityName:string;timezone:string;rateCodeResolution?:{match:"exact"|"family_inferred";disclosure:string};disclosures?:string[];
}
export interface RateReviewCandidate {
  id:number;name:string;utilityName:string;structure:TariffStructure;freshness:string;
  eligibleFor:(peakKw:number,component:AccountPricingComponent)=>boolean;
  /** Oct 25: full filed-eligibility result (reason + conditions). When present it governs over eligibleFor. */
  eligibility?:(peakKw:number,component:AccountPricingComponent)=>{eligible:boolean;reason?:string;conditions?:string[];belowMinimumDemandKw?:number};
  /** Oct 25: list this schedule (with its filed reason) when the account cannot use it. Default false. */
  listIfIneligible?:boolean;
}
export interface CoveredPeriod {fromTs:number;toTs:number;calendarMonths:number;partialMonths:string[];timezone:string;basis:string}
/** Oct 25 (owner-approved): one priced schedule in an account's side-by-side comparison. */
export interface RateReviewOption {
  id:number;name:string;isCurrent:boolean;observedCost:number;
  /** current − this option over the same covered period (positive = this option is cheaper). */
  differenceUsd:number;differencePct:number|null;
  components:{energy:number;demand:number;fixed:number;riders:number};
  conditions:string[];indicative:boolean;freshness:string;
}
export type RateReviewVerdict="lowest"|"within_threshold"|"switch_candidate"|"no_alternatives";
export interface PerMeterRateReviewRow {
  meterId:number;label:string;tariffId:number;tariffName:string;utilityName:string;currentObservedCost:number;
  peakKw:number;period:CoveredPeriod;disclosures:string[];rateCodeResolution?:{match:"exact"|"family_inferred";disclosure:string};
  bestAlternative:{id:number;name:string;observedCost:number;savingsRangeUsd:SavingsRangeUsd;freshness:string;disclosures:string[];basis:string;
    /** Oct 24: true when the comparison rests on an inferred schedule or a
     * modeled subtotal. Shown as a wider range with a "confirm first" note —
     * never withheld when the data exists. */
    indicative?:boolean}|null;
  /** Oct 25: current schedule plus every schedule this account may take, cheapest first. */
  options?:RateReviewOption[];
  /** Oct 25: same-provider schedules this account cannot take, with the filed reason. */
  excluded?:Array<{id:number;name:string;reason:string}>;
  verdict?:RateReviewVerdict;
  /** Oct 25: plain one-line verdict for screen and print. */
  verdictText?:string;
  /** Oct 25: notes specific to this account (shared notes live once on the review). */
  accountNotes?:string[];
}
export interface MeterRateReview {
  perMeter:PerMeterRateReviewRow[];totalCurrentObservedCost:number;totalSavingsRangeUsd:SavingsRangeUsd|null;
  reviewedCount:number;betterCount:number;disclosures:string[];savingsBasis:string;
  /** Oct 25: verdict counts across accounts. */
  verdictCounts?:Record<RateReviewVerdict,number>;
  /** Oct 25: notes common to every account, stated once. */
  sharedNotes?:string[];
  /** Oct 25: materiality rule used for verdicts. */
  materiality?:{minUsd:number;minPct:number};
}
export const RATE_RANGE_BASIS="Screening convention: 70–100% of the same-account, same-observed-period repricing difference; not a statistical confidence interval, annual projection or bill guarantee. Confirm utility eligibility before switching.";
export const INDICATIVE_RATE_RANGE_BASIS="Indicative screening range: 40–100% of the same-account, same-observed-period repricing difference, widened because the current schedule is inferred from the bill code or the filed-rate model excludes some riders/taxes. Not a bill guarantee. Confirm the schedule and switching terms with the utility first.";
/** Oct 26: the review-level basis line must describe the ranges actually shown —
 * 70–100% (confirmed schedule), 40–100% (indicative), or both when mixed. */
export function reviewSavingsBasis(indicativeFlags:boolean[]):string{
  const anyInd=indicativeFlags.some(Boolean),anyDef=indicativeFlags.some(f=>!f);
  if(anyInd&&anyDef)return `${RATE_RANGE_BASIS} Accounts marked indicative use a wider 40–100% range because their schedule is inferred from the bill code or the filed-rate model excludes some riders/taxes.`;
  return anyInd?INDICATIVE_RATE_RANGE_BASIS:RATE_RANGE_BASIS;
}
export const INDICATIVE_RATE_NOTE="Indicative: priced on the filed base schedule; confirm your exact rate and switching terms with the utility before acting.";
/** Oct 25: a switch is worth requesting only when it saves more than both thresholds. */
export const RATE_MATERIALITY={minUsd:50,minPct:0.02} as const;
export function sameAccountProvider(a:string,b:string){
  const normalize=(s:string)=>s.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
  const key=(s:string)=>/^(uns|unisource)/.test(normalize(s))&&/electric/.test(normalize(s))?"unselectric":normalize(s);
  return Boolean(a.trim()&&b.trim())&&key(a)===key(b);
}
function period(component:AccountPricingComponent,cost:CostResult):CoveredPeriod {
  return {fromTs:component.points.reduce((v,p)=>Math.min(v,p.ts),Infinity),toTs:component.points.reduce((v,p)=>Math.max(v,p.ts+p.durationMin*60_000),-Infinity),calendarMonths:cost.monthlyCosts.length,partialMonths:cost.coverage?.partialMonths??[],timezone:component.timezone,basis:"Modeled observed-window subtotal using touched calendar months, not actual utility billing cycles; no annualization. Each touched month can incur a full fixed charge; partial-month demand/block/rider terms require bill-cycle confirmation."};
}
function price(c:AccountPricingComponent,structure=c.structure){
  if(!c.points.length||!c.timezone||!c.utilityName)throw new Error("Every billed account needs data, provider and timezone; partial-campus pricing is withheld.");
  return costOnTariff(c.points,structure,{tz:c.timezone,rateCodeResolution:c.rateCodeResolution});
}
function disclosures(c:AccountPricingComponent,cost:CostResult){return Array.from(new Set([...(c.disclosures??[]),...(c.rateCodeResolution?[c.rateCodeResolution.disclosure]:[]),...cost.disclosures]));}
function sumBreakdowns(results:CostResult[]):CostBreakdown {
  const riders=new Map<string,number>();for(const r of results)for(const item of r.breakdown.riders??[])riders.set(item.label,(riders.get(item.label)??0)+item.amount);
  const sum=(key:"energy"|"demand"|"fixed"|"cp"|"minBillAdjustment"|"exportCredits"|"total")=>results.reduce((s,r)=>s+(r.breakdown[key]??0),0);
  const cpMethodology=results.some(r=>r.breakdown.cpMethodology==="cp_proxy_top_n_customer_peaks")?"cp_proxy_top_n_customer_peaks":results.some(r=>r.breakdown.cpMethodology==="cp_omitted_demand_not_computable")?"cp_omitted_demand_not_computable":results.some(r=>r.breakdown.cpMethodology==="cp_omitted_no_interval_data")?"cp_omitted_no_interval_data":"no_cp_charges";
  return {energy:sum("energy"),demand:sum("demand"),fixed:sum("fixed"),cp:results.some(r=>r.breakdown.cp!=null)?sum("cp"):null,cpMethodology,minBillAdjustment:sum("minBillAdjustment"),exportCredits:sum("exportCredits"),total:sum("total"),...(riders.size?{riders:Array.from(riders).map(([label,amount])=>({label,amount}))}:{})};
}
export function priceAccountsSeparately(components:AccountPricingComponent[],_tz?:string,_campusMonthlyDetails?:CostResult["monthlyDetails"]){
  if(!components.length)throw new Error("No billed accounts available");
  const priced=components.map(component=>({component,cost:price(component)}));
  const byMonth=new Map<string,CostResult["monthlyCosts"][number]>();
  for(const {cost} of priced)for(const m of cost.monthlyCosts){const p=byMonth.get(m.month)??{month:m.month,energy:0,riders:0,demand:0,fixed:0,cp:0,total:0,exportCredit:0};for(const key of ["energy","riders","demand","fixed","cp","total","exportCredit"] as const)p[key]+=m[key];byMonth.set(m.month,p);}
  // Per-account ratchet-history sentences carry account-specific dollars;
  // replace them with one campus-level statement (sum over accounts).
  const RATCHET_PREFIX="No billing history before ";
  const notes=Array.from(new Set(priced.flatMap(({component,cost})=>disclosures(component,cost)).filter(n=>!n.startsWith(RATCHET_PREFIX))));
  const estimated=priced.filter(p=>p.cost.ratchetHistory?.basis==="same_months_prior_year");
  let ratchetHistory:CostResult["ratchetHistory"];
  if(estimated.length){
    const added=estimated.reduce((s,p)=>s+(p.cost.ratchetHistory!.addedUsd),0);
    const total=priced.reduce((s,p)=>s+p.cost.breakdown.total,0);
    ratchetHistory={basis:"same_months_prior_year",observedOnlyTotal:total-added,addedUsd:added};
    notes.push(`No billing history before the uploaded year was provided for ${estimated.length} of ${priced.length} accounts, so their demand ratchets assume last year's peaks matched this year's (a steady-state estimate). That adds $${added.toFixed(2)}; pricing only the uploaded months, with no earlier history, gives $${(total-added).toFixed(2)}. Prior bills showing billed demand replace this estimate.`);
  }
  notes.push(`Priced ${components.length} separately billed service agreements in each account's timezone; campus subtotal is the sum of observed-window account subtotals. No account is priced on coincident campus demand.`,"Monthly billed-demand details are omitted because separately billed accounts do not have one campus billing determinant.","Covered-period amounts are not annualized; calendar months, including partial boundary months, are not verified utility billing cycles.");
  return {combined:{breakdown:sumBreakdowns(priced.map(p=>p.cost)),monthlyDetails:[],monthlyCosts:Array.from(byMonth.values()).sort((a,b)=>a.month.localeCompare(b.month)),disclosures:notes,pricingStatus:priced.some(p=>p.cost.pricingStatus==="incomplete_rider_coverage")?"incomplete_rider_coverage":"modeled_subtotal",switchRecommendationAllowed:priced.every(p=>p.cost.switchRecommendationAllowed!==false),...(ratchetHistory?{ratchetHistory}:{})} as CostResult,
    accountCosts:priced.map(p=>p.cost),
    perMeter:priced.map(({component,cost})=>({meterId:component.meterId,label:component.label,tariffId:component.tariffId,tariffName:component.tariffName,observedCost:cost.breakdown.total,period:period(component,cost),peakKw:computeDemandAnalytics(component.points,4,[6,7,8,9],component.timezone)?.peakKw??0}))};
}
const shortName=(name:string)=>name.split(" — ")[0];
const usd0=(v:number)=>`$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
function componentsOf(cost:CostResult){
  const b=cost.breakdown;
  return {energy:b.energy,demand:b.demand,fixed:b.fixed,riders:(b.riders??[]).reduce((s,r)=>s+r.amount,0)};
}
/**
 * Oct 25 (owner-approved restore of the rate comparison): every account shows
 * its current schedule next to EVERY same-provider schedule it may take, with
 * the covered-period cost and difference, plus the schedules it cannot take
 * and the filed reason. A plain verdict says whether a switch is worth
 * requesting (> $50 and > 2% cheaper) — the comparison itself is never hidden.
 */
export function perMeterRateReview(components:AccountPricingComponent[],candidates:RateReviewCandidate[],_tz?:string):MeterRateReview {
  const perMeter=components.map(component=>{
    const current=price(component);const peakKw=computeDemandAnalytics(component.points,4,[6,7,8,9],component.timezone)?.peakKw??0;
    const notes=disclosures(component,current);
    const currentTotal=current.breakdown.total;
    const sameProvider=candidates.filter(c=>c.id!==component.tariffId&&sameAccountProvider(c.utilityName,component.utilityName));
    const excluded:Array<{id:number;name:string;reason:string}>=[];
    const priced:Array<{candidate:RateReviewCandidate;cost:CostResult;conditions:string[]}>=[];
    for(const c of sameProvider){
      const elig=c.eligibility?c.eligibility(peakKw,component):{eligible:c.eligibleFor(peakKw,component)};
      if(!elig.eligible){
        if(c.listIfIneligible&&!excluded.some(e=>e.name===shortName(c.name)))excluded.push({id:c.id,name:shortName(c.name),reason:elig.reason??"Not available to this account under the filed rules"});
        continue;
      }
      const cost=price(component,c.structure);
      // A schedule whose filed minimum billing demand is above this account's
      // peak is technically open to it but bills kW it never uses; when that
      // makes it dearer it is listed as "not a fit" with the cost, not as an option.
      const notFit=notAFitReason(elig.belowMinimumDemandKw,peakKw,cost.breakdown.total,currentTotal);
      if(notFit){
        if(c.listIfIneligible!==false&&!excluded.some(e=>e.name===shortName(c.name)))excluded.push({id:c.id,name:shortName(c.name),reason:notFit});
        continue;
      }
      priced.push({candidate:c,cost,conditions:elig.conditions??[]});
    }
    priced.sort((a,b)=>a.cost.breakdown.total-b.cost.breakdown.total);
    const isDefinitive=(cost:CostResult)=>current.switchRecommendationAllowed!==false&&component.rateCodeResolution?.match!=="family_inferred"&&cost.switchRecommendationAllowed!==false;
    const options:RateReviewOption[]=[
      {id:component.tariffId,name:shortName(component.tariffName),isCurrent:true,observedCost:currentTotal,differenceUsd:0,differencePct:0,components:componentsOf(current),conditions:[],indicative:component.rateCodeResolution?.match==="family_inferred"||current.switchRecommendationAllowed===false,freshness:"current"},
      ...priced.map(({candidate,cost,conditions})=>({id:candidate.id,name:shortName(candidate.name),isCurrent:false,observedCost:cost.breakdown.total,differenceUsd:currentTotal-cost.breakdown.total,differencePct:currentTotal>0?(currentTotal-cost.breakdown.total)/currentTotal:null,components:componentsOf(cost),conditions,indicative:!isDefinitive(cost),freshness:candidate.freshness})),
    ].sort((a,b)=>a.observedCost-b.observedCost);
    // Oct 24 (owner): a reconciled-but-inferred schedule or a modeled subtotal
    // WIDENS the range and adds one plain note; it never hides the result.
    const cheapest=priced[0];const difference=cheapest?currentTotal-cheapest.cost.breakdown.total:0;
    const definitive=cheapest?isDefinitive(cheapest.cost):true;
    const threshold=Math.max(RATE_MATERIALITY.minUsd,currentTotal*RATE_MATERIALITY.minPct);
    const material=Boolean(cheapest)&&difference>threshold;
    if(material&&!definitive)notes.push(INDICATIVE_RATE_NOTE);
    const bestAlternative=material&&cheapest?{id:cheapest.candidate.id,name:cheapest.candidate.name,observedCost:cheapest.cost.breakdown.total,savingsRangeUsd:{low:difference*(definitive?0.7:0.4),high:difference},freshness:cheapest.candidate.freshness,disclosures:disclosures(component,cheapest.cost),basis:definitive?RATE_RANGE_BASIS:INDICATIVE_RATE_RANGE_BASIS,indicative:!definitive}:null;
    const notAFit=excluded.filter(e=>e.reason.startsWith("Not a fit:")).length;
    const verdict:RateReviewVerdict=!cheapest?(notAFit?"lowest":"no_alternatives"):material?"switch_candidate":difference>0?"within_threshold":"lowest";
    const pct=(v:number)=>currentTotal>0?`${(Math.abs(v)/currentTotal*100).toFixed(1)}%`:"";
    const verdictText=verdict==="no_alternatives"
      ?`No other ${component.utilityName} schedule is available to this account under the filed rules.`
      :verdict==="switch_candidate"
      ?`Switch candidate: ${shortName(cheapest!.candidate.name)} would have cost ${usd0(difference)} (${pct(difference)}) less over the same period; screening range ${usd0(bestAlternative!.savingsRangeUsd.low)}–${usd0(bestAlternative!.savingsRangeUsd.high)}.`
      :verdict==="within_threshold"
      ?`Not worth a switch request: the cheapest option, ${shortName(cheapest!.candidate.name)}, is only ${usd0(difference)} (${pct(difference)}) lower — under the $${RATE_MATERIALITY.minUsd} and ${RATE_MATERIALITY.minPct*100}% threshold.`
      :!cheapest
      ?`Already on the lowest-cost schedule: the other ${component.utilityName} schedules open to this account would cost more (listed below).`
      :`Already on the lowest-cost schedule it qualifies for; the next option, ${shortName(cheapest.candidate.name)}, costs ${usd0(difference)} (${pct(difference)}) more.`;
    return {meterId:component.meterId,label:component.label,tariffId:component.tariffId,tariffName:component.tariffName,utilityName:component.utilityName,currentObservedCost:currentTotal,period:period(component,current),peakKw,bestAlternative,disclosures:notes,rateCodeResolution:component.rateCodeResolution,options,excluded,verdict,verdictText};
  });
  const better=perMeter.filter(r=>r.bestAlternative);
  // Notes that every account shares are stated once; each account keeps only
  // what is specific to it (e.g. its own REST or ratchet dollars).
  const noteSets=perMeter.map(r=>new Set(r.disclosures));
  const sharedNotes=perMeter.length?perMeter[0].disclosures.filter(n=>noteSets.every(s=>s.has(n))):[];
  const shared=new Set(sharedNotes);
  for(const r of perMeter)(r as PerMeterRateReviewRow).accountNotes=r.disclosures.filter(n=>!shared.has(n));
  const verdictCounts:Record<RateReviewVerdict,number>={lowest:0,within_threshold:0,switch_candidate:0,no_alternatives:0};
  for(const r of perMeter)verdictCounts[r.verdict]++;
  return {perMeter,totalCurrentObservedCost:perMeter.reduce((s,r)=>s+r.currentObservedCost,0),totalSavingsRangeUsd:better.length?addSavingsRanges(better.map(r=>r.bestAlternative!.savingsRangeUsd)):null,reviewedCount:perMeter.length,betterCount:better.length,savingsBasis:reviewSavingsBasis(better.map(r=>r.bestAlternative!.indicative===true)),verdictCounts,sharedNotes,materiality:{...RATE_MATERIALITY},disclosures:["Each service agreement is reviewed and priced separately. Campus-coincident demand is not used for account eligibility or demand charges.","The total sums account-specific covered periods, not an annual forecast. Savings from rate review overlap with efficiency estimates and must not be added to them.",...Array.from(new Set(perMeter.flatMap(r=>[...r.disclosures,...(r.bestAlternative?.disclosures??[])])))]};
}
