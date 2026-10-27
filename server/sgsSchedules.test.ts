/**
 * Oct 25 (owner-approved rate-comparison restore):
 *  - official UNS SGS-TOU / SGS-Demand / SGS-Demand-TOU (sheets 202–204) price
 *    to the filed numbers;
 *  - demand tiers, 1-hour averaging and filed holidays are applied;
 *  - an engine that ignores the new fields OVERSTATES (never understates) cost;
 *  - eligibility explains LGS's filed minimum instead of hiding it, excludes
 *    SGS-Demand at 40 kW with the filed reason, and optional schedules are never
 *    the presumed current rate;
 *  - the per-account review lists every eligible schedule, the exclusions and a
 *    plain verdict.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff, notAFitReason, tariffEligible, tariffEligibilityTerms } from "./analytics/tariffEngine";
import { perMeterRateReview, reviewSavingsBasis, RATE_RANGE_BASIS, INDICATIVE_RATE_RANGE_BASIS, type AccountPricingComponent, type RateReviewCandidate } from "./analytics/multiMeter";
import { pickSizeFitBasis } from "./analytics/basisSelect";
import { resolveRateCode } from "./rateCodes";
import { SEED_TARIFFS, SEED_VERSION } from "./seed/seedData";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const seed = (id: string) => SEED_TARIFFS.find((t) => t.urdbId === id)!;
const s = (id: string) => seed(id).structure as TariffStructure;
/** Strip riders so tests check the filed base schedule arithmetic only. */
const base = (id: string): TariffStructure => ({ ...s(id), riders: [], requiredRiderLabels: [] });
/** Old-engine view: drop every field added on Oct 25. */
const legacyView = (st: TariffStructure): TariffStructure => {
  const { energyBlockAdjustments: _a, optionalSchedule: _o, sizeLimitReason: _r, ...rest } = st;
  return { ...rest, demand: st.demand.map(({ tiers: _t, averagingMinutes: _m, holidayExclusions: _h, ...d }) => d) } as TariffStructure;
};
const at = (iso: string, kwh: number, kw: number | null = null, durationMin = 15): IntervalPoint => ({ ts: Date.parse(iso), usage: kwh, demand: kw, durationMin });

