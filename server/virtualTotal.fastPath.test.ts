import { describe, expect, it } from "vitest";
import { requireAlignedCampusSeries, requireAlignedCampusSeriesKeyed, type ComponentIntervalSeries } from "./virtualTotal";

// Oct 25: the index-aligned fast path must be indistinguishable from the
// original keyed algorithm (same points, order, demand nulls, notes, errors).
const T0 = Date.UTC(2025, 9, 1, 7, 0);
function series(n: number, seed: number, opts: { step?: number; demandNullEvery?: number; start?: number } = {}): ComponentIntervalSeries {
  const step = opts.step ?? 15; const out: ComponentIntervalSeries = [];
  for (let i = 0; i < n; i++) {
    const usage = Math.round((Math.sin(i * 0.37 + seed) + 1.3) * 1000) / 1000 + seed * 0.001;
    const demand = opts.demandNullEvery && i % opts.demandNullEvery === 0 ? null : Math.round(usage * 4 * 1000) / 1000;
    out.push({ ts: (opts.start ?? T0) + i * step * 60_000, durationMin: step, usage, demand });
  }
  return out;
}
function outcome(fn: typeof requireAlignedCampusSeries, s: ComponentIntervalSeries[]) {
  try { return { ok: fn(s) }; } catch (e) { return { err: String((e as Error).message) }; }
}
describe("campus total fast path parity", () => {
  const cases: Array<[string, ComponentIntervalSeries[]]> = [
    ["two aligned", [series(96, 1), series(96, 2)]],
    ["four aligned year", [series(35040, 1), series(35040, 2), series(35040, 3), series(35040, 4)]],
    ["demand nulls in one", [series(200, 1, { demandNullEvery: 7 }), series(200, 2)]],
    ["demand nulls in both", [series(200, 1, { demandNullEvery: 5 }), series(200, 2, { demandNullEvery: 3 })]],
    ["different lengths", [series(100, 1), series(99, 2)]],
    ["offset start", [series(100, 1), series(100, 2, { start: T0 + 15 * 60_000 })]],
    ["mixed durations", [series(100, 1), series(50, 2, { step: 30 })]],
    ["gap in one", [series(100, 1), (() => { const s = series(101, 2); s.splice(40, 1); return s; })()]],
    ["duplicate ts", [series(100, 1), (() => { const s = series(100, 2); s[50] = { ...s[49]! }; return s; })()]],
    ["unsorted", [series(100, 1), (() => { const s = series(100, 2); [s[10], s[11]] = [s[11]!, s[10]!]; return s; })()]],
    ["nan usage", [series(100, 1), (() => { const s = series(100, 2); s[5] = { ...s[5]!, usage: Number.NaN }; return s; })()]],
    ["empty component", [series(100, 1), []]],
    ["single component", [series(100, 1)]],
  ];
  for (const [name, s] of cases) {
    it(name, () => {
      expect(outcome(requireAlignedCampusSeries, s)).toEqual(outcome(requireAlignedCampusSeriesKeyed, s));
    });
  }
  it("still rejects misaligned campuses with the same message", () => {
    expect(() => requireAlignedCampusSeries([series(100, 1), series(99, 2)])).toThrow("Incomplete campus alignment");
  });
});
