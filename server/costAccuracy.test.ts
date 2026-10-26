/**
 * Oct 25 cost-accuracy audit fixes:
 *  1. A sub-day edge month (e.g. one end-labeled "Oct 1 00:00" reading) is billed
 *     with its neighbor — never as a 13th month with a full fixed + demand charge.
 *  2. Demand ratchets get a steady-state prior-year estimate when a full data year
 *     is uploaded with no billing history; the observed-only subtotal is disclosed.
 *  3. Timestamp start/end convention is detected from the data's edges.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff, foldEdgeStubMonths } from "./analytics/tariffEngine";
import { priceAccountsSeparately } from "./analytics/multiMeter";
import { detectTimestampBasis, parseSheetRows } from "./ingest/parsers";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const flat = (over: Partial<TariffStructure> = {}): TariffStructure => ({
  fixedMonthly: 100,
  energy: [{ label: "All", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 }],
  demand: [{ label: "Demand", months: ALL_MONTHS, ratePerKw: 10 }],
  ...over,
} as TariffStructure);

/** Hourly points in UTC from `from` (inclusive) to `to` (exclusive), kW given per month. */
function hourly(from: string, to: string, kwFor: (month: number) => number): IntervalPoint[] {
  const out: IntervalPoint[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += 3_600_000) {
    const kw = kwFor(new Date(t).getUTCMonth() + 1);
    out.push({ ts: t, usage: kw, demand: kw, durationMin: 60 });
  }
  return out;
}

describe("edge-month fold", () => {
  const year = () => hourly("2025-10-01T00:00Z", "2026-10-01T00:00Z", () => 10);
  it("bills a single trailing reading with the last full month, not as a 13th month", () => {
    const pts = [...year(), { ts: Date.parse("2026-10-01T00:00Z"), usage: 10, demand: 10, durationMin: 15 }];
    const r = costOnTariff(pts, flat(), { tz: "UTC" });
    expect(r.monthlyCosts.map((m) => m.month)).not.toContain("2026-10");
    expect(r.monthlyCosts).toHaveLength(12);
    expect(r.breakdown.fixed).toBeCloseTo(12 * 100);
    expect(r.edgeMonthFolds).toEqual([{ edge: "end", from: "2026-10", into: "2026-09", intervals: 1, minutes: 15 }]);
    expect(r.disclosures.join(" ")).toMatch(/billed with 2026-09/);
    // Energy is still counted — nothing is dropped.
    const kwh = pts.reduce((s, p) => s + p.usage, 0);
    expect(r.breakdown.energy).toBeCloseTo(kwh * 0.1, 6);
  });
  it("folds a leading sliver too, and leaves full-day edge months alone", () => {
    const lead = { ts: Date.parse("2025-09-30T23:45Z"), usage: 1, demand: 1, durationMin: 15 };
    expect(costOnTariff([lead, ...year()], flat(), { tz: "UTC" }).edgeMonthFolds?.[0]).toMatchObject({ edge: "start", from: "2025-09", into: "2025-10" });
    const fullDay = [...year(), ...hourly("2026-10-01T00:00Z", "2026-10-02T00:00Z", () => 10)];
    const r = costOnTariff(fullDay, flat(), { tz: "UTC" });
    expect(r.edgeMonthFolds).toBeUndefined();
    expect(r.monthlyCosts).toHaveLength(13);
  });
  it("never folds into a non-adjacent month or a thinner neighbor", () => {
    const m = new Map<string, IntervalPoint[]>([
      ["2026-01", [{ ts: 0, usage: 1, demand: 1, durationMin: 15 }]],
      ["2026-03", [{ ts: 1, usage: 1, demand: 1, durationMin: 15 }]],
    ]);
    expect(foldEdgeStubMonths(m)).toEqual([]);
    expect(Array.from(m.keys())).toEqual(["2026-01", "2026-03"]);
  });
});

