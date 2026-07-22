/**
 * HRS-1 specs: operating-hours model.
 * - archetype defaults per building type
 * - hours math: simple windows, overnight wraps, 24h, seasonal months
 * - usage-share weighting and normalization
 * - effectiveSchedules: archetype fallback vs user rows
 * - schedules router CRUD with ownership checks
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  archetypeDefaultSchedules,
  computeHoursSummary,
  hoursPerWeek,
  effectiveSchedules,
  type ScheduleSpec,
} from "./operatingHours";
import { getDb } from "./db";
import { users, sites, siteSchedules } from "../drizzle/schema";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  name: "Test",
  kind: "business",
  days: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 18,
  months: null,
  usageSharePct: 100,
  source: "user",
  ...over,
});

describe("hoursPerWeek", () => {
  it("computes a simple business window", () => {
    expect(hoursPerWeek(spec())).toBe(50); // 10h × 5 days
  });
  it("handles 24h always-on", () => {
    expect(hoursPerWeek(spec({ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 }))).toBe(168);
  });
  it("handles overnight wrap (22 → 6 = 8h)", () => {
    expect(hoursPerWeek(spec({ startHour: 22, endHour: 6 }))).toBe(40); // 8h × 5
  });
});

describe("computeHoursSummary", () => {
  it("single business schedule ≈ 2609 occupied h/yr", () => {
    const s = computeHoursSummary([spec()]);
    expect(s.occupiedHoursPerYear).toBeGreaterThan(2550);
    expect(s.occupiedHoursPerYear).toBeLessThan(2670);
    expect(s.occupiedHoursPerYear + s.unoccupiedHoursPerYear).toBe(8760);
    expect(s.userConfirmed).toBe(true);
  });
  it("24/7 schedule caps at 8760 with zero unoccupied", () => {
    const s = computeHoursSummary([spec({ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 })]);
    expect(s.occupiedHoursPerYear).toBe(8760);
    expect(s.unoccupiedHoursPerYear).toBe(0);
  });
  it("usage splits weight occupied hours (70% office + 30% 24/7)", () => {
    const office = spec({ name: "Office", usageSharePct: 70 });
    const server = spec({ name: "Server room", kind: "always_on", days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24, usageSharePct: 30 });
    const s = computeHoursSummary([office, server]);
    // 0.7 × ~2609 + 0.3 × 8760 ≈ 4454
    expect(s.occupiedHoursPerYear).toBeGreaterThan(4300);
    expect(s.occupiedHoursPerYear).toBeLessThan(4600);
    expect(s.disclosure).toContain("Office");
    expect(s.disclosure).toContain("[70% of usage]");
  });
  it("normalizes shares that do not sum to 100 (fail-soft)", () => {
    const a = spec({ usageSharePct: 30 });
    const b = spec({ name: "B", usageSharePct: 30 });
    const s = computeHoursSummary([a, b]);
    // identical windows → same result as one 100% schedule
    expect(s.occupiedHoursPerYear).toBeGreaterThan(2550);
    expect(s.occupiedHoursPerYear).toBeLessThan(2670);
  });
  it("seasonal months scale the year fraction", () => {
    const summer = spec({ months: [6, 7, 8], usageSharePct: 100 });
    const s = computeHoursSummary([summer]);
    // 2609 × (3/12) ≈ 652
    expect(s.occupiedHoursPerYear).toBeGreaterThan(600);
    expect(s.occupiedHoursPerYear).toBeLessThan(700);
    expect(s.disclosure).toContain("(3 mo/yr)");
  });
});

describe("archetypeDefaultSchedules", () => {
  it("residential is always-occupied", () => {
    const s = computeHoursSummary(archetypeDefaultSchedules("single_family"));
    expect(s.occupiedHoursPerYear).toBe(8760);
    expect(s.userConfirmed).toBe(false);
  });
  it("office defaults to Mon–Fri 8–18", () => {
    const [d] = archetypeDefaultSchedules("office");
    expect(d.days).toEqual([1, 2, 3, 4, 5]);
    expect(d.startHour).toBe(8);
    expect(d.endHour).toBe(18);
    expect(d.source).toBe("archetype_default");
  });
  it("hospital/hotel default to 24/7", () => {
    expect(computeHoursSummary(archetypeDefaultSchedules("hospital")).unoccupiedHoursPerYear).toBe(0);
    expect(computeHoursSummary(archetypeDefaultSchedules("hotel")).unoccupiedHoursPerYear).toBe(0);
  });
  it("unknown type matches the legacy single-shift assumption", () => {
    const [d] = archetypeDefaultSchedules(null);
    expect(d.kind).toBe("business");
    expect(d.days.length).toBe(5);
  });
});

/* ---------- DB-backed: effectiveSchedules + router CRUD ---------- */

