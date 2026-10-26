/**
 * OPEN-2 (R4 #1): savings that remain after a completed measure.
 *
 * The analysis is run on historical interval data. If a measure was completed
 * part-way through that history, the readings before the change still contain
 * the load the measure removed. Re-using those readings unchanged would let the
 * remaining recommendations claim savings on load that no longer exists (for
 * example, an HVAC card counting the cooling that an earlier lighting retrofit
 * already reduced, or a baseload card counting lights that were already
 * replaced).
 *
 * This module adjusts the load figures the efficiency cards use, in proportion
 * to the share of the analysis period that came before each completion, using
 * the MIDPOINT of each completed measure's own published savings band:
 *   - LED lighting retrofit: 30–55% of lighting energy  → 42.5%
 *   - HVAC tune-up / scheduling: 5–15% of cooling energy → 10%
 *   - After-hours baseload reduction: 10–25% of baseload → 17.5%
 * Readings recorded after a completion already reflect it, so they are not
 * adjusted again (share before = 0 → no change). Everything here is modeled,
 * never measured, and every adjusted card says so.
 */

export interface CompletedMeasure {
  measure: string;
  title: string;
  /** ms epoch when the user says the change went in */
  implementedAt: number;
}

export interface ResidualLoad {
  /** annual lighting kWh the LED card is computed on */
  lightingKwh: number;
  /** annual cooling kWh the HVAC card is computed on */
  coolingKwh: number;
  /** overnight baseload kW the baseload card is computed on (null if not measured) */
  baseloadKw: number | null;
}

export interface ResidualAdjustment extends ResidualLoad {
  /** Completed measures that changed the figures above, with their pre-change share. */
  applied: Array<{ measure: string; title: string; implementedAt: number; shareBefore: number }>;
  /** One plain sentence for each adjusted card; null when nothing was adjusted. */
  note: string | null;
}

/** Midpoint of each measure's own published savings band (see header). */
export const RESIDUAL_MIDPOINTS = {
  led_retrofit: 0.425,
  hvac_tuneup: 0.1,
  baseload_reduction: 0.175,
} as const;

type ResidualMeasure = keyof typeof RESIDUAL_MIDPOINTS;
const isResidualMeasure = (m: string): m is ResidualMeasure => m in RESIDUAL_MIDPOINTS;

/**
 * Share of the analysis window [startMs, endMs) recorded BEFORE the change.
 * 1 = the whole window predates the change; 0 = all readings already reflect it.
 */
export function shareBeforeChange(implementedAt: number, startMs: number, endMs: number): number {
  if (!Number.isFinite(implementedAt) || !(endMs > startMs)) return 0;
  if (implementedAt <= startMs) return 0;
  if (implementedAt >= endMs) return 1;
  return (implementedAt - startMs) / (endMs - startMs);
}

const monthYear = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Apply completed measures to the load figures the efficiency cards use.
 * Measures are applied in completion order. Interactions modeled:
 *   - LED removes lighting energy; the lighting share of the overnight baseload
 *     (taken as the building's lighting fraction) shrinks by the same share.
 *   - HVAC scheduling removes cooling energy; the cooling share of the
 *     baseload shrinks the same way.
 *   - Baseload reduction removes after-hours energy; that energy is taken out
 *     of lighting and cooling in proportion to their fractions.
 * Other completed measures (rate switch, peak management, demand response,
 * other commodities) do not change these energy figures.
 */
export function applyCompletedMeasures(
  base: ResidualLoad,
  context: {
    completed: CompletedMeasure[];
    windowStartMs: number;
    windowEndMs: number;
    lightingFraction: number;
    coolingFraction: number;
    unoccupiedHoursPerYear: number;
  },
): ResidualAdjustment {
  let { lightingKwh, coolingKwh, baseloadKw } = base;
  const lf = Math.max(0, Math.min(1, context.lightingFraction || 0));
  const cf = Math.max(0, Math.min(1, context.coolingFraction || 0));
  const applied: ResidualAdjustment["applied"] = [];
  // Latest completion per measure (a reopened-then-completed measure counts once).
  const latest = new Map<string, CompletedMeasure>();
  for (const c of context.completed) {
    if (!isResidualMeasure(c.measure)) continue;
    const prev = latest.get(c.measure);
    if (!prev || c.implementedAt > prev.implementedAt) latest.set(c.measure, c);
  }
  const ordered = Array.from(latest.values()).sort((a, b) => a.implementedAt - b.implementedAt);
  for (const c of ordered) {
    const s = shareBeforeChange(c.implementedAt, context.windowStartMs, context.windowEndMs);
    if (s <= 0) continue;
    const m = c.measure as ResidualMeasure;
    const cut = RESIDUAL_MIDPOINTS[m] * s;
    if (m === "led_retrofit") {
      lightingKwh *= 1 - cut;
      if (baseloadKw != null) baseloadKw -= baseloadKw * lf * cut;
    } else if (m === "hvac_tuneup") {
      coolingKwh *= 1 - cut;
      if (baseloadKw != null) baseloadKw -= baseloadKw * cf * cut;
    } else if (m === "baseload_reduction" && baseloadKw != null) {
      const savedKwh = baseloadKw * cut * Math.max(0, context.unoccupiedHoursPerYear);
      baseloadKw *= 1 - cut;
      lightingKwh = Math.max(0, lightingKwh - savedKwh * lf);
      coolingKwh = Math.max(0, coolingKwh - savedKwh * cf);
    }
    applied.push({ measure: c.measure, title: c.title, implementedAt: c.implementedAt, shareBefore: s });
  }
  const note = applied.length
    ? `Re-estimated on the load that remains after ${applied
        .map((a) => `${a.title} (completed ${monthYear(a.implementedAt)}; ${Math.round(a.shareBefore * 100)}% of the analyzed readings predate it)`)
        .join(" and ")}. Modeled from the midpoint of each completed measure's savings band, not measured — readings recorded after a change already reflect it.`
    : null;
  return { lightingKwh, coolingKwh, baseloadKw: baseloadKw == null ? null : Math.max(0, baseloadKw), applied, note };
}
