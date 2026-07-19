/**
 * §3i-2 tests — consolidation finding honesty gates + per-commodity utility
 * registry + portfolio roll-up fields.
 */
import { describe, expect, it } from "vitest";

// The consolidation math is embedded in the pipeline; replicate the core
// computation here against synthetic series to falsify the honesty gates.
function consolidationMath(series: { ts: number; kw: number }[][]) {
  const perMeter = series.map((rows) => {
    let peakKw = 0;
    let peakTs = 0;
    for (const r of rows)
      if (r.kw > peakKw) {
        peakKw = r.kw;
        peakTs = r.ts;
      }
    return { peakKw, peakHour: new Date(peakTs).getHours() };
  });
  const bucket = new Map<number, number>();
  for (const rows of series) for (const r of rows) bucket.set(r.ts, (bucket.get(r.ts) ?? 0) + r.kw);
  let coincidentPeakKw = 0;
  bucket.forEach((v) => {
    if (v > coincidentPeakKw) coincidentPeakKw = v;
  });
  const sumOfPeaks = perMeter.reduce((a, p) => a + p.peakKw, 0);
  return { perMeter, coincidentPeakKw, sumOfPeaks, reductionKw: sumOfPeaks - coincidentPeakKw };
}

const HOUR = 3600_000;
/** Build a day of hourly points where the peak lands at `peakHour`. */
function dayShape(peakHour: number, peakKw: number, baseKw = 2): { ts: number; kw: number }[] {
  const day0 = Date.UTC(2026, 0, 5); // Mon Jan 5 2026 UTC
  return Array.from({ length: 24 }, (_, h) => ({ ts: day0 + h * HOUR, kw: h === peakHour ? peakKw : baseKw }));
}

describe("§3i-2 consolidation finding math", () => {
  it("meters peaking at DIFFERENT hours → coincident peak < sum of peaks (finding fires)", () => {
    const r = consolidationMath([dayShape(9, 40), dayShape(18, 35)]);
    expect(r.sumOfPeaks).toBeCloseTo(75);
    // At 9:00 meter B contributes base 2 → coincident 42; at 18:00 A adds 2 → 37.
    expect(r.coincidentPeakKw).toBeCloseTo(42);
    expect(r.reductionKw).toBeGreaterThan(0.5);
    expect(new Set(r.perMeter.map((p) => p.peakHour)).size).toBeGreaterThan(1);
  });

  it("meters peaking at the SAME hour → no reduction, finding must NOT fire", () => {
    const r = consolidationMath([dayShape(14, 40), dayShape(14, 35)]);
    expect(r.coincidentPeakKw).toBeCloseTo(75 + 0); // peaks stack
    expect(r.reductionKw).toBeCloseTo(0);
    expect(new Set(r.perMeter.map((p) => p.peakHour)).size).toBe(1);
  });

  it("reduction below the 0.5 kW materiality floor must not fire", () => {
    // Nearly-identical shapes: peaks 1h apart but the off-peak base nearly
    // equals the peak, so the reduction is tiny.
    const a = dayShape(9, 10, 9.8);
    const b = dayShape(10, 10, 9.8);
    const r = consolidationMath([a, b]);
    expect(r.reductionKw).toBeLessThan(0.5);
  });
});

describe("§3i-2 utility registry + roll-up (live procedures)", () => {
  it("tariffs.utilitiesForState returns per-commodity providers for AZ from the seeded snapshot", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      user: { id: 999901, openId: "test-portfolio-reg", name: "T", role: "user", tier: "pro" },
    } as never);
    const reg = await caller.tariffs.utilitiesForState({ state: "az" });
    expect(reg.state).toBe("AZ");
    expect(reg.electric.length).toBeGreaterThan(0);
    expect(reg.gas.length).toBeGreaterThan(0);
    expect(reg.water.length).toBeGreaterThan(0);
    expect(reg.rateCount).toBeGreaterThanOrEqual(10);
    // Honesty: providers must come only from the seeded snapshot
    expect(reg.electric.some((u: string) => /APS|Arizona Public Service|SRP|Salt River|TEP|Tucson|UNS/i.test(u))).toBe(true);
  });

  it("VT (national coverage) lists its real electric, gas, and water providers from the seeded snapshot", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      user: { id: 999901, openId: "test-portfolio-reg", name: "T", role: "user", tier: "pro" },
    } as never);
    const reg = await caller.tariffs.utilitiesForState({ state: "VT" });
    // National snapshot: Green Mountain Power (electric), Vermont Gas Systems
    // (dominant LDC, EIA-176-derived state-average imputed rates), and a
    // representative municipal water row — RATE-2 (owner directive Jul 19)
    // extended gas/water to every state; providers still come ONLY from the
    // seeded snapshot, never fabricated at query time.
    expect(reg.electric.some((u: string) => /Green Mountain/i.test(u))).toBe(true);
    expect(reg.gas.some((u: string) => /Vermont Gas/i.test(u))).toBe(true);
    expect(reg.water.some((u: string) => /municipal water/i.test(u))).toBe(true);
  });

  it("a nonexistent state code returns empty arrays, not fabricated providers", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({
      user: { id: 999901, openId: "test-portfolio-reg", name: "T", role: "user", tier: "pro" },
    } as never);
    const reg = await caller.tariffs.utilitiesForState({ state: "ZZ" });
    expect(reg.electric).toEqual([]);
    expect(reg.gas).toEqual([]);
    expect(reg.water).toEqual([]);
    expect(reg.rateCount).toBe(0);
  });
});
