/**
 * NEXT-1 (Jul 21) — "calibrate to my bill".
 *
 * Derives a BILL-VERIFIED blended rate for a site directly from the real
 * bills on file: sum(totalCost) / sum(usage) over the most recent 12 months
 * of usable bill periods. This becomes a provenance tier ABOVE every imputed
 * rate (state-average, national assumption) but BELOW an exact tariff-priced
 * cost basis — a tariff engine priced on the customer's actual structure and
 * reconciled against bills (billReconciliation.ts) is still the gold standard
 * for per-period math; the bill-verified blend is the honest next-best when
 * no tariff could be identified.
 *
 * Usability rules (each one is an accuracy guard, not a convenience):
 * - actual reads only — utilities true up estimated reads later; calibrating
 *   on them bakes their error into every downstream dollar (§2.6 convention).
 * - superseded bills excluded — when a corrected bill (billRevision > 0)
 *   covers the same period, only the latest revision counts.
 * - both usage and totalCost must be positive — a $0 or 0-kWh row is a data
 *   artifact, not a price observation.
 * - at least ONE qualifying bill; the basis string always discloses how many
 *   bills and which span, so a single-bill calibration reads as exactly that.
 */
import * as h from "./dbHelpers";

export interface MonthlyRatePoint {
  /** calendar month 1–12 */
  month: number;
  /** blended $/unit for bills whose midpoint falls in this month */
  rate: number;
  /** number of qualifying bills contributing */
  billCount: number;
}

export interface BillVerifiedRate {
  /** blended $/unit — canonical usage units: electric kWh, gas therms, water GALLONS */
  rate: number;
  /** number of qualifying bills */
  billCount: number;
  /** ISO date span covered */
  spanStart: string;
  spanEnd: string;
  /** human basis string, ladder-convention wording */
  basis: string;
  commodity: "electric" | "gas" | "water";
  /** SEAS-1 (Jul 21): monthly blended-rate curve, present only when 3+ bills
   * span 3+ distinct calendar months AND the seasonal spread is material
   * (max/min > 5%). Months without a bill are omitted — never interpolated. */
  monthlyCurve?: MonthlyRatePoint[];
  /** max/min spread of the curve as a fraction (e.g. 0.18 = 18%) */
  seasonalSpreadPct?: number;
}

