/**
 * Batch-3 reconciliation suite — AC13 equipment + AC14 vertical packs.
 *
 * Pins the honesty contracts:
 *  - equipment rows are inferred with a stated basis; lifecycle windows are
 *    planning language, never failure predictions;
 *  - degradation drift is material only past ±8% and names the drift, not a
 *    diagnosis;
 *  - production KPI computes only from logged periods; no log → no KPI;
 *  - regressor disclosure warns that weather-only anomalies can't be separated
 *    from production swings.
 */
import { describe, expect, it } from "vitest";
import {
  inferEquipment,
  lifecycleHorizon,
  degradationDrift,
  sizingDiagnostic,
  annualCheckupStory,
} from "./equipment";
import { VERTICAL_PACKS, packForBuildingType, productionKpi, regressorDisclosure } from "./verticals";

describe("AC13 — equipment inference", () => {
  it("infers compressor cooling with a stated basis when the HVAC share is strong", () => {
    const rows = inferEquipment({
      buildingType: "single_family",
      sqft: 1800,
      state: "AZ",
      hvacShare: 0.45,
      baseloadShare: 0.3,
      hasSolar: false,
      hasGasMeter: false,
      peakKw: 6,
    });
    const cooling = rows.find((r) => r.equipKey === "cooling_system");
    expect(cooling).toBeDefined();
    expect(cooling!.confidence).toBe("high");
    expect(cooling!.basis).toContain("45%"); // the observation is named
    // no gas meter → electric water heater at LOW confidence (honest)
    const wh = rows.find((r) => r.equipKey === "water_heater");
    expect(wh!.label).toContain("Electric");
    expect(wh!.confidence).toBe("low");
  });

  it("gas meter flips heating + water heater inference to gas", () => {
    const rows = inferEquipment({
      buildingType: "office",
      sqft: 12000,
      state: "WA",
      hvacShare: 0.1,
      baseloadShare: 0.5,
      hasSolar: false,
      hasGasMeter: true,
      peakKw: 40,
    });
    expect(rows.find((r) => r.equipKey === "heating_system")).toBeDefined();
    expect(rows.find((r) => r.equipKey === "water_heater")!.label).toContain("Gas");
    // commercial floor area → lighting system row
    expect(rows.find((r) => r.equipKey === "lighting_system")).toBeDefined();
  });
});

describe("AC13 — lifecycle horizon (planning language, not predictions)", () => {
  const now = new Date("2026-07-18");
  it("classifies past-life, 5-year-window, and healthy horizons", () => {
    const items = lifecycleHorizon(
      [
        { equipKey: "a", label: "Old AC", installYear: 2005, serviceLifeYears: 15 }, // past
        { equipKey: "b", label: "Mid furnace", installYear: 2010, serviceLifeYears: 18 }, // 2028 → window
        { equipKey: "c", label: "New heat pump", installYear: 2024, serviceLifeYears: 15 }, // healthy
        { equipKey: "d", label: "Unknown vintage", installYear: null, serviceLifeYears: 15 },
      ],
      now,
    );
    expect(items[0].window).toBe("past_typical_life");
    expect(items[0].message).toContain("plan (don't panic)"); // never a failure prediction
    expect(items[1].window).toBe("inside_5yr_window");
    expect(items[2].window).toBe("healthy_horizon");
    expect(items[3].window).toBe("unknown");
    expect(items[3].message).toContain("add the install year");
  });
});

describe("AC13 — degradation drift", () => {
  it("names material upward drift without diagnosing", () => {
    const d = degradationDrift(11_000, 10_000)!; // +10%
    expect(d.material).toBe(true);
    expect(d.message).toContain("names the drift, not the diagnosis");
  });
  it("stays quiet inside normal variation", () => {
    const d = degradationDrift(10_300, 10_000)!; // +3%
    expect(d.material).toBe(false);
  });
  it("returns null without a prior year", () => {
    expect(degradationDrift(10_000, null)).toBeNull();
  });
});

