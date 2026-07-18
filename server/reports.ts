/**
 * §3l Reports — three artifacts, one engine.
 *
 * One assembler (`assembleReportData`) gathers everything a report needs from
 * the site's persisted analysis rows; three shapers turn it into:
 *   - energy_plan        (Plus): Bill Builder basket as a decision document
 *   - verified_savings   (Pro):  cumulative verified headline + verdict table
 *   - practitioner       (Pro):  CalTRACK terms, CVRMSE/uncertainty, CSV refs
 *
 * Shared honesty rules (spec §3l):
 *   - every exported number carries a confidence chip suffix (Est./Good/Measured)
 *   - footer = modeled-estimates disclaimer + live verification link token
 *     (report_artifacts) so forwarded PDFs are never silently stale
 *   - numbers never fabricated: missing inputs render as explicit gaps
 */
import * as h from "./dbHelpers";
import { MODELED_ESTIMATES_DISCLAIMER } from "../shared/wattwise";

/** Confidence chip per §3l print rule. */
export type Chip = "Est." | "Good" | "Measured";

export function chipForConfidence(confidence: string | null | undefined, measured = false): Chip {
  if (measured) return "Measured";
  if (confidence === "high") return "Good";
  return "Est.";
}

export interface ReportMeasure {
  title: string;
  measure: string;
  what: string;
  annualSavingsUsd: number | null;
  paybackLabel: string | null;
  costClass: string | null;
  confidence: string | null;
  chip: Chip;
}

export interface VerdictRow {
  measure: string;
  implementedAt: number;
  status: string;
  verifiedSavingsUsd: number;
  months: number;
  chip: Chip;
}

export interface ReportData {
  site: { id: number; name: string; state: string | null; buildingType: string | null; sqft: number | null };
  generatedAt: number;
  /** headline current annual cost (modeled) + chip */
  annualCostUsd: number | null;
  annualCostChip: Chip;
  /** planned (open) measures — the "basket" */
  measures: ReportMeasure[];
  plannedTotalUsd: number;
  /** prove-it ledger */
  verdicts: VerdictRow[];
  verifiedTotalUsd: number;
  /** practitioner block */
  baseline: {
    method: string | null;
    cvrmse: number | null;
    r2: number | null;
    confidence: string | null;
    monthsUsed: number | null;
  } | null;
  disclaimer: string;
}

/** Assemble everything a report needs from persisted rows — no recomputation. */
export async function assembleReportData(siteId: number, userId: number): Promise<ReportData> {
  const site = await h.getSite(siteId, userId);
  const [opps, impls, insights] = await Promise.all([
    h.listOpportunities(siteId, userId),
    h.listMeasureImplementations(siteId, userId),
    h.listInsights(siteId, userId),
  ]);

  // Current cost from the machine-readable summary insight (persisted).
  const summary = insights.find((i) => i.kind === "summary");
  const metrics = (summary?.metrics ?? {}) as {
    currentCost?: { total?: number };
    demand?: unknown;
  };
  const annualCostUsd = metrics.currentCost?.total ?? null;

  // Basket = open opportunities (not yet implemented).
  const implemented = new Set(impls.map((i) => i.measure));
  const measures: ReportMeasure[] = opps
    .filter((o) => !implemented.has(o.measure))
    .map((o) => ({
      title: o.title,
      measure: o.measure,
      what: o.description ?? "",
      annualSavingsUsd: o.estCostSavingsPerYr ?? null,
      paybackLabel: o.paybackBandYears ?? null,
      costClass: o.estDemandSavingsKw != null && o.estDemandSavingsKw > 0 ? "demand-reducing" : null,
      confidence: o.confidence ?? null,
      chip: chipForConfidence(o.confidence),
    }));
  const plannedTotalUsd = measures.reduce((a, m) => a + (m.annualSavingsUsd ?? 0), 0);

  // Prove-it verdict ledger.
  const verdicts: VerdictRow[] = impls.map((i) => {
    const v = (i.verdicts ?? []) as unknown[];
    return {
      measure: i.measure,
      implementedAt: i.implementedAt,
      status: i.status,
      verifiedSavingsUsd: i.verifiedSavingsUsd ?? 0,
      months: Array.isArray(v) ? v.length : 0,
      chip: i.status === "verified" ? "Measured" : "Est.",
    };
  });
  const verifiedTotalUsd = verdicts.reduce((a, v) => a + v.verifiedSavingsUsd, 0);

  // Practitioner block from the latest baseline row.
  const baselineRow = await h.getLatestBaseline(siteId, userId);
  const params = (baselineRow?.params ?? null) as {
    method?: string;
    cvrmse?: number;
    r2?: number;
    confidence?: string;
    monthsUsed?: number;
  } | null;

  return {
    site: { id: site.id, name: site.name, state: site.state, buildingType: site.buildingType, sqft: site.sqft },
    generatedAt: Date.now(),
    annualCostUsd,
    annualCostChip: chipForConfidence(summary?.confidence, false),
    measures,
    plannedTotalUsd,
    verdicts,
    verifiedTotalUsd,
    baseline: params
      ? {
          method: params.method ?? null,
          cvrmse: params.cvrmse ?? null,
          r2: params.r2 ?? null,
          confidence: params.confidence ?? null,
          monthsUsed: params.monthsUsed ?? null,
        }
      : null,
    disclaimer: MODELED_ESTIMATES_DISCLAIMER,
  };
}

/** Practitioner CSV — measures + verdicts with chips, Portfolio-Manager-ish columns. */
export function practitionerCsv(d: ReportData): string {
  const esc = (s: string | number | null) => {
    const v = s == null ? "" : String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines: string[] = [];
  lines.push("section,name,annual_usd,confidence_chip,detail");
  lines.push(["site", esc(d.site.name), esc(d.annualCostUsd), d.annualCostChip, esc(`${d.site.buildingType ?? ""} ${d.site.sqft ?? ""} sqft ${d.site.state ?? ""}`)].join(","));
  for (const m of d.measures) lines.push(["planned_measure", esc(m.title), esc(m.annualSavingsUsd), m.chip, esc(`${m.costClass ?? ""}; payback ${m.paybackLabel ?? "n/a"}`)].join(","));
  for (const v of d.verdicts) lines.push(["implementation", esc(v.measure), esc(v.verifiedSavingsUsd), v.chip, esc(`status ${v.status}; ${v.months} month(s) evaluated`)].join(","));
  if (d.baseline)
    lines.push(
      ["baseline", esc(d.baseline.method), "", d.baseline.confidence === "high" ? "Good" : "Est.", esc(`CVRMSE ${d.baseline.cvrmse != null ? (d.baseline.cvrmse * 100).toFixed(1) + "%" : "n/a"}; R2 ${d.baseline.r2 ?? "n/a"}; months ${d.baseline.monthsUsed ?? "n/a"}`)].join(","),
    );
  lines.push(["disclaimer", esc(d.disclaimer), "", "", ""].join(","));
  return lines.join("\n");
}

/** Random URL-safe token for report_artifacts. */
export function newReportToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let t = "";
  for (let i = 0; i < 32; i++) t += alphabet[Math.floor(Math.random() * alphabet.length)];
  return t;
}
