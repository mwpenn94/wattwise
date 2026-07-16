/**
 * Demand analytics + tariff cost engine (handoff §5 steps 4–6, Cycle 4/5 items).
 * - Load factor, peak demand, top-decile peak analysis
 * - Ratchet sub-module: billed demand = max(actual month peak, ratchetPct ×
 *   rolling lookback peak) per month, itemized so UI can show ratchet carry
 * - CP/4CP proxy: top-N customer peaks in peak season, labeled verbatim
 *   "estimated — not ISO system peaks"; omitted (null) when no interval data
 * - TOU energy engine over interval data; monthly-only data uses flat
 *   allocation with disclosure
 * - Export-rate asymmetry (Cycle 5): negative net intervals credited at
 *   tariff exportRate, never netted at retail unless net_metering_retail
 */
import type {
  CostBreakdown,
  IntervalPoint,
  MonthlyDemandDetail,
  TariffStructure,
} from "../../shared/wattwise";
import { LABEL_CP_ESTIMATED } from "../../shared/wattwise";

export interface DemandAnalytics {
  peakKw: number;
  peakTimestamp: number;
  avgKw: number;
  loadFactor: number; // avg/peak
  topDecilePeaks: Array<{ ts: number; kw: number }>;
  monthlyPeaks: Array<{ month: string; peakKw: number; peakTs: number }>;
  /** demand heatmap: [dayOfWeek][hour] avg kW */
  heatmap: number[][];
  cpProxy: {
    label: typeof LABEL_CP_ESTIMATED;
    topN: number;
    events: Array<{ ts: number; kw: number }>;
  } | null;
}

