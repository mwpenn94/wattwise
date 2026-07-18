/**
 * §2.57 sewer-on-winter-water linkage specs — the opportunity only appears for
 * water meters with ≥2 winter months of real data and a priced volumetric
 * basis, and always carries the sewer-rate-assumption disclosure.
 *
 * The candidate logic lives inline in pipeline.ts stage 7; these specs
 * exercise the same winter-average math on the shared helpers plus a full
 * pipeline run over a seeded water meter.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users, sites, meters, uploads, intervals, opportunities } from "../drizzle/schema";
import { ensureSeeded } from "./seed/runSeeders";
import { runAnalysisPipeline } from "./analytics/pipeline";
import * as h from "./dbHelpers";

let userId: number;

beforeAll(async () => {
  await ensureSeeded();
  const db = await getDb();
  await db.insert(users).values({ openId: "sewer-test", name: "sewer-test", tier: "pro" as never }).onDuplicateKeyUpdate({ set: { name: "sewer-test" } });
  const [u] = await db.select().from(users).where(eq(users.openId, "sewer-test"));
  userId = u.id;
});

async function makeWaterSite(withWinter: boolean) {
  const db = await getDb();
  const [siteRes] = await db.insert(sites).values({
    userId,
    name: withWinter ? "Sewer Winter Site" : "Sewer No-Winter Site",
    city: "Phoenix",
    state: "AZ",
    zip: "85001",
    buildingType: "office",
    sqft: 20000,
    utilityName: "City of Phoenix Water Services",
  });
  const siteId = siteRes.insertId;
  const [meterRes] = await db.insert(meters).values({
    siteId,
    userId,
    label: "Water main",
    commodity: "water" as never,
    meterRole: "main" as never,
    usageUnit: "kgal",
    timezone: "America/Phoenix",
  } as never);
  const meterId = meterRes.insertId;
  // Attach the seeded municipal water tariff as the current rate so a priced
  // volumetric basis exists.
  const waterTariffs = await h.listTariffs("water", "AZ");
  if (waterTariffs.length > 0) {
    await db.update(meters).set({ currentTariffId: waterTariffs[0].id }).where(eq(meters.id, meterId));
  }
  // 12 months of daily readings (kgal): higher summer outdoor use, steady
  // winter indoor floor — or, for the no-winter case, only Mar–Nov.
  const [up] = await db.insert(uploads).values({
    userId,
    siteId,
    filename: withWinter ? "water-winter.csv" : "water-nowinter.csv",
    sha256: `sewer-test-${withWinter ? "w" : "nw"}-${Date.now()}`,
    format: "csv" as never,
    status: "parsed" as never,
  } as never);
  const rows: Array<typeof intervals.$inferInsert> = [];
  const start = Date.UTC(2025, 0, 1);
  for (let d = 0; d < 365; d++) {
    const ts = start + d * 86400_000;
    const month = new Date(ts).getUTCMonth() + 1;
    if (!withWinter && (month === 12 || month === 1 || month === 2)) continue;
    const summer = month >= 5 && month <= 9;
    rows.push({ meterId, uploadId: up.insertId, ts, durationMin: 1440, usage: summer ? 3.2 : 1.6, demand: null } as never);
  }
  // chunked insert
  for (let i = 0; i < rows.length; i += 200) await db.insert(intervals).values(rows.slice(i, i + 200));
  const [siteRow] = await db.select().from(sites).where(eq(sites.id, siteId));
  const [meterRow] = await db.select().from(meters).where(eq(meters.id, meterId));
  return { siteRow, meterRow };
}

describe("§2.57 sewer-on-winter-water linkage", () => {
  it("emits the winter_water_sewer opportunity for a water meter with winter data, with the sewer-assumption disclosure", async () => {
    const { siteRow, meterRow } = await makeWaterSite(true);
    await runAnalysisPipeline(siteRow, meterRow, userId, "pro");
    const db = await getDb();
    const opps = await db.select().from(opportunities).where(eq(opportunities.siteId, siteRow.id));
    const sewer = opps.find((o) => o.measure === "winter_water_sewer");
    expect(sewer).toBeDefined();
    expect(sewer!.title).toMatch(/sewer/i);
    expect(sewer!.description).toMatch(/winter-quarter-average convention/i);
    expect(sewer!.description).toMatch(/does not have your sewer tariff/i);
    expect(Number(sewer!.estCostSavingsPerYr)).toBeGreaterThan(0);
    expect(sewer!.confidence).toBe("low");
  }, 120_000);

  it("stays silent when no winter months exist in the data (gate: ≥2 winter months)", async () => {
    const { siteRow, meterRow } = await makeWaterSite(false);
    await runAnalysisPipeline(siteRow, meterRow, userId, "pro");
    const db = await getDb();
    const opps = await db.select().from(opportunities).where(eq(opportunities.siteId, siteRow.id));
    expect(opps.find((o) => o.measure === "winter_water_sewer")).toBeUndefined();
  }, 120_000);
});
