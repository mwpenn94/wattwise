/**
 * §3k Ask WattWise — routing + dispatch honesty tests.
 *
 * The NL box is an ENTRANCE to engines: the router only classifies; every
 * displayed number must come from stored rows. Unknown intents get an honest
 * can't-route card, and missing analysis rows get run-first cards — never a
 * generated answer.
 */
import { describe, expect, it } from "vitest";
import { keywordRoute, buildAskCard, routeQuestion } from "./askWattwise";

const CTX = {
  siteId: 42,
  siteName: "Test Office",
  insights: [
    {
      kind: "peak_attribution",
      title: "Your 180 kW peak was mostly schedule",
      body: "Schedule 120 kW, weather 40 kW, coincidence 20 kW.",
      confidence: "medium",
      metrics: { counterfactualSavingsUsd: 900 },
    },
  ],
  summaryMetrics: {
    tariffComparisons: [
      { tariffName: "E-32 TOU", eligible: true, savingsVsCurrent: 412 },
      { tariffName: "E-99 Ineligible", eligible: false, savingsVsCurrent: 999 },
    ],
    benchmark: { percentileBand: "Top quartile (better than 75%)", siteEui: 52 },
    emissions: { annualCo2eLb: 12000, subregion: "AZNM", mapped: true },
  },
  opportunities: [
    {
      id: 1,
      rank: 1,
      measure: "battery_peak_shave",
      title: "Battery peak shaving",
      description: "Shave 30 kW off your billed peak.",
      estCostSavingsPerYr: 2400,
      confidence: "medium",
      paybackBandYears: "4-7 yr",
    },
  ],
  verifiedTotalUsd: 156,
};

describe("keywordRoute — deterministic fallback", () => {
  it("routes engine vocabulary to the right intents", () => {
    expect(keywordRoute("What if I add a battery?")).toBe("scenario_battery");
    expect(keywordRoute("should I get solar panels")).toBe("scenario_solar");
    expect(keywordRoute("is there a cheaper rate plan")).toBe("rate_switch");
    expect(keywordRoute("Why was July so high?")).toBe("attribution");
    expect(keywordRoute("how much have I actually saved")).toBe("verified_savings");
    expect(keywordRoute("how do I compare to similar buildings")).toBe("benchmark");
    expect(keywordRoute("what is my carbon footprint")).toBe("emissions");
    expect(keywordRoute("what should I do first")).toBe("top_opportunity");
  });

  it("returns unknown for unroutable questions instead of guessing", () => {
    expect(keywordRoute("what's the weather in Paris")).toBe("unknown");
  });
});

describe("routeQuestion — LLM disabled path", () => {
  it("uses keyword fallback with disclosure when allowLlm=false", async () => {
    const r = await routeQuestion("why was my bill high", false);
    expect(r.routedBy).toBe("keyword_fallback");
    expect(r.intent).toBe("attribution");
  });
});

describe("buildAskCard — numbers only from stored rows", () => {
  it("attribution card carries the stored counterfactual dollars and deep link", async () => {
    const c = await buildAskCard("attribution", CTX);
    expect(c.dollars).toBe(900);
    expect(c.action?.href).toContain("/app/explore?site=42");
    expect(c.provenance.join(" ")).toMatch(/stored peak-attribution/i);
  });

  it("rate_switch picks the best ELIGIBLE row, never the ineligible one", async () => {
    const c = await buildAskCard("rate_switch", CTX);
    expect(c.dollars).toBe(412); // not 999 — ineligible rows must not headline
    expect(c.why).toContain("E-32 TOU");
  });

  it("verified_savings uses the prove-it total with measured confidence", async () => {
    const c = await buildAskCard("verified_savings", CTX);
    expect(c.dollars).toBe(156);
    expect(c.framing).toBe("Verified");
    expect(c.confidence).toBe("measured");
  });

  it("scenario_battery deep-links with the measure preselected", async () => {
    const c = await buildAskCard("scenario_battery", CTX);
    expect(c.action?.href).toBe("/app/scenarios?site=42&measure=battery_peak_shave");
    expect(c.dollars).toBe(2400); // from the stored opportunity row
  });

  it("returns run-first cards when the stored rows are missing — never invents", async () => {
    const empty = { ...CTX, insights: [], summaryMetrics: null, opportunities: [], verifiedTotalUsd: 0 };
    for (const intent of ["attribution", "rate_switch", "top_opportunity", "benchmark", "emissions"] as const) {
      const c = await buildAskCard(intent, empty);
      expect(c.dollars).toBeNull();
      expect((c.headlineFallback ?? "") + c.why).toMatch(/run|analysis/i);
    }
  });

  it("unknown intent answers honestly with example questions, no action fabricated", async () => {
    const c = await buildAskCard("unknown", CTX);
    expect(c.dollars).toBeNull();
    expect(c.why).toMatch(/Why was my peak high/i);
    expect(c.provenance.join(" ")).toMatch(/never answers with generated text/i);
  });
});
