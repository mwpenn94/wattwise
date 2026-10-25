import { describe, expect, it } from "vitest";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";
import { priceAccountsSeparately, perMeterRateReview } from "./analytics/multiMeter";
import { costOnTariff } from "./analytics/tariffEngine";
import { sumComponentSeries, requireAlignedCampusSeries, componentFingerprint } from "./virtualTotal";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const flat = (rate: number): TariffStructure => ({
  fixedMonthly: 0,
  energy: [{ label: "all", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: rate }],
  demand: [],
});
const p = (ts: number, usage: number, demand: number | null = null): IntervalPoint => ({ ts, durationMin: 60, usage, demand });

describe("multi-meter campus pricing", () => {
  it("sums independently priced accounts, including riders by label", () => {
    const components = [
      { meterId: 1, label: "Gym", points: [p(Date.UTC(2026, 0, 15), 100, 100)], structure: { ...flat(0.1), riders: [{ label: "Fuel", ratePerUnit: 0.01 }] }, tariffId: 11, tariffName: "Small GS", utilityName:"Test", timezone:"UTC" },
      { meterId: 2, label: "Library", points: [p(Date.UTC(2026, 0, 15), 200, 200)], structure: { ...flat(0.2), riders: [{ label: "Fuel", ratePerUnit: 0.02 }] }, tariffId: 12, tariffName: "Demand GS", utilityName:"Test", timezone:"UTC" },
    ];
    const priced = priceAccountsSeparately(components, "UTC");
    const expected = components.reduce((total, component) => total + costOnTariff(component.points, component.structure, { tz: "UTC" }).breakdown.total, 0);
    expect(priced.combined.breakdown.total).toBeCloseTo(expected, 8);
    expect(priced.combined.breakdown.riders).toEqual([{ label: "Fuel", amount: 5 }]);
    expect(priced.combined.monthlyDetails).toEqual([]);
    expect(priced.combined.disclosures.join(" ")).toContain("separately billed");
  });

  it("finds a cheaper eligible alternative independently for each account", () => {
    const points = Array.from({ length: 10 }, (_, hour) => p(Date.UTC(2026, 0, 15, hour), 100, 50));
    const components = [{ meterId: 1, label: "Gym", points, structure: flat(0.2), tariffId: 1, tariffName: "Current", utilityName:"Test", timezone:"UTC" }];
    const review = perMeterRateReview(
      components,
      [
        { id: 1, name: "Current", utilityName: "Test", structure: flat(0.2), freshness: "verified", eligibleFor: () => true },
        { id: 2, name: "Cheaper", utilityName: "Test", structure: flat(0.1), freshness: "verified", eligibleFor: (peakKw) => peakKw >= 40 },
        { id: 3, name: "Ineligible", utilityName: "Test", structure: flat(0.01), freshness: "verified", eligibleFor: () => false },
      ],
      "UTC",
    );
    expect(review.betterCount).toBe(1);
    expect(review.perMeter[0]?.bestAlternative).toMatchObject({ id: 2, name: "Cheaper", savingsRangeUsd: { low:70, high:100 } });
    expect(review.totalSavingsRangeUsd).toEqual({low:70,high:100});
  });

  it("keeps only matching duration points and nulls demand unless every account reports it", () => {
    const ts = Date.UTC(2026, 0, 1);
    const result = sumComponentSeries([
      [p(ts, 10, 5), { ts: ts + 3_600_000, durationMin: 60, usage: 20, demand: 10 }],
      [p(ts, 15, null), { ts: ts + 3_600_000, durationMin: 30, usage: 8, demand: 4 }],
    ]);
    expect(result.points).toEqual([{ ts, durationMin: 60, usage: 25, demand: null }]);
    expect(result.notes.join(" ")).toMatch(/Excluded 2 unmatched/);
    expect(result.notes.join(" ")).toMatch(/Demand is null/);
  });
});

