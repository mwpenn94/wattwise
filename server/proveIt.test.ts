/**
 * §3e prove-it loop — honesty-gate unit tests.
 *
 * The verdict engine must NEVER claim savings it can't defend:
 *  - zero evaluable months → awaiting_data, no verdicts
 *  - <3 months → early read, capped at on_track (never "verified")
 *  - ≥3 months with ≥60% band-clearing and no over-baseline months → verified
 *  - deltas inside the CVRMSE band → inconclusive, contribute $0
 *  - over-baseline months get next-steps copy, not blame
 */
import { describe, expect, it } from "vitest";
import { buildMonthlyActuals, evaluateImplementation, type MonthlyActual } from "./analytics/proveIt";
import type { BaselineFit } from "./analytics/baseline";

const FIT: BaselineFit = {
  method: "caltrack_monthly",
  coefficients: { baseloadPerDay: 30, coolingSlope: 2, heatingSlope: 1, coolingBalanceF: 65, heatingBalanceF: 60 },
  rSquared: 0.9,
  cvrmse: 0.1, // ±10% band
  monthsCoverage: 12,
  confidence: "high",
  confidenceLabel: "high",
  weatherBasis: "normal_year",
  normalizedAnnualUsage: 12_000,
  disclosures: [],
};

const RATE = 0.15;

function month(m: string, expected: number, actual: number): MonthlyActual {
  return { month: m, expectedKwh: expected, usageKwh: actual };
}

describe("evaluateImplementation — honesty gates", () => {
  it("returns awaiting_data with no verdicts when zero evaluable months exist", () => {
    const r = evaluateImplementation([], FIT, RATE, 500);
    expect(r.status).toBe("awaiting_data");
    expect(r.monthVerdicts).toHaveLength(0);
    expect(r.verifiedSavingsUsd).toBe(0);
    expect(r.disclosures.join(" ")).toMatch(/one full calendar month/i);
  });

  it("caps <3 months at on_track (early read), never verified", () => {
    // two months, both clearly below baseline (20% under, band is 10%)
    const r = evaluateImplementation([month("2026-05", 1000, 800), month("2026-06", 1000, 790)], FIT, RATE, 500);
    expect(r.status).toBe("on_track");
    expect(r.status).not.toBe("verified");
    expect(r.disclosures.join(" ")).toMatch(/early read/i);
    expect(r.verifiedSavingsUsd).toBeGreaterThan(0);
  });

  it("verifies with ≥3 months when ≥60% clear the band and none are over baseline", () => {
    const r = evaluateImplementation(
      [month("2026-04", 1000, 800), month("2026-05", 1000, 820), month("2026-06", 1000, 950)],
      FIT,
      RATE,
      500,
    );
    // 2 of 3 saving (66% ≥ 60%), third inconclusive (5% inside 10% band), none over
    expect(r.status).toBe("verified");
    // only the two band-clearing months count: (200+180) kWh * 0.15
    expect(r.verifiedSavingsUsd).toBe(Math.round((200 + 180) * RATE));
    const inconclusive = r.monthVerdicts.find((v) => v.month === "2026-06");
    expect(inconclusive?.verdict).toBe("inconclusive");
  });

  it("reports inside-band deltas as inconclusive and never counts them as savings", () => {
    // all three months 5% under expected — inside the ±10% band
    const r = evaluateImplementation(
      [month("2026-04", 1000, 950), month("2026-05", 1000, 952), month("2026-06", 1000, 948)],
      FIT,
      RATE,
      500,
    );
    expect(r.status).toBe("inconclusive");
    expect(r.verifiedSavingsUsd).toBe(0);
    for (const v of r.monthVerdicts) expect(v.verdict).toBe("inconclusive");
    expect(r.headline).toMatch(/inconclusive/i);
  });

  it("gives over-baseline months next-steps copy, not blame, and flags underperforming", () => {
    const r = evaluateImplementation(
      [month("2026-04", 1000, 1200), month("2026-05", 1000, 1180), month("2026-06", 1000, 990)],
      FIT,
      RATE,
      500,
    );
    expect(r.status).toBe("underperforming");
    const over = r.monthVerdicts.find((v) => v.verdict === "over_baseline");
    expect(over?.note).toMatch(/new equipment|schedule change|walk-through/i);
    expect(r.headline).toMatch(/not a verdict on you/i);
    expect(r.verifiedSavingsUsd).toBe(0);
  });

  it("widens the band to ±25% when no baseline fit exists, and discloses it", () => {
    // 20% under expected clears a 10% band but NOT a 25% band
    const r = evaluateImplementation([month("2026-04", 1000, 800), month("2026-05", 1000, 800), month("2026-06", 1000, 800)], null, RATE, null);
    expect(r.monthVerdicts.every((v) => v.verdict === "inconclusive")).toBe(true);
    expect(r.status).toBe("inconclusive");
    expect(r.disclosures.join(" ")).toMatch(/±25%/);
  });

  it("annualizes pace against the expected savings only at ≥3 months", () => {
    const two = evaluateImplementation([month("2026-05", 1000, 800), month("2026-06", 1000, 800)], FIT, RATE, 600);
    expect(two.disclosures.join(" ")).not.toMatch(/annualizes/);
    const three = evaluateImplementation(
      [month("2026-04", 1000, 800), month("2026-05", 1000, 800), month("2026-06", 1000, 800)],
      FIT,
      RATE,
      600,
    );
    expect(three.disclosures.join(" ")).toMatch(/annualizes/);
  });
});