const OPEN_ID = "hrs-test-user";
let userId: number;
let siteId: number;
let otherSiteId: number;

function ctxFor(uid: number): TrpcContext {
  return {
    user: { id: uid, openId: `${OPEN_ID}-${uid}`, role: "user" },
    req: { headers: {} },
    res: { setHeader: () => {}, clearCookie: () => {} },
  } as unknown as TrpcContext;
}

beforeAll(async () => {
  const db = (await getDb())!;
  await db.insert(users).values({ openId: OPEN_ID, name: "HRS Tester", role: "user" }).onDuplicateKeyUpdate({ set: { name: "HRS Tester" } });
  const [u] = await db.select().from(users).where((await import("drizzle-orm")).eq(users.openId, OPEN_ID));
  userId = u.id;
  const { eq, and } = await import("drizzle-orm");
  // fresh sites each run — names unique per run to avoid collisions
  const tag = Date.now();
  await db.insert(sites).values({ userId, name: `HRS Site ${tag}`, buildingType: "office", state: "AZ" });
  await db.insert(sites).values({ userId: userId + 999999, name: `HRS Other ${tag}`, buildingType: "office", state: "AZ" });
  const mine = await db.select().from(sites).where(and(eq(sites.userId, userId), eq(sites.name, `HRS Site ${tag}`)));
  siteId = mine[0].id;
  const others = await db.select().from(sites).where(eq(sites.name, `HRS Other ${tag}`));
  otherSiteId = others[0].id;
});

describe("effectiveSchedules", () => {
  it("falls back to archetype default when no rows exist", async () => {
    const s = await effectiveSchedules(siteId, "office");
    expect(s.userConfirmed).toBe(false);
    expect(s.schedules[0].source).toBe("archetype_default");
  });
  it("uses user rows once present and flags userConfirmed", async () => {
    const db = (await getDb())!;
    await db.insert(siteSchedules).values({
      siteId,
      name: "Front office",
      kind: "business",
      days: [1, 2, 3, 4, 5],
      startHour: 7,
      endHour: 19,
      months: null,
      usageSharePct: 100,
      source: "user",
    });
    const s = await effectiveSchedules(siteId, "office");
    expect(s.userConfirmed).toBe(true);
    expect(s.disclosure).toContain("Front office");
    // 12h × 5 × 52.18 ≈ 3131
    expect(s.occupiedHoursPerYear).toBeGreaterThan(3050);
    expect(s.occupiedHoursPerYear).toBeLessThan(3200);
  });
});

describe("schedules router", () => {
  it("upsert + list + effective round-trip", async () => {
    const caller = appRouter.createCaller(ctxFor(userId));
    await caller.schedules.upsert({
      siteId,
      name: "Server room",
      kind: "always_on",
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
      months: null,
      usageSharePct: 30,
    });
    const rows = await caller.schedules.list({ siteId });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const eff = await caller.schedules.effective({ siteId });
    expect(eff.userConfirmed).toBe(true);
  });
  it("rejects access to another user's site", async () => {
    const caller = appRouter.createCaller(ctxFor(userId));
    await expect(caller.schedules.list({ siteId: otherSiteId })).rejects.toThrow();
  });
  it("remove deletes only own schedules", async () => {
    const caller = appRouter.createCaller(ctxFor(userId));
    const rows = await caller.schedules.list({ siteId });
    const target = rows.find((r) => r.name === "Server room");
    expect(target).toBeTruthy();
    await caller.schedules.remove({ id: target!.id, siteId });
    const after = await caller.schedules.list({ siteId });
    expect(after.find((r) => r.name === "Server room")).toBeUndefined();
  });
});
