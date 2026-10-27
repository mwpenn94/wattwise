/**
 * RATE-2 (Oct 26 2026): rate rows re-read from the official sheets, and two
 * additive engine rules needed to represent them exactly.
 *
 *  - Southwest Gas G-5: 378th Revised A.C.C. Sheet No. 11, effective 2026-09-01.
 *  - LG&E RS / RTOD-Energy / GS: P.S.C. Electric No. 14, effective 2026-09-01.
 *  - LG&E RGS / CGS: P.S.C. Gas No. 14, effective 2026-08-14 (GSCC 2026-08-01).
 *  - touTimezone: LG&E RTOD periods are filed in Eastern Standard Time all year.
 *  - energyBlockAdjustmentMonths: LG&E CGS high-volume reduction only Apr–Oct.
 */
import { describe, expect, it } from "vitest";
import { costOnTariff } from "./analytics/tariffEngine";
import { hourlyRateSignal } from "./analytics/scenarios";
import { SEED_TARIFFS } from "./seed/seedData";
import { RATE_SOURCE_SEEDS } from "./rateCurrency";
import type { IntervalPoint, TariffStructure } from "../shared/wattwise";

const row = (urdbId: string) => {
  const r = SEED_TARIFFS.find((t) => t.urdbId === urdbId);
  if (!r) throw new Error(`missing seed row ${urdbId}`);
  return r;
};
const one = (iso: string, usage = 1): IntervalPoint[] => [{ ts: Date.parse(iso), usage, demand: usage, durationMin: 60 }];
const energyOf = (pts: IntervalPoint[], s: TariffStructure, tz = "America/New_York") =>
  costOnTariff(pts, s, { tz }).monthlyCosts.reduce((a, m) => a + m.energy, 0);