describe("AC13 — sizing diagnostics", () => {
  it("flags oversize suspicion from spiky low-load-factor shape", () => {
    const s = sizingDiagnostic({ loadFactor: 0.15, hvacShare: 0.4, peakKw: 20, sqft: 2000 }); // 10 W/sqft
    expect(s.kind).toBe("oversize_suspect");
  });
  it("flags undersize suspicion when HVAC runs flat-out", () => {
    const s = sizingDiagnostic({ loadFactor: 0.8, hvacShare: 0.5, peakKw: 10, sqft: 2000 });
    expect(s.kind).toBe("undersize_suspect");
  });
  it("no finding on unremarkable shapes", () => {
    const s = sizingDiagnostic({ loadFactor: 0.45, hvacShare: 0.3, peakKw: 8, sqft: 2000 });
    expect(s.kind).toBe("no_finding");
  });
});

describe("AC13 — annual checkup story", () => {
  it("composes lifecycle + drift + sizing and always ends with the confirm invitation", () => {
    const lifecycle = lifecycleHorizon([{ equipKey: "a", label: "Old AC", installYear: 2005, serviceLifeYears: 15 }], new Date("2026-07-18"));
    const story = annualCheckupStory({
      siteName: "Test Office",
      lifecycle,
      drift: degradationDrift(11_000, 10_000),
      sizing: sizingDiagnostic({ loadFactor: 0.15, hvacShare: 0.4, peakKw: 20, sqft: 2000 }),
    });
    expect(story).toContain("Old AC");
    expect(story).toContain("confirm or edit the inventory");
  });
});

describe("AC14 — vertical packs", () => {
  it("maps municipal buildings to the water pack and manufacturing/warehouse to production", () => {
    expect(packForBuildingType("municipal")?.packKey).toBe("water_wastewater");
    expect(packForBuildingType("manufacturing")?.packKey).toBe("manufacturing");
    expect(packForBuildingType("office")).toBeNull();
  });

  it("computes the production KPI only from logged periods (no log → null)", () => {
    const pack = VERTICAL_PACKS.find((p) => p.packKey === "water_wastewater")!;
    expect(productionKpi({ pack, periods: [], usageKwhInWindow: () => 999 })).toBeNull();

    const day = 86_400_000;
    const kpi = productionKpi({
      pack,
      periods: [{ periodStart: 0, periodEnd: 30 * day, quantity: 10, metricKey: "water_pumped_mg" }],
      usageKwhInWindow: () => 20_000, // 20,000 kWh over the logged window
    })!;
    expect(kpi.intensity).toBe(2000); // kWh per MG
    expect(kpi.standing).toBe("in_range"); // 1000–3500 typical range
    expect(kpi.coverageNote).toContain("logged production period");
  });

  it("above-range standing names both possible explanations (inefficiency OR site conditions)", () => {
    const pack = VERTICAL_PACKS.find((p) => p.packKey === "water_wastewater")!;
    const kpi = productionKpi({
      pack,
      periods: [{ periodStart: 0, periodEnd: 1000, quantity: 1, metricKey: "water_pumped_mg" }],
      usageKwhInWindow: () => 5000,
    })!;
    expect(kpi.standing).toBe("above_range");
    expect(kpi.message).toContain("OR site conditions");
  });

  it("manufacturing pack refuses to fake a benchmark (no honest cross-industry range)", () => {
    const pack = VERTICAL_PACKS.find((p) => p.packKey === "manufacturing")!;
    expect(pack.typicalRange).toBeNull();
    const kpi = productionKpi({
      pack,
      periods: [{ periodStart: 0, periodEnd: 1000, quantity: 100, metricKey: "units_produced" }],
      usageKwhInWindow: () => 5000,
    })!;
    expect(kpi.standing).toBe("no_range");
    expect(kpi.message).toContain("No honest cross-industry benchmark");
  });

  it("regressor disclosure warns anomalies can't be separated from production swings", () => {
    const pack = VERTICAL_PACKS.find((p) => p.packKey === "water_wastewater")!;
    expect(regressorDisclosure(pack, true)).toContain("may simply be a production change");
    expect(regressorDisclosure(pack, false)).toContain("log production periods");
  });
});
