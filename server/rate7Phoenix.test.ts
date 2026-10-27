/**
 * RATE-7 (Oct 26 2026): City of Phoenix water, Water Rate Schedule effective
 * March 1, 2025 (inside City). Every expected dollar figure below is computed
 * by hand from the City's published per-CCF numbers, independent of the
 * engine's per-gallon storage:
 *   service charge (5/8 in.) $4.64/mo, includes 5 CCF Oct–May, 8 CCF Jun–Sep
 *   user charge above the included use: low (Dec–Mar) $4.93, medium
 *   (Apr–May, Oct–Nov) $5.65, high (Jun–Sep) $6.13 per CCF
 *   environmental charge $0.62/CCF on ALL use; 1 CCF = 748 gallons.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff, normalizeMeterSize } from "./analytics/tariffEngine";
import { PHX_WATER_STRUCTURE, SEED_TARIFFS } from "./seed/seedData";
import { RATE_SOURCE_SEEDS } from "./rateCurrency";
import { usageConversion, WATER_METER_SIZES } from "../shared/commodity";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const TZ = "America/Phoenix";
const GAL = 748;
/** One full calendar month of hourly readings totalling `gallons`. */
function month(year: number, m: number, gallons: number): IntervalPoint[] {
  const start = Date.UTC(year, m - 1, 1, 7); // 00:00 Phoenix (UTC-7, no DST)
  const end = Date.UTC(m === 12 ? year + 1 : year, m === 12 ? 0 : m, 1, 7);
  const hours = Math.round((end - start) / 3_600_000);
  const per = gallons / hours;
  return Array.from({ length: hours }, (_, i) => ({ ts: start + i * 3_600_000, usage: per, demand: per, durationMin: 60 }));
}
/** Hand bill from the City's per-CCF schedule. */
function handBill(ccf: number, season: "low" | "medium" | "high"): number {
  const included = season === "high" ? 8 : 5;
  const user = { low: 4.93, medium: 5.65, high: 6.13 }[season];
  return 4.64 + Math.max(0, ccf - included) * user + ccf * 0.62;
}
const costOf = (pts: IntervalPoint[], s: TariffStructure = PHX_WATER_STRUCTURE) => costOnTariff(pts, s, { tz: TZ });

describe("RATE-7 Phoenix water rows", () => {
  it("both rows carry the filed March 1, 2025 schedule and are governed by the Phoenix source", () => {
    const comm = SEED_TARIFFS.find((t) => t.urdbId === "phxwater-az-comm")!;
    const res = SEED_TARIFFS.find((t) => t.urdbId === "phxwater-az-res")!;
    expect(comm.sector).toBe("commercial");
    expect(res.sector).toBe("residential");
    for (const r of [comm, res]) {
      expect(r.commodity).toBe("water");
      expect(r.effectiveDate).toBe("2025-03-01");
      expect(r.structure.fixedMonthly).toBe(4.64);
      expect(r.structure.meterSizeCharges?.map((m) => m.monthly)).toEqual([4.64, 6.03, 8.81, 15.77, 24.13, 43.62, 71.46, 141.06]);
      // energy[0] is the LOWEST marginal rate, so single-rate readers stay conservative.
      const rates = r.structure.energy.map((e) => e.ratePerUnit);
      expect(rates[0]).toBe(Math.min(...rates));
      expect(r.structure.energy[0].ratePerUnit * GAL).toBeCloseTo(4.93 + 0.62, 6);
    }
    const src = RATE_SOURCE_SEEDS.find((s) => s.sourceKey === "phxwater-az-water")!;
    expect(src.governsUrdbIds).toEqual(["phxwater-az-comm", "phxwater-az-res"]);
  });

  it("every calendar month has exactly one season rate and one allowance", () => {
    for (let m = 1; m <= 12; m++) {
      expect(PHX_WATER_STRUCTURE.energy.filter((e) => e.months.includes(m))).toHaveLength(1);
      expect(PHX_WATER_STRUCTURE.seasonalEnergyBlockAdjustments!.filter((a) => a.months.includes(m))).toHaveLength(1);
    }
  });

  it.each([
    ["low", 1, 12],
    ["low", 12, 3],
    ["medium", 4, 20],
    ["medium", 10, 5],
    ["high", 7, 30],
    ["high", 9, 8],
  ] as const)("%s season, month %i, %i CCF matches the hand bill", (season, m, ccf) => {
    const c = costOf(month(2026, m, ccf * GAL));
    expect(c.monthlyCosts).toHaveLength(1);
    expect(c.breakdown.total).toBeCloseTo(handBill(ccf, season), 2);
    expect(c.breakdown.fixed).toBeCloseTo(4.64, 6);
  });

  it("use inside the allowance pays only the service and environmental charges", () => {
    // 3 CCF in January (allowance 5): $4.64 + 3 × $0.62 = $6.50
    expect(costOf(month(2026, 1, 3 * GAL)).breakdown.total).toBeCloseTo(6.5, 2);
    // 7 CCF in August (allowance 8): $4.64 + 7 × $0.62 = $8.98
    expect(costOf(month(2026, 8, 7 * GAL)).breakdown.total).toBeCloseTo(8.98, 2);
    // Zero use: just the service charge.
    expect(costOf(month(2026, 3, 0)).breakdown.total).toBeCloseTo(4.64, 2);
  });

  it("a full year equals the sum of twelve hand bills", () => {
    const ccfByMonth = [10, 9, 11, 14, 18, 26, 31, 30, 24, 16, 12, 10];
    const season = (m: number) => ([12, 1, 2, 3].includes(m) ? "low" : [6, 7, 8, 9].includes(m) ? "high" : "medium");
    const pts = ccfByMonth.flatMap((ccf, i) => month(2026, i + 1, ccf * GAL));
    const expected = ccfByMonth.reduce((a, ccf, i) => a + handBill(ccf, season(i + 1) as "low" | "medium" | "high"), 0);
    const c = costOf(pts);
    expect(c.monthlyCosts).toHaveLength(12);
    expect(c.breakdown.total).toBeCloseTo(expected, 1);
  });

  it("CCF readings priced after usageConversion match the same use in gallons", () => {
    const conv = usageConversion("water", "CCF");
    expect(conv.toUnit).toBe("gallons");
    const ccfPts = month(2026, 7, 30); // 30 CCF stored as written
    const asGallons = ccfPts.map((p) => ({ ...p, usage: p.usage * conv.factor, demand: (p.demand ?? 0) * conv.factor }));
    // usageConversion uses 748.052 gal/CCF (exact); the City bills 748. The
    // difference on 30 CCF is under a cent per CCF.
    expect(costOf(asGallons).breakdown.total).toBeCloseTo(handBill(30, "high"), 1);
  });

  it("discloses the allowance, the meter-size range, and what is not modeled", () => {
    const d = costOf(month(2026, 7, 30 * GAL)).disclosures.join(" ");
    expect(d).toMatch(/Included-use allowance applied by calendar month/);
    expect(d).toMatch(/depends on meter size \(\$4\.64–\$141\.06\/mo\)/);
    expect(d).toMatch(/Outside-City service is billed at 150%/);
    expect(d).toMatch(/Sales taxes and surcharges are not included/);
  });

  it("the new engine fields are off for every other tariff (identical prices)", () => {
    const others = SEED_TARIFFS.filter((t) => !t.urdbId?.startsWith("phxwater-"));
    expect(others.some((t) => t.structure.seasonalEnergyBlockAdjustments || t.structure.meterSizeCharges)).toBe(false);
    const pts = month(2026, 7, 1000);
    for (const t of others.filter((t) => t.commodity !== "electric").slice(0, 6)) {
      const withField = { ...t.structure, seasonalEnergyBlockAdjustments: [] };
      expect(costOf(pts, withField).breakdown.total).toBeCloseTo(costOf(pts, t.structure).breakdown.total, 9);
    }
  });
});

