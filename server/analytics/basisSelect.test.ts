import { describe, expect, it } from "vitest";
import { pickSizeFitBasis } from "./basisSelect";

// Shapes mirror the seeded, filed UNS Electric commercial schedules.
const LGS = { id: 11, urdbId: "uns-lgs", name: "Large General Service (EGLGS) — filed base", structure: { demandMinKw: 450, energy: [{}], demand: [{}] } };
const SGS = { id: 9, urdbId: "uns-egsgs", name: "Small General Service (EGSGS) — filed base", structure: { energy: [], demand: [], migrationAtConsecutiveMonthlyKwh: { kwh: 12000, months: 2 } } };
const MGS = { id: 10, urdbId: "uns-egmgs", name: "Medium General Service (EGMGS) — filed base", structure: { demandMinKw: 20, energy: [{}], demand: [{}] } };
const MGST = { id: 12, urdbId: "uns-egmgst", name: "Medium General Service Time-of-Use (EGMGST) — filed base", structure: { demandMinKw: 20, energy: [{}, {}, {}, {}, {}], demand: [{}] } };
const all = [LGS, SGS, MGS, MGST];
const yes = () => true;

describe("size-fit current-rate basis (Oct 24 rerun audit)", () => {
  it("never prices a small load on the 450 kW-minimum large-general schedule", () => {
    const pick = pickSizeFitBasis(all, { eligible: (t) => t.id !== SGS.id, peakKw: 21 });
    expect(pick?.tariff.urdbId).toBe("uns-egmgs");
    expect(pick?.method).toBe("size_fit");
    expect(pick?.disclosure).toMatch(/not on file/);
    expect(pick?.disclosure).toMatch(/Large General Service/);
  });
  it("prefers the small-customer schedule while the site has not met its migration threshold", () => {
    const pick = pickSizeFitBasis(all, { eligible: yes, peakKw: 4 });
    expect(pick?.tariff.urdbId).toBe("uns-egsgs");
  });
  it("uses the large schedule only when the observed peak meets its filed minimum", () => {
    const pick = pickSizeFitBasis(all, { eligible: (t) => t.id !== SGS.id, peakKw: 900 });
    expect(pick?.tariff.urdbId).toBe("uns-lgs");
  });
  it("chooses the standard schedule before time-of-use", () => {
    const pick = pickSizeFitBasis([MGST, MGS], { eligible: yes, peakKw: 60 });
    expect(pick?.tariff.urdbId).toBe("uns-egmgs");
  });
  it("an exact bill rate code always wins", () => {
    const pick = pickSizeFitBasis(all, { eligible: yes, peakKw: 21, rateCodeUrdbId: "uns-egmgst" });
    expect(pick?.tariff.urdbId).toBe("uns-egmgst");
    expect(pick?.method).toBe("rate_code");
    expect(pick?.disclosure).toBeNull();
  });
  it("keeps legacy order for utilities without filed size terms", () => {
    const a = { id: 1, name: "A", structure: { energy: [{}], demand: [] } };
    const b = { id: 2, name: "B", structure: { energy: [{}], demand: [] } };
    expect(pickSizeFitBasis([a, b], { eligible: yes, peakKw: 50 })?.tariff.id).toBe(1);
    expect(pickSizeFitBasis([a, b], { eligible: yes, peakKw: 50 })?.method).toBe("first_eligible");
  });
  it("returns null when nothing is eligible (caller falls back with disclosure)", () => {
    expect(pickSizeFitBasis(all, { eligible: () => false, peakKw: 50 })).toBeNull();
  });
});
