/**
 * Oct 24 (Joel demo + rerun audit): when a meter has NO assigned rate, the
 * current-cost basis used to be "first eligible same-utility tariff by id" —
 * for UNS Electric that is Large General Service (EGLGS, 450 kW class
 * minimum billing demand), which priced a 5,164 kWh/yr hangar at ~$90k/yr.
 *
 * Selection order (each step uses only FILED terms carried on the tariff):
 *   1. The bill's own rate code, when it resolves to a filed schedule.
 *   2. Size fit among eligible schedules at the site's utility:
 *      - drop schedules whose filed minimum billing demand (demandMinKw) the
 *        site's observed peak never reaches (it is not in that class);
 *      - if a small-customer schedule with a filed migration rule is still
 *        eligible (the site has NOT met its migration threshold), that is the
 *        filed fit (e.g. UNS SGS until 12,000 kWh in 2 consecutive months);
 *      - otherwise the class with the largest filed minimum the site meets;
 *      - standard (non-TOU, non-school-only) schedules first — the default a
 *        customer is on unless they elected otherwise.
 *   3. Fallback: the first eligible candidate (legacy behavior), then any.
 * Utilities whose seeded rows carry no size terms keep the legacy order.
 */
import type { TariffStructure } from "../../shared/wattwise";

export interface BasisCandidate {
  id: number;
  name: string;
  urdbId?: string | null;
  structure: unknown;
}

export interface BasisChoice<T extends BasisCandidate> {
  tariff: T;
  method: "rate_code" | "size_fit" | "first_eligible";
  disclosure: string | null;
}

function isStandardSchedule(s: TariffStructure): boolean {
  return (s.energy?.length ?? 0) <= 1 && !s.schoolOnly;
}

export function pickSizeFitBasis<T extends BasisCandidate>(
  candidates: T[],
  opts: {
    eligible: (t: T) => boolean;
    peakKw: number | null;
    rateCodeUrdbId?: string | null;
  },
): BasisChoice<T> | null {
  if (candidates.length === 0) return null;
  if (opts.rateCodeUrdbId) {
    const byCode = candidates.find((t) => t.urdbId === opts.rateCodeUrdbId);
    if (byCode) return { tariff: byCode, method: "rate_code", disclosure: null };
  }
  const eligible = candidates.filter(opts.eligible);
  if (eligible.length === 0) return null;
  const peak = opts.peakKw;
  const hasSizeTerms = eligible.some((t) => {
    const s = t.structure as TariffStructure;
    return s.demandMinKw != null || s.migrationAtConsecutiveMonthlyKwh != null;
  });
  if (peak == null || !Number.isFinite(peak) || !hasSizeTerms) {
    return { tariff: eligible[0], method: "first_eligible", disclosure: null };
  }
  const minOf = (t: T) => (t.structure as TariffStructure).demandMinKw ?? 0;
  const fits = eligible.filter((t) => minOf(t) <= peak);
  const pool = fits.length > 0 ? fits : eligible;
  const standard = pool.filter((t) => isStandardSchedule(t.structure as TariffStructure));
  const ranked = standard.length > 0 ? standard : pool;
  const small = ranked.find((t) => (t.structure as TariffStructure).migrationAtConsecutiveMonthlyKwh != null);
  // Among classes the site meets, the largest filed minimum is its class; if it
  // meets none (tiny load), the class with the SMALLEST minimum is the fit.
  const chosen =
    small ??
    [...ranked].sort((a, b) => (fits.length > 0 ? minOf(b) - minOf(a) : minOf(a) - minOf(b)))[0];
  const skipped = eligible.filter((t) => ((t.structure as TariffStructure).demandMinKw ?? 0) > peak);
  const why = small
    ? "the small-customer schedule this site's monthly usage still qualifies for"
    : `the standard schedule that fits a ${Math.round(peak)} kW peak`;
  const skippedNote = skipped.length
    ? ` Schedules with a filed minimum billing demand above this site's peak (${skipped.map((t) => t.name.split(" — ")[0]).join(", ")}) were not used.`
    : "";
  return {
    tariff: chosen,
    method: "size_fit",
    disclosure: `This account's current rate is not on file, so it is priced on ${chosen.name.split(" — ")[0]} — ${why}.${skippedNote} Add the rate code from a bill to price it exactly.`,
  };
}
