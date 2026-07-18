/**
 * v1.19 §5 stage 4 / v2.10 §1b — Away mode as a promise.
 *
 * One toggle ("I'm away Nov–Apr" or dates) flips the product's voice:
 *  - the feed quiets to a single watchdog card ("All quiet at your Tucson home"),
 *  - the ONLY proactive message is the one that matters: usage above the
 *    vacant baseline ("water usage started Tuesday 2am and hasn't stopped —
 *    likely a leak; here's your shutoff checklist").
 *
 * Vacant baseline: the expected load of an EMPTY home — fridge, standby, HVAC
 * min-cycling. Computed from the site's own overnight floor (2–5am median
 * daily minimum over the pre-away window), the closest measurable proxy for
 * "nobody home" load. For water meters the vacant baseline is ~zero, so ANY
 * sustained flow is leak-first framed.
 *
 * In a manual-upload world (current data rungs), the watchdog evaluates at
 * upload/analysis time over intervals stamped inside the away window — it is
 * honest about that in the card copy ("checked as of your last upload").
 */
import { localParts, DEFAULT_TZ } from "../shared/wattwise";

export interface AwayWindow {
  awayMode: boolean;
  awayStart: number | null;
  awayEnd: number | null;
}

export function tsInAwayWindow(ts: number, w: AwayWindow): boolean {
  if (!w.awayMode) return false;
  if (w.awayStart != null && ts < w.awayStart) return false;
  if (w.awayEnd != null && ts > w.awayEnd) return false;
  return true;
}

export interface VacantBaselineResult {
  /** kW (electric) or unit/hr (water/gas) floor an empty building should hold */
  vacantFloor: number;
  basis: "overnight_floor" | "assumed_zero_water";
  nightsUsed: number;
}

/**
 * Overnight floor from PRE-AWAY data: per-night median of 2–5am average draw,
 * then the median across nights. Robust to one-off spikes (water heater kick).
 * Returns null when fewer than 5 usable nights exist — the watchdog then
 * declines to alert rather than alerting off a guess.
 */
export function computeVacantBaseline(
  points: Array<{ ts: number; durationMin: number; usage: number }>,
  commodity: "electric" | "gas" | "water",
  awayStart: number | null,
  tz: string = DEFAULT_TZ,
): VacantBaselineResult | null {
  if (commodity === "water") {
    // An empty home's water draw is ~zero; irrigation timers are the known
    // exception and are disclosed in the alert copy rather than baked in.
    return { vacantFloor: 0, basis: "assumed_zero_water", nightsUsed: 0 };
  }
  const pre = awayStart != null ? points.filter((p) => p.ts < awayStart) : points;
  const byNight = new Map<string, number[]>();
  for (const p of pre) {
    const lp = localParts(p.ts, tz);
    if (lp.hour < 2 || lp.hour >= 5) continue;
    const rate = p.durationMin > 0 ? (p.usage * 60) / p.durationMin : NaN;
    if (!Number.isFinite(rate)) continue;
    const key = `${lp.year}-${lp.month}-${lp.day}`;
    const arr = byNight.get(key) ?? [];
    arr.push(rate);
    byNight.set(key, arr);
  }
  const nightMedians: number[] = [];
  byNight.forEach((arr) => {
    arr.sort((a, b) => a - b);
    nightMedians.push(arr[Math.floor(arr.length / 2)]);
  });
  if (nightMedians.length < 5) return null;
  nightMedians.sort((a, b) => a - b);
  return {
    vacantFloor: nightMedians[Math.floor(nightMedians.length / 2)],
    basis: "overnight_floor",
    nightsUsed: nightMedians.length,
  };
}

export interface WatchdogFinding {
  kind: "quiet" | "excess_usage" | "sustained_water_flow" | "insufficient_baseline";
  /** headline for the watchdog card / alert */
  title: string;
  body: string;
  /** estimated $ impact of the excess (0 for quiet) */
  dollarImpactUsd: number;
  /** when the excess started, if found */
  excessStartTs: number | null;
}

