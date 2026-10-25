import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { tariffs, rateSources } from "../drizzle/schema";
import { seedTariffs } from "./seed/runSeeders";
import { SEED_TARIFFS, SEED_VERSION } from "./seed/seedData";
import { registerRateSources } from "./rateCurrency";
import { costOnTariff } from "./analytics/tariffEngine";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

// Explicitly opt in: this deployment verification writes official reference
// seeds and reads retained demo evidence outside the repository, not CI fixtures.
describe.skipIf(process.env.RUN_FB_LIVE_VERIFICATION !== "1")("FB live tariff publication and real KUSD checks", () => {
  it("upserts versioned tariffs id-stably and verifies live rows", async () => {
    const db = await getDb(); if (!db) throw new Error("Live DB required");
    await seedTariffs(db);
    await registerRateSources();
    const keys = ["uns-egsgs", "uns-egmgs", "uns-egmgst", "uns-egmgsst", "uns-lgs"];
    const rows = await db.select().from(tariffs).where(inArray(tariffs.urdbId, keys));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.sourceVersion).toBe(SEED_VERSION);
      expect(row.structure).toEqual(SEED_TARIFFS.find((s) => s.urdbId === row.urdbId)!.structure);
    }
    const watchers = await db.select().from(rateSources).where(inArray(rateSources.sourceKey, ["unse-az-electric", "unse-az-ppfac", "unse-az-riders"]));
    expect(watchers).toHaveLength(3);
    expect(watchers.filter((w) => w.sourceUrl.endsWith(".pdf")).every((w) => w.verifyCadenceDays === 30)).toBe(true);
    const residential = await db.select({ urdbId: tariffs.urdbId, freshness: tariffs.freshness }).from(tariffs).where(eq(tariffs.urdbId, "uns-erres"));
    expect(residential[0]?.freshness).toBe("urdb_stale");
    writeFileSync("/home/ubuntu/work/fixes/FB_live_rates.json", JSON.stringify({ seedVersion: SEED_VERSION, checkedAt: new Date().toISOString(), rows, watchers, residential }, null, 2));
  }, 30000);
  it("reprices two real retained KUSD meter series on the corrected filed terms", () => {
    const inputs = JSON.parse(readFileSync("/home/ubuntu/work/reviews/R2_points.json", "utf8")) as Record<string, IntervalPoint[]>;
    const output = [];
    for (const [meterId, key, expected, before] of [["2880054", "uns-egsgs", 1408.059728320, 1319.314373440006], ["2880048", "uns-egmgs", 2480.197437120, 2327.642489215998]] as const) {
      const structure = SEED_TARIFFS.find((t) => t.urdbId === key)!.structure as TariffStructure;
      const result = costOnTariff(inputs[meterId], structure, { tz: "America/Phoenix", restTreatment: "usage" });
      const august = result.monthlyCosts.find((m) => m.month === "2026-08")!;
      expect(august.total).toBeCloseTo(expected, 7);
      output.push({ meterId, key, source: "Retained real DB interval extract from R2; unchanged timestamps isolate tariff effects, not a timezone-import certification", beforeAugust: before, afterAugust: august, difference: august.total - before, demand: result.monthlyDetails.find((m) => m.month === "2026-08"), coveredPeriod: result.breakdown, coverage: result.coverage, pricingStatus: result.pricingStatus, missingRiderCoverage: result.missingRiderCoverage, disclosures: result.disclosures });
    }
    writeFileSync("/home/ubuntu/work/fixes/FB_real_meter_checks.json", JSON.stringify(output, null, 2));
  }, 30000);
});
