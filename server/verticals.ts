/**
 * AC14 — vertical packs: production-normalized analytics for non-office
 * building types (water/wastewater plants, agriculture, industrial).
 *
 * The core mechanic the handoff asks for: when a site's vertical has a
 * production driver (million gallons pumped, units produced, irrigated acres),
 * the KPI switches from EUI (kWh/sqft) to a production intensity
 * (kWh per unit produced) and the baseline conversation names production as
 * the regressor the weather model can't see.
 *
 * Honesty contract:
 *  - the production KPI only renders when the user has actually logged
 *    production periods overlapping the usage window — never an assumed
 *    production figure;
 *  - benchmark comparisons for production KPIs are seeded typical RANGES with
 *    a named source basis, disclosed as ranges, not percentiles.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { productionSeries } from "../drizzle/schema";

/* ------------------------------------------------------------------ */
/* Vertical pack registry                                              */
/* ------------------------------------------------------------------ */

export interface VerticalPack {
  packKey: string;
  label: string;
  /** buildingType values this pack applies to */
  buildingTypes: string[];
  metricKey: string;
  metricLabel: string;
  unit: string;
  /** e.g. "kWh per million gallons" */
  kpiLabel: string;
  /** typical range for the KPI, with a stated basis (NOT a percentile claim) */
  typicalRange: { lo: number; hi: number; basis: string } | null;
}

export const VERTICAL_PACKS: VerticalPack[] = [
  {
    packKey: "water_wastewater",
    label: "Water / wastewater",
    buildingTypes: ["municipal"],
    metricKey: "water_pumped_mg",
    metricLabel: "Water pumped / treated",
    unit: "million gallons",
    kpiLabel: "kWh per million gallons",
    typicalRange: {
      lo: 1000,
      hi: 3500,
      basis: "EPA/AWWA published ranges for treatment + distribution energy intensity (varies with lift, process, and plant size)",
    },
  },
  {
    packKey: "agriculture",
    label: "Agriculture / irrigation",
    buildingTypes: [], // no matching building type in the enum — manual production logging still activates this pack
    metricKey: "irrigated_acres",
    metricLabel: "Irrigated area served",
    unit: "acres",
    kpiLabel: "kWh per irrigated acre",
    typicalRange: {
      lo: 150,
      hi: 900,
      basis: "USDA/extension-service ranges for pumped irrigation (varies enormously with water depth and method)",
    },
  },
  {
    packKey: "manufacturing",
    label: "Manufacturing / production",
    buildingTypes: ["manufacturing", "warehouse"],
    metricKey: "units_produced",
    metricLabel: "Units produced",
    unit: "units",
    kpiLabel: "kWh per unit produced",
    typicalRange: null, // no honest cross-industry range exists
  },
];

/** The pack (if any) applicable to a building type. */
export function packForBuildingType(buildingType: string | null): VerticalPack | null {
  if (!buildingType) return null;
  return VERTICAL_PACKS.find((p) => p.buildingTypes.includes(buildingType)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Production series persistence                                       */
/* ------------------------------------------------------------------ */

export async function addProductionPeriod(data: {
  siteId: number;
  userId: number;
  metricKey: string;
  metricLabel: string;
  unit: string;
  periodStart: number;
  periodEnd: number;
  quantity: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const res = await db.insert(productionSeries).values({ ...data, createdAt: Date.now() });
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function listProduction(siteId: number, userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(productionSeries)
    .where(and(eq(productionSeries.siteId, siteId), eq(productionSeries.userId, userId)));
}

export async function deleteProductionPeriod(id: number, userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(productionSeries).where(and(eq(productionSeries.id, id), eq(productionSeries.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* Production-normalized KPI                                           */
/* ------------------------------------------------------------------ */

export interface ProductionKpi {
  packKey: string;
  kpiLabel: string;
  intensity: number; // kWh per unit
  totalUsageKwh: number;
  totalQuantity: number;
  unit: string;
  coverageNote: string;
  typicalRange: { lo: number; hi: number; basis: string } | null;
  standing: "below_range" | "in_range" | "above_range" | "no_range";
  message: string;
}

/**
 * Compute the production-normalized KPI over the overlap between logged
 * production periods and the usage window. Pure — caller supplies usage
 * over the same window.
 */
export function productionKpi(opts: {
  pack: VerticalPack;
  periods: Array<{ periodStart: number; periodEnd: number; quantity: number; metricKey: string }>;
  usageKwhInWindow: (fromTs: number, toTs: number) => number;
}): ProductionKpi | null {
  const rows = opts.periods.filter((p) => p.metricKey === opts.pack.metricKey && p.quantity > 0);
  if (rows.length === 0) return null;
  let totalQuantity = 0;
  let totalUsage = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const r of rows) {
    totalQuantity += r.quantity;
    totalUsage += opts.usageKwhInWindow(r.periodStart, r.periodEnd);
    earliest = Math.min(earliest, r.periodStart);
    latest = Math.max(latest, r.periodEnd);
  }
  if (totalQuantity <= 0 || totalUsage <= 0) return null;
  const intensity = totalUsage / totalQuantity;
  const range = opts.pack.typicalRange;
  const standing: ProductionKpi["standing"] =
    range == null ? "no_range" : intensity < range.lo ? "below_range" : intensity > range.hi ? "above_range" : "in_range";
  const spanDays = Math.round((latest - earliest) / 86_400_000);
  const message =
    standing === "no_range"
      ? `Your production intensity is ${Math.round(intensity).toLocaleString()} ${opts.pack.kpiLabel}. No honest cross-industry benchmark exists for this metric — track it over time; the trend is yours.`
      : standing === "above_range"
        ? `Your production intensity is ${Math.round(intensity).toLocaleString()} ${opts.pack.kpiLabel} — above the typical published range (${range!.lo.toLocaleString()}–${range!.hi.toLocaleString()}). That can mean real inefficiency OR site conditions the range can't see (${range!.basis}).`
        : standing === "below_range"
          ? `Your production intensity is ${Math.round(intensity).toLocaleString()} ${opts.pack.kpiLabel} — below the typical published range (${range!.lo.toLocaleString()}–${range!.hi.toLocaleString()}). Efficient, or a metering/logging mismatch worth double-checking.`
          : `Your production intensity is ${Math.round(intensity).toLocaleString()} ${opts.pack.kpiLabel} — inside the typical published range (${range!.lo.toLocaleString()}–${range!.hi.toLocaleString()}).`;
  return {
    packKey: opts.pack.packKey,
    kpiLabel: opts.pack.kpiLabel,
    intensity,
    totalUsageKwh: totalUsage,
    totalQuantity,
    unit: opts.pack.unit,
    coverageNote: `Computed over ${rows.length} logged production period${rows.length === 1 ? "" : "s"} spanning ~${spanDays} days. Usage outside logged periods is excluded — log more periods to widen coverage.`,
    typicalRange: range,
    standing,
    message,
  };
}

/**
 * AC14 regressor honesty note: when production data exists, the weather-only
 * baseline must SAY production is an unmodeled regressor (production swings
 * masquerade as anomalies otherwise).
 */
export function regressorDisclosure(pack: VerticalPack, hasProductionData: boolean): string {
  return hasProductionData
    ? `This building's usage is driven by ${pack.metricLabel.toLowerCase()}, not just weather. The weather-normalized baseline treats production swings as unexplained variation — a "usage anomaly" here may simply be a production change. Cross-check flagged months against your production log before acting.`
    : `This building type is usually production-driven (${pack.metricLabel.toLowerCase()}). Without a production log, weather-normalized anomalies can't be separated from production swings — log production periods to make anomaly detection meaningful.`;
}
