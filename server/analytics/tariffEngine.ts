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
  /** PEAK-2 (handoff demand module): normalized load duration curve — kW at
   * each percentile of hours (0 = highest). 101 points, percentile 0..100.
   * Answers "how many hours a year are we anywhere near peak": a steep cliff
   * near 0% means the peak is rare and shaveable; a flat curve means high
   * baseload where demand-charge reduction must come from equipment. */
  loadDurationCurve: Array<{ pctOfHours: number; kw: number }>;
  /** Share of total hours within 90% of the annual peak — the "peak rarity"
   * number the duration curve summarizes. */
  hoursNearPeakPct: number;
  /** PEAK-4: per-monthly-peak contributing-load hypothesis. Heuristic and
   * labeled as such — derived only from when the peak lands (month, hour,
   * weekday/weekend) relative to this site's own heatmap; never asserted. */
  peakHypotheses: Array<{ month: string; ts: number; kw: number; hypothesis: string; basis: string }>;
}

export function computeDemandAnalytics(points: IntervalPoint[], cpTopN = 4, cpSeasonMonths: number[] = [6, 7, 8, 9], tz: string = DEFAULT_TZ): DemandAnalytics | null {
  // Batch-44 (pass 1912): a zero/invalid-duration point with no explicit demand
  // reading carries NO usable kW information — coercing it to a finite 0 let it
  // through the isFinite filter, where it could seed a spurious 0-kW "peak day"
  // in the CP proxy's byDay map (displacing legitimate high-demand days on
  // sparse feeds) and dilute the duration-weighted average. Map it to NaN so
  // the existing filter drops it instead.
  const withDemand = points
    .map((p) => ({ ts: p.ts, kw: p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : NaN), durationMin: p.durationMin }))
    .filter((p) => Number.isFinite(p.kw));
  if (withDemand.length < 10) return null;

  let peakKw = -Infinity;
  let peakTimestamp = 0;
  // Batch-13 (pass 61): DURATION-WEIGHTED average — with mixed interval lengths
  // (e.g. 15-min data plus hourly data after a meter swap) a simple per-reading
  // mean skews toward whichever granularity contributes more rows. Weighting by
  // interval duration yields the true time-averaged demand, keeping loadFactor
  // ≡ avg/peak physically meaningful.
  let weightedSum = 0;
  let weightMin = 0;
  for (const p of withDemand) {
    if (p.kw > peakKw) {
      peakKw = p.kw;
      peakTimestamp = p.ts;
    }
    const w = p.durationMin > 0 ? p.durationMin : 1;
    weightedSum += p.kw * w;
    weightMin += w;
  }
  const avgKw = weightMin > 0 ? weightedSum / weightMin : 0;

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

  // PEAK-2: load duration curve — duration-weighted kW percentiles. Sort all
  // readings by kW descending, walk cumulative duration, and sample kW at each
  // percent of total hours. O(n log n) once; 101 transport points.
  const totalMin = withDemand.reduce((s, p) => s + (p.durationMin > 0 ? p.durationMin : 1), 0);
  const ldc: Array<{ pctOfHours: number; kw: number }> = [];
  {
    let cum = 0;
    let idx = 0;
    for (let pct = 0; pct <= 100; pct++) {
      const targetMin = (pct / 100) * totalMin;
      while (idx < sorted.length - 1 && cum + (sorted[idx].durationMin > 0 ? sorted[idx].durationMin : 1) < targetMin) {
        cum += sorted[idx].durationMin > 0 ? sorted[idx].durationMin : 1;
        idx++;
      }
      ldc.push({ pctOfHours: pct, kw: sorted[Math.min(idx, sorted.length - 1)].kw });
    }
  }
  const nearPeakMin = withDemand.reduce((s, p) => s + (p.kw >= 0.9 * peakKw ? (p.durationMin > 0 ? p.durationMin : 1) : 0), 0);
  const hoursNearPeakPct = totalMin > 0 ? nearPeakMin / totalMin : 0;

  const monthlyPeaksArr = Array.from(monthly.entries())
    .map(([month, r]) => ({ month, peakKw: r.peakKw, peakTs: r.peakTs }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // PEAK-4: contributing-load hypothesis per monthly peak. Purely positional
  // heuristics (month/hour/daytype vs this site's own heatmap) — the copy is
  // explicit that these are hypotheses to check, not measured attributions.
  const peakHypotheses = monthlyPeaksArr.map((mp) => {
    const lp = localParts(mp.peakTs, tz);
    const isSummer = [6, 7, 8, 9].includes(lp.month);
    const isWinter = [12, 1, 2].includes(lp.month);
    const isWeekend = lp.dow === 0 || lp.dow === 6;
    const isAfternoon = lp.hour >= 12 && lp.hour <= 18;
    const isMorning = lp.hour >= 5 && lp.hour <= 10;
    const isOvernight = lp.hour >= 22 || lp.hour <= 4;
    let hypothesis: string;
    let basis: string;
    if (isSummer && isAfternoon) {
      hypothesis = "Cooling-driven: lands on a summer afternoon, the classic AC-coincident window.";
      basis = `hits ${lp.hour}:00 local in month ${lp.month} — check whether HVAC staging or pre-cooling could shift it`;
    } else if (isWinter && isMorning) {
      hypothesis = "Morning warm-up: winter morning spike consistent with heating recovery / startup surge after setback.";
      basis = `hits ${lp.hour}:00 local — check staggered equipment starts and setback recovery ramp`;
    } else if (isOvernight) {
      hypothesis = "Baseload or scheduled equipment: an overnight peak points to always-on or timer-driven load, not occupancy.";
      basis = `hits ${lp.hour}:00 local — check timers, batch processes, EV/thermal charging schedules`;
    } else if (isWeekend) {
      hypothesis = "Off-schedule load: a weekend peak suggests equipment running outside occupied hours.";
      basis = "weekend timing — check schedules and BMS weekend modes";
    } else {
      hypothesis = "Occupancy-coincident: a weekday business-hours peak tracking normal operations.";
      basis = `hits ${lp.hour}:00 local on a weekday — check simultaneous large-load overlap in that hour`;
    }
    return { month: mp.month, ts: mp.peakTs, kw: mp.peakKw, hypothesis, basis };
  });

  return {
    peakKw,
    peakTimestamp,
    avgKw,
    loadFactor: peakKw > 0 ? avgKw / peakKw : 0,
    topDecilePeaks,
    monthlyPeaks: monthlyPeaksArr,
    heatmap: heat,
    cpProxy: cpEvents.length > 0 ? { label: LABEL_CP_ESTIMATED, topN: cpTopN, events: cpEvents } : null,
    loadDurationCurve: ldc,
    hoursNearPeakPct,
    peakHypotheses,
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
      //
      // Batch-39 (passes 1602/1622) — SUMMER-RATCHET SEMANTICS, made explicit
      // because two reviews read `applicablePeriod: "summer"` in opposite ways:
      // this field scopes WHICH months' peaks feed the ratchet DETERMINANT
      // (summer-season peaks only, May–Oct), NOT which months the resulting
      // floor is billed in. The floor applies to EVERY billing month, including
      // winter — that is the defining behavior of the industry-standard summer
      // ratchet (e.g. Georgia Power PLM, Duke I/OPT: winter billed demand =
      // max(actual, pct × highest summer peak in the lookback)). Filtering
      // non-summer months OUT of the determinant is therefore correct, and
      // applying the floor IN non-summer months is also correct. All currently
      // seeded tariffs use applicablePeriod "all", so this branch is dormant
      // with seed data; it is covered by a dedicated unit test.
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
  // Batch-40 (pass 1746) invariant: pricing NEVER consults eligibility. State/
  // sector/size eligibility (tariffEligible) gates tariff SELECTION upstream;
  // once a structure reaches costOnTariff it prices every hour from its own
  // TOU periods — so the buildScenarioBasis disclosure "your assigned
  // (ineligible) rate is used for these figures; no substitute rate was
  // applied" is literally true. The widest-coverage fallback below applies
  // only to HOURS no defined period covers (a period-definition gap, disclosed
  // via touFallback.used), never to eligibility mismatches.
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
  monthlyCosts: Array<{ month: string; energy: number; demand: number; fixed: number; cp: number; total: number; exportCredit: number }>;
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
  // Batch-46 (pass 2052): hoist the CP $/kW-month determinant ABOVE the monthly
  // loop so the minimum-bill floor sees the month's FULL charges. Previously the
  // floor compared energy+demand+fixed alone while CP was folded in afterwards —
  // on a tariff carrying BOTH minBill and CP, a light month could take an uplift
  // to the floor AND the CP charge on top, overstating the bill by the overlap.
  // (No seeded tariff currently combines the two; this closes the engine-level
  // correctness gap for user/OCR-derived structures.) The hoisted values are
  // reused by the CP fold below — one determinant, computed once.
  let hoistedCpDa: ReturnType<typeof computeDemandAnalytics> | null = null;
  let hoistedCpPerMonth = 0;
  let hoistedCpMonthsBilled = 0;
  if (structure.cp && points.length > 0) {
    const topNHoist = opts?.cpTopNOverride ?? structure.cp.topN;
    hoistedCpDa = computeDemandAnalytics(points, topNHoist, structure.cp.peakSeasonMonths, tz);
    if (hoistedCpDa?.cpProxy && hoistedCpDa.cpProxy.events.length > 0) {
      const avgCpKwHoist = hoistedCpDa.cpProxy.events.reduce((a, e) => a + e.kw, 0) / hoistedCpDa.cpProxy.events.length;
      hoistedCpPerMonth = avgCpKwHoist * structure.cp.ratePerKw;
      hoistedCpMonthsBilled = Math.min(structure.cp.chargeMonths ?? 12, months.length);
    }
  }
  let energyTotal = 0;
  let minBillTotal = 0; // Batch-40 (pass 1742): explicit minimum-bill uplift component
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
      // Batch-46 (pass 2012): only a TRULY unrestricted charge (no hour window
      // AND no daysOfWeek filter) may substitute the ratcheted all-hours
      // monthly peak — an hourless charge that still carries a daysOfWeek
      // restriction (e.g. weekdays-only "anytime" demand) must bill the
      // day-filtered window scan, or weekend peaks would leak into a
      // weekday-only determinant. demandWindowMatch already applies the
      // daysOfWeek filter independently of the hour window, so windowPeak is
      // correct for that case; the ratchet floor intentionally does not apply
      // to day-restricted determinants (ratchets ride on the full monthly peak).
      if (dc.hourStart == null && !dc.daysOfWeek) {
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
    // Batch-40 (pass 1742): the minimum-bill uplift is tracked as an EXPLICIT
    // component instead of being folded invisibly into the monthly total. The
    // old code raised monthly totals to the floor while breakdown.energy/
    // demand/fixed kept pre-floor values — so Σ(components) understated
    // breakdown.total whenever minBill triggered, misleading users about what
    // drove the bill. minBillTotal now carries the uplift so
    // Σ(energy+demand+fixed+cp+minBillAdjustment) − export ≡ total holds.
    // Batch-46 (pass 2052): the floor test includes this month's CP charge —
    // CP is billed revenue like any other charge, so a month whose
    // energy+demand+fixed+CP already clears the minimum takes NO uplift. The
    // CP allocation below assigns cpPerMonth to the first cpMonthsBilled
    // months of monthlyCosts, which is exactly the months.indexOf order here.
    const mCpForFloor = months.indexOf(mk) < hoistedCpMonthsBilled ? hoistedCpPerMonth : 0;
    let mMinBillUplift = 0;
    if (structure.minBill != null && mCharges + mCpForFloor < structure.minBill) {
      mMinBillUplift = structure.minBill - (mCharges + mCpForFloor);
      mCharges = structure.minBill - mCpForFloor;
    }
    const mTotal = mCharges - mExport;
    energyTotal += mEnergy;
    demandTotal += mDemand;
    fixedTotal += mFixed;
    exportTotal += mExport;
    minBillTotal += mMinBillUplift;
    // Batch-30 (pass 1072): cp starts 0 here; the CP fold below fills it so
    // Σ(monthly.demand) ≡ breakdown.demand and Σ(monthly.cp) ≡ breakdown.cp —
    // monthly rows and the aggregate breakdown use identical line semantics.
    monthlyCosts.push({ month: mk, energy: mEnergy, demand: mDemand, fixed: mFixed, cp: 0, total: mTotal, exportCredit: mExport });
  }

  // CP proxy charge
  let cp: number | null = null;
  // Batch-47 (passes 2123/2132): a tariff with NO CP component must report
  // "no_cp_charges" — the omitted-for-data-reasons label is reserved for
  // tariffs that DO define structure.cp but had no interval points to price it.
  let cpMethodology: CostBreakdown["cpMethodology"] = structure.cp
    ? "cp_omitted_no_interval_data"
    : "no_cp_charges";
  let cpTopNApplied: number | undefined;
  if (structure.cp && points.length > 0) {
    const topN = opts?.cpTopNOverride ?? structure.cp.topN;
    // Batch-46 (pass 2052): reuse the determinant hoisted above the monthly
    // loop — one computeDemandAnalytics call, one CP figure, shared by the
    // minimum-bill floor test and this fold.
    const da = hoistedCpDa;
    if (da?.cpProxy && da.cpProxy.events.length > 0) {
      // CP transmission-style charges (ERCOT 4CP pattern): the CP average sets a
      // billing determinant applied at $/kW-month for each month of the billing
      // year. cp.ratePerKw is defined as $/kW-month (documented in shared type
      // + seeds); annualized here as ratePerKw × 12 months (cycle 1, pass 12:
      // unit semantics made explicit rather than ambiguous annual-vs-monthly).
      const cpMonths = structure.cp.chargeMonths ?? 12;
      cpMethodology = "cp_proxy_top_n_customer_peaks";
      // Batch-50 (pass 2572): report the number of peak events ACTUALLY used in
      // the CP average — sparse seasonal histories can yield fewer distinct peak
      // days than the requested topN (cpEvents is sliced to AT MOST cpTopN), and
      // labeling the determinant "top-4" when only 2 events contributed would
      // overstate the estimate's basis to API consumers and the UI.
      cpTopNApplied = da.cpProxy.events.length;
      // Batch-13 (pass 62): fold the CP $/kW-month charge into monthlyCosts so
      // Σ(monthly totals) reconciles with breakdown.total — a UI summing the
      // monthly rows must never disagree with the annual figure. The determinant
      // is billed per month; allocate one month's CP charge to each covered
      // month (all months when chargeMonths spans the year, else spread across
      // the months actually present, capped at cpMonths).
      const cpPerMonth = hoistedCpPerMonth;
      const cpMonthsBilled = Math.min(cpMonths, monthlyCosts.length);
      // Batch-39 (pass 1642): breakdown.cp previously carried the FULL
      // cpMonths determinant while energy/demand/fixed cover only the
      // months-with-data span — an internally inconsistent breakdown whose
      // Σ(monthly.cp) ≠ breakdown.cp. All components now share the same
      // coverage convention: cp = billed months present in the data, and the
      // un-billable remainder is DISCLOSED (annualize() scales by coverage,
      // so downstream annual figures are unaffected).
      cp = cpPerMonth * cpMonthsBilled;
      let cpAllocated = 0;
      for (let i = 0; i < monthlyCosts.length && i < cpMonthsBilled; i++) {
        // Batch-30 (pass 1072): allocate to the dedicated cp field, NOT demand —
        // breakdown.demand excludes CP (Batch-23), so monthly demand must too.
        monthlyCosts[i].cp += cpPerMonth;
        monthlyCosts[i].total += cpPerMonth;
        cpAllocated += cpPerMonth;
      }
      // Batch-13 Σ(monthly) ≡ annual invariant now holds by construction:
      // cpAllocated === cp exactly (same per-month charge, same month count).
      void cpAllocated;
      if (cpMonthsBilled < cpMonths) {
        disclosures.push(
          `CP charge spans ${cpMonths} billing months but only ${cpMonthsBilled} months of data are present — the cost shown includes ${cpMonthsBilled} month(s) of CP charges (matching the data span, like all other components); a full billing year would add approximately $${(cpPerMonth * (cpMonths - cpMonthsBilled)).toFixed(0)} more in CP charges.`,
        );
      }
      disclosures.push(
        `CP/4CP charge uses your top-${da.cpProxy.events.length} seasonal customer peak${da.cpProxy.events.length === 1 ? "" : "s"}${da.cpProxy.events.length < topN ? ` (fewer than the ${topN} requested — sparse seasonal history)` : ""} as proxy coincident peaks (${LABEL_CP_ESTIMATED}), billed as a $/kW-month determinant over ${cpMonths} months. Actual ISO/utility CP timing may differ materially.`,
      );
    } else {
      // Batch-32 (pass 1192): the tariff DOES carry a CP charge but no proxy
      // events could be computed — disclose the omission instead of silently
      // understating cost. Batch-35 (pass 1332): name the ACTUAL cause —
      // interval points exist here (points.length > 0), so "no interval data"
      // would be false. `da` null means demand could not be computed from the
      // available intervals (e.g. a vacancy/net-export span where fewer than 10
      // points carry usable demand); `da` present but zero events means no
      // peaks fell in the CP season.
      const cpOmissionCause =
        da == null
          ? "interval data exists but demand could not be computed from it (too few points with usable demand — e.g. a vacancy or net-export period)"
          : "no qualifying seasonal peaks in the interval history";
      // Batch-49 (passes 2472/2492): the machine-readable label previously kept
      // its init value "cp_omitted_no_interval_data" on this branch even though
      // interval data EXISTS (points.length > 0) — an API consumer reading the
      // label without the disclosure text would infer the wrong cause. The
      // label now names the same cause the disclosure does.
      cpMethodology = "cp_omitted_demand_not_computable";
      disclosures.push(
        `This tariff includes a coincident-peak (CP) charge, but it could not be estimated from your data (${cpOmissionCause}) — the cost shown EXCLUDES the CP component and understates the true bill on this rate.`,
      );
    }
  } else if (structure.cp) {
    // Batch-32 (pass 1192): CP-bearing tariff with NO interval points at all.
    // Batch-50 (passes 2552/2562): pin the machine-readable label explicitly in
    // this branch (it previously relied on the init value alone) so the label
    // assignment is locally auditable and can never drift from the disclosure
    // if the initializer changes. "cp_omitted_no_interval_data" is exactly this
    // branch's meaning: structure.cp defined, points.length === 0.
    cpMethodology = "cp_omitted_no_interval_data";
    disclosures.push(
      "This tariff includes a coincident-peak (CP) charge, but no interval data is available to estimate it — the cost shown EXCLUDES the CP component and understates the true bill on this rate.",
    );
  }

  // Batch-47 (pass 2142): an energy-less structure (fixed/demand-only tariff,
  // energy legitimately []) always "falls back" to $0/kWh — that is the tariff
  // working as defined, not a period-coverage gap, so no disclosure is emitted.
  if (touFallback.used && structure.energy.length > 0) {
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
  // Batch-16 (pass 272): scope this disclosure to types that actually credit at a
  // non-retail rate. net_metering_retail credits at full retail (disclosure would
  // mislead), and "zero" pays nothing ("credited at buyback rate" would be false).
  if (exportTotal > 0 && structure.exportRate && structure.exportRate.type !== "net_metering_retail" && structure.exportRate.type !== "zero") {
    disclosures.push(
      "Exported energy is credited at the utility's export/buyback rate, typically below the retail import rate — these credits do not offset fixed or demand charges at retail value.",
    );
  }

  if (minBillTotal > 0) {
    disclosures.push(
      `A minimum-bill floor raised charges by $${minBillTotal.toFixed(2)} across the billed span — shown as a separate "minimum-bill adjustment" line so the energy/demand/fixed components still reflect actual metered charges.`,
    );
  }
  const total = energyTotal + demandTotal + fixedTotal + (cp ?? 0) + minBillTotal - exportTotal;
  return {
    breakdown: {
      energy: energyTotal,
      demand: demandTotal,
      // Batch-13 (pass 62, minor): `fixed` is fixedMonthly × months-with-data
      // (the covered span), not a calendar-year annualization — callers that
      // annualize must scale by data coverage (annualize() does).
      fixed: fixedTotal,
      cp,
      cpMethodology,
      cpTopNApplied,
      minBillAdjustment: minBillTotal,
      // Batch-46 (pass 1990): export credits are the subtrahend in the component
      // identity Σ(energy+demand+fixed+cp+minBill) − exportCredits ≡ total.
      // Exposing it lets tests and API consumers verify the identity exactly
      // instead of the export term being silently absorbed into `total`.
      exportCredits: exportTotal,
      total,
    },
    monthlyDetails,
    monthlyCosts,
    disclosures,
  };
}

/* ---------------- eligibility ---------------- */
export function tariffEligible(
  t: {
    sector: string;
    commodity: string;
    peakKwMin: number | null;
    peakKwMax: number | null;
    /** v1.18 applicability conditions (optional — legacy callers omit them) */
    closedToNew?: boolean;
    techCondition?: "none" | "solar_only" | "non_solar_only";
  },
  site: { sectorClass: string; hasSolar?: boolean; isCurrentBasis?: boolean },
  peakKw: number | null,
): { eligible: boolean; reason?: string } {
  // v1.18 §5 stage 7: applicability conditions beyond sector/size.
  // (a) Closed/grandfathered plans may be the customer's CURRENT basis (they
  //     are already on it) but must never appear as a switch target.
  if (t.closedToNew && !site.isCurrentBasis) {
    return { eligible: false, reason: "Closed to new customers (grandfathered plan)" };
  }
  // (b) Technology-conditioned plans, both directions: a solar-only plan is
  //     hidden from non-solar sites; solar sites see ONLY plans they may
  //     lawfully take (SRP pattern: solar customers restricted to solar plans).
  const tech = t.techCondition ?? "none";
  if (tech === "solar_only" && !site.hasSolar) {
    return { eligible: false, reason: "Solar-customer-only plan; this site has no solar on record" };
  }
  if (tech === "non_solar_only" && site.hasSolar) {
    return { eligible: false, reason: "Not open to solar customers — solar sites are restricted to solar price plans" };
  }
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
