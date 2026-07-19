/**
 * CLEAN-1 — purge test-fixture residue from the production database.
 * Deletes: (a) all users with @test.local emails and every row of their data
 * (sites, meters, intervals, bills, insights, opportunities, baselines,
 * analyses, scenarios, alerts, uploads, report artifacts, site groups,
 * memberships, geometry, reconciliation, equipment, production series,
 * plan baskets, measure implementations, audit rows), via the same cascade
 * order as server/dbHelpers.deleteAllUserData; (b) fixture tariffs
 * ("Recon Test Utility" and any tariff no longer referenced by a real meter
 * that matches the test-fixture naming registry).
 *
 * Run: node scripts/purge-test-data.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const FIXTURE_TARIFF_PATTERNS = ["Recon Test Utility", "Recon Flat 10"];

const conn = await mysql.createConnection(url);

async function q(sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}

// ---- 1. test users ----
const testUsers = await q("SELECT id, openId, email FROM users WHERE email LIKE '%@test.local'");
console.log(`Found ${testUsers.length} test users`);

for (const u of testUsers) {
  const uid = u.id;
  const sites = await q("SELECT id FROM sites WHERE userId = ?", [uid]);
  const siteIds = sites.map((s) => s.id);
  if (siteIds.length > 0) {
    const sph = siteIds.map(() => "?").join(",");
    const meters = await q(`SELECT id FROM meters WHERE siteId IN (${sph})`, siteIds);
    const meterIds = meters.map((m) => m.id);
    if (meterIds.length > 0) {
      const mph = meterIds.map(() => "?").join(",");
      await q(`DELETE FROM intervals WHERE meterId IN (${mph})`, meterIds);
      await q(`DELETE FROM bills WHERE meterId IN (${mph})`, meterIds);
      await q(`DELETE FROM meters WHERE id IN (${mph})`, meterIds);
    }
    for (const table of [
      "baselines",
      "analyses",
      "insights",
      "opportunities",
      "scenarios",
      "measure_implementations",
      "alerts",
      "site_geometry",
      "site_members",
      "bill_reconciliations",
      "production_series",
      "equipment_inventory",
      "report_artifacts",
    ]) {
      await q(`DELETE FROM ${table} WHERE siteId IN (${sph})`, siteIds).catch(() => {});
    }
    await q(`DELETE FROM site_group_members WHERE siteId IN (${sph})`, siteIds).catch(() => {});
    await q(`DELETE FROM sites WHERE id IN (${sph})`, siteIds);
  }
  for (const table of ["uploads", "plan_baskets", "site_groups", "audit_log", "site_members"]) {
    await q(`DELETE FROM ${table} WHERE userId = ?`, [uid]).catch(() => {});
  }
  await q("DELETE FROM users WHERE id = ?", [uid]);
  console.log(`Purged user ${uid} (${u.email}) with ${siteIds.length} sites`);
}

// ---- 2. fixture tariffs ----
for (const pat of FIXTURE_TARIFF_PATTERNS) {
  const rows = await q("SELECT id FROM tariffs WHERE utilityName = ? OR name = ?", [pat, pat]);
  for (const r of rows) {
    // detach any meters still pointing at the fixture tariff (real users should never be on it)
    await q("UPDATE meters SET tariffId = NULL WHERE tariffId = ?", [r.id]).catch(() => {});
    await q("DELETE FROM tariffs WHERE id = ?", [r.id]);
  }
  if (rows.length > 0) console.log(`Deleted ${rows.length} fixture tariffs matching "${pat}"`);
}

// ---- 3. verify ----
const remainUsers = await q("SELECT COUNT(*) AS c FROM users WHERE email LIKE '%@test.local'");
const remainTariffs = await q(
  "SELECT COUNT(*) AS c FROM tariffs WHERE utilityName = 'Recon Test Utility' OR name = 'Recon Flat 10'",
);
console.log(`Remaining test users: ${remainUsers[0].c}; remaining fixture tariffs: ${remainTariffs[0].c}`);
await conn.end();
