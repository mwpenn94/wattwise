/**
 * v1.19 §5 stage 4 / v2.10 §1b — away-mode watchdog persona suite
 * ("the snowbird": away Nov–Apr, wants ONE promise kept — quiet unless
 * something at the empty home actually needs attention).
 */
import { describe, expect, it } from "vitest";
import { computeVacantBaseline, evaluateAwayWatchdog, tsInAwayWindow } from "./awayMode";

const HOUR = 3_600_000;
// Build hourly points: (utcHourOffset, kWh-in-hour)
function pts(startTs: number, hourly: number[]): Array<{ ts: number; durationMin: number; usage: number }> {
  return hourly.map((usage, i) => ({ ts: startTs + i * HOUR, durationMin: 60, usage }));
}

// 10 pre-away days of a home with a 0.2 kW overnight floor and daytime living load.
function preAwayHistory(startTs: number): Array<{ ts: number; durationMin: number; usage: number }> {
  const out: Array<{ ts: number; durationMin: number; usage: number }> = [];
  for (let d = 0; d < 10; d++) {
    for (let h = 0; h < 24; h++) {
      const usage = h >= 2 && h < 5 ? 0.2 : h >= 17 && h < 22 ? 1.8 : 0.6;
      out.push({ ts: startTs + (d * 24 + h) * HOUR, durationMin: 60, usage });
    }
  }
  return out;
}

describe("away window membership", () => {
  it("respects start/end bounds and the master toggle", () => {
    const w = { awayMode: true, awayStart: 1000, awayEnd: 2000 };
    expect(tsInAwayWindow(1500, w)).toBe(true);
    expect(tsInAwayWindow(500, w)).toBe(false);
    expect(tsInAwayWindow(2500, w)).toBe(false);
    expect(tsInAwayWindow(1500, { ...w, awayMode: false })).toBe(false);
    // open-ended window (indefinite away)
    expect(tsInAwayWindow(99999, { awayMode: true, awayStart: null, awayEnd: null })).toBe(true);
  });
});

describe("vacant baseline (empty-home floor)", () => {
  // Use a UTC-pinned timezone so hour-of-day in the test data is deterministic.
  const tz = "UTC";

  it("computes the overnight floor from pre-away nights only", () => {
    const start = Date.UTC(2026, 0, 1);
    const awayStart = start + 10 * 24 * HOUR;
    const vb = computeVacantBaseline(preAwayHistory(start), "electric", awayStart, tz);
    expect(vb).not.toBeNull();
    expect(vb!.basis).toBe("overnight_floor");
    expect(vb!.vacantFloor).toBeCloseTo(0.2, 5);
    expect(vb!.nightsUsed).toBe(10);
  });

  it("declines (null) with fewer than 5 usable nights — no alerting off a guess", () => {
    const start = Date.UTC(2026, 0, 1);
    const short = preAwayHistory(start).slice(0, 3 * 24); // 3 days
    const vb = computeVacantBaseline(short, "electric", start + 3 * 24 * HOUR, tz);
    expect(vb).toBeNull();
  });

  it("water vacant baseline is zero — any sustained flow is leak-first", () => {
    const vb = computeVacantBaseline([], "water", null, tz);
    expect(vb).not.toBeNull();
    expect(vb!.vacantFloor).toBe(0);
    expect(vb!.basis).toBe("assumed_zero_water");
  });
});

describe("snowbird persona — watchdog verdicts", () => {
  const tz = "UTC";
  const start = Date.UTC(2026, 0, 1);
  const awayStart = start + 10 * 24 * HOUR;
  const history = preAwayHistory(start);
  const vacant = computeVacantBaseline(history, "electric", awayStart, tz)!;

  it("all quiet: away usage at the floor produces the reassurance card, $0, no alert kind", () => {
    const awayPts = pts(awayStart, Array(48).fill(0.2));
    const f = evaluateAwayWatchdog(awayPts, vacant, "electric", { ratePerUnit: 0.15, siteLabel: "Tucson home", tz });
    expect(f.kind).toBe("quiet");
    expect(f.title).toMatch(/All quiet at Tucson home/);
    expect(f.dollarImpactUsd).toBe(0);
    expect(f.body).toMatch(/last upload/i); // honest about manual-upload timing
  });

  it("sustained excess (6h+) above 1.5× floor fires excess_usage with when-it-started", () => {
    // 12 quiet hours, then 10 hours stuck at 1.5 kW (HVAC stuck on)
    const awayPts = pts(awayStart, [...Array(12).fill(0.2), ...Array(10).fill(1.5)]);
    const f = evaluateAwayWatchdog(awayPts, vacant, "electric", { ratePerUnit: 0.15, siteLabel: "Tucson home", tz });
    expect(f.kind).toBe("excess_usage");
    expect(f.excessStartTs).toBe(awayStart + 12 * HOUR);
    expect(f.dollarImpactUsd).toBeGreaterThan(0);
    expect(f.body).toMatch(/empty-home baseline/);
  });

  it("brief spikes under 6h do NOT alert — quiet-by-default holds", () => {
    // two 3h bumps separated by quiet — never 6h sustained
    const awayPts = pts(awayStart, [
      ...Array(6).fill(0.2), ...Array(3).fill(1.5), ...Array(6).fill(0.2), ...Array(3).fill(1.5), ...Array(6).fill(0.2),
    ]);
    const f = evaluateAwayWatchdog(awayPts, vacant, "electric", { ratePerUnit: 0.15, siteLabel: "Tucson home", tz });
    expect(f.kind).toBe("quiet");
  });

  it("water: any 6h+ sustained flow at an empty home is leak-first with shutoff checklist", () => {
    const vacantW = computeVacantBaseline([], "water", null, tz)!;
    const awayPts = pts(awayStart, [...Array(5).fill(0), ...Array(8).fill(12)]); // gal/hr from 5am
    const f = evaluateAwayWatchdog(awayPts, vacantW, "water", { ratePerUnit: 0.008, siteLabel: "Tucson home", tz });
    expect(f.kind).toBe("sustained_water_flow");
    expect(f.title).toMatch(/likely a leak/i);
    expect(f.body).toMatch(/shutoff/i);
    expect(f.body).toMatch(/irrigation/i); // known false positive disclosed
  });

  it("insufficient baseline: watchdog says so instead of alerting off a guess", () => {
    const awayPts = pts(awayStart, Array(24).fill(1.0));
    const f = evaluateAwayWatchdog(awayPts, null, "electric", { ratePerUnit: 0.15, siteLabel: "Tucson home", tz });
    expect(f.kind).toBe("insufficient_baseline");
    expect(f.dollarImpactUsd).toBe(0);
  });
});
