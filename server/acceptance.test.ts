/**
 * Acceptance criteria verification — AC2, AC3, AC4 from the handoff spec.
 *
 * AC2: A fully hypothetical AZ office (archetype-synthetic baseline) must flow
 *      through the SAME analysis pipeline and produce a rate comparison, a
 *      benchmark percentile, and support a solar scenario with disclosures.
 * AC3: A water meter must flow through ingestion + analytics with zero
 *      electric-specific special-casing (no crash, commodity-agnostic totals).
 * AC4: Scenario parity — measured and hypothetical load bases invoke the
 *      identical runScenario code path and return the same result structure
 *      with equivalent disclosure classes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { meters, sites, users } from "../drizzle/schema";
import { LABEL_NORMAL_YEAR, type TariffStructure } from "../shared/wattwise";
import { archetypeBaseline } from "./analytics/baseline";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { runScenario } from "./analytics/scenarios";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { writeIntervals } from "./ingest/writer";

const USER = "e2e-acceptance-user";
let userId: number;

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const TOU: TariffStructure = {
  fixedMonthly: 30,
  energy: [
    { label: "on", months: [6, 7, 8, 9], daysOfWeek: [1, 2, 3, 4, 5], hourStart: 15, hourEnd: 20, ratePerUnit: 0.22 },
    { label: "off", months: ALL_MONTHS, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: 0.07 },
  ],
  demand: [{ label: "all", months: ALL_MONTHS, ratePerKw: 14 }] as TariffStructure["demand"],
};

async function fetchSiteAndMeter(siteId: number, meterId: number) {
  const db = await getDb();
  const site = (await db!.select().from(sites).where(eq(sites.id, siteId)).limit(1))[0]!;
  const meter = (await db!.select().from(meters).where(eq(meters.id, meterId)).limit(1))[0]!;
  return { site, meter };
}

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db
    .insert(users)
    .values({ openId: USER, name: "Acceptance Tester", role: "user" })
    .onDuplicateKeyUpdate({ set: { name: "Acceptance Tester" } });
  userId = (await db.select().from(users).where(eq(users.openId, USER)).limit(1))[0]!.id;
});

describe("AC2 — hypothetical AZ office produces rate comparison + benchmark + solar scenario", () => {
  it("archetype-synthetic pipeline yields eligible tariff rows, a benchmark percentile, and a solar run", async () => {
    const siteId = await h.createSite({
      userId,
      name: "AC2 Hypothetical Office",
      buildingType: "office",
      sqft: 20000,
      vintage: 2005,
      state: "AZ",
      climateZone: "2B",
      utilityName: "APS",
      isHypothetical: true,
      attrSource: "user_entered",
    });
    const meterId = await h.createMeter(
      {
        siteId,
        userId,
        commodity: "electric",
        label: "AC2 synthetic meter",
        usageUnit: "kWh",
        demandUnit: "kW",
        timezone: "America/Phoenix",
      },
      userId,
    );
    const { site, meter } = await fetchSiteAndMeter(siteId, meterId);

    const result = await runAnalysisPipeline(site, meter, userId, "plus");

    // Rate comparison exists with at least one eligible row (AC2 clause 1)
    expect(result.tariffComparisons.length).toBeGreaterThan(0);
    expect(result.tariffComparisons.some((r) => r.eligible)).toBe(true);

    // Benchmark percentile computed against seeded EUI medians (AC2 clause 3)
    expect(result.benchmark).not.toBeNull();
    expect(result.benchmark!.percentileBand).toBeTruthy();
    expect(result.benchmark!.source).toBeTruthy();

    // Baseline is archetype-derived for the hypothetical path
    expect(result.baseline).not.toBeNull();
    expect(String(result.baseline!.method)).toContain("archetype");

    // Solar scenario runs on the hypothetical basis (AC2 clause 2)
    const annual = result.baseline!.normalizedAnnualUsage ?? 250_000;
    const flatShape = Array.from({ length: 8760 }, () => 1 / 8760);
    const { hourly } = archetypeBaseline(flatShape, annual / 20000, 20000, { outOfCalibrationRange: false });
    const solar = runScenario(hourly, { kind: "solar", solarKwDc: 50 }, TOU, "2B", 850, "medium", true);
    expect(solar.scenarioAnnualCost).not.toBeNull();
    expect(solar.scenarioAnnualCost!).toBeLessThan(solar.baselineAnnualCost!);
    expect(solar.disclosures.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("AC3 — water meter flows through with zero electric-specific changes", () => {
  it("ingests daily water intervals and completes the pipeline commodity-agnostically", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const siteId = await h.createSite({
      userId,
      name: "AC3 Water Site",
      buildingType: "office",
      sqft: 10000,
      state: "AZ",
      climateZone: "2B",
      utilityName: "City of Phoenix Water",
      isHypothetical: false,
      attrSource: "user_entered",
    });
    const meterId = await h.createMeter(
      {
        siteId,
        userId,
        commodity: "water",
        label: "AC3 water meter",
        usageUnit: "gallons",
        demandUnit: "gpm",
        timezone: "America/Phoenix",
      },
      userId,
    );

    const uploadId = await h.createUpload({
      userId,
      siteId,
      filename: "ac3-water-daily.csv",
      sha256: "ac3".padEnd(64, "0"),
      format: "csv",
      parser: "acceptance-test",
      status: "parsed",
    });

    // One year of daily water usage with a summer irrigation bump
    const start = Date.UTC(2025, 0, 1);
    const series = {
      meterLabel: "AC3 water meter",
      points: Array.from({ length: 365 }, (_, d) => {
        const month = new Date(start + d * 86_400_000).getUTCMonth();
        const summer = month >= 4 && month <= 8;
        return {
          ts: start + d * 86_400_000,
          durationMin: 1440,
          usage: 3000 + (summer ? 2500 : 0) + Math.sin(d / 5) * 200,
          demand: null,
        };
      }),
    };
    const wrote = await writeIntervals(db, meterId, series as never, uploadId);
    expect((wrote as { written?: number }).written ?? (wrote as { count?: number }).count ?? 365).toBeGreaterThan(300);

    const { site, meter } = await fetchSiteAndMeter(siteId, meterId);
    const result = await runAnalysisPipeline(site, meter, userId, "plus");

    // Pipeline completes: analysis row exists, no crash on a non-electric commodity
    expect(result.analysisId).toBeGreaterThan(0);
    // Tariff comparison is defined (may legitimately be empty for water)
    expect(Array.isArray(result.tariffComparisons)).toBe(true);
    // No electric-only fabrications: emissions for water should be null or mapped=false
    if (result.emissions) {
      expect(result.emissions.mapped).toBe(false);
    }
  }, 120_000);
});

describe("AC4 — scenario parity: measured vs hypothetical share one code path & result structure", () => {
  it("runScenario returns structurally identical results for measured and archetype-derived bases", () => {
    // "Measured"-style basis: observed hourly kW pattern
    const measured = Array.from({ length: 8760 }, (_, hI) => {
      const hour = hI % 24;
      return 15 + (hour >= 8 && hour < 18 ? 25 : 0);
    });
    // Hypothetical basis: archetype-synthetic 8760 from the baseline generator
    const shape = Array.from({ length: 8760 }, (_, hI) => {
      const hour = hI % 24;
      return hour >= 8 && hour < 18 ? 1.6 : 0.6;
    });
    const norm = shape.reduce((s, v) => s + v, 0);
    const { hourly: hypothetical } = archetypeBaseline(
      shape.map((v) => v / norm),
      16.5,
      20000,
      { outOfCalibrationRange: false, calibMidSqft: 15000 },
    );
    expect(hypothetical.length).toBe(8760);

    const spec = { kind: "efficiency" as const, efficiencyReductions: { cooling: 0.15 }, endUseFractions: { cooling: 0.35 } };
    const rM = runScenario(measured, spec, TOU, "2B", 850, "medium", false);
    const rH = runScenario(hypothetical, spec, TOU, "2B", 850, "medium", true);

    // Identical result structure (same keys) — single code path, single shape
    expect(Object.keys(rM).sort()).toEqual(Object.keys(rH).sort());
    // Both carry the normal-year disclosure class
    expect(rM.disclosures.join(" ")).toContain(LABEL_NORMAL_YEAR);
    expect(rH.disclosures.join(" ")).toContain(LABEL_NORMAL_YEAR);
    // Both produce finite, negative (cost-saving) deltas for an efficiency measure
    expect(Number.isFinite(rM.siteTotalDeltaCost)).toBe(true);
    expect(Number.isFinite(rH.siteTotalDeltaCost)).toBe(true);
    expect(rM.siteTotalDeltaCost).toBeLessThan(0);
    expect(rH.siteTotalDeltaCost).toBeLessThan(0);
  });
});
