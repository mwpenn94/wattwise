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
import { DEFAULT_TZ, LABEL_CP_ESTIMATED, localParts } from "../../shared/wattwise";

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

export function computeDemandAnalytics(points: IntervalPoint[], cpTopN = 4, cpSeasonMonths: number[] = [6, 7, 8, 9], tz: string = DEFAULT_TZ): DemandAnalytics | null {
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
  // True top decile (10%) of interval demand readings; capped at 50 points for display/transport.
  const topDecilePeaks = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.1))).slice(0, 50).map((p) => ({ ts: p.ts, kw: p.kw }));

  const monthly = new Map<string, { peakKw: number; peakTs: number }>();
  const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const heatN: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const p of withDemand) {
    // Cycle 3, pass 59/66: all calendar bucketing computed in the meter's
    // timezone, never the server's.
    const lp = localParts(p.ts, tz);
    const rec = monthly.get(lp.monthKey);
    if (!rec || p.kw > rec.peakKw) monthly.set(lp.monthKey, { peakKw: p.kw, peakTs: p.ts });
    heat[lp.dow][lp.hour] += p.kw;
    heatN[lp.dow][lp.hour]++;
  }
  for (let dow = 0; dow < 7; dow++) for (let h = 0; h < 24; h++) heat[dow][h] = heatN[dow][h] > 0 ? heat[dow][h] / heatN[dow][h] : 0;

  // CP proxy: top-N distinct-day peaks within peak season (meter-local days)
  const seasonal = withDemand.filter((p) => cpSeasonMonths.includes(localParts(p.ts, tz).month));
  const byDay = new Map<string, { ts: number; kw: number }>();
  for (const p of seasonal) {
    const lp = localParts(p.ts, tz);
    const dk = `${lp.year}-${lp.month}-${lp.day}`;
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
      // Deliverable cycle 2, pass 22: the ratchet determinant window includes
      // the current month — billed = max(current peak, pct × max peak over the
      // lookback INCLUDING current). For pct < 1 the inclusion is a no-op on
      // the current month itself (pct×own ≤ own), but it makes the convention
      // explicit and correct for pct ≥ 1 riders.
      const lookStart = Math.max(0, i - ratchet.lookbackMonths);
      let lookPeak = 0;
      for (let j = lookStart; j <= i; j++) {
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
/**
 * Duration of an hour window, overnight-safe (pass-442): a 22→02 window is
 * 4 hours, not −20. Equal start/end (or 0→24) is treated as the full day.
 */
function hourSpan(hourStart: number, hourEnd: number): number {
  const span = (hourEnd - hourStart + 24) % 24;
  return span === 0 ? 24 : span;
}

function touRate(structure: TariffStructure, ts: number, tz: string, fallbackFlag?: { used: boolean }): number {
  const { month, dow, hour } = localParts(ts, tz);
  // Most-specific matching period wins regardless of array order (deliverable
  // convergence cycle 1, pass 2): specificity = narrower month set + narrower
  // day set + narrower hour window. Ties fall back to earlier array position.
  let best: { rate: number; score: number; idx: number } | null = null;
  for (let i = 0; i < structure.energy.length; i++) {
    const p = structure.energy[i];
    if (!p.months.includes(month)) continue;
    if (!p.daysOfWeek.includes(dow)) continue;
    // Overnight-safe TOU period membership (Cycle 9, consistent with hourSpan
    // and demandWindowMatch): a 22→02 period matches hours 22,23,0,1.
    const inPeriod =
      p.hourStart <= p.hourEnd ? hour >= p.hourStart && hour < p.hourEnd : hour >= p.hourStart || hour < p.hourEnd;
    if (!inPeriod) continue;
    const score =
      (12 - p.months.length) * 100 + (7 - p.daysOfWeek.length) * 10 + (24 - hourSpan(p.hourStart, p.hourEnd));
    if (!best || score > best.score || (score === best.score && i < best.idx)) {
      best = { rate: p.ratePerUnit, score, idx: i };
    }
  }
  if (best) return best.rate;
  // Cycle 3, pass 52: no matching TOU period — fall back to the tariff's
  // LEAST-specific (widest-coverage) period as the default rate rather than an
  // arbitrary array position, and flag the fallback so callers can disclose it.
  if (fallbackFlag) fallbackFlag.used = true;
  // Cycle 5, pass 182: coverage comparison must be strictly hierarchical —
  // months dominate, then days-of-week, then hour span. (A weighted sum let a
  // 1-month/24-hour period outrank a 12-month/1-hour one.)
  // Batch-12 pass 12: ties on the full coverage key resolve to the LOWEST rate,
  // so the fallback is deterministic (array order can never change the answer)
  // and errs in the customer's favor.
  let widest: { rate: number; key: [number, number, number] } | null = null;
  for (const p of structure.energy) {
    const key: [number, number, number] = [p.months.length, p.daysOfWeek.length, hourSpan(p.hourStart, p.hourEnd)];
    const wins =
      !widest ||
      key[0] > widest.key[0] ||
      (key[0] === widest.key[0] && key[1] > widest.key[1]) ||
      (key[0] === widest.key[0] && key[1] === widest.key[1] && key[2] > widest.key[2]) ||
      (key[0] === widest.key[0] && key[1] === widest.key[1] && key[2] === widest.key[2] && p.ratePerUnit < widest.rate);
    if (wins) widest = { rate: p.ratePerUnit, key };
  }
  return widest ? widest.rate : 0;
}

function demandWindowMatch(dc: { hourStart?: number; hourEnd?: number; daysOfWeek?: number[]; months: number[] }, ts: number, tz: string): boolean {
  const { month, dow, hour } = localParts(ts, tz);
  if (!dc.months.includes(month)) return false;
  if (dc.daysOfWeek && !dc.daysOfWeek.includes(dow)) return false;
  if (dc.hourStart != null && dc.hourEnd != null) {
    // Cycle 9 (passes 500/512): overnight windows (hourStart > hourEnd, e.g.
    // 22–02) wrap midnight — the naive range test excluded exactly the hours
    // such a window covers. Mirrors the pass-442 hourSpan overnight fix.
    const inWindow =
      dc.hourStart <= dc.hourEnd
        ? hour >= dc.hourStart && hour < dc.hourEnd
        : hour >= dc.hourStart || hour < dc.hourEnd;
    if (!inWindow) return false;
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
export function costOnTariff(points: IntervalPoint[], structure: TariffStructure, opts?: { cpTopNOverride?: number; tz?: string }): CostResult {
  const tz = opts?.tz ?? DEFAULT_TZ;
  const disclosures: string[] = [];
  const touFallback = { used: false };
  const byMonth = new Map<string, IntervalPoint[]>();
  for (const p of points) {
    const mk = localParts(p.ts, tz).monthKey;
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
        mEnergy += p.usage * touRate(structure, p.ts, tz, touFallback);
      } else {
        // Cycle 5: export asymmetry — credit at export rate only
        const er = structure.exportRate;
        if (!er || er.type === "zero") {
          // no credit
        } else if (er.type === "net_metering_retail") {
          mExport += -p.usage * touRate(structure, p.ts, tz, touFallback);
        } else {
          mExport += -p.usage * er.ratePerKwh;
        }
      }
    }
    // Demand charges: each charge computes its OWN windowed peak (windowPeak is
    // local per-charge, so anytime and windowed charges never clobber each other).
    // Charges sharing a demandGroup are alternative windows of ONE billed
    // determinant: bill max(peak across the group's windows) × ratePerKw ONCE.
    let mDemand = 0;
    const groupPeaks = new Map<string, { peak: number; ratePerKw: number }>();
    for (const dc of structure.demand) {
      const monthNum = parseInt(mk.split("-")[1], 10);
      if (!dc.months.includes(monthNum)) continue;
      let windowPeak = 0;
      for (const p of pts) {
        if (!demandWindowMatch(dc, p.ts, tz)) continue;
        const kw = p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0);
        if (kw > windowPeak) windowPeak = kw;
      }
      // Anytime charge (no window): the billing determinant is the RATCHETED
      // monthly demand, never the raw window scan (cycle 5, pass 212 — made
      // explicit: detailByMonth always has every month key by construction,
      // and billedDemandKw ≥ actual peak, so the ratchet floor is applied).
      if (dc.hourStart == null) {
        const det = detailByMonth.get(mk);
        windowPeak = det ? det.billedDemandKw : 0;
      }
      if (dc.demandGroup) {
        const g = groupPeaks.get(dc.demandGroup);
        if (!g || windowPeak > g.peak) {
          groupPeaks.set(dc.demandGroup, { peak: windowPeak, ratePerKw: dc.ratePerKw });
        }
        continue;
      }
      mDemand += windowPeak * dc.ratePerKw;
    }
    groupPeaks.forEach((g) => { mDemand += g.peak * g.ratePerKw; });
    const mFixed = structure.fixedMonthly;
    // Minimum bill applies to charges BEFORE export credits (cycle 1, pass 12):
    // export credits reduce the bill after the minimum floor is established,
    // so exporters are not silently stripped of credit value by the floor.
    let mCharges = mEnergy + mDemand + mFixed;
    if (structure.minBill != null && mCharges < structure.minBill) mCharges = structure.minBill;
    const mTotal = mCharges - mExport;
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
    const da = computeDemandAnalytics(points, topN, structure.cp.peakSeasonMonths, tz);
    if (da?.cpProxy && da.cpProxy.events.length > 0) {
      const avgCpKw = da.cpProxy.events.reduce((a, e) => a + e.kw, 0) / da.cpProxy.events.length;
      // CP transmission-style charges (ERCOT 4CP pattern): the CP average sets a
      // billing determinant applied at $/kW-month for each month of the billing
      // year. cp.ratePerKw is defined as $/kW-month (documented in shared type
      // + seeds); annualized here as ratePerKw × 12 months (cycle 1, pass 12:
      // unit semantics made explicit rather than ambiguous annual-vs-monthly).
      const cpMonths = structure.cp.chargeMonths ?? 12;
      cp = avgCpKw * structure.cp.ratePerKw * cpMonths;
      cpMethodology = "cp_proxy_top_n_customer_peaks";
      cpTopNApplied = topN;
      disclosures.push(
        `CP/4CP charge uses your top-${topN} seasonal customer peaks as proxy coincident peaks (${LABEL_CP_ESTIMATED}), billed as a $/kW-month determinant over ${cpMonths} months. Actual ISO/utility CP timing may differ materially.`,
      );
    }
  }

  if (touFallback.used) {
    disclosures.push(
      "Some intervals fell outside every defined TOU period on this tariff — they were priced at the tariff's widest-coverage (default) rate. Verify the tariff's period definitions cover all hours.",
    );
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
  // Cycle 3, pass 62: industrial sites must match industrial AND commercial
  // tariffs (industrial rates are a subset of C&I offerings).
  const sectorMap: Record<string, string[]> = {
    residential: ["residential"],
    commercial: ["commercial", "industrial"],
    industrial: ["commercial", "industrial"],
  };
  const allowed = sectorMap[site.sectorClass] ?? ["commercial"];
  if (!allowed.includes(t.sector)) return { eligible: false, reason: `Tariff is ${t.sector}; site is ${site.sectorClass}` };
  if (peakKw != null) {
    if (t.peakKwMin != null && peakKw < t.peakKwMin) return { eligible: false, reason: `Peak ${peakKw.toFixed(0)} kW below tariff minimum ${t.peakKwMin} kW` };
    if (t.peakKwMax != null && peakKw > t.peakKwMax) return { eligible: false, reason: `Peak ${peakKw.toFixed(0)} kW above tariff maximum ${t.peakKwMax} kW` };
  }
  return { eligible: true };
}