/**
 * Evaluate away-window intervals against the vacant baseline.
 *  - electric/gas: sustained draw > 1.5× vacant floor for ≥ 6 consecutive
 *    hours → excess_usage (something is running that shouldn't be).
 *  - water: ANY draw in ≥ 6 consecutive hours → sustained_water_flow,
 *    leak-first framing with shutoff checklist.
 * Quiet result carries the reassurance copy — for snowbirds this card IS the product.
 */
export function evaluateAwayWatchdog(
  awayPoints: Array<{ ts: number; durationMin: number; usage: number }>,
  vacant: VacantBaselineResult | null,
  commodity: "electric" | "gas" | "water",
  opts: { ratePerUnit: number; siteLabel: string; tz?: string },
): WatchdogFinding {
  const tz = opts.tz ?? DEFAULT_TZ;
  const label = opts.siteLabel;
  if (vacant == null) {
    return {
      kind: "insufficient_baseline",
      title: `Away watchdog needs a bit more history for ${label}`,
      body: "Fewer than 5 nights of pre-away data exist to establish what your empty home should draw. Upload more interval history and the watchdog will arm itself.",
      dollarImpactUsd: 0,
      excessStartTs: null,
    };
  }
  const sorted = [...awayPoints].sort((a, b) => a.ts - b.ts);
  const threshold = commodity === "water" ? 0 : vacant.vacantFloor * 1.5;
  const MIN_RUN_MS = 6 * 3_600_000;
  let runStart: number | null = null;
  let runEnd: number | null = null;
  let excessStart: number | null = null;
  let excessUnits = 0;
  let runUnits = 0;
  for (const p of sorted) {
    const rate = p.durationMin > 0 ? (p.usage * 60) / p.durationMin : 0;
    const over = commodity === "water" ? p.usage > 0 : rate > threshold && vacant.vacantFloor >= 0;
    if (over) {
      if (runStart == null) {
        runStart = p.ts;
        runUnits = 0;
      }
      runEnd = p.ts + p.durationMin * 60_000;
      runUnits += commodity === "water" ? p.usage : Math.max(0, p.usage - (vacant.vacantFloor * p.durationMin) / 60);
      if (runEnd - runStart >= MIN_RUN_MS && excessStart == null) {
        excessStart = runStart;
      }
      if (excessStart != null) excessUnits = runUnits;
    } else {
      if (excessStart != null) break; // first qualifying run wins — alert on it
      runStart = null;
      runEnd = null;
    }
  }
  if (excessStart != null) {
    const startLp = localParts(excessStart, tz);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const when = `${dayNames[startLp.dow]} ${startLp.hour}:00`;
    const dollars = excessUnits * opts.ratePerUnit;
    if (commodity === "water") {
      return {
        kind: "sustained_water_flow",
        title: `Water is running at ${label} — likely a leak`,
        body: `Water usage started ${when} and ran 6+ hours straight while you were away. An empty home should draw none (irrigation timers are the usual false positive — if you have one, check its schedule first). Shutoff checklist: 1) main shutoff valve at the meter or where the line enters the house, 2) toilet flappers (most common silent leak), 3) water heater relief valve, 4) irrigation controller. Checked as of your last upload.`,
        dollarImpactUsd: dollars,
        excessStartTs: excessStart,
      };
    }
    return {
      kind: "excess_usage",
      title: `Something is drawing power at ${label} while you're away`,
      body: `Usage has run ${(vacant.vacantFloor > 0 ? "well above" : "above")} your empty-home baseline (${vacant.vacantFloor.toFixed(2)} kW overnight floor from ${vacant.nightsUsed} pre-away nights) since ${when}, sustained 6+ hours. Common causes: HVAC stuck on, water heater fault, a door left ajar tripping heating. Checked as of your last upload.`,
      dollarImpactUsd: dollars,
      excessStartTs: excessStart,
    };
  }
  return {
    kind: "quiet",
    title: `All quiet at ${label}`,
    body: `Usage is holding at your empty-home baseline${vacant.basis === "overnight_floor" ? ` (${vacant.vacantFloor.toFixed(2)} kW floor, ${vacant.nightsUsed} nights of evidence)` : ""}. Nothing needs your attention. Checked as of your last upload.`,
    dollarImpactUsd: 0,
    excessStartTs: null,
  };
}
