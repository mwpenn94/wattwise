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
  /** RECON (Jul 19) — implementer-grade unit savings: rebate math runs on
   * units (kWh, therms, gallons), not dollars; kW is demand, kept separate. */
  unitSavings: { value: number; unit: string } | null;
  demandSavingsKw: number | null;
  /** Live incentive matches for this measure (never-expired, named sources). */
  rebates: Array<{ name: string; valueUsd: number; source: string }>;
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
  // RECON (Jul 19): reports carry the same unit savings + rebate matches the
  // Scenarios page has — rebates were previously confined to Scenarios.
  const sectorClass = site.buildingType === "single_family" || site.buildingType === "multifamily" ? ("residential" as const) : ("commercial" as const);
  const measures: ReportMeasure[] = await Promise.all(
    opps
      .filter((o) => !implemented.has(o.measure))
      .map(async (o) => {
        const prov = (o.provenance ?? null) as Record<string, unknown> | null;
        const commodity = ((prov?.commodity as string | undefined) ?? "electric") as "electric" | "gas" | "water";
        let rebates: Array<{ name: string; valueUsd: number; source: string }> = [];
        try {
          const { matchIncentives } = await import("./incentives");
          const matches = await matchIncentives({
            measureKey: o.measure,
            state: site.state,
            utilityName: site.utilityName ?? null,
            sectorClass,
            capexUsd: 0,
            unitsSavedAnnual: o.estEnergySavingsPerYr != null ? { [commodity]: o.estEnergySavingsPerYr } : undefined,
          });
          rebates = matches
            .filter((m) => m.valueUsd > 0 || (m.annualUsd ?? 0) > 0 || m.ratePerUnitSaved != null)
            .map((m) => ({
              name: m.ratePerUnitSaved != null && m.valueUsd <= 0 ? `${m.name} ($${m.ratePerUnitSaved}/${m.rateUnit ?? "unit"} saved)` : m.name,
              valueUsd: m.valueUsd > 0 ? m.valueUsd : (m.annualUsd ?? 0),
              source: m.sourceName,
            }));
        } catch {
          /* incentive matching never blocks report assembly */
        }
        return {
          title: o.title,
          measure: o.measure,
          what: o.description ?? "",
          annualSavingsUsd: o.estCostSavingsPerYr ?? null,
          paybackLabel: o.paybackBandYears ?? null,
          costClass: o.estDemandSavingsKw != null && o.estDemandSavingsKw > 0 ? "demand-reducing" : null,
          confidence: o.confidence ?? null,
          chip: chipForConfidence(o.confidence),
          unitSavings: o.estEnergySavingsPerYr != null ? { value: o.estEnergySavingsPerYr, unit: o.energyUnit ?? "kWh" } : null,
          demandSavingsKw: o.estDemandSavingsKw ?? null,
          rebates,
        };
      }),
  );
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
  lines.push("section,name,annual_usd,confidence_chip,detail,unit_savings,demand_kw,rebates");
  lines.push(["site", esc(d.site.name), esc(d.annualCostUsd), d.annualCostChip, esc(`${d.site.buildingType ?? ""} ${d.site.sqft ?? ""} sqft ${d.site.state ?? ""}`), "", "", ""].join(","));
  for (const m of d.measures)
    lines.push(
      [
        "planned_measure",
        esc(m.title),
        esc(m.annualSavingsUsd),
        m.chip,
        esc(`${m.costClass ?? ""}; payback ${m.paybackLabel ?? "n/a"}`),
        esc(m.unitSavings ? `${Math.round(m.unitSavings.value).toLocaleString()} ${m.unitSavings.unit}/yr` : ""),
        esc(m.demandSavingsKw != null ? m.demandSavingsKw : ""),
        esc((m.rebates ?? []).map((r) => `${r.name} ($${Math.round(r.valueUsd).toLocaleString()})`).join("; ")),
      ].join(","),
    );
  for (const v of d.verdicts) lines.push(["implementation", esc(v.measure), esc(v.verifiedSavingsUsd), v.chip, esc(`status ${v.status}; ${v.months} month(s) evaluated`), "", "", ""].join(","));
  if (d.baseline)
    lines.push(
      ["baseline", esc(d.baseline.method), "", d.baseline.confidence === "high" ? "Good" : "Est.", esc(`CVRMSE ${d.baseline.cvrmse != null ? (d.baseline.cvrmse * 100).toFixed(1) + "%" : "n/a"}; R2 ${d.baseline.r2 ?? "n/a"}; months ${d.baseline.monthsUsed ?? "n/a"}`), "", "", ""].join(","),
    );
  lines.push(["disclaimer", esc(d.disclaimer), "", "", "", "", ""].join(","));
  return lines.join("\n");
}

/* ================= GAP-N portfolio exports ================= */

export interface PortfolioExportRow {
  siteId: number;
  siteName: string;
  buildingType: string | null;
  state: string | null;
  zip: string | null;
  sqft: number | null;
  annualUsageKwh: number | null;
  annualCostUsd: number | null;
  euiKwhPerSqft: number | null;
  euiBasis: string | null;
  verifiedSavingsUsd: number;
  analyzed: boolean;
}