describe("ratchet history estimate", () => {
  // 75% ratchet over 11 months, determinant billed: a big summer peak (100 kW)
  // should raise the following winter months even at the start of the data.
  const structure = flat({ ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" } as TariffStructure["ratchet"] });
  const pts = hourly("2025-10-01T00:00Z", "2026-10-01T00:00Z", (m) => (m >= 6 && m <= 8 ? 100 : 20));
  it("uses this year's peaks as last year's when a full year is uploaded without bills", () => {
    const r = costOnTariff(pts, structure, { tz: "UTC" });
    const observed = costOnTariff(pts, structure, { tz: "UTC", ratchetHistory: "none" });
    expect(r.ratchetHistory?.basis).toBe("same_months_prior_year");
    expect(r.ratchetHistory?.observedOnlyTotal).toBeCloseTo(observed.breakdown.total, 6);
    // Oct–May are billed at 75 kW (75% of last summer's 100 kW) instead of 20 kW: 8 months × 55 kW × $10.
    expect(r.ratchetHistory?.addedUsd).toBeCloseTo(8 * 55 * 10, 6);
    expect(r.breakdown.total - observed.breakdown.total).toBeCloseTo(4400, 6);
    expect(r.disclosures.join(" ")).toMatch(/steady-state estimate\)\. That adds \$4400\.00/);
    expect(observed.ratchetHistory?.basis).toBe("observed_only");
  });
  it("prefers supplied prior bills and skips the estimate for a partial year", () => {
    const supplied = costOnTariff(pts, structure, { tz: "UTC", priorBilledDemand: [{ month: "2025-09", billedDemandKw: 20 }] });
    expect(supplied.ratchetHistory?.basis).toBe("supplied_bills");
    const half = pts.filter((p) => p.ts < Date.parse("2026-04-01T00:00Z"));
    expect(costOnTariff(half, structure, { tz: "UTC" }).ratchetHistory?.basis).toBe("observed_only");
  });
  it("tariffs without a ratchet report no history basis and are unchanged", () => {
    const r = costOnTariff(pts, flat(), { tz: "UTC" });
    expect(r.ratchetHistory).toBeUndefined();
  });
  it("campus pricing sums per-account additions into one disclosure", () => {
    const comp = (meterId: number) => ({ meterId, label: `M${meterId}`, points: pts, structure, tariffId: 1, tariffName: "T", utilityName: "UNS Electric", timezone: "UTC" });
    const { combined } = priceAccountsSeparately([comp(1), comp(2)]);
    expect(combined.ratchetHistory?.addedUsd).toBeCloseTo(8800, 6);
    const notes = combined.disclosures.filter((n: string) => n.startsWith("No billing history before"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/2 of 2 accounts/);
  });
});

describe("timestamp convention detection", () => {
  const clock = { timeZone: "America/Phoenix", timestampBasis: "start" as const, ambiguousTime: "reject" as const, detectBasis: true };
  const day = (labels: Array<[number, string]>) => [["DATE", "TIME", "KWH_DEL", "KW"], ...labels.map(([d, t]) => [d, t, 1, 4])];
  const times = (from: number, n: number) => Array.from({ length: n }, (_, i) => {
    const m = from + i * 15; return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  });
  it("detects END labels (00:15 … next-day 00:00) and stores UTC interval starts", () => {
    const labels: Array<[number, string]> = [...times(15, 95).map((t) => [20251001, t] as [number, string]), [20251002, "00:00"]];
    const [s] = parseSheetRows("end", day(labels), clock);
    expect(s.timestampBasis).toBe("end");
    expect(s.points[0].ts).toBe(Date.parse("2025-10-01T07:00:00Z"));
    expect(s.points.at(-1)!.ts).toBe(Date.parse("2025-10-02T06:45:00Z"));
    expect(s.validation.notes.join(" ")).toMatch(/detected as the END/);
  });
  it("detects START labels (00:00 … 23:45)", () => {
    const [s] = parseSheetRows("start", day(times(0, 96).map((t) => [20251001, t] as [number, string])), { ...clock, timestampBasis: "end" });
    expect(s.timestampBasis).toBe("start");
    expect(s.points[0].ts).toBe(Date.parse("2025-10-01T07:00:00Z"));
  });
  it("falls back to the chosen convention and says so when edges are ambiguous", () => {
    const [s] = parseSheetRows("mid", day(times(600, 8).map((t) => [20251001, t] as [number, string])), clock);
    expect(s.timestampBasis).toBe("start");
    expect(s.validation.notes.join(" ")).toMatch(/Could not tell/);
  });
  it("explicit choices are honored when detection is off", () => {
    const labels: Array<[number, string]> = times(15, 4).map((t) => [20251001, t] as [number, string]);
    const [s] = parseSheetRows("explicit", day(labels), { ...clock, detectBasis: false });
    expect(s.timestampBasis).toBe("start");
    expect(s.points[0].ts).toBe(Date.parse("2025-10-01T07:15:00Z"));
  });
  it("pure helper: day-aligned edges only", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(detectTimestampBasis(at("2025-10-01T07:15Z"), at("2026-10-01T07:00Z"), 15, "America/Phoenix")).toBe("end");
    expect(detectTimestampBasis(at("2025-10-01T07:00Z"), at("2026-10-01T06:45Z"), 15, "America/Phoenix")).toBe("start");
    expect(detectTimestampBasis(at("2025-10-01T17:00Z"), at("2025-10-01T18:00Z"), 15, "America/Phoenix")).toBeNull();
    expect(detectTimestampBasis(0, 1, 7, "UTC")).toBeNull();
  });
});
describe("pricing performance shortcuts are exact (Oct 26)", () => {
  // TOU energy with filed holidays, a windowed on-peak demand charge with
  // holidays and 1-hour averaging, an anytime ratcheted demand charge, and a
  // capped per-kWh rider — every reading-scan path the shortcuts touch.
  const holidays = ["new_years_day", "memorial_day", "independence_day", "labor_day", "thanksgiving", "christmas_day"] as const;
  const structure = {
    fixedMonthly: 50,
    energy: [
      { label: "Off", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.07 },
      { label: "On", months: ALL_MONTHS, daysOfWeek: [1, 2, 3, 4, 5], hourStart: 14, hourEnd: 20, ratePerUnit: 0.16, holidayExclusions: [...holidays] },
    ],
    demand: [
      { label: "Anytime", months: ALL_MONTHS, ratePerKw: 9 },
      { label: "On-peak", months: ALL_MONTHS, daysOfWeek: [1, 2, 3, 4, 5], hourStart: 14, hourEnd: 20, ratePerKw: 4, averagingMinutes: 60, holidayExclusions: [...holidays] },
    ],
    ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" },
    riders: [{ label: "REST", basis: "kwh", ratePerUnit: 0.01, monthlyCapUsd: 40 }],
  } as unknown as TariffStructure;
  const pts: IntervalPoint[] = [];
  for (let t = Date.parse("2025-10-01T07:00Z"); t < Date.parse("2026-10-01T07:00Z"); t += 900_000) {
    const d = new Date(t);
    const kw = 15 + 40 * Math.max(0, Math.sin((d.getUTCHours() / 24) * Math.PI)) + (d.getUTCMonth() >= 5 && d.getUTCMonth() <= 7 ? 35 : 0) + (d.getUTCDate() % 7);
    pts.push({ ts: t, usage: kw / 4, demand: kw, durationMin: 15 });
  }
  it("the steady-state result's observed-only subtotal equals an independent observed-only pricing", () => {
    const r = costOnTariff(pts, structure, { tz: "America/Phoenix" });
    const standalone = costOnTariff(pts, structure, { tz: "America/Phoenix", ratchetHistory: "none" });
    expect(r.ratchetHistory?.basis).toBe("same_months_prior_year");
    expect(r.ratchetHistory?.observedOnlyTotal).toBe(standalone.breakdown.total);
    expect(r.breakdown.energy).toBe(standalone.breakdown.energy);
    expect(r.ratchetHistory!.addedUsd).toBeGreaterThan(0);
  });
  it("repeated pricing (warm holiday cache) gives the identical result", () => {
    const a = JSON.stringify(costOnTariff(pts, structure, { tz: "America/Phoenix" }));
    const b = JSON.stringify(costOnTariff(pts, structure, { tz: "America/Phoenix" }));
    expect(b).toBe(a);
  });
  it("observed holidays across a year boundary stay off-peak (Jan 1 2028 on Saturday → Dec 31 2027)", () => {
    const onPeakOnly = { ...structure, demand: [], ratchet: undefined, riders: [], fixedMonthly: 0,
      energy: [structure.energy[0], { ...structure.energy[1], hourStart: 0, hourEnd: 24 }] } as unknown as TariffStructure;
    const day = (iso: string) => [{ ts: Date.parse(iso), usage: 1, demand: 4, durationMin: 15 }];
    // Friday Dec 31 2027 is the observed New Year's Day → off-peak rate.
    expect(costOnTariff(day("2027-12-31T19:00Z"), onPeakOnly, { tz: "UTC" }).breakdown.energy).toBeCloseTo(0.07, 10);
    // Thursday Dec 30 2027 is an ordinary weekday → on-peak rate.
    expect(costOnTariff(day("2027-12-30T19:00Z"), onPeakOnly, { tz: "UTC" }).breakdown.energy).toBeCloseTo(0.16, 10);
    // Thanksgiving 2026 (Nov 26) off-peak; the Wednesday before is on-peak.
    expect(costOnTariff(day("2026-11-26T19:00Z"), onPeakOnly, { tz: "UTC" }).breakdown.energy).toBeCloseTo(0.07, 10);
    expect(costOnTariff(day("2026-11-25T19:00Z"), onPeakOnly, { tz: "UTC" }).breakdown.energy).toBeCloseTo(0.16, 10);
  });
});
