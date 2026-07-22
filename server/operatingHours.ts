/**
 * HRS-1: operating-hours model.
 *
 * Every site's savings math previously assumed a single-shift commercial
 * schedule (AFTER_HOURS_PER_YEAR = 4900 h, hard-coded). This module makes the
 * assumption explicit, per-site, and user-adjustable:
 *
 *  - Multiple schedules per site with usage splits (usageSharePct) — an office
 *    wing on 8–18 M–F next to a 24/7 server room, or a seasonal production
 *    line (months array).
 *  - When the user has entered nothing, an archetype default derived from
 *    buildingType applies — clearly labeled `archetype_default` so every
 *    surface can say "assumed — adjust in Sites".
 *  - computeHoursSummary() converts schedules into occupied/unoccupied hours
 *    per year, weighted by usage share, replacing the flat 4900 h constant in
 *    after-hours baseload savings and disclosed in the basis string.
 *
 * Honesty rules: derived figures always carry `source` so the UI can badge
 * assumed vs user-confirmed; disclosure strings state the exact hour windows.
 */
import { getDb } from "./db";
import { siteSchedules, type SiteSchedule } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface ScheduleSpec {
  name: string;
  kind: string; // business | always_on | production | custom
  days: number[]; // 0(Sun)–6(Sat)
  startHour: number; // 0–23 local
  endHour: number; // 1–24; <= startHour means overnight wrap; 0→24 = 24h
  months: number[] | null; // 1–12, null = all year
  usageSharePct: number; // 0–100
  source: "archetype_default" | "user";
}

