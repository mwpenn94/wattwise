/**
 * GAP-A / AC11 / AC18 — PV signature detection + net/gross gate contract.
 *
 * Pins:
 * 1. A clean, solar-free load shape does NOT trigger detection.
 * 2. A midday-collapse (net-metered PV) shape DOES trigger detection.
 * 3. Negative (export) intervals trigger detection unambiguously.
 * 4. Below 30 analyzable days the detector stays silent (no shape-only call).
 * 5. PV_GATED_INSIGHT_KINDS covers the shape-dependent kinds and nothing
 *    provenance-only (summary/intake must never be withheld).
 * 6. pvGateState maps site fields to the correct gate state.
 * 7. sites.resolvePv: "net" confirms solar + basis; "no_solar" dismisses.
 * 8. AC12: measures.evaluate stamps ENGINE_VERSION on first evaluation.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { detectPvSignature, PV_GATED_INSIGHT_KINDS, pvGateState } from "./analytics/pvDetection";
import { appRouter } from "./routers";
import * as h from "./dbHelpers";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { ENGINE_VERSION } from "../shared/wattwise";
import type { IntervalPoint } from "../shared/wattwise";

const TZ = "America/Phoenix";
const HOUR = 3_600_000;

/** Build hourly interval days. shape(hour) returns kWh for that hour. */
function buildDays(nDays: number, shape: (hour: number) => number): IntervalPoint[] {
  const points: IntervalPoint[] = [];
  // Anchor at a known UTC ts that lands at local midnight-ish; exact alignment
  // is irrelevant because the detector re-derives local hours itself.
  const start = Date.UTC(2026, 0, 5, 7, 0, 0); // Jan 5 2026 00:00 Phoenix
  for (let d = 0; d < nDays; d++) {
    for (let hr = 0; hr < 24; hr++) {
      points.push({ ts: start + d * 24 * HOUR + hr * HOUR, durationMin: 60, usage: shape(hr), demand: null });
    }
  }
  return points;
}

describe("PV signature detector (GAP-A)", () => {
  it("stays silent on a normal solar-free load shape", () => {
    // Typical home: baseload 0.4, morning bump, evening peak, midday moderate.
    const r = detectPvSignature(
      buildDays(45, (h2) => (h2 >= 18 && h2 < 22 ? 1.8 : h2 >= 6 && h2 < 9 ? 1.2 : h2 >= 10 && h2 < 15 ? 0.9 : 0.4)),
      TZ,
    );
    expect(r.detected).toBe(false);
    expect(r.daysAnalyzed).toBeGreaterThanOrEqual(30);
  });

  it("detects the midday-collapse fingerprint of net-metered PV", () => {
    // Solar carves midday to near zero while shoulders stay normal.
    const r = detectPvSignature(
      buildDays(45, (h2) => (h2 >= 10 && h2 < 15 ? 0.05 : h2 >= 18 && h2 < 22 ? 1.8 : h2 >= 6 && h2 < 9 ? 1.2 : 0.4)),
      TZ,
    );
    expect(r.detected).toBe(true);
    expect(r.signatureDayShare).toBeGreaterThanOrEqual(0.4);
  });

  it("treats negative (export) intervals as an unambiguous signal", () => {
    const r = detectPvSignature(
      buildDays(10, (h2) => (h2 >= 11 && h2 < 14 ? -0.6 : h2 >= 18 ? 1.5 : 0.5)),
      TZ,
    );
    expect(r.hasNegativeIntervals).toBe(true);
    expect(r.detected).toBe(true);
  });

  it("stays silent below 30 days when the only evidence is shape", () => {
    const r = detectPvSignature(
      buildDays(12, (h2) => (h2 >= 10 && h2 < 15 ? 0.05 : 1.2)),
      TZ,
    );
    expect(r.detected).toBe(false);
    expect(r.rationale).toContain("needs ≥30");
  });

  it("gates shape-dependent kinds but never provenance/summary kinds", () => {
    for (const k of ["load_factor", "peak_attribution", "baseline", "end_use", "anomaly"]) {
      expect(PV_GATED_INSIGHT_KINDS.has(k)).toBe(true);
    }
    for (const k of ["summary", "intake_assumptions", "data_coverage", "pv_gate"]) {
      expect(PV_GATED_INSIGHT_KINDS.has(k)).toBe(false);
    }
  });

  it("maps site fields to gate states", () => {
    expect(pvGateState({ hasSolar: false, pvDetectionStatus: "detected_unconfirmed", netMeteringBasis: null })).toBe("blocked_unconfirmed");
    expect(pvGateState({ hasSolar: true, pvDetectionStatus: "confirmed_net", netMeteringBasis: "net" })).toBe("resolved_net");
    expect(pvGateState({ hasSolar: false, pvDetectionStatus: "dismissed", netMeteringBasis: null })).toBe("dismissed");
    expect(pvGateState({ hasSolar: false, pvDetectionStatus: null, netMeteringBasis: null })).toBe("not_applicable");
  });
});