describe("official UNS SGS-family schedules (sheets 202–204)", () => {
  it("seeds all three with exact rate codes and a new seed version", () => {
    for (const [code, id] of [["EGSGST", "uns-egsgst"], ["EGSGSD", "uns-egsgsd"], ["EGSGSDT", "uns-egsgsdt"]] as const) {
      expect(seed(id), id).toBeTruthy();
      expect(seed(id).effectiveDate).toBe("2024-02-01");
      expect(s(id).fixedMonthly).toBe(20);
      expect(s(id).optionalSchedule).toBe(true);
      expect(resolveRateCode("UNS Electric", code)).toMatchObject({ urdbId: id, match: "exact" });
    }
    // The SGS rows arrived in 2026.10.6; later releases may bump it again (RATE-7: 2026.10.7).
    const v = (x: string) => x.split(".").map(Number);
    const [a, b] = [v(SEED_VERSION), v("2026.10.6")];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    expect(cmp).toBeGreaterThanOrEqual(0);
  });

  it("SGS-TOU prices each delivery block at the filed sheet 202-1 totals", () => {
    // 1 kWh/hour on summer weekday on-peak hours only (no off-peak use).
    const pts: IntervalPoint[] = [];
    for (let d = 2; d <= 31 && pts.length < 8000; d++) {
      const dow = new Date(Date.UTC(2026, 6, d)).getUTCDay();
      // July 4 2026 is a Saturday, so Friday July 3 is the filed off-peak holiday.
      if (dow === 0 || dow === 6 || d === 3) continue;
      for (let h = 14; h < 20; h++) pts.push(at(`2026-07-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`, 70, null, 60));
    }
    const kwh = pts.reduce((a, p) => a + p.usage, 0);
    expect(kwh).toBeGreaterThan(7500);
    const r = costOnTariff(pts, base("uns-egsgst"), { tz: "UTC" });
    const filed = 400 * 0.184476 + 7100 * 0.189601 + (kwh - 7500) * 0.233162;
    expect(r.breakdown.energy).toBeCloseTo(filed, 6);
    expect(r.breakdown.fixed).toBe(20);
  });

  it("SGS-TOU treats filed holidays as off-peak (Independence Day)", () => {
    const july4 = new Date(Date.UTC(2025, 6, 4)).getUTCDay(); // 2025-07-04 is a Friday
    expect(july4).toBe(5);
    const r = costOnTariff([at("2025-07-04T15:00:00Z", 100, null, 60)], base("uns-egsgst"), { tz: "UTC" });
    expect(r.breakdown.energy).toBeCloseTo(100 * 0.100357, 6); // first-block off-peak total
  });

  it("SGS-Demand bills tiers on the greatest 60-minute on-peak average, excluding holidays", () => {
    // Weekday 2026-07-15: a single 15-minute 30 kW spike inside 2–8 pm; other on-peak readings 10 kW.
    const pts: IntervalPoint[] = [];
    for (let m = 0; m < 6 * 60; m += 15) {
      const ts = Date.parse("2026-07-15T14:00:00Z") + m * 60_000;
      const kw = m === 60 ? 30 : 10;
      pts.push({ ts, usage: kw / 4, demand: kw, durationMin: 15 });
    }
    // A 50 kW reading at 3 pm on July 3 2026 (Friday) — the observed Independence Day holiday (July 4 is a Saturday).
    pts.push({ ts: Date.parse("2026-07-03T15:00:00Z"), usage: 12.5, demand: 50, durationMin: 15 });
    const r = costOnTariff(pts, base("uns-egsgsd"), { tz: "UTC" });
    const avgKw = (30 + 10 + 10 + 10) / 4; // 15 kW greatest rolling hour
    expect(r.breakdown.demand).toBeCloseTo(7 * 8.46 + (avgKw - 7) * 11.27, 6);
    const kwh = pts.reduce((a, p) => a + p.usage, 0);
    expect(r.breakdown.energy).toBeCloseTo(kwh * 0.083206, 6);
  });

  it("winter's two on-peak windows share one billing peak (billed once, not per window)", () => {
    const pts: IntervalPoint[] = [];
    for (let m = 0; m < 60; m += 15) pts.push({ ts: Date.parse("2026-01-14T06:00:00Z") + m * 60_000, usage: 5, demand: 20, durationMin: 15 });
    for (let m = 0; m < 60; m += 15) pts.push({ ts: Date.parse("2026-01-14T18:00:00Z") + m * 60_000, usage: 3, demand: 12, durationMin: 15 });
    const r = costOnTariff(pts, base("uns-egsgsd"), { tz: "UTC" });
    expect(r.breakdown.demand).toBeCloseTo(7 * 8.46 + 13 * 11.27, 6);
  });

  it("SGS-Demand-TOU uses the filed TOU energy prices with the same demand charge", () => {
    const pts = [at("2026-01-14T06:00:00Z", 10, 10), at("2026-01-14T12:00:00Z", 10, 4)];
    const r = costOnTariff(pts, base("uns-egsgsdt"), { tz: "UTC" });
    expect(r.breakdown.energy).toBeCloseTo(10 * 0.156053 + 10 * 0.065813, 6);
  });

  it("per-kW TCA bills the on-peak billing demand on SGS-Demand", () => {
    const pts: IntervalPoint[] = [];
    for (let m = 0; m < 60; m += 15) pts.push({ ts: Date.parse("2026-07-15T15:00:00Z") + m * 60_000, usage: 5, demand: 20, durationMin: 15 });
    pts.push({ ts: Date.parse("2026-07-15T23:00:00Z"), usage: 9, demand: 36, durationMin: 15 }); // off-peak spike
    const r = costOnTariff(pts, s("uns-egsgsd"), { tz: "UTC", restTreatment: "usage" });
    const tca = (r.breakdown.riders ?? []).find((x) => x.label === "TCA");
    expect(tca?.amount).toBeCloseTo(20 * 0.36, 6);
  });

  it("an engine that ignores the new fields overstates cost (never invents savings)", () => {
    const year: IntervalPoint[] = [];
    for (let t = Date.parse("2025-10-01T00:00Z"); t < Date.parse("2026-10-01T00:00Z"); t += 3_600_000) {
      const h = new Date(t).getUTCHours();
      const kw = 4 + (h >= 9 && h < 17 ? 18 : 0) + ((t / 3_600_000) % 37 === 0 ? 9 : 0);
      year.push({ ts: t, usage: kw, demand: kw, durationMin: 60 });
    }
    for (const id of ["uns-egsgst", "uns-egsgsd", "uns-egsgsdt"]) {
      const now = costOnTariff(year, s(id), { tz: "America/Phoenix", restTreatment: "usage" }).breakdown.total;
      const legacy = costOnTariff(year, legacyView(s(id)), { tz: "America/Phoenix", restTreatment: "usage" }).breakdown.total;
      expect(legacy, id).toBeGreaterThanOrEqual(now - 1e-6);
    }
  });
});

