import { describe, expect, it } from "vitest";
import { applyRatchet, costOnTariff, monthlyImportedKwh, tariffEligible, tariffEligibilityTerms } from "./analytics/tariffEngine";
import { SEED_TARIFFS } from "./seed/seedData";
import { resolveRateCode } from "./rateCodes";
import type { IntervalPoint } from "../shared/wattwise";

const seed = (id: string) => SEED_TARIFFS.find((t) => t.urdbId === id)!;
const p = (date: string, usage = 1, demand = 1): IntervalPoint => ({ ts: Date.parse(date), usage, demand, durationMin: 15 });
const price = (id: string, date: string, usage = 1, demand = 1) => costOnTariff([p(date, usage, demand)], seed(id).structure, { tz: "UTC", restTreatment: "usage" });
const riders = (r: ReturnType<typeof costOnTariff>) => Object.fromEntries((r.breakdown.riders ?? []).map((x) => [x.label, x.amount]));

describe("UNS official tariff corrections (R2)", () => {
  it.each([
    ["2025-10", .016629], ["2025-11", .015548], ["2025-12", .014480], ["2026-01", .013425],
    ["2026-02", .012384], ["2026-03", .011356], ["2026-04", .010341], ["2026-05", .009338],
    ["2026-06", .008348], ["2026-07", .007370], ["2026-08", .006404], ["2026-09", .005450], ["2026-10", .004508],
  ])("uses sheet 701-1 history in %s", (month, rate) => {
    expect(riders(price("uns-egsgs", `${month}-15T12:00:00Z`, 10000)).PPFAC).toBeCloseTo(10000 * rate, 8);
  });
  it("dates separate surcharge, credit, TEAM and REST; does not extrapolate future PPFAC", () => {
    expect(riders(price("uns-egsgs", "2025-11-15T12:00Z", 10000))["PPFAC temporary surcharge"]).toBeCloseTo(222.59);
    expect(riders(price("uns-egsgs", "2025-12-15T12:00Z", 10000))["PPFAC temporary surcharge"]).toBeUndefined();
    const jan = price("uns-egsgs", "2026-01-15T12:00Z", 10000);
    expect(riders(jan).PPFAC).toBeCloseTo(134.25);
    expect(riders(jan).REST).toBeUndefined();
    expect(jan.pricingStatus).toBe("incomplete_rider_coverage");
    expect(jan.switchRecommendationAllowed).toBe(false);
    expect(jan.missingRiderCoverage?.[0].labels).toEqual(expect.arrayContaining(["REST", "TCA"]));
    expect(riders(price("uns-egsgs", "2025-12-15T12:00Z")).TEAM).toBeUndefined();
    expect(riders(price("uns-egsgs", "2026-04-15T12:00Z"))["PPFAC temporary credit"]).toBeUndefined();
    expect(riders(price("uns-egsgs", "2026-05-15T12:00Z", 10000))["PPFAC temporary credit"]).toBeCloseTo(-209.31);
    const future = price("uns-egsgs", "2026-11-15T12:00Z");
    expect(riders(future).PPFAC).toBeUndefined();
    expect(future.pricingStatus).toBe("incomplete_rider_coverage");
  });
  it("charges class-specific TCA on billed demand or energy from June, never earlier", () => {
    expect(riders(price("uns-egsgs", "2026-08-15T12:00Z", 10000)).TCA).toBeCloseTo(14.74);
    expect(riders(price("uns-egmgs", "2026-08-15T12:00Z", 10000, 10)).TCA).toBeCloseTo(20 * .36);
    expect(riders(price("uns-egmgs", "2026-05-15T12:00Z", 10000, 10)).TCA).toBeUndefined();
  });
  it("enforces EGLGS 450-kW minimum and only confirmed primary service receives credit", () => {
    const st = seed("uns-lgs").structure;
    const pts = [p("2026-08-15T12:00Z", 10, 50)];
    expect(costOnTariff(pts, st).breakdown.demand).toBeCloseTo(6561);
    expect(costOnTariff(pts, st, { primaryVoltage: true }).breakdown.demand).toBeCloseTo(6561 * .97);
    expect(costOnTariff(pts, st, { contractCapacityKw: 600 }).breakdown.demand).toBeCloseTo(600 * 14.58);
    expect(costOnTariff(pts, st).disclosures.join(" ")).toContain("Secondary-voltage");
  });
  it("ratchets on recursively billed demand over preceding calendar months", () => {
    const history = Array.from({ length: 13 }, (_, i) => ({ month: new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7), peakKw: i === 0 ? 1000 : 10, peakTs: 0 }));
    const ratchet = seed("uns-egmgs").structure.ratchet;
    expect(applyRatchet(history, ratchet, { demandMinKw: 20 })[12].billedDemandKw).toBe(562.5);
    expect(applyRatchet([{ month: "2024-01", peakKw: 1000, peakTs: 0 }, { month: "2026-01", peakKw: 10, peakTs: 0 }], ratchet, { demandMinKw: 20 })[1].billedDemandKw).toBe(20);
    expect(applyRatchet([{ month: "2026-01", peakKw: 10, peakTs: 0 }], ratchet, { demandMinKw: 20, priorBilledDemand: [{ month: "2025-12", billedDemandKw: 800 }] })[0].billedDemandKw).toBe(600);
  });
  it.each(["2026-07-03T18:00:00-07:00", "2027-07-05T18:00:00-07:00", "2027-12-31T18:00:00-07:00"])("observes Friday/Monday and cross-year holidays %s", (date) => {
    const summer = date.includes("-07-");
    const r = costOnTariff([p(date)], seed("uns-egmgst").structure, { tz: "America/Phoenix" });
    expect(r.breakdown.energy).toBeCloseTo(summer ? .048460 : .046609, 6);
  });
  it.each([["uns-egmgst", 14, 20, .155789, .048460], ["uns-egmgsst", 15, 19, .163269, .055940]] as const)("respects exact TOU boundaries %s", (id, start, end, on, off) => {
    expect(price(id, `2026-07-07T${start}:00:00Z`).breakdown.energy).toBe(on);
    expect(price(id, `2026-07-07T${end}:00:00Z`).breakdown.energy).toBe(off);
  });
  it("rejects consecutive 12000-kWh SGS switch targets but retains assigned baseline", () => {
    const s = seed("uns-egsgs");
    const t = { ...s, ...tariffEligibilityTerms(s.structure) };
    const site = { sectorClass: "commercial", switchTermsConfirmed: true, monthlyImportedKwh: [{ month: "2026-06", kwh: 12000 }, { month: "2026-07", kwh: 12000 }] };
    expect(tariffEligible(t, site, 20).eligible).toBe(false);
    expect(tariffEligible(t, { ...site, isCurrentBasis: true }, 20).eligible).toBe(true);
    expect(tariffEligible(t, { ...site, monthlyImportedKwh: [{ month: "2026-04", kwh: 12000 }, { month: "2026-07", kwh: 12000 }] }, 20).eligible).toBe(true);
    expect(monthlyImportedKwh([p("2026-06-01T12:00Z", 10), p("2026-06-01T13:00Z", -5)], "UTC")).toEqual([{ month: "2026-06", kwh: 10 }]);
  });
  it("requires confirmed K12 and switching terms, not school/daycare labels", () => {
    const s = seed("uns-egmgsst"); const t = { ...s, ...tariffEligibilityTerms(s.structure) };
    const site = { sectorClass: "commercial", buildingType: "school" };
    expect(tariffEligible(t, site, 50).eligible).toBe(false);
    expect(tariffEligible(t, { ...site, k12Confirmed: true }, 50).eligible).toBe(false);
    expect(tariffEligible(t, { ...site, k12Confirmed: true, switchTermsConfirmed: true }, 50).eligible).toBe(true);
    expect(tariffEligible(t, { ...site, buildingType: "daycare", k12Confirmed: true, switchTermsConfirmed: true }, 50).eligible).toBe(false);
  });
  it("uses renewable REST flat charges independently of net imports and discloses unknown treatment", () => {
    for (const [id, expected] of [["uns-egsgs", 13.46], ["uns-egmgs", 203.39], ["uns-lgs", 911.50]] as const) {
      const st = seed(id).structure;
      for (const use of [0, 10000]) expect(riders(costOnTariff([p("2026-08-15T12:00Z", use)], st, { restTreatment: "renewable_class_average" })).REST).toBe(expected);
      const unknown = costOnTariff([p("2026-08-15T12:00Z", 10000)], st);
      expect(unknown.restConditionalTotal).toBeDefined();
      expect(unknown.switchRecommendationAllowed).toBe(false);
      expect(unknown.disclosures.join(" ")).toContain("REST treatment unconfirmed");
    }
  });
  it("carries inferred bill code into normal pricing output and never certifies a switch", () => {
    const resolution = resolveRateCode("UNS Electric", "EGMGSQ");
    const cost = costOnTariff([p("2026-08-15T12:00Z")], seed("uns-egmgs").structure, { rateCodeResolution: resolution });
    expect(cost.disclosures.join(" ")).toContain("EGMGSQ → EGMGS (inferred, unconfirmed)");
    expect(cost.switchRecommendationAllowed).toBe(false);
  });
  it("itemizes riders so breakdown sums exactly, discloses subtotal and partial months", () => {
    const c = price("uns-egsgs", "2026-08-15T12:00Z", 11264.960);
    const b = c.breakdown;
    expect(b.energy + b.demand + b.fixed + (b.riders ?? []).reduce((s, r) => s + r.amount, 0)).toBeCloseTo(b.total, 8);
    expect(c.coverage?.partialMonths).toEqual(["2026-08"]);
    expect(c.pricingStatus).toBe("modeled_subtotal");
    expect(c.disclosures.join(" ")).toContain("excludes LFCR");
    expect(b.total).toBeCloseTo(1408.059728320, 8);
    expect(price("uns-egmgs", "2026-08-15T12:00Z", 20695.376, 55.616).breakdown.total).toBeCloseTo(2480.197437120, 8);
  });
});