export function computeDemandAnalytics(points: IntervalPoint[], cpTopN = 4, cpSeasonMonths: number[] = [6, 7, 8, 9]): DemandAnalytics | null {
  const withDemand = points
    .map((p) => ({ ts: p.ts, kw: p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0) }))
    .filter((p) => Number.isFinite(p.kw));
  if (withDemand.length < 10) return null;

  let peakKw = -Infinity;
  let peakTimestamp = 0;
  let sum = 0;
  for (const p of withDemand) {
    if (p.kw > peakKw) {
      peakKw = p.kw;
      peakTimestamp = p.ts;
    }
    sum += p.kw;
  }
  const avgKw = sum / withDemand.length;

  const sorted = [...withDemand].sort((a, b) => b.kw - a.kw);
  const topDecilePeaks = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.001))).slice(0, 50).map((p) => ({ ts: p.ts, kw: p.kw }));

  const monthly = new Map<string, { peakKw: number; peakTs: number }>();
  const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatN: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const p of withDemand) {
    const d = new Date(p.ts);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const rec = monthly.get(mk);
    if (!rec || p.kw > rec.peakKw) monthly.set(mk, { peakKw: p.kw, peakTs: p.ts });
    heat[d.getDay()][d.getHours()] += p.kw;
    heatN[d.getDay()][d.getHours()]++;
  }
  for (let dow = 0; dow < 7; dow++) for (let h = 0; h < 24; h++) heat[dow][h] = heatN[dow][h] > 0 ? heat[dow][h] / heatN[dow][h] : 0;

  // CP proxy: top-N distinct-day peaks within peak season
  const seasonal = withDemand.filter((p) => cpSeasonMonths.includes(new Date(p.ts).getMonth() + 1));
  const byDay = new Map<string, { ts: number; kw: number }>();
  for (const p of seasonal) {
    const d = new Date(p.ts);
    const dk = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const rec = byDay.get(dk);
    if (!rec || p.kw > rec.kw) byDay.set(dk, { ts: p.ts, kw: p.kw });
  }
  const cpEvents = Array.from(byDay.values()).sort((a, b) => b.kw - a.kw).slice(0, cpTopN);

  return {
    peakKw,
    peakTimestamp,
    avgKw,
    loadFactor: peakKw > 0 ? avgKw / peakKw : 0,
    topDecilePeaks,
    monthlyPeaks: Array.from(monthly.entries())
      .map(([month, r]) => ({ month, peakKw: r.peakKw, peakTs: r.peakTs }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    heatmap: heat,
    cpProxy: cpEvents.length > 0 ? { label: LABEL_CP_ESTIMATED, topN: cpTopN, events: cpEvents } : null,
  };
}

/* ---------------- ratchet sub-module (Cycle 4 finding 5) ---------------- */
export function applyRatchet(
  monthlyPeaks: Array<{ month: string; peakKw: number; peakTs: number }>,
  ratchet: { lookbackMonths: number; ratchetPct: number; applicablePeriod: "all" | "summer" } | undefined,
): MonthlyDemandDetail[] {
  const out: MonthlyDemandDetail[] = [];
  for (let i = 0; i < monthlyPeaks.length; i++) {
    const m = monthlyPeaks[i];
    let billed = m.peakKw;
    let applied = false;
    if (ratchet) {
      const lookStart = Math.max(0, i - ratchet.lookbackMonths);
      let lookPeak = 0;
      for (let j = lookStart; j < i; j++) {
        const mm = monthlyPeaks[j];
        if (ratchet.applicablePeriod === "summer") {
          const mon = parseInt(mm.month.split("-")[1], 10);
          if (mon < 5 || mon > 10) continue;
        }
        if (mm.peakKw > lookPeak) lookPeak = mm.peakKw;
      }
      const floor = ratchet.ratchetPct * lookPeak;
      if (floor > billed) {
        billed = floor;
        applied = true;
      }
    }
    out.push({ month: m.month, actualPeakKw: m.peakKw, billedDemandKw: billed, ratchetApplied: applied, peakTimestamp: m.peakTs });
  }
  return out;
}

/* ---------------- TOU matching ---------------- */
function touRate(structure: TariffStructure, ts: number): number {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const dow = d.getDay();
  const hour = d.getHours();
  // First matching *specific* period wins (periods listed specific → general)
  for (const p of structure.energy) {
    if (!p.months.includes(month)) continue;
    if (!p.daysOfWeek.includes(dow)) continue;
    if (hour >= p.hourStart && hour < p.hourEnd) return p.ratePerUnit;
  }
  return structure.energy.length > 0 ? structure.energy[structure.energy.length - 1].ratePerUnit : 0;
}

function demandWindowMatch(dc: { hourStart?: number; hourEnd?: number; daysOfWeek?: number[]; months: number[] }, ts: number): boolean {
  const d = new Date(ts);
  if (!dc.months.includes(d.getMonth() + 1)) return false;
  if (dc.daysOfWeek && !dc.daysOfWeek.includes(d.getDay())) return false;
  if (dc.hourStart != null && dc.hourEnd != null) {
    const h = d.getHours();
    if (h < dc.hourStart || h >= dc.hourEnd) return false;
  }
  return true;
}

/* ---------------- full cost engine ---------------- */
export interface CostResult {
  breakdown: CostBreakdown;
  monthlyDetails: MonthlyDemandDetail[];
  monthlyCosts: Array<{ month: string; energy: number; demand: number; fixed: number; total: number; exportCredit: number }>;
  disclosures: string[];
}

/**
 * Cost interval data on a tariff. Handles TOU, windowed demand charges,
 * ratchet, CP proxy, export credits. Points may include negative usage
 * (net metering export intervals).
 */
export function costOnTariff(points: IntervalPoint[], structure: TariffStructure, opts?: { cpTopNOverride?: number }): CostResult {
  const disclosures: string[] = [];
  const byMonth = new Map<string, IntervalPoint[]>();
  for (const p of points) {
    const d = new Date(p.ts);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const arr = byMonth.get(mk) ?? [];
    arr.push(p);
    byMonth.set(mk, arr);
  }
  const months = Array.from(byMonth.keys()).sort();

  // Monthly peaks per demand-charge window
  const monthlyPeaksAll: Array<{ month: string; peakKw: number; peakTs: number }> = [];
  for (const mk of months) {
    const pts = byMonth.get(mk)!;
    let pk = 0;
    let pkTs = pts[0]?.ts ?? 0;
    for (const p of pts) {
      const kw = p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0);
      if (kw > pk) {
        pk = kw;
        pkTs = p.ts;
      }
    }
    monthlyPeaksAll.push({ month: mk, peakKw: pk, peakTs: pkTs });
  }
  const monthlyDetails = applyRatchet(monthlyPeaksAll, structure.ratchet);
  const detailByMonth = new Map(monthlyDetails.map((m) => [m.month, m]));

  let energyTotal = 0;
  let demandTotal = 0;
  let fixedTotal = 0;
  let exportTotal = 0;
  const monthlyCosts: CostResult["monthlyCosts"] = [];

  for (const mk of months) {
    const pts = byMonth.get(mk)!;
    let mEnergy = 0;
    let mExport = 0;
    for (const p of pts) {
      if (p.usage >= 0) {
        mEnergy += p.usage * touRate(structure, p.ts);
      } else {
        // Cycle 5: export asymmetry — credit at export rate only
        const er = structure.exportRate;
        if (!er || er.type === "zero") {
          // no credit
        } else if (er.type === "net_metering_retail") {
          mExport += -p.usage * touRate(structure, p.ts);
        } else {
          mExport += -p.usage * er.ratePerKwh;
        }
      }
    }
    // demand charges: use windowed peak within each charge's window, with ratchet on the anytime peak
    let mDemand = 0;
    for (const dc of structure.demand) {
      const monthNum = parseInt(mk.split("-")[1], 10);
      if (!dc.months.includes(monthNum)) continue;
      let windowPeak = 0;
      for (const p of pts) {
        if (!demandWindowMatch(dc, p.ts)) continue;
        const kw = p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0);
        if (kw > windowPeak) windowPeak = kw;
      }
      // if charge is anytime (no window), apply ratcheted billed demand
      if (dc.hourStart == null) {
        const det = detailByMonth.get(mk);
        windowPeak = det ? det.billedDemandKw : windowPeak;
      }
      mDemand += windowPeak * dc.ratePerKw;
    }
    const mFixed = structure.fixedMonthly;
    let mTotal = mEnergy + mDemand + mFixed - mExport;
    if (structure.minBill != null && mTotal < structure.minBill) mTotal = structure.minBill;
    energyTotal += mEnergy;
    demandTotal += mDemand;
    fixedTotal += mFixed;
    exportTotal += mExport;
    monthlyCosts.push({ month: mk, energy: mEnergy, demand: mDemand, fixed: mFixed, total: mTotal, exportCredit: mExport });
  }

  // CP proxy charge
  let cp: number | null = null;
  let cpMethodology: CostBreakdown["cpMethodology"] = "cp_omitted_no_interval_data";
  let cpTopNApplied: number | undefined;
  if (structure.cp && points.length > 0) {
    const topN = opts?.cpTopNOverride ?? structure.cp.topN;
    const da = computeDemandAnalytics(points, topN, structure.cp.peakSeasonMonths);
    if (da?.cpProxy && da.cpProxy.events.length > 0) {
      const avgCpKw = da.cpProxy.events.reduce((a, e) => a + e.kw, 0) / da.cpProxy.events.length;
      cp = avgCpKw * structure.cp.ratePerKw * 12;
      cpMethodology = "cp_proxy_top_n_customer_peaks";
      cpTopNApplied = topN;
      disclosures.push(
        `CP/4CP charge uses your top-${topN} seasonal customer peaks as proxy coincident peaks (${LABEL_CP_ESTIMATED}). Actual ISO/utility CP timing may differ materially.`,
      );
    }
  }

  const anyRatchet = monthlyDetails.some((m) => m.ratchetApplied);
  if (anyRatchet) {
    disclosures.push(
      "Demand ratchet applied in one or more months — billed demand reflects the tariff's ratchet floor from prior-period peaks, not that month's actual peak.",
    );
  }
  if (exportTotal > 0 && structure.exportRate && structure.exportRate.type !== "net_metering_retail") {
    disclosures.push(
      "Exported energy is credited at the utility's export/buyback rate, which is below the retail import rate — export credits never offset fixed or demand charges at retail value.",
    );
  }

  const total = energyTotal + demandTotal + fixedTotal + (cp ?? 0) - exportTotal;
  return {
    breakdown: {
      energy: energyTotal,
      demand: demandTotal,
      fixed: fixedTotal,
      cp,
      cpMethodology,
      cpTopNApplied,
      total,
    },
    monthlyDetails,
    monthlyCosts,
    disclosures,
  };
}

/* ---------------- eligibility ---------------- */
export function tariffEligible(
  t: { sector: string; commodity: string; peakKwMin: number | null; peakKwMax: number | null },
  site: { sectorClass: string },
  peakKw: number | null,
): { eligible: boolean; reason?: string } {
  const sectorMap: Record<string, string[]> = {
    residential: ["residential"],
    commercial: ["commercial", "industrial"],
  };
  const allowed = sectorMap[site.sectorClass] ?? ["commercial"];
  if (!allowed.includes(t.sector)) return { eligible: false, reason: `Tariff is ${t.sector}; site is ${site.sectorClass}` };
  if (peakKw != null) {
    if (t.peakKwMin != null && peakKw < t.peakKwMin) return { eligible: false, reason: `Peak ${peakKw.toFixed(0)} kW below tariff minimum ${t.peakKwMin} kW` };
    if (t.peakKwMax != null && peakKw > t.peakKwMax) return { eligible: false, reason: `Peak ${peakKw.toFixed(0)} kW above tariff maximum ${t.peakKwMax} kW` };
  }
  return { eligible: true };
}
