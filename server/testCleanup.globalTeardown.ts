/**
 * CLEAN-2 (owner report Jul 19) — global vitest teardown.
 *
 * Many suites create users/sites in the shared database (there is no separate
 * test database). Rather than trusting 40+ suites to each write their own
 * afterAll, this teardown sweeps ALL test residue after every `pnpm test` run:
 *   - every user whose email ends in @test.local or openId matches the test
 *     registry patterns, with their full data cascade;
 *   - every tariff tagged source="test_fixture" (belt) or matching the known
 *     fixture-name registry (suspenders).
 *
 * The listTariffs query-layer guard (dbHelpers.ts) additionally hides tagged
 * fixture tariffs from all user-facing surfaces even mid-run, so a crashed
 * suite can never leak fixtures to real users again.
 */
import mysql from "mysql2/promise";


export async function setup() {
  /* no-op: cleanup runs in teardown after all suites finish */
}

export async function teardown() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection(url);
    const q = async (sql: string, params: unknown[] = []) => {
      const [rows] = await conn!.execute(sql, params);
      return rows as Array<Record<string, unknown>>;
    };

    // 1. collect test users: @test.local emails or registry openIds
    const users = (await q(
      `SELECT id FROM users WHERE email LIKE '%@test.local'
       OR openId LIKE 'recon-suite-%' OR openId LIKE 'pin-test-%'`,
    )) as Array<{ id: number }>;

    for (const u of users) {
      const uid = u.id;
      const sites = (await q("SELECT id FROM sites WHERE userId = ?", [uid])) as Array<{ id: number }>;
      const siteIds = sites.map((s) => s.id);
      if (siteIds.length > 0) {
        const sph = siteIds.map(() => "?").join(",");
        const meters = (await q(`SELECT id FROM meters WHERE siteId IN (${sph})`, siteIds)) as Array<{ id: number }>;
        const meterIds = meters.map((m) => m.id);
        if (meterIds.length > 0) {
          const mph = meterIds.map(() => "?").join(",");
          await q(`DELETE FROM intervals WHERE meterId IN (${mph})`, meterIds);
          await q(`DELETE FROM bills WHERE meterId IN (${mph})`, meterIds);
          await q(`DELETE FROM meters WHERE id IN (${mph})`, meterIds);
        }
        for (const table of [
          "baselines", "analyses", "insights", "opportunities", "scenarios",
          "measure_implementations", "alerts", "site_geometry", "site_members",
          "bill_reconciliations", "production_series", "equipment_inventory",
          "report_artifacts", "site_group_members",
        ]) {
          await q(`DELETE FROM ${table} WHERE siteId IN (${sph})`, siteIds).catch(() => {});
        }
        await q(`DELETE FROM sites WHERE id IN (${sph})`, siteIds);
      }
      for (const table of ["uploads", "plan_baskets", "site_groups", "audit_log", "site_members", "metering", "alerts", "entities"]) {
        await q(`DELETE FROM ${table} WHERE userId = ?`, [uid]).catch(() => {});
      }
      await q("DELETE FROM users WHERE id = ?", [uid]);
    }

    // 2. fixture tariffs — tagged or registry-named
    await q("UPDATE meters SET tariffId = NULL WHERE tariffId IN (SELECT id FROM (SELECT id FROM tariffs WHERE source = 'test_fixture' OR utilityName = 'Recon Test Utility') t)").catch(() => {});
    await q("DELETE FROM tariffs WHERE source = 'test_fixture' OR utilityName = 'Recon Test Utility'");

    if (users.length > 0) {
      console.log(`[testCleanup] purged ${users.length} test users + fixture tariffs`);
    }
  } catch (e) {
    console.warn("[testCleanup] teardown failed (non-fatal):", (e as Error).message);
  } finally {
    await conn?.end().catch(() => {});
  }
}