describe("RATE-7b meter size", () => {
  const sized = (pts: IntervalPoint[], meterSize: string | null, st: TariffStructure = PHX_WATER_STRUCTURE) => costOnTariff(pts, st, { tz: TZ, meterSize });
  it("every picker size matches a filed Phoenix size, and common spellings normalize to it", () => {
    const filed = new Set(PHX_WATER_STRUCTURE.meterSizeCharges!.map((m) => normalizeMeterSize(m.size)));
    for (const sz of WATER_METER_SIZES.filter((x) => filed.has(normalizeMeterSize(x)))) expect(normalizeMeterSize(sz)).toBe(sz);
    expect(filed.size).toBe(PHX_WATER_STRUCTURE.meterSizeCharges!.length);
    for (const m of PHX_WATER_STRUCTURE.meterSizeCharges!) expect(WATER_METER_SIZES as readonly string[]).toContain(normalizeMeterSize(m.size));
    expect(normalizeMeterSize('1 1/2"')).toBe("1-1/2 in.");
    expect(normalizeMeterSize("1.5 inch")).toBe("1-1/2 in.");
    expect(normalizeMeterSize("5/8")).toBe("5/8 in.");
    expect(normalizeMeterSize(" 2 in ")).toBe("2 in.");
    expect(normalizeMeterSize(null)).toBeNull();
  });
  it("a known size uses its filed monthly service charge; usage charges are unchanged", () => {
    const pts = month(2025, 1, 20 * GAL);
    const base = sized(pts, null).breakdown;
    for (const m of PHX_WATER_STRUCTURE.meterSizeCharges!) {
      const b = sized(pts, m.size).breakdown;
      expect(b.fixed).toBeCloseTo(m.monthly, 9);
      expect(b.energy).toBeCloseTo(base.energy, 9);
      expect(b.total).toBeCloseTo(handBill(20, "low") - 4.64 + m.monthly, 4); // per-gallon storage: sub-cent rounding only
    }
    const d = sized(pts, "1 in.").disclosures.join(" ");
    expect(d).toMatch(/Monthly service charge for a 1 in\. meter: \$8\.81 \(filed range \$4\.64–\$141\.06\/mo by meter size\)/);
    expect(d).not.toMatch(/not on file/);
  });
  it("no size or an unfiled size falls back to the smallest charge and says so", () => {
    const pts = month(2025, 7, 10 * GAL);
    for (const v of [null, undefined, "12 in."]) {
      const r = costOnTariff(pts, PHX_WATER_STRUCTURE, { tz: TZ, meterSize: v as string | null | undefined });
      expect(r.breakdown.fixed).toBeCloseTo(4.64, 9);
      expect(r.disclosures.join(" ")).toMatch(/meter size is not on file, so the smallest size \(\$4\.64\) is used.*Set the meter size on the Sites page/);
    }
  });
  it("tariffs without meter-size charges ignore the size entirely", () => {
    const pts = month(2026, 7, 1000);
    for (const t of SEED_TARIFFS.filter((t) => !t.structure.meterSizeCharges).slice(0, 12)) {
      expect(sized(pts, "2 in.", t.structure).breakdown.total).toBe(sized(pts, null, t.structure).breakdown.total);
    }
  });
});