describe("filed eligibility", () => {
  const terms = (id: string) => ({ sector: "commercial", commodity: "electric", peakKwMin: seed(id).peakKwMin, peakKwMax: seed(id).peakKwMax, closedToNew: false, techCondition: null, ...tariffEligibilityTerms(s(id)) });
  const site = { sectorClass: "commercial", hasSolar: false, monthlyImportedKwh: [{ month: "2026-07", kwh: 900 }, { month: "2026-08", kwh: 950 }] };
  it("LGS stays available to a small account but states its 450 kW monthly minimum", () => {
    const r = tariffEligible(terms("uns-lgs"), site, 3);
    expect(r.eligible).toBe(true);
    expect(r.belowMinimumDemandKw).toBe(450);
    expect(r.conditions?.join(" ")).toMatch(/at least 450 kW of demand every month/);
  });
  it("SGS-Demand and SGS-Demand-TOU exclude accounts at 40 kW+ with the filed reason", () => {
    for (const id of ["uns-egsgsd", "uns-egsgsdt"]) {
      const r = tariffEligible(terms(id), site, 55);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/40 kW or more/);
      expect(r.reason).toMatch(/55 kW/);
      expect(tariffEligible(terms(id), site, 25).eligible).toBe(true);
    }
  });
  it("SGS-TOU follows the 12,000 kWh two-month migration to MGS-TOU", () => {
    const big = { ...site, monthlyImportedKwh: [{ month: "2026-07", kwh: 13000 }, { month: "2026-08", kwh: 12500 }] };
    const r = tariffEligible(terms("uns-egsgst"), big, 30);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/MGS-TOU|Medium General Service Time-of-Use/);
    expect(r.reason).toMatch(/sheet 202/);
  });
  it("an optional schedule is never presumed to be the current rate", () => {
    const cands = ["uns-egsgsd", "uns-egsgst", "uns-egsgs", "uns-egmgs"].map((id, i) => ({ id: i + 1, name: seed(id).name, urdbId: id, structure: s(id) }));
    const pick = pickSizeFitBasis(cands, { eligible: () => true, peakKw: 12 });
    expect(pick?.tariff.urdbId).toBe("uns-egsgs");
  });
});