describe("sites.resolvePv + AC12 engine pinning (integration)", () => {
  const openId = `pv-gate-test-${Date.now()}`;
  let userId: number;
  let siteId: number;

  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    await db.insert(users).values({ openId, name: "PV Gate Tester", tier: "pro", role: "user" });
    const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
    userId = rows[0].id;
    const caller = appRouter.createCaller({
      user: { ...rows[0] },
      req: {} as never,
      res: {} as never,
    } as never);
    const site = await caller.sites.create({ name: "PV Test Site", buildingType: "single_family", state: "AZ" });
    siteId = site.id;
  });

  function callerFor() {
    return (async () => {
      const db = await getDb();
      const rows = await db!.select().from(users).where(eq(users.openId, openId)).limit(1);
      return appRouter.createCaller({ user: { ...rows[0] }, req: {} as never, res: {} as never } as never);
    })();
  }

  it("answer=net confirms solar and sets basis; gate resolves", async () => {
    // Simulate a prior detection
    await h.updateSite(siteId, userId, { pvDetectionStatus: "detected_unconfirmed" });
    const caller = await callerFor();
    const res = await caller.sites.resolvePv({ siteId, answer: "net" });
    expect(res.ok).toBe(true);
    const site = await h.getSite(siteId, userId);
    expect(site.pvDetectionStatus).toBe("confirmed_net");
    expect(site.netMeteringBasis).toBe("net");
    expect(site.hasSolar).toBe(true);
    expect(
      pvGateState({ hasSolar: site.hasSolar, pvDetectionStatus: site.pvDetectionStatus, netMeteringBasis: site.netMeteringBasis }),
    ).toBe("resolved_net");
  });

  it("answer=no_solar dismisses the gate without claiming solar", async () => {
    await h.updateSite(siteId, userId, { pvDetectionStatus: "detected_unconfirmed" });
    const caller = await callerFor();
    const res = await caller.sites.resolvePv({ siteId, answer: "no_solar" });
    expect(res.note).toContain("no solar");
    const site = await h.getSite(siteId, userId);
    expect(site.pvDetectionStatus).toBe("dismissed");
  });

  it("proveIt.evaluate stamps the current engine version on first evaluation (AC12)", async () => {
    const caller = await callerFor();
    const impl = await caller.proveIt.mark({
      siteId,
      measure: "led_retrofit",
      title: "LED retrofit",
      implementedAt: Date.now() - 90 * 86_400_000,
      expectedSavingsUsd: 200,
    });
    await caller.proveIt.evaluate({ id: impl.id });
    const row = await h.getMeasureImplementation(impl.id, userId);
    expect(row.engineVersion).toBe(ENGINE_VERSION);
    expect(row.occupancyPeriod).toBe("baseline");
  });

  it("occupancy change marks the site and future evaluations disclose it (AC12)", async () => {
    const caller = await callerFor();
    const changedAt = Date.now() - 30 * 86_400_000;
    await caller.sites.markOccupancyChange({ siteId, changedAt });
    const site = await h.getSite(siteId, userId);
    expect(Number(site.occupancyChangedAt)).toBe(changedAt);
    // A measure implemented BEFORE the change gets the pre- period label + disclosure
    const impl = await caller.proveIt.mark({
      siteId,
      measure: "thermostat",
      title: "Smart thermostat",
      implementedAt: changedAt - 60 * 86_400_000,
      expectedSavingsUsd: 150,
    });
    const result = await caller.proveIt.evaluate({ id: impl.id });
    expect(result.disclosures.some((d: string) => d.includes("Occupancy changed"))).toBe(true);
    const row = await h.getMeasureImplementation(impl.id, userId);
    expect(row.occupancyPeriod?.startsWith("pre-")).toBe(true);
  });
});