export interface HoursSummary {
  /** usage-share-weighted occupied hours per year across schedules */
  occupiedHoursPerYear: number;
  /** usage-share-weighted unoccupied hours per year (8760 − occupied) */
  unoccupiedHoursPerYear: number;
  /** whether ANY schedule is user-entered (vs all archetype defaults) */
  userConfirmed: boolean;
  /** human-readable window list for disclosures, e.g. "Office: Mon–Fri 8–18 (70%)" */
  disclosure: string;
  schedules: ScheduleSpec[];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ------------------------------------------------------------------ */
/* Archetype defaults by buildingType                                   */
/* ------------------------------------------------------------------ */

const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Default schedule for a building type — single entry at 100% share. */
export function archetypeDefaultSchedules(buildingType: string | null): ScheduleSpec[] {
  const bt = (buildingType ?? "").toLowerCase();
  const mk = (name: string, kind: string, days: number[], startHour: number, endHour: number): ScheduleSpec[] => [
    { name, kind, days, startHour, endHour, months: null, usageSharePct: 100, source: "archetype_default" },
  ];
  if (/(house|home|residential|apartment|condo|mobile|single_family|multifamily|multi_family|duplex|townhome)/.test(bt)) {
    // Residential: occupied evenings + mornings + weekends; model as 6–9 & 17–23
    // simplified to a single 15h envelope (6–23 wouldn't reflect workday absence,
    // but residential after-hours savings logic differs anyway) — use 17–8 wrap
    // weekdays + all-day weekends? Keep it simple and honest: always-occupied.
    return mk("Home (always occupied)", "always_on", ALL_DAYS, 0, 24);
  }
  if (/(office|bank|medical office)/.test(bt)) return mk("Business hours", "business", WEEKDAYS, 8, 18);
  if (/(retail|store|shop|strip|mall)/.test(bt)) return mk("Store hours", "business", ALL_DAYS, 9, 21);
  if (/(restaurant|food)/.test(bt)) return mk("Service hours", "business", ALL_DAYS, 10, 22);
  if (/(warehouse|distribution|storage)/.test(bt)) return mk("Warehouse shift", "business", WEEKDAYS, 7, 19);
  if (/(manufactur|industrial|plant|factory)/.test(bt))
    return mk("Two-shift production", "production", [1, 2, 3, 4, 5, 6], 6, 22);
  if (/(school|education|university)/.test(bt)) return mk("School hours", "business", WEEKDAYS, 7, 17);
  if (/(hospital|clinic|care|hotel|motel|lodging|data center|datacenter)/.test(bt))
    return mk("24/7 operations", "always_on", ALL_DAYS, 0, 24);
  if (/(church|worship)/.test(bt)) return mk("Service days", "custom", [0, 3], 8, 14);
  // Unknown commercial default — matches the old single-shift assumption.
  return mk("Business hours (assumed)", "business", WEEKDAYS, 8, 18);
}

/* ------------------------------------------------------------------ */
/* Hours math                                                           */
/* ------------------------------------------------------------------ */

/** Occupied hours/week for one schedule (handles overnight wrap and 24h). */
export function hoursPerWeek(s: Pick<ScheduleSpec, "days" | "startHour" | "endHour">): number {
  const span =
    s.startHour === 0 && s.endHour === 24
      ? 24
      : s.endHour > s.startHour
        ? s.endHour - s.startHour
        : 24 - s.startHour + s.endHour; // overnight wrap
  return span * s.days.length;
}

/** Fraction of the year a schedule is active (seasonal months). */
function yearFraction(months: number[] | null): number {
  if (!months || months.length === 0 || months.length >= 12) return 1;
  return months.length / 12;
}

/**
 * Usage-share-weighted occupied/unoccupied hours per year.
 * Each schedule contributes its own occupied-hours figure weighted by its
 * usageSharePct; shares are normalized if they don't sum to 100 (fail-soft).
 */
export function computeHoursSummary(schedules: ScheduleSpec[]): HoursSummary {
  const list = schedules.length > 0 ? schedules : archetypeDefaultSchedules(null);
  const totalShare = list.reduce((a, s) => a + (Number.isFinite(s.usageSharePct) ? Math.max(s.usageSharePct, 0) : 0), 0);
  let occupied = 0;
  for (const s of list) {
    const weight = totalShare > 0 ? Math.max(s.usageSharePct, 0) / totalShare : 1 / list.length;
    const perYear = hoursPerWeek(s) * 52.18 * yearFraction(s.months);
    occupied += Math.min(perYear, 8760) * weight;
  }
  occupied = Math.min(Math.round(occupied), 8760);
  const disclosure = list
    .map((s) => {
      const days = formatDays(s.days);
      const hours = s.startHour === 0 && s.endHour === 24 ? "24h" : `${s.startHour}–${s.endHour}`;
      const season = s.months && s.months.length > 0 && s.months.length < 12 ? ` (${s.months.length} mo/yr)` : "";
      const share = list.length > 1 ? ` [${Math.round(s.usageSharePct)}% of usage]` : "";
      return `${s.name}: ${days} ${hours}${season}${share}`;
    })
    .join("; ");
  return {
    occupiedHoursPerYear: occupied,
    unoccupiedHoursPerYear: 8760 - occupied,
    userConfirmed: list.some((s) => s.source === "user"),
    disclosure,
    schedules: list,
  };
}

function formatDays(days: number[]): string {
  if (days.length === 7) return "every day";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "Mon–Fri";
  if (sorted.join(",") === "1,2,3,4,5,6") return "Mon–Sat";
  if (sorted.join(",") === "0,6") return "weekends";
  return sorted.map((d) => DAY_NAMES[d] ?? String(d)).join(",");
}

/* ------------------------------------------------------------------ */
/* DB access                                                            */
/* ------------------------------------------------------------------ */

function rowToSpec(r: SiteSchedule): ScheduleSpec {
  return {
    name: r.name,
    kind: r.kind,
    days: Array.isArray(r.days) ? (r.days as number[]) : [],
    startHour: r.startHour,
    endHour: r.endHour,
    months: Array.isArray(r.months) ? (r.months as number[]) : null,
    usageSharePct: r.usageSharePct,
    source: r.source === "archetype_default" ? "archetype_default" : "user",
  };
}

/**
 * Effective schedules for a site: user rows when present, else the archetype
 * default for its buildingType (never persisted — computed so buildingType
 * edits update the assumption automatically until the user takes over).
 */
export async function effectiveSchedules(siteId: number, buildingType: string | null): Promise<HoursSummary> {
  const db = await getDb();
  let rows: SiteSchedule[] = [];
  if (db) {
    try {
      rows = await db.select().from(siteSchedules).where(eq(siteSchedules.siteId, siteId));
    } catch {
      rows = []; // fail open to archetype default
    }
  }
  const specs = rows.length > 0 ? rows.map(rowToSpec) : archetypeDefaultSchedules(buildingType);
  return computeHoursSummary(specs);
}
