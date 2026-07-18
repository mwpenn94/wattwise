/**
 * §3 Hero 5 — "Energy Wrapped": a shareable year-in-review card.
 *
 * Honesty rules (same as everything else):
 *  - Assembled ONLY from persisted analysis rows — no recomputation, no
 *    fabrication. Every stat carries its basis.
 *  - If a stat's underlying data is missing, the stat is omitted (named in
 *    `omitted`), never zero-filled.
 *  - Verified savings only appear when prove-it verdicts exist; otherwise the
 *    card says "projected" with the Est. chip.
 */
import * as h from "./dbHelpers";

export interface WrappedStat {
  key: string;
  label: string;
  value: string;
  sub: string;
  chip: "Est." | "Good" | "Measured";
}

export interface WrappedCard {
  siteName: string;
  year: number;
  generatedAt: number;
  stats: WrappedStat[];
  /** Stats that could not be produced, with the reason — named, not hidden. */
  omitted: Array<{ label: string; reason: string }>;
  disclaimer: string;
}

const chipFor = (confidence: string | null | undefined): "Est." | "Good" | "Measured" =>
  confidence === "high" ? "Measured" : confidence === "medium" ? "Good" : "Est.";

export async function assembleWrapped(siteId: number, userId: number): Promise<WrappedCard | null> {
  const site = await h.getSite(siteId, userId);
  if (!site) return null;

  const insights = await h.listInsights(siteId, userId);
  const summary = insights.find((i) => i.kind === "summary");
  const metrics = (summary?.metrics ?? {}) as Record<string, unknown>;
  const currentCost = metrics.currentCost as
    | { breakdown?: { total?: number; energy?: number; demand?: number }; annualUsageKwh?: number }
    | undefined;
  const demand = metrics.demand as
    | { peakKw?: number; peakTimestamp?: number; loadFactor?: number; monthlyPeaks?: Array<{ month: string; peakKw: number }> }
    | undefined;
  const emissions = metrics.emissions as { annualCo2eLb?: number; factorSource?: string } | undefined;
  const benchmark = metrics.benchmark as { percentileLabel?: string; euiKwhPerSqft?: number } | undefined;

  const impls = await h.listMeasureImplementations(siteId, userId);
  const verifiedTotal = impls.reduce((a, m) => a + (m.verifiedSavingsUsd ?? 0), 0);

  const opps = await h.listOpportunities(siteId, userId);
  // opportunities table has no status column — every persisted row is an open
  // (not-yet-verified) opportunity from the latest analysis run.
  const openTotal = opps.reduce((a, o) => a + (o.estCostSavingsPerYr ?? 0), 0);

  const stats: WrappedStat[] = [];
  const omitted: Array<{ label: string; reason: string }> = [];
  const conf = summary?.confidence ?? "low";
  const year = new Date().getFullYear();

  if (currentCost?.breakdown?.total != null) {
    stats.push({
      key: "annual_cost",
      label: "Your year in utility spend",
      value: `$${Math.round(currentCost.breakdown.total).toLocaleString()}`,
      sub: "modeled on your latest analysis basis",
      chip: chipFor(conf),
    });
  } else {
    omitted.push({ label: "Annual spend", reason: "no completed analysis with a priced basis" });
  }

  if (demand?.peakKw != null && demand.peakTimestamp != null) {
    const d = new Date(demand.peakTimestamp);
    stats.push({
      key: "peak_moment",
      label: "Your single biggest moment",
      value: `${demand.peakKw.toFixed(1)} kW`,
      sub: `${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })} around ${d.toLocaleTimeString("en-US", { hour: "numeric" })} — your meter's peak of the year`,
      chip: "Measured",
    });
  } else {
    omitted.push({ label: "Peak moment", reason: "needs interval data" });
  }

  if (demand?.loadFactor != null) {
    stats.push({
      key: "load_factor",
      label: "How steadily you use power",
      value: `${(demand.loadFactor * 100).toFixed(0)}%`,
      sub: demand.loadFactor > 0.5 ? "steady operator — flat load, fewer demand surprises" : "spiky profile — your peaks cost more than your average",
      chip: "Measured",
    });
  }

  if (benchmark?.euiKwhPerSqft != null) {
    stats.push({
      key: "benchmark",
      label: "vs buildings like yours",
      value: `${benchmark.euiKwhPerSqft.toFixed(1)} kWh/sqft`,
      sub: benchmark.percentileLabel ?? "compared against CBECS/RECS peer archetypes",
      chip: chipFor(conf),
    });
  }

  if (emissions?.annualCo2eLb != null) {
    stats.push({
      key: "emissions",
      label: "Your footprint",
      value: `${Math.round(emissions.annualCo2eLb).toLocaleString()} lb CO₂e`,
      sub: emissions.factorSource ?? "eGRID annual average factors",
      chip: "Est.",
    });
  }

  if (verifiedTotal > 0) {
    stats.push({
      key: "verified",
      label: "Savings you proved",
      value: `$${Math.round(verifiedTotal).toLocaleString()}`,
      sub: "measured against your weather-adjusted baseline — not a projection",
      chip: "Measured",
    });
  } else if (openTotal > 0) {
    stats.push({
      key: "open_opportunity",
      label: "Money still on the table",
      value: `$${Math.round(openTotal).toLocaleString()}/yr`,
      sub: "modeled open opportunities — mark measures done to start verifying",
      chip: "Est.",
    });
  }

  if (stats.length === 0) return null;

  return {
    siteName: site.name,
    year,
    generatedAt: Date.now(),
    stats,
    omitted,
    disclaimer:
      "Every figure above is labeled with its basis. Modeled estimates are not a guarantee; verified figures are measured against a weather-adjusted baseline.",
  };
}
