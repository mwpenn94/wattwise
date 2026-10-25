import type { CostBreakdown, IntervalPoint, TariffStructure } from "../../shared/wattwise";
import { addSavingsRanges, type SavingsRangeUsd } from "../../shared/savingsRange";
import { computeDemandAnalytics, costOnTariff, type CostResult } from "./tariffEngine";

export interface AccountPricingComponent {
  meterId:number;label:string;points:IntervalPoint[];structure:TariffStructure;tariffId:number;tariffName:string;
  utilityName:string;timezone:string;rateCodeResolution?:{match:"exact"|"family_inferred";disclosure:string};disclosures?:string[];
}
export interface RateReviewCandidate {
  id:number;name:string;utilityName:string;structure:TariffStructure;freshness:string;
  eligibleFor:(peakKw:number,component:AccountPricingComponent)=>boolean;
}
export interface CoveredPeriod {fromTs:number;toTs:number;calendarMonths:number;partialMonths:string[];timezone:string;basis:string}
export interface PerMeterRateReviewRow {
  meterId:number;label:string;tariffId:number;tariffName:string;utilityName:string;currentObservedCost:number;
  peakKw:number;period:CoveredPeriod;disclosures:string[];rateCodeResolution?:{match:"exact"|"family_inferred";disclosure:string};
  bestAlternative:{id:number;name:string;observedCost:number;savingsRangeUsd:SavingsRangeUsd;freshness:string;disclosures:string[];basis:string}|null;
}
export interface MeterRateReview {
  perMeter:PerMeterRateReviewRow[];totalCurrentObservedCost:number;totalSavingsRangeUsd:SavingsRangeUsd|null;
  reviewedCount:number;betterCount:number;disclosures:string[];savingsBasis:string;
}
export const RATE_RANGE_BASIS="Screening convention: 70–100% of the same-account, same-observed-period repricing difference; not a statistical confidence interval, annual projection or bill guarantee. Confirm utility eligibility before switching.";
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
  const notes=Array.from(new Set(priced.flatMap(({component,cost})=>disclosures(component,cost))));
  notes.push(`Priced ${components.length} separately billed service agreements in each account's timezone; campus subtotal is the sum of observed-window account subtotals. No account is priced on coincident campus demand.`,"Monthly billed-demand details are omitted because separately billed accounts do not have one campus billing determinant.","Covered-period amounts are not annualized; calendar months, including partial boundary months, are not verified utility billing cycles.");
  return {combined:{breakdown:sumBreakdowns(priced.map(p=>p.cost)),monthlyDetails:[],monthlyCosts:Array.from(byMonth.values()).sort((a,b)=>a.month.localeCompare(b.month)),disclosures:notes,pricingStatus:priced.some(p=>p.cost.pricingStatus==="incomplete_rider_coverage")?"incomplete_rider_coverage":"modeled_subtotal",switchRecommendationAllowed:priced.every(p=>p.cost.switchRecommendationAllowed!==false)} as CostResult,
    perMeter:priced.map(({component,cost})=>({meterId:component.meterId,label:component.label,tariffId:component.tariffId,tariffName:component.tariffName,observedCost:cost.breakdown.total,period:period(component,cost),peakKw:computeDemandAnalytics(component.points,4,[6,7,8,9],component.timezone)?.peakKw??0}))};
}
export function perMeterRateReview(components:AccountPricingComponent[],candidates:RateReviewCandidate[],_tz?:string):MeterRateReview {
  const perMeter=components.map(component=>{
    const current=price(component);const peakKw=computeDemandAnalytics(component.points,4,[6,7,8,9],component.timezone)?.peakKw??0;
    const notes=disclosures(component,current);
    const eligible=candidates.filter(c=>c.id!==component.tariffId&&sameAccountProvider(c.utilityName,component.utilityName)&&c.eligibleFor(peakKw,component));
    const alternatives=eligible.map(c=>({candidate:c,cost:price(component,c.structure)})).filter(c=>c.cost.switchRecommendationAllowed!==false).sort((a,b)=>a.cost.breakdown.total-b.cost.breakdown.total);
    const cheapest=alternatives[0];const difference=cheapest?current.breakdown.total-cheapest.cost.breakdown.total:0;
    const allowed=current.switchRecommendationAllowed!==false&&component.rateCodeResolution?.match!=="family_inferred";
    if(!allowed)notes.push("Alternative savings withheld: incomplete or inferred account billing basis. Confirm missing riders, tariff identity and account terms first.");
    const bestAlternative=allowed&&cheapest&&difference>Math.max(50,current.breakdown.total*0.02)?{id:cheapest.candidate.id,name:cheapest.candidate.name,observedCost:cheapest.cost.breakdown.total,savingsRangeUsd:{low:difference*0.7,high:difference},freshness:cheapest.candidate.freshness,disclosures:disclosures(component,cheapest.cost),basis:RATE_RANGE_BASIS}:null;
    return {meterId:component.meterId,label:component.label,tariffId:component.tariffId,tariffName:component.tariffName,utilityName:component.utilityName,currentObservedCost:current.breakdown.total,period:period(component,current),peakKw,bestAlternative,disclosures:notes,rateCodeResolution:component.rateCodeResolution};
  });
  const better=perMeter.filter(r=>r.bestAlternative);
  return {perMeter,totalCurrentObservedCost:perMeter.reduce((s,r)=>s+r.currentObservedCost,0),totalSavingsRangeUsd:better.length?addSavingsRanges(better.map(r=>r.bestAlternative!.savingsRangeUsd)):null,reviewedCount:perMeter.length,betterCount:better.length,savingsBasis:RATE_RANGE_BASIS,disclosures:["Each service agreement is reviewed and priced separately. Campus-coincident demand is not used for account eligibility or demand charges.","The total sums account-specific covered periods, not an annual forecast. Savings from rate review overlap with efficiency estimates and must not be added to them.",...Array.from(new Set(perMeter.flatMap(r=>[...r.disclosures,...(r.bestAlternative?.disclosures??[])])))]};
}