describe("RATE-2 adopted official values", () => {
  it("Southwest Gas G-5 matches Sheet No. 11 (eff 2026-09-01)", () => {
    const r = row("swgas-az-res");
    expect(r.effectiveDate).toBe("2026-09-01");
    expect(r.structure.fixedMonthly).toBe(10.7);
    expect(r.structure.energy).toHaveLength(1);
    // Delivery 1.23580 − rate adj 0.03556 − DOT 0.00092 + DCA 0.16269 + gas cost 0.22836
    const parts = 1.2358 - 0.03556 - 0.00092 + 0.16269 + 0.22836;
    expect(r.structure.energy[0].ratePerUnit).toBeCloseTo(parts, 5);
    expect(r.structure.energy[0].ratePerUnit).toBe(1.59037);
  });

  it("LG&E RS and GS match Electric No. 14 sheets 5 and 10 (eff 2026-09-01)", () => {
    const rs = row("lge-rs");
    expect(rs.effectiveDate).toBe("2026-09-01");
    expect(rs.structure.fixedMonthly).toBeCloseTo(0.48 * 30.437, 2);
    expect(rs.structure.energy[0].ratePerUnit).toBeCloseTo(0.07481 + 0.04018, 5);
    const gs = row("lge-gs");
    expect(gs.effectiveDate).toBe("2026-09-01");
    expect(gs.structure.fixedMonthly).toBeCloseTo(1.35 * 30.437, 2);
    expect(gs.structure.energy[0].ratePerUnit).toBeCloseTo(0.0936 + 0.0403, 5);
    expect(gs.peakKwMax).toBe(50);
  });

  it("LG&E RGS and CGS match Gas No. 14 (eff 2026-08-14; GSCC $0.57318/Ccf)", () => {
    const rgs = row("lge-rgs");
    expect(rgs.effectiveDate).toBe("2026-08-14");
    expect(rgs.structure.fixedMonthly).toBeCloseTo(0.72 * 30.437, 2);
    expect(rgs.structure.energy[0].ratePerUnit).toBeCloseTo((0.63912 + 0.57318) / 1.037, 4);
    const cgs = row("lge-cgs");
    expect(cgs.effectiveDate).toBe("2026-08-14");
    expect(cgs.structure.fixedMonthly).toBeCloseTo(2.92 * 30.437, 2);
    expect(cgs.structure.energy[0].ratePerUnit).toBeCloseTo((0.4386 + 0.57318) / 1.037, 4);
    expect(cgs.structure.energyBlockAdjustments).toEqual([
      { upToKwh: 1037, ratePerUnit: 0 },
      { upToKwh: null, ratePerUnit: -0.0482 },
    ]);
    expect(cgs.structure.energyBlockAdjustmentMonths).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("LG&E sources point at the current tariff books", () => {
    const el = RATE_SOURCE_SEEDS.find((s) => s.sourceKey === "lge-ky-electric")!;
    const gas = RATE_SOURCE_SEEDS.find((s) => s.sourceKey === "lge-ky-gas")!;
    expect(el.sourceUrl).toMatch(/LGE-Electric-Rates-083126\.pdf$/);
    expect(el.sourceLabel).toMatch(/Electric No\. 14/);
    expect(gas.sourceUrl).toMatch(/LGE-Gas-Rates-082726\.pdf$/);
    expect(gas.adjustorCycle).toBe("quarterly_gsc");
  });
});

describe("RATE-2 LG&E RTOD-Energy periods (Eastern Standard Time all year)", () => {
  const s = row("lge-rtod-energy").structure;
  const ON = 0.19307;
  const OFF = 0.09312;

  it("has the filed rates and EST clock", () => {
    expect(s.touTimezone).toBe("Etc/GMT+5");
    expect(s.fixedMonthly).toBeCloseTo(0.48 * 30.437, 2);
    expect(new Set(s.energy.map((p) => p.ratePerUnit))).toEqual(new Set([ON, OFF]));
    expect(s.energy.some((p) => p.holidayExclusions?.length)).toBe(false);
  });

  // Wed Jul 15 2026 (EDT = UTC−4; EST = UTC−5). On-peak 1–5 pm EST = 2–6 pm EDT.
  it.each([
    ["2026-07-15T16:30:00Z", OFF], // 12:30 EDT = 11:30 EST
    ["2026-07-15T17:30:00Z", OFF], // 1:30 pm EDT = 12:30 EST (old 1–7 pm model said on-peak)
    ["2026-07-15T18:30:00Z", ON], // 2:30 pm EDT = 1:30 pm EST
    ["2026-07-15T21:30:00Z", ON], // 5:30 pm EDT = 4:30 pm EST
    ["2026-07-15T22:30:00Z", OFF], // 6:30 pm EDT = 5:30 pm EST
    ["2026-07-18T19:30:00Z", OFF], // Saturday afternoon
  ])("summer %s prices at %s", (iso, rate) => {
    expect(energyOf(one(iso), s)).toBeCloseTo(rate, 6);
  });

  // Wed Jan 14 2026 (EST = UTC−5). On-peak 6–10 am and 6–10 pm EST.
  it.each([
    ["2026-01-14T11:30:00Z", ON], // 6:30 am EST
    ["2026-01-14T15:30:00Z", OFF], // 10:30 am EST
    ["2026-01-14T17:00:00Z", OFF], // noon EST
    ["2026-01-14T23:30:00Z", ON], // 6:30 pm EST
    ["2026-01-15T03:30:00Z", OFF], // 10:30 pm EST
    ["2026-01-17T12:00:00Z", OFF], // Saturday 7 am EST
  ])("winter %s prices at %s", (iso, rate) => {
    expect(energyOf(one(iso), s)).toBeCloseTo(rate, 6);
  });

  it("treats a weekday legal holiday as a weekday (Jul 3 2026 observed holiday)", () => {
    expect(energyOf(one("2026-07-03T19:00:00Z"), s)).toBeCloseTo(ON, 6); // Fri 2 pm EST
  });

  it("billing months stay on the meter's clock", () => {
    // 00:30 EDT Aug 1 = 23:30 EST Jul 31 — still billed in August on the meter.
    const r = costOnTariff(one("2026-08-01T04:30:00Z"), s, { tz: "America/New_York" });
    expect(r.monthlyCosts.map((m) => m.month)).toEqual(["2026-08"]);
  });

  it("dispatch signal uses the same EST periods", () => {
    const sig = hourlyRateSignal(s, 2025, "America/New_York");
    const hourOf = (iso: string) => Math.round((Date.parse(iso) - new Date(2025, 0, 1).getTime()) / 3_600_000);
    // The signal is hourly: use whole hours.
    expect(sig[hourOf("2025-07-16T17:00:00Z")]).toBeCloseTo(OFF, 6); // 1 pm EDT = noon EST
    expect(sig[hourOf("2025-07-16T18:00:00Z")]).toBeCloseTo(ON, 6); // 2 pm EDT = 1 pm EST
    expect(sig[hourOf("2025-07-16T22:00:00Z")]).toBeCloseTo(OFF, 6); // 6 pm EDT = 5 pm EST
    expect(sig[hourOf("2025-01-15T11:00:00Z")]).toBeCloseTo(ON, 6); // 6 am EST
  });
});

describe("RATE-2 LG&E CGS April–October high-volume distribution reduction", () => {
  const s = row("lge-cgs").structure;
  const BASE = 0.9757;
  const monthOf = (startIso: string, therms: number): IntervalPoint[] => {
    // 100 hourly readings within the month (well inside it on any US clock).
    const t0 = Date.parse(startIso);
    return Array.from({ length: 100 }, (_, i) => ({ ts: t0 + i * 3_600_000, usage: therms / 100, demand: null, durationMin: 60 }));
  };

  it("April usage over 1,037 therms gets the filed reduction", () => {
    const e = energyOf(monthOf("2026-04-10T12:00:00Z", 2000), s);
    expect(e).toBeCloseTo(2000 * BASE - (2000 - 1037) * 0.0482, 4);
  });

  it("January usage is billed at the full price", () => {
    expect(energyOf(monthOf("2026-01-10T12:00:00Z", 2000), s)).toBeCloseTo(2000 * BASE, 4);
  });

  it("April usage under the threshold is billed at the full price", () => {
    expect(energyOf(monthOf("2026-04-10T12:00:00Z", 900), s)).toBeCloseTo(900 * BASE, 4);
  });
});

describe("RATE-2 additive fields are off by default", () => {
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const tou: TariffStructure = {
    fixedMonthly: 10,
    energy: [
      { label: "On", months: ALL, daysOfWeek: [1, 2, 3, 4, 5], hourStart: 13, hourEnd: 17, ratePerUnit: 0.3 },
      { label: "Off", months: ALL, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: 0.1 },
    ],
    demand: [],
    energyBlockAdjustments: [{ upToKwh: 100, ratePerUnit: 0 }, { upToKwh: null, ratePerUnit: -0.01 }],
  };

  it("without touTimezone, periods use the meter clock", () => {
    // 1:30 pm EDT on a Wednesday is on-peak on the meter clock.
    expect(energyOf(one("2026-07-15T17:30:00Z"), tou)).toBeCloseTo(0.3 + 0, 6);
  });

  it("without energyBlockAdjustmentMonths, adjustments apply every month", () => {
    const pts: IntervalPoint[] = Array.from({ length: 10 }, (_, i) => ({ ts: Date.parse("2026-01-10T06:00:00Z") + i * 3_600_000, usage: 30, demand: 30, durationMin: 60 }));
    // 300 kWh off-peak (1–10 am EST) at 0.1 = 30, minus 200 × 0.01 = 2
    expect(energyOf(pts, tou)).toBeCloseTo(30 - 2, 6);
  });
});

describe("RATE-2 registry URL correction", () => {
  it("clears the old document's fingerprint only when the URL changes", async () => {
    const { registryUrlChangeReset } = await import("./rateCurrency");
    const oldUrl = "https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Electric-Rates-072126.pdf";
    const newUrl = "https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Electric-Rates-083126.pdf";
    expect(registryUrlChangeReset(oldUrl, newUrl)).toEqual({ contentFingerprint: null, fingerprintAt: null, consecutiveFailures: 0 });
    expect(registryUrlChangeReset(newUrl, newUrl)).toEqual({});
  });
});
