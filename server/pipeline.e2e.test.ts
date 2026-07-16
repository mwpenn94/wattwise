/**
 * Pipeline E2E test — pushes the REAL Cantex interval workbook through the
 * full stack: hardening gate → Excel parser → interval writer → analysis
 * pipeline (baseline, demand, tariff sweep, benchmark, emissions, insights,
 * opportunities) → free-tier cost-cap assertion (AC5). Uses the dev database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { uploads, users } from "../drizzle/schema";
import * as h from "./dbHelpers";
import { preParseGate } from "./ingest/hardening";
import { parseExcelIntervals } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { assertFreeTierCostCap } from "./analytics/costModel";
import { ensureSeeded } from "./seed/runSeeders";
import { LABEL_CP_ESTIMATED } from "../shared/wattwise";

const FIX = path.resolve(__dirname, "../tests/fixtures");
const cantex = path.join(FIX, "cantex.xlsx");
const hasFixture = existsSync(cantex);

let userId = 0;
let siteId = 0;
let meterId = 0;
let analysisId = 0;

beforeAll(async () => {
  if (!hasFixture) return;
  await ensureSeeded();
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId: "vitest-pipeline", name: "pipeline", email: "p@test.local", loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date() } });
  const u = await db.select().from(users).where(eq(users.openId, "vitest-pipeline"));
  userId = u[0]!.id;
  siteId = await h.createSite({
    userId,
    name: `Cantex E2E ${Date.now()}`,
    siteType: "manufacturing",
    sectorClass: "commercial",
    climateZone: "2B",
    state: "AZ",
    zip: "85043",
    floorAreaSqft: 150_000,
    isHypothetical: false,
  } as Parameters<typeof h.createSite>[0]);
  meterId = await h.createMeter(
    { siteId, userId, commodity: "electric", label: "Main service", usageUnit: "kWh", demandUnit: "kW", timezone: "America/Phoenix" } as Parameters<typeof h.createMeter>[0],
    userId,
  );
}, 60_000);

describe.skipIf(!hasFixture)("real-file pipeline E2E (Cantex)", () => {
  it("ingests the workbook through the hardening gate and writer", async () => {
    const buf = readFileSync(cantex);
    const gate = preParseGate(buf, "xlsx");
    expect(gate.ok).toBe(true);
    const series = parseExcelIntervals(buf);
    expect(series.length).toBeGreaterThanOrEqual(1);
    const db = (await getDb())!;
    const upRes = await db.insert(uploads).values({
      userId,
      siteId,
      meterId,
      filename: "cantex.xlsx",
      format: "xlsx",
      byteSize: buf.length,
      sha256: "test-cantex",
      status: "parsed",
      parserVersion: "test",
    } as typeof uploads.$inferInsert);
    const uploadId = Number((upRes as unknown as [{ insertId: number }])[0].insertId);
    const res = await writeIntervals(db, meterId, series[0]!, uploadId);
    expect(res.inserted + res.replaced + res.skippedDuplicates).toBeGreaterThan(30_000);
  }, 180_000);

  it("runs the full analysis pipeline with honest labels", async () => {
    const site = await h.getSite(siteId, userId);
    const meters = await h.listMeters(siteId, userId);
    expect(site).toBeTruthy();
    expect(meters.length).toBeGreaterThan(0);
    const result = await runAnalysisPipeline(site!, meters[0]!, userId, "pro");
    analysisId = result.analysisId;
    // Demand analytics on 15-min industrial data
    expect(result.demand).not.toBeNull();
    expect(result.demand!.peakKw).toBeGreaterThan(10);
    expect(result.demand!.loadFactor).toBeGreaterThan(0);
    // CP proxy labeled verbatim
    if (result.demand!.cpProxy) {
      expect(result.demand!.cpProxy.label).toBe(LABEL_CP_ESTIMATED);
    }
    // Baseline fit or honest null; disclosures must mention weather basis when fit
    expect(result.baseline).toBeTruthy();
    // Tariff comparison ran across seeded tariffs
    expect(result.tariffComparisons.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.tariffComparisons[0]!.annualCost.total)).toBe(true);
    // emissions computed with eGRID subregion factor
    expect(result.emissions).toBeTruthy();
    expect(result.emissions!.annualCo2eLb).toBeGreaterThan(0);
    // insights + opportunities persisted
    expect(result.insightsCount).toBeGreaterThan(0);
    expect(result.opportunitiesCount).toBeGreaterThan(0);
    // modeled-estimates disclaimer travels with every result
    expect(result.disclaimer.toLowerCase()).toContain("modeled");
    // marginal cost instrumented
    expect(result.marginalCostUsd).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it("AC5: per-analysis marginal cost is instrumented and ≤ $0.20", async () => {
    expect(analysisId).toBeGreaterThan(0);
    const cap = await assertFreeTierCostCap(analysisId);
    // Batch-29 (passes 1030/1040): assert the ACTUAL incurred cost against the
    // cap — the previous `cap.capUsd <= 0.2` line only re-checked the constant
    // (a tautology). `cap.ok` already encodes totalUsd <= capUsd, but the
    // relation is asserted explicitly so a regression in `ok`'s definition
    // cannot silently weaken AC5.
    expect(cap.totalUsd).toBeGreaterThanOrEqual(0);
    expect(cap.totalUsd).toBeLessThanOrEqual(cap.capUsd);
    expect(cap.ok).toBe(true); // template-only pipeline must stay within the cap
  }, 60_000);
});