describe("per-account rate review (all options, exclusions, verdicts)", () => {
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const flat = (rate: number, fixed = 0): TariffStructure => ({ fixedMonthly: fixed, energy: [{ label: "All", months: ALL, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: rate }], demand: [] });
  const points: IntervalPoint[] = Array.from({ length: 24 * 30 }, (_, i) => ({ ts: Date.parse("2026-06-01T00:00Z") + i * 3_600_000, usage: 10, demand: 10, durationMin: 60 }));
  const account = (id: number, label: string): AccountPricingComponent => ({ meterId: id, label, points, structure: flat(0.1), tariffId: 1, tariffName: "Current — filed", utilityName: "UNS Electric", timezone: "UTC" });
  const cand = (id: number, name: string, rate: number, eligible = true, listIfIneligible = false): RateReviewCandidate => ({
    id, name, utilityName: "UNS Electric", structure: flat(rate), freshness: "verified", eligibleFor: () => eligible,
    eligibility: () => (eligible ? { eligible: true, conditions: ["Confirm with the utility"] } : { eligible: false, reason: "Filed rule: too large" }), listIfIneligible,
  });
  it("shows every eligible schedule with cost and difference, lists exclusions, and gives a verdict", () => {
    const r = perMeterRateReview([account(1, "Gym")], [cand(2, "Cheaper — x", 0.08), cand(3, "Dearer — x", 0.12), cand(4, "Blocked — x", 0.01, false, true), cand(5, "Other sector", 0.01, false, false)]);
    const row = r.perMeter[0];
    expect(row.options?.map((o) => o.name)).toEqual(["Cheaper", "Current", "Dearer"]);
    const cheaper = row.options!.find((o) => o.name === "Cheaper")!;
    expect(cheaper.differenceUsd).toBeCloseTo(7200 * 0.02, 6);
    expect(cheaper.differencePct).toBeCloseTo(0.2, 6);
    expect(cheaper.conditions).toEqual(["Confirm with the utility"]);
    expect(row.excluded).toEqual([{ id: 4, name: "Blocked", reason: "Filed rule: too large" }]);
    expect(row.verdict).toBe("switch_candidate");
    expect(row.verdictText).toMatch(/Cheaper would have cost \$144 \(20\.0%\) less/);
    expect(r.verdictCounts).toEqual({ lowest: 0, within_threshold: 0, switch_candidate: 1, no_alternatives: 0 });
  });
  it("names small differences as not worth switching instead of hiding them", () => {
    const r = perMeterRateReview([account(1, "Shop")], [cand(2, "Slightly cheaper — x", 0.0995)]);
    const row = r.perMeter[0];
    expect(row.bestAlternative).toBeNull();
    expect(row.verdict).toBe("within_threshold");
    expect(row.options).toHaveLength(2);
    expect(row.verdictText).toMatch(/Not worth a switch request/);
  });
  it("says already lowest, and no alternatives, plainly", () => {
    const lowest = perMeterRateReview([account(1, "A")], [cand(2, "Dearer — x", 0.2)]).perMeter[0];
    expect(lowest.verdict).toBe("lowest");
    expect(lowest.verdictText).toMatch(/Already on the lowest-cost schedule/);
    const none = perMeterRateReview([account(1, "A")], [cand(2, "Blocked — x", 0.01, false, true)]).perMeter[0];
    expect(none.verdict).toBe("no_alternatives");
    expect(none.excluded).toHaveLength(1);
  });
  it("states shared notes once and keeps account-specific notes per account", () => {
    const a = { ...account(1, "A"), disclosures: ["Shared note", "Only A"] };
    const b = { ...account(2, "B"), disclosures: ["Shared note"] };
    const r = perMeterRateReview([a, b], [cand(3, "Dearer — x", 0.2)]);
    expect(r.sharedNotes).toContain("Shared note");
    expect(r.perMeter[0].accountNotes).toEqual(["Only A"]);
    expect(r.perMeter[1].accountNotes).toEqual([]);
  });
});