describe("buildMonthlyActuals — evaluable-month filtering", () => {
  const TZ = "America/Phoenix";
  const HOUR = 3_600_000;

  /** hourly points of `kwhPerHour` covering [fromIso, toIso) in UTC */
  function hourly(fromIso: string, toIso: string, kwhPerHour: number) {
    const out: Array<{ ts: number; usage: number }> = [];
    for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += HOUR) out.push({ ts: t, usage: kwhPerHour });
    return out;
  }

  it("skips the implementation month, the current partial month, and low-coverage months", () => {
    // implemented mid-March; data mid-March → mid-July; "now" = July 10
    const points = hourly("2026-03-15T00:00:00Z", "2026-07-10T00:00:00Z", 1);
    const months = buildMonthlyActuals(points, Date.parse("2026-03-15T12:00:00Z"), () => 800, TZ, Date.parse("2026-07-10T00:00:00Z"));
    const keys = months.map((m) => m.month);
    expect(keys).not.toContain("2026-03"); // implementation month excluded
    expect(keys).not.toContain("2026-07"); // current partial month excluded
    expect(keys).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  it("drops months whose reading coverage is below the 85% floor", () => {
    // April only has 10 days of data → far below the 85% coverage floor
    const points = [...hourly("2026-04-01T07:00:00Z", "2026-04-11T07:00:00Z", 1), ...hourly("2026-05-01T07:00:00Z", "2026-06-01T07:00:00Z", 1)];
    const months = buildMonthlyActuals(points, Date.parse("2026-03-01T00:00:00Z"), () => 700, TZ, Date.parse("2026-06-15T00:00:00Z"));
    expect(months.map((m) => m.month)).toEqual(["2026-05"]);
  });

  it("skips months where the counterfactual model has no expectation", () => {
    const points = hourly("2026-04-01T07:00:00Z", "2026-06-01T07:00:00Z", 1);
    const months = buildMonthlyActuals(points, Date.parse("2026-03-01T00:00:00Z"), (k) => (k === "2026-04" ? 700 : null), TZ, Date.parse("2026-06-15T00:00:00Z"));
    expect(months.map((m) => m.month)).toEqual(["2026-04"]);
  });

  it("ignores pre-implementation points entirely", () => {
    const points = hourly("2026-01-01T07:00:00Z", "2026-06-01T07:00:00Z", 1);
    const months = buildMonthlyActuals(points, Date.parse("2026-04-20T00:00:00Z"), () => 700, TZ, Date.parse("2026-06-15T00:00:00Z"));
    expect(months.map((m) => m.month)).toEqual(["2026-05"]);
  });
});
