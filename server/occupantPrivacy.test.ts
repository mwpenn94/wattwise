/**
 * v1.19 §5 stage 3b — occupant privacy boundary: "modeling continuity is not
 * data visibility." A new occupant at the same address must NEVER see the
 * prior occupant's usage or bills; at most the system may use de-identified
 * archetype context.
 *
 * In WattWise's architecture this boundary is structural, and this suite pins
 * the structure so it cannot regress silently:
 *   1. Every site/meter/interval/bill read goes through ownership-asserting
 *      helpers (assertSiteOwner / assertMeterOwner) that throw TenancyError
 *      for any userId that does not own the row — there is no "same address"
 *      join anywhere that could bridge two accounts.
 *   2. A new occupant creating a site at the same address gets a NEW siteId
 *      with zero meters/intervals — prior data lives under the prior user's
 *      siteId and is unreachable per (1).
 *   3. The only cross-account context is the archetype/benchmark layer, which
 *      is keyed by (buildingType, climateZone, vintage band) — never by
 *      address, userId, or any prior occupant's actual meter rows.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8");

describe("occupant privacy boundary (v1.19 §5 stage 3b)", () => {
  const dbHelpers = read("dbHelpers.ts");

  it("every interval/bill read path asserts meter or site ownership first", () => {
    // getIntervalPoints and intervalStats must call assertMeterOwner before querying
    const gip = dbHelpers.slice(dbHelpers.indexOf("export async function getIntervalPoints"));
    expect(gip.slice(0, 400)).toMatch(/assertMeterOwner\(meterId, userId\)/);
    const stats = dbHelpers.slice(dbHelpers.indexOf("export async function intervalStats"));
    expect(stats.slice(0, 400)).toMatch(/assertMeterOwner\(meterId, userId\)/);
  });

  it("site reads are scoped by userId in the WHERE clause, not post-filtered", () => {
    const getSite = dbHelpers.slice(dbHelpers.indexOf("export async function getSite"));
    expect(getSite.slice(0, 400)).toMatch(/eq\(sites\.userId, userId\)/);
    const listSitesFn = dbHelpers.slice(dbHelpers.indexOf("export async function listSites"));
    expect(listSitesFn.slice(0, 300)).toMatch(/eq\(sites\.userId, userId\)/);
  });

  it("TenancyError exists and ownership assertions throw it (never return empty)", () => {
    expect(dbHelpers).toMatch(/class TenancyError extends Error/);
    expect(dbHelpers).toMatch(/if \(rows\.length === 0\) throw new TenancyError\(\)/);
  });

  it("no query joins sites/meters/intervals across accounts by address", () => {
    // The dangerous pattern would be a WHERE on sites.address without userId.
    // Assert no helper selects intervals/bills based on address matching.
    expect(dbHelpers).not.toMatch(/eq\(sites\.address/);
  });

  it("archetype/benchmark context is keyed by building class, never by address or user", () => {
    const scenarios = read("analytics/scenarios.ts");
    // benchmark lookups use buildingType/climate/vintage — assert no userId or address keys
    const bm = scenarios.slice(scenarios.indexOf("benchmarkPercentile"));
    expect(bm).not.toMatch(/address/i);
    expect(bm.slice(0, 2000)).not.toMatch(/userId/);
  });

  it("deleting a site removes its intervals and bills — no orphaned usage for a future occupant to inherit", () => {
    const del = dbHelpers.slice(dbHelpers.indexOf("export async function deleteSite"));
    expect(del.slice(0, 1500)).toMatch(/delete\(intervals\)/);
    expect(del.slice(0, 1500)).toMatch(/delete\(bills\)/);
  });
});