/** ENERGY STAR Portfolio Manager building-type mapping. PM's picklist is
 * finite; anything we can't map cleanly exports as "Other" with the Meterly
 * type preserved in its own column — never silently mislabeled. */
const ESPM_TYPE: Record<string, string> = {
  office: "Office",
  retail: "Retail Store",
  warehouse: "Non-Refrigerated Warehouse",
  school: "K-12 School",
  grocery: "Supermarket/Grocery Store",
  restaurant: "Restaurant",
  hotel: "Hotel",
  hospital: "Hospital (General Medical & Surgical)",
  multifamily: "Multifamily Housing",
  single_family: "Single Family Home",
  manufacturing: "Manufacturing/Industrial Plant",
};

/** GAP-N — Portfolio Manager-compatible CSV: one property row per site using
 * PM's spreadsheet-upload vocabulary (Property Name, Primary Function, Gross
 * Floor Area, energy use in kWh). Honesty rules carry over: modeled figures
 * are chip-suffixed, unmapped types are "Other", missing figures stay blank
 * (PM rejects fabrications anyway), and the disclaimer rides the last row. */
export function portfolioManagerCsv(rows: PortfolioExportRow[]): string {
  const esc = (s: string | number | null) => {
    const v = s == null ? "" : String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines: string[] = [];
  lines.push(
    [
      "Property Name",
      "Primary Function",
      "Meterly Building Type",
      "State/Province",
      "Postal Code",
      "Gross Floor Area (ft2)",
      "Annual Electricity Use (kWh)",
      "Annual Energy Cost (USD)",
      "Site EUI (kWh/ft2)",
      "EUI Basis",
      "Verified Savings To Date (USD)",
      "Data Status",
    ].join(","),
  );
  for (const r of rows) {
    lines.push(
      [
        esc(r.siteName),
        esc(r.buildingType ? (ESPM_TYPE[r.buildingType] ?? "Other") : "Other"),
        esc(r.buildingType ?? ""),
        esc(r.state ?? ""),
        esc(r.zip ?? ""),
        esc(r.sqft),
        esc(r.annualUsageKwh != null ? Math.round(r.annualUsageKwh) : null),
        esc(r.annualCostUsd != null ? Math.round(r.annualCostUsd) : null),
        esc(r.euiKwhPerSqft != null ? r.euiKwhPerSqft.toFixed(2) : null),
        esc(r.euiBasis ?? (r.analyzed ? "modeled" : "")),
        esc(Math.round(r.verifiedSavingsUsd)),
        r.analyzed ? "analyzed (modeled figures)" : "not yet analyzed — fields left blank, not fabricated",
      ].join(","),
    );
  }
  lines.push(["# " + MODELED_ESTIMATES_DISCLAIMER.replace(/,/g, ";"), "", "", "", "", "", "", "", "", "", "", ""].join(","));
  return lines.join("\n");
}

export interface PortfolioVerifiedData {
  generatedAt: number;
  siteCount: number;
  analyzedCount: number;
  verifiedTotalUsd: number;
  perSite: Array<{
    siteId: number;
    siteName: string;
    verifiedSavingsUsd: number;
    verdicts: VerdictRow[];
  }>;
  disclaimer: string;
}

/** GAP-N — portfolio verified-savings edition: cumulative verified headline
 * across every site with the per-site verdict ledgers underneath. Only
 * persisted implementation verdicts count — planned/estimated savings never
 * enter the verified total. */
export async function assemblePortfolioVerified(userId: number): Promise<PortfolioVerifiedData> {
  const userSites = await h.listSites(userId);
  const perSite: PortfolioVerifiedData["perSite"] = [];
  let analyzedCount = 0;
  for (const s of userSites) {
    const impls = await h.listMeasureImplementations(s.id, userId);
    const analysis = await h.getLatestAnalysis(s.id, userId);
    if (analysis) analyzedCount += 1;
    if (impls.length === 0) continue;
    const verdicts: VerdictRow[] = impls.map((i) => {
      const v = (i.verdicts ?? []) as unknown[];
      return {
        measure: i.measure,
        implementedAt: i.implementedAt,
        status: i.status,
        verifiedSavingsUsd: i.verifiedSavingsUsd ?? 0,
        months: Array.isArray(v) ? v.length : 0,
        chip: i.status === "verified" ? ("Measured" as Chip) : ("Est." as Chip),
      };
    });
    perSite.push({
      siteId: s.id,
      siteName: s.name,
      verifiedSavingsUsd: verdicts.reduce((a, v) => a + v.verifiedSavingsUsd, 0),
      verdicts,
    });
  }
  return {
    generatedAt: Date.now(),
    siteCount: userSites.length,
    analyzedCount,
    verifiedTotalUsd: perSite.reduce((a, s) => a + s.verifiedSavingsUsd, 0),
    perSite: perSite.sort((a, b) => b.verifiedSavingsUsd - a.verifiedSavingsUsd),
    disclaimer: MODELED_ESTIMATES_DISCLAIMER,
  };
}

/** Random URL-safe token for report_artifacts. */
export function newReportToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let t = "";
  for (let i = 0; i < 32; i++) t += alphabet[Math.floor(Math.random() * alphabet.length)];
  return t;
}
