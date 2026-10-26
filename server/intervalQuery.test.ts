/**
 * Oct 26 regression: getIntervalPoints combined its superseded-row filter with
 * the meter filter without parentheses, so the WHERE clause read
 * "(meterId = A AND qcFlags IS NULL) OR qcFlags != 'superseded_overlap'".
 * That scanned the whole intervals table on every analysis and would have
 * returned another meter's flagged readings and ignored the time window.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { intervals, meters, sites, uploads, users } from "../drizzle/schema";
import * as h from "./dbHelpers";

let userId = 0;
const meterIds: number[] = [];
const siteIds: number[] = [];
const uploadIds: number[] = [];
const T0 = Date.UTC(2025, 9, 1, 7);
const STEP = 15 * 60_000;

async function meterWith(label: string, flags: Array<string | null>) {
  const db = (await getDb())!;
  const [s] = await db.insert(sites).values({ userId, name: `QC ${label}`, city: "Kingman", state: "AZ", zip: "86401", buildingType: "office", sqft: 1000 } as never);
  siteIds.push(Number(s.insertId));
  const [m] = await db.insert(meters).values({ siteId: Number(s.insertId), userId, label, commodity: "electric" as never, meterRole: "main" as never, usageUnit: "kWh", timezone: "America/Phoenix" } as never);
  const meterId = Number(m.insertId);
  meterIds.push(meterId);
  const [u] = await db.insert(uploads).values({ userId, siteId: Number(s.insertId), filename: `${label}.csv`, sha256: `qc-${label}-${Date.now()}`, format: "csv" as never, status: "parsed" as never } as never);
  uploadIds.push(Number(u.insertId));
  await db.insert(intervals).values(flags.map((qcFlags, i) => ({ meterId, uploadId: Number(u.insertId), ts: T0 + i * STEP, durationMin: 15, usage: 1 + i, demand: 4 + i, qcFlags })) as never);
  return meterId;
}

beforeAll(async () => {
  const db = (await getDb())!;
  await db.insert(users).values({ openId: "interval-query-test", name: "interval-query-test", tier: "pro" as never }).onDuplicateKeyUpdate({ set: { name: "interval-query-test" } });
  const [u] = await db.select().from(users).where(eq(users.openId, "interval-query-test"));
  userId = u.id;
});

afterAll(async () => {
  const db = (await getDb())!;
  if (meterIds.length) await db.delete(intervals).where(inArray(intervals.meterId, meterIds));
  if (meterIds.length) await db.delete(meters).where(inArray(meters.id, meterIds));
  if (uploadIds.length) await db.delete(uploads).where(inArray(uploads.id, uploadIds));
  if (siteIds.length) await db.delete(sites).where(inArray(sites.id, siteIds));
});

describe("getIntervalPoints filter grouping", () => {
  it("returns only this meter's usable readings, excluding superseded rows and other meters' flagged rows", async () => {
    const a = await meterWith("A", [null, null, "superseded_overlap", null]);
    await meterWith("B", ["estimated", "estimated"]);
    const pts = await h.getIntervalPoints(a, userId);
    expect(pts.map((p) => p.ts)).toEqual([T0, T0 + STEP, T0 + 3 * STEP]);
    expect(pts.every((p) => p.durationMin === 15)).toBe(true);
  }, 30_000);

  it("honors the time window even when other meters have flagged rows", async () => {
    const a = meterIds[0];
    const pts = await h.getIntervalPoints(a, userId, T0 + STEP, T0 + 3 * STEP);
    expect(pts.map((p) => p.ts)).toEqual([T0 + STEP, T0 + 3 * STEP]);
  }, 30_000);
});
