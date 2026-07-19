/**
 * v1.22 S-LIFECYCLE / AC18b — seed freshness suite.
 *
 * Pins the living-data contract:
 *  1. boot registration is idempotent and never clobbers ops-tuned rows;
 *  2. staleness = age > cadence × multiplier, with honest user copy;
 *  3. bill-verification clock: reconciliation HIT resets billVerifiedAt;
 *  4. unknown-tariff crowd discovery opens a create-template task at N≥3;
 *  5. parser-drift monitor raises a template-update task below the floor;
 *  6. config-not-constant: thresholds read from platform_config.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { getDb } from "./db";
import { seedFreshness, platformConfig, templateTasks, tariffs } from "../drizzle/schema";
import {
  registerSeedFreshness,
  assessSeedFreshness,
  staleSeedsForDomain,
  touchBillVerification,
  recordUnknownTariff,
  recordParseOutcome,
  configNumber,
  SEED_CADENCES,
} from "./seedLifecycle";

async function getDbOrFail() {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  return db;
}

const runTag = `t${Date.now().toString(36)}`;

describe("v1.22 seed freshness (AC18b)", () => {
  beforeAll(async () => {
    await registerSeedFreshness("test_v1");
  });

  it("registers every cadence-table seed and the config defaults idempotently", async () => {
    // Second call must not throw or duplicate.
    await registerSeedFreshness("test_v2");
    const db = await getDbOrFail();
    const rows = await db.select().from(seedFreshness);
    for (const c of SEED_CADENCES) {
      const row = rows.filter((r) => r.source === c.source);
      expect(row.length, `seed ${c.source} registered exactly once`).toBe(1);
      expect(row[0].cadenceDays).toBe(c.cadenceDays);
    }
    const cfg = await db.select().from(platformConfig).where(eq(platformConfig.configKey, "seed.staleness_multiplier"));
    expect(cfg.length).toBe(1);
  });

  it("marks a seed stale only past cadence × multiplier, with honest user copy", async () => {
    const db = await getDbOrFail();
    const row = (await db.select().from(seedFreshness).where(eq(seedFreshness.source, "egrid_emissions")))[0];
    expect(row).toBeTruthy();
    const mult = await configNumber("seed.staleness_multiplier", 1.5);
    // Just inside the window: fresh.
    const justInside = row.seededAt + Math.floor(row.cadenceDays * mult * 0.99) * 86_400_000;
    const freshView = (await assessSeedFreshness(justInside)).find((s) => s.source === "egrid_emissions")!;
    expect(freshView.stale).toBe(false);
    expect(freshView.userNote).toBeNull();
    // Just past the window: stale, named and dated — never silent.
    const justPast = row.seededAt + Math.ceil(row.cadenceDays * mult + 2) * 86_400_000;
    const staleView = (await assessSeedFreshness(justPast)).find((s) => s.source === "egrid_emissions")!;
    expect(staleView.stale).toBe(true);
    expect(staleView.userNote).toMatch(/update pending/i);
    expect(staleView.userNote).toMatch(/eGRID/i);
  });

  it("maps domains to their seeds: a stale eGRID widens emissions, not tariffs", async () => {
    const db = await getDbOrFail();
    const row = (await db.select().from(seedFreshness).where(eq(seedFreshness.source, "egrid_emissions")))[0];
    const past = row.seededAt + (row.cadenceDays * 2 + 10) * 86_400_000;
    const emissionsStale = await staleSeedsForDomain("emissions", past);
    expect(emissionsStale.some((s) => s.source === "egrid_emissions")).toBe(true);
    // tariffs domain must not include egrid even when egrid is stale
    const tariffsStale = await staleSeedsForDomain("tariffs", past);
    expect(tariffsStale.every((s) => s.source !== "egrid_emissions")).toBe(true);
  });

  it("bill-verification clock: touchBillVerification stamps billVerifiedAt (currency earned from bills)", async () => {
    const db = await getDbOrFail();
    const anyTariff = (await db.select().from(tariffs).limit(1))[0];
    expect(anyTariff, "seeded tariff exists").toBeTruthy();
    const before = Date.now() - 1000;
    await touchBillVerification(anyTariff.id, Date.now());
    const after = (await db.select().from(tariffs).where(eq(tariffs.id, anyTariff.id)))[0];
    expect(after.billVerifiedAt).not.toBeNull();
    expect(Number(after.billVerifiedAt)).toBeGreaterThanOrEqual(before);
  });

  it("unknown-tariff crowd discovery: task opens only at the configured threshold", async () => {
    const utility = `Test Utility ${runTag}`;
    const name = `TOU-MYSTERY-${runTag}`;
    const r1 = await recordUnknownTariff(utility, name);
    expect(r1.occurrences).toBe(1);
    expect(r1.taskOpen).toBe(false);
    const r2 = await recordUnknownTariff(utility, name);
    expect(r2.occurrences).toBe(2);
    expect(r2.taskOpen).toBe(false);
    const r3 = await recordUnknownTariff(utility, name);
    expect(r3.occurrences).toBe(3);
    expect(r3.taskOpen).toBe(true);
    // Exactly one task row aggregates the occurrences — crowd counting, not spam.
    const db = await getDbOrFail();
    const tasks = await db
      .select()
      .from(templateTasks)
      .where(and(eq(templateTasks.kind, "create_template"), eq(templateTasks.tariffNameRaw, name)));
    expect(tasks.length).toBe(1);
    expect(tasks[0].occurrences).toBe(3);
    expect(tasks[0].status).toBe("open");
  });

  it("parser-drift monitor: below-floor success over ≥10 attempts raises a template-update task", async () => {
    const key = `tmpl_${runTag}`;
    // 3 successes then 9 failures → 3/12 = 25% < 70% floor.
    for (let i = 0; i < 3; i++) await recordParseOutcome(key, true);
    let last: { successRate: number; drift: boolean } = { successRate: 1, drift: false };
    for (let i = 0; i < 9; i++) last = await recordParseOutcome(key, false);
    expect(last.successRate).toBeLessThan(0.7);
    expect(last.drift).toBe(true);
    const db = await getDbOrFail();
    const tasks = await db
      .select()
      .from(templateTasks)
      .where(and(eq(templateTasks.kind, "template_update"), eq(templateTasks.tariffNameRaw, key)));
    expect(tasks.length).toBe(1); // deduped: repeated drift bumps occurrences, never spawns twins
    expect(tasks[0].note).toMatch(/below the 70% floor/i);
    expect(tasks[0].occurrences).toBeGreaterThanOrEqual(1);
  });

  it("config-not-constant: thresholds come from platform_config, not compiled constants", async () => {
    const v = await configNumber("tariff.unknown_name_task_threshold", 999);
    expect(v).toBe(3); // read from the seeded DB row, not the 999 fallback
    const missing = await configNumber(`no.such.key.${runTag}`, 42);
    expect(missing).toBe(42); // fail-open to fallback
  });
});