describe("not-a-fit schedules and size-limit warnings", () => {
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const pts: IntervalPoint[] = Array.from({ length: 24 * 30 }, (_, i) => ({ ts: Date.parse("2026-06-01T00:00Z") + i * 3_600_000, usage: 3, demand: 3, durationMin: 60 }));
  const cur: TariffStructure = { fixedMonthly: 20, energy: [{ label: "All", months: ALL, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 }], demand: [] };
  it("lists a schedule whose filed minimum demand is far above the peak as 'not a fit' with its cost", () => {
    const big: TariffStructure = { ...cur, demand: [{ label: "D", months: ALL, ratePerKw: 10 }], demandMinKw: 450 };
    const r = perMeterRateReview([{ meterId: 1, label: "Shed", points: pts, structure: cur, tariffId: 1, tariffName: "Small — x", utilityName: "UNS Electric", timezone: "UTC" }], [{
      id: 2, name: "Large General Service (EGLGS) — x", utilityName: "UNS Electric", structure: big, freshness: "verified", eligibleFor: () => true,
      eligibility: () => ({ eligible: true, conditions: ["Bills at least 450 kW"], belowMinimumDemandKw: 450 }), listIfIneligible: true,
    }]);
    const row = r.perMeter[0];
    expect(row.options?.map((o) => o.name)).toEqual(["Small"]);
    expect(row.excluded?.[0].reason).toMatch(/Not a fit: bills at least 450 kW .* peaks at 3 kW, so it would have cost \$4,500 more/);
    expect(row.verdict).toBe("lowest");
    expect(row.verdictText).toMatch(/would cost more/);
  });
  it("warns when an account peaks near the SGS-Demand 40 kW limit", () => {
    const terms = { sector: "commercial", commodity: "electric", peakKwMin: null, peakKwMax: 40, closedToNew: false, techCondition: null, ...tariffEligibilityTerms(s("uns-egsgsd")) };
    const r = tariffEligible(terms, { sectorClass: "commercial", hasSolar: false }, 36);
    expect(r.eligible).toBe(true);
    expect(r.conditions?.join(" ")).toMatch(/close to the filed 40 kW limit/);
    expect(tariffEligible(terms, { sectorClass: "commercial", hasSolar: false }, 20).conditions?.join(" ") ?? "").not.toMatch(/close to/);
  });
});

describe("Oct 26: 'not a fit' rule shared by single-account and per-account comparisons", () => {
  const lgs = SEED_TARIFFS.find((t) => t.urdbId === "uns-lgs")!;
  it("flags the 450 kW-minimum Large General Service schedule for a 35 kW account when it costs more", () => {
    const terms = { sector: lgs.sector, commodity: lgs.commodity, peakKwMin: lgs.peakKwMin ?? null, peakKwMax: lgs.peakKwMax ?? null, closedToNew: false, techCondition: null, ...tariffEligibilityTerms(lgs.structure as TariffStructure) };
    const e = tariffEligible(terms, { sectorClass: "commercial", hasSolar: false }, 35);
    expect(e.eligible).toBe(true);
    expect(e.belowMinimumDemandKw).toBe(450);
    const reason = notAFitReason(e.belowMinimumDemandKw, 35, 110_000, 27_920);
    expect(reason).toMatch(/^Not a fit: bills at least 450 kW .* peaks at 35 kW, so it would have cost \$82,080 more\.$/);
  });
  it("keeps a below-minimum schedule as an option if it would still be cheaper", () => {
    expect(notAFitReason(450, 35, 20_000, 27_920)).toBeNull();
  });
  it("never applies when the schedule has no filed minimum or the peak is unknown", () => {
    expect(notAFitReason(undefined, 35, 99_999, 1)).toBeNull();
    expect(notAFitReason(450, null, 99_999, 1)).toBeNull();
  });
});

describe("Oct 26: review-level savings basis matches the ranges shown", () => {
  it("uses the 70–100% basis when every candidate is confirmed, 40–100% when all are indicative, and names both when mixed", () => {
    expect(reviewSavingsBasis([false, false])).toBe(RATE_RANGE_BASIS);
    expect(reviewSavingsBasis([true, true])).toBe(INDICATIVE_RATE_RANGE_BASIS);
    expect(reviewSavingsBasis([])).toBe(RATE_RANGE_BASIS);
    const mixed = reviewSavingsBasis([true, false]);
    expect(mixed).toContain("70–100%");
    expect(mixed).toContain("40–100%");
  });
});