describe("review safety regressions",()=>{
  const points=Array.from({length:10},(_,hour)=>p(Date.UTC(2026,0,15,hour),100,50));
  const account={meterId:1,label:"Gym",points,structure:flat(0.2),tariffId:1,tariffName:"Current",utilityName:"UNS Electric",timezone:"UTC"};
  it("never offers a foreign utility even when it is cheaper",()=>{
    const r=perMeterRateReview([account],[{id:2,name:"APS",utilityName:"APS",structure:flat(0.01),freshness:"verified",eligibleFor:()=>true},{id:3,name:"UNS",utilityName:"UNS Electric",structure:flat(0.1),freshness:"verified",eligibleFor:()=>true}],"UTC");
    expect(r.perMeter[0]?.bestAlternative?.id).toBe(3);
    expect(r.perMeter[0]?.period).toMatchObject({fromTs:points[0]!.ts,toTs:points.at(-1)!.ts+3600000,calendarMonths:1});
    expect(r.savingsBasis).toContain("70–100%");
    expect(r.perMeter[0]).not.toHaveProperty("currentAnnualCost");
  });
  it("prices each account using its own timezone rather than the campus clock",()=>{
    const structure={...flat(0.1),energy:[{label:"peak",months:ALL_MONTHS,daysOfWeek:ALL_DAYS,hourStart:12,hourEnd:13,ratePerUnit:1},{label:"base",months:ALL_MONTHS,daysOfWeek:ALL_DAYS,hourStart:0,hourEnd:24,ratePerUnit:0.1}]};
    const accounts=[{...account,points:[p(Date.UTC(2026,0,15,12),100)],structure,timezone:"UTC"},{...account,meterId:2,points:[p(Date.UTC(2026,0,15,12),100)],structure,timezone:"America/Phoenix"}];
    const r=priceAccountsSeparately(accounts,"UTC");
    expect(r.combined.breakdown.total).toBeCloseTo(accounts.reduce((s,c)=>s+costOnTariff(c.points,c.structure,{tz:c.timezone}).breakdown.total,0),8);
    expect(r.perMeter[0]?.observedCost).not.toBe(r.perMeter[1]?.observedCost);
  });
  it("shows an indicative (wider) range on inferred billing bases and retains every disclosure",()=>{
    const r=perMeterRateReview([{...account,rateCodeResolution:{match:"family_inferred",disclosure:"EGMGSQ inferred, unconfirmed"},disclosures:["Provider conflict","Rider caveat"]}],[{id:2,name:"Cheap",utilityName:"UNS Electric",structure:flat(0.1),freshness:"verified",eligibleFor:()=>true}]);
    expect(r.totalSavingsRangeUsd).toEqual({low:40,high:100});expect(r.perMeter[0]?.bestAlternative?.indicative).toBe(true);
    expect(r.disclosures.join(" ")+r.perMeter[0]!.disclosures.join(" ")).toContain("Indicative");
    expect(r.disclosures.join(" ")).toContain("Rider caveat");expect(r.disclosures.join(" ")).toContain("EGMGSQ inferred");
  });
  it("rejects empty, missing, mixed-duration or overlapping component coverage",()=>{
    const ts=Date.UTC(2026,0,1);const a=[p(ts,1),p(ts+3600000,1)];
    expect(()=>requireAlignedCampusSeries([a,[]])).toThrow("Incomplete campus alignment");
    expect(()=>requireAlignedCampusSeries([a,[p(ts,1)]])).toThrow();
    expect(()=>requireAlignedCampusSeries([a,[{...p(ts,1),durationMin:30},p(ts+3600000,1)]])).toThrow();
    expect(()=>requireAlignedCampusSeries([[p(ts,1),p(ts,1)],a])).toThrow();
    expect(requireAlignedCampusSeries([a,a]).points).toHaveLength(2);
  });
  it("fingerprints corrected historical contents rather than only maximum timestamp",()=>{
    const components=[{id:1,timezone:"UTC"}];
    const a=componentFingerprint(components,[[p(0,1),p(3600000,2)]]);
    const b=componentFingerprint(components,[[p(0,999),p(3600000,2)]]);
    expect(a).not.toBe(b);
  });
});