function isoDay(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

/**
 * Derive the bill-verified blended rate for one commodity of a site.
 * Returns null when no qualifying bills exist — callers fall through to the
 * next ladder tier exactly as before, so this is strictly additive.
 */
export async function deriveBillVerifiedRate(
  siteId: number,
  userId: number,
  commodity: "electric" | "gas" | "water" = "electric",
): Promise<BillVerifiedRate | null> {
  const [allBills, siteMeters] = await Promise.all([h.listBills(siteId, userId), h.listMeters(siteId, userId)]);
  const meterIds = new Set(siteMeters.filter((m) => m.commodity === commodity).map((m) => m.id));
  if (meterIds.size === 0) return null;

  // Latest revision per (meterId, periodStart, periodEnd): corrected bills
  // supersede originals.
  const byPeriod = new Map<string, (typeof allBills)[number]>();
  for (const b of allBills) {
    if (!meterIds.has(b.meterId)) continue;
    if ((b.readType ?? "actual") === "estimated") continue;
    const usage = Number(b.usage ?? 0);
    const cost = Number(b.totalCost ?? 0);
    if (!(usage > 0) || !(cost > 0)) continue;
    const key = `${b.meterId}|${isoDay(b.periodStart)}|${isoDay(b.periodEnd)}`;
    const prev = byPeriod.get(key);
    if (!prev || (b.billRevision ?? 0) > (prev.billRevision ?? 0)) byPeriod.set(key, b);
  }
  const usable = Array.from(byPeriod.values()).sort(
    (a, b) => new Date(b.periodStart as unknown as string).getTime() - new Date(a.periodStart as unknown as string).getTime(),
  );
  if (usable.length === 0) return null;

  // Most recent 12 months of periods (up to 13 bills covers a year with
  // offset cycles; cap at 13 to avoid stale-rate drag from older vintages).
  const window = usable.slice(0, 13);
  const totalCost = window.reduce((s, b) => s + Number(b.totalCost ?? 0), 0);
  const totalUsage = window.reduce((s, b) => s + Number(b.usage ?? 0), 0);
  if (!(totalUsage > 0) || !(totalCost > 0)) return null;
  const rate = totalCost / totalUsage;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const spanStart = isoDay(window[window.length - 1].periodStart as unknown as string);
  const spanEnd = isoDay(window[0].periodEnd as unknown as string);
  // Canonical usage units (meters schema + COMMODITY_UNITS): water bills store
  // gallons, so cost ÷ usage yields $/gal — matching the cross-commodity
  // module's water pricing unit. Water rates (~$0.005/gal) need more decimals
  // than electric/gas to be legible.
  const unit = commodity === "electric" ? "kWh" : commodity === "gas" ? "therm" : "gal";
  const rateStr = commodity === "water" ? rate.toFixed(4) : rate.toFixed(3);
  const fmtMonth = (iso: string) => {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  };
  const span = fmtMonth(spanStart) === fmtMonth(spanEnd) ? fmtMonth(spanEnd) : `${fmtMonth(spanStart)}–${fmtMonth(spanEnd)}`;

  // SEAS-1 — seasonal curve: with 3+ bills across 3+ distinct calendar months,
  // the per-month blend exposes tiered/TOU seasonality a single annual figure
  // flattens (e.g. AZ summer tiers). Each bill lands in the month of its
  // period MIDPOINT (a Jun-15→Jul-14 bill is mostly both; the midpoint is the
  // least-wrong single assignment and is deterministic). Months with no bill
  // are omitted rather than interpolated, and the curve is only attached when
  // the spread is material (>5%) — a flat curve would be noise dressed as signal.
  let monthlyCurve: MonthlyRatePoint[] | undefined;
  let seasonalSpreadPct: number | undefined;
  if (window.length >= 3) {
    const byMonth = new Map<number, { cost: number; usage: number; count: number }>();
    for (const b of window) {
      const start = new Date(b.periodStart as unknown as string).getTime();
      const end = new Date(b.periodEnd as unknown as string).getTime();
      const mid = new Date((start + end) / 2);
      const m = mid.getUTCMonth() + 1;
      const cur = byMonth.get(m) ?? { cost: 0, usage: 0, count: 0 };
      cur.cost += Number(b.totalCost ?? 0);
      cur.usage += Number(b.usage ?? 0);
      cur.count += 1;
      byMonth.set(m, cur);
    }
    if (byMonth.size >= 3) {
      const pts: MonthlyRatePoint[] = Array.from(byMonth.entries())
        .filter(([, v]) => v.usage > 0 && v.cost > 0)
        .map(([month, v]) => ({ month, rate: v.cost / v.usage, billCount: v.count }))
        .sort((a, b) => a.month - b.month);
      if (pts.length >= 3) {
        const rates = pts.map((p) => p.rate);
        const spread = Math.max(...rates) / Math.min(...rates) - 1;
        if (spread > 0.05) {
          monthlyCurve = pts;
          seasonalSpreadPct = Math.round(spread * 1000) / 1000;
        }
      }
    }
  }

  const seasonalNote =
    monthlyCurve && seasonalSpreadPct != null
      ? `; seasonal: your rate varies ${(seasonalSpreadPct * 100).toFixed(0)}% across ${monthlyCurve.length} billed months`
      : "";
  return {
    rate,
    billCount: window.length,
    spanStart,
    spanEnd,
    commodity,
    basis: `your actual bills — bill-verified blended rate ($${rateStr}/${unit}, ${window.length} bill${window.length === 1 ? "" : "s"}, ${span}${seasonalNote})`,
    monthlyCurve,
    seasonalSpreadPct,
  };
}
