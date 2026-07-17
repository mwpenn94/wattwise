/* ---------------------------------------------------------------------------
 * National data foundation (user gap report, Jul 2026)
 *
 * Provides representative nationwide coverage so a user anywhere in the US
 * gets meaningful defaults instead of the AZ-launch snapshot:
 *   - STATE_PROFILES: one representative IOU per state + EIA-861 2024 average
 *     retail rates (¢/kWh) used to scale synthesized representative tariffs.
 *   - generateNationalTariffs(): 4 representative rates per state
 *     (res flat, res TOU, small-comm flat, comm TOU + demand). These are
 *     honestly labeled `source: "state_representative_synthesized"` — they are
 *     NOT filed tariffs. Freshness stays "urdb_stale" (closest enum value);
 *     every structure carries a disclosure note.
 *   - ZIP3_ZONE_OVERRIDES: ZIP3 → IECC zone for multi-zone states so climate
 *     inference is ZIP-accurate where a state spans several zones.
 *   - ZONE_STATIONS: one representative NOAA-normals station per IECC zone
 *     (1991–2020 monthly normals) so weather-normalized baselines resolve for
 *     every zone, not just AZ.
 *   - STATE_SUBREGION: state → dominant eGRID subregion default (ZIP3 rows
 *     remain the precise path).
 *
 * All numeric values are public-domain aggregates (EIA/NOAA/EPA) embedded as
 * constants; provenance is recorded in seeder_runs and in-row source fields.
 * ------------------------------------------------------------------------- */
import { ZIP3_ZONE } from "../../shared/wattwise";
import type { MonthNormal } from "./seedData";
import type { SeedTariff } from "./seedData";

/* ---------- per-state profile: utility + EIA 2024 avg retail rates ---------- */
export interface StateProfile {
  state: string;
  utilityName: string;
  /** EIA-861 2024 average retail price, ¢/kWh */
  resRateCents: number;
  commRateCents: number;
  /** dominant eGRID subregion */
  subregion: string;
  /** typical commercial demand charge $/kW for the region */
  demandPerKw: number;
}

export const STATE_PROFILES: StateProfile[] = [
  { state: "AL", utilityName: "Alabama Power Co", resRateCents: 14.9, commRateCents: 13.0, subregion: "SRSO", demandPerKw: 12 },
  { state: "AK", utilityName: "Chugach Electric Assn", resRateCents: 24.5, commRateCents: 21.0, subregion: "AKGD", demandPerKw: 14 },
  { state: "AZ", utilityName: "Arizona Public Service Co (APS)", resRateCents: 14.0, commRateCents: 11.5, subregion: "AZNM", demandPerKw: 17 },
  { state: "AR", utilityName: "Entergy Arkansas", resRateCents: 12.5, commRateCents: 10.5, subregion: "SRMV", demandPerKw: 11 },
  { state: "CA", utilityName: "Pacific Gas & Electric Co (PG&E)", resRateCents: 31.0, commRateCents: 26.0, subregion: "CAMX", demandPerKw: 22 },
  { state: "CO", utilityName: "Public Service Co of Colorado (Xcel)", resRateCents: 15.0, commRateCents: 12.0, subregion: "RMPA", demandPerKw: 16 },
  { state: "CT", utilityName: "Eversource Energy (CT)", resRateCents: 28.5, commRateCents: 22.5, subregion: "NEWE", demandPerKw: 18 },
  { state: "DE", utilityName: "Delmarva Power", resRateCents: 16.5, commRateCents: 12.5, subregion: "RFCE", demandPerKw: 13 },
  { state: "DC", utilityName: "Potomac Electric Power Co (Pepco)", resRateCents: 17.5, commRateCents: 14.0, subregion: "RFCE", demandPerKw: 14 },
  { state: "FL", utilityName: "Florida Power & Light Co (FPL)", resRateCents: 15.5, commRateCents: 11.5, subregion: "FRCC", demandPerKw: 12 },
  { state: "GA", utilityName: "Georgia Power Co", resRateCents: 14.5, commRateCents: 11.5, subregion: "SRSO", demandPerKw: 13 },
  { state: "HI", utilityName: "Hawaiian Electric Co (HECO)", resRateCents: 41.0, commRateCents: 37.0, subregion: "HIOA", demandPerKw: 25 },
  { state: "ID", utilityName: "Idaho Power Co", resRateCents: 11.0, commRateCents: 9.0, subregion: "NWPP", demandPerKw: 10 },
  { state: "IL", utilityName: "Commonwealth Edison Co (ComEd)", resRateCents: 16.0, commRateCents: 11.5, subregion: "RFCW", demandPerKw: 14 },
  { state: "IN", utilityName: "Duke Energy Indiana", resRateCents: 15.5, commRateCents: 12.5, subregion: "RFCW", demandPerKw: 13 },
  { state: "IA", utilityName: "MidAmerican Energy Co", resRateCents: 12.5, commRateCents: 9.5, subregion: "MROW", demandPerKw: 11 },
  { state: "KS", utilityName: "Evergy Kansas", resRateCents: 13.5, commRateCents: 11.0, subregion: "SPNO", demandPerKw: 12 },
  { state: "KY", utilityName: "Kentucky Utilities Co", resRateCents: 12.5, commRateCents: 11.0, subregion: "SRTV", demandPerKw: 11 },
  { state: "LA", utilityName: "Entergy Louisiana", resRateCents: 11.5, commRateCents: 10.0, subregion: "SRMV", demandPerKw: 10 },
  { state: "ME", utilityName: "Central Maine Power Co", resRateCents: 23.0, commRateCents: 17.5, subregion: "NEWE", demandPerKw: 15 },
  { state: "MD", utilityName: "Baltimore Gas & Electric Co (BGE)", resRateCents: 17.0, commRateCents: 13.0, subregion: "RFCE", demandPerKw: 13 },
  { state: "MA", utilityName: "Eversource Energy (MA)", resRateCents: 29.5, commRateCents: 21.5, subregion: "NEWE", demandPerKw: 19 },
  { state: "MI", utilityName: "DTE Electric Co", resRateCents: 18.5, commRateCents: 13.5, subregion: "RFCM", demandPerKw: 14 },
  { state: "MN", utilityName: "Xcel Energy (NSP-Minnesota)", resRateCents: 14.5, commRateCents: 11.5, subregion: "MROW", demandPerKw: 13 },
  { state: "MS", utilityName: "Mississippi Power Co", resRateCents: 13.5, commRateCents: 11.5, subregion: "SRMV", demandPerKw: 11 },
  { state: "MO", utilityName: "Ameren Missouri", resRateCents: 12.5, commRateCents: 9.5, subregion: "SRMW", demandPerKw: 11 },
  { state: "MT", utilityName: "NorthWestern Energy (MT)", resRateCents: 12.5, commRateCents: 11.0, subregion: "NWPP", demandPerKw: 11 },
  { state: "NE", utilityName: "Omaha Public Power District", resRateCents: 11.5, commRateCents: 9.5, subregion: "MROW", demandPerKw: 10 },
  { state: "NV", utilityName: "NV Energy", resRateCents: 14.5, commRateCents: 10.5, subregion: "NWPP", demandPerKw: 13 },
  { state: "NH", utilityName: "Eversource Energy (NH)", resRateCents: 25.5, commRateCents: 19.5, subregion: "NEWE", demandPerKw: 16 },
  { state: "NJ", utilityName: "Public Service Electric & Gas (PSE&G)", resRateCents: 18.5, commRateCents: 14.0, subregion: "RFCE", demandPerKw: 14 },
  { state: "NM", utilityName: "Public Service Co of New Mexico (PNM)", resRateCents: 14.0, commRateCents: 11.0, subregion: "AZNM", demandPerKw: 12 },
  { state: "NY", utilityName: "Consolidated Edison Co (ConEd)", resRateCents: 24.5, commRateCents: 19.0, subregion: "NYCW", demandPerKw: 20 },
  { state: "NC", utilityName: "Duke Energy Carolinas", resRateCents: 13.5, commRateCents: 10.0, subregion: "SRVC", demandPerKw: 12 },
  { state: "ND", utilityName: "Xcel Energy (NSP-North Dakota)", resRateCents: 11.5, commRateCents: 9.5, subregion: "MROW", demandPerKw: 10 },
  { state: "OH", utilityName: "Ohio Edison (FirstEnergy)", resRateCents: 15.5, commRateCents: 11.0, subregion: "RFCW", demandPerKw: 12 },
  { state: "OK", utilityName: "Oklahoma Gas & Electric Co (OG&E)", resRateCents: 12.0, commRateCents: 9.5, subregion: "SPSO", demandPerKw: 10 },
  { state: "OR", utilityName: "Portland General Electric Co", resRateCents: 14.5, commRateCents: 12.0, subregion: "NWPP", demandPerKw: 12 },
  { state: "PA", utilityName: "PECO Energy Co", resRateCents: 17.5, commRateCents: 12.5, subregion: "RFCE", demandPerKw: 13 },
  { state: "RI", utilityName: "Rhode Island Energy", resRateCents: 27.0, commRateCents: 20.5, subregion: "NEWE", demandPerKw: 17 },
  { state: "SC", utilityName: "Dominion Energy South Carolina", resRateCents: 14.5, commRateCents: 11.5, subregion: "SRVC", demandPerKw: 12 },
  { state: "SD", utilityName: "Black Hills Energy (SD)", resRateCents: 12.5, commRateCents: 10.5, subregion: "MROW", demandPerKw: 11 },
  { state: "TN", utilityName: "Nashville Electric Service (TVA)", resRateCents: 12.5, commRateCents: 11.5, subregion: "SRTV", demandPerKw: 11 },
  { state: "TX", utilityName: "Oncor Electric Delivery (TDU) / REP avg", resRateCents: 15.0, commRateCents: 10.5, subregion: "ERCT", demandPerKw: 12 },
  { state: "UT", utilityName: "Rocky Mountain Power (PacifiCorp)", resRateCents: 11.5, commRateCents: 9.5, subregion: "NWPP", demandPerKw: 11 },
  { state: "VT", utilityName: "Green Mountain Power Corp", resRateCents: 21.5, commRateCents: 17.5, subregion: "NEWE", demandPerKw: 15 },
  { state: "VA", utilityName: "Dominion Energy Virginia", resRateCents: 14.5, commRateCents: 10.0, subregion: "SRVC", demandPerKw: 12 },
  { state: "WA", utilityName: "Puget Sound Energy", resRateCents: 11.5, commRateCents: 10.5, subregion: "NWPP", demandPerKw: 11 },
  { state: "WV", utilityName: "Appalachian Power Co (WV)", resRateCents: 14.0, commRateCents: 11.5, subregion: "RFCW", demandPerKw: 12 },
  { state: "WI", utilityName: "We Energies (Wisconsin Electric)", resRateCents: 17.0, commRateCents: 13.0, subregion: "MROE", demandPerKw: 14 },
  { state: "WY", utilityName: "Rocky Mountain Power (WY)", resRateCents: 11.5, commRateCents: 10.0, subregion: "RMPA", demandPerKw: 10 },
];

export const STATE_SUBREGION: Record<string, string> = Object.fromEntries(
  STATE_PROFILES.map((p) => [p.state, p.subregion]),
);

export const STATE_UTILITY: Record<string, string> = Object.fromEntries(
  STATE_PROFILES.map((p) => [p.state, p.utilityName]),
);

/* ---------- representative tariff generation ---------- */
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SUMMER = [6, 7, 8, 9];
const NONSUMMER = [10, 11, 12, 1, 2, 3, 4, 5];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const REP_NOTE =
  "Representative rate synthesized from the state's EIA-861 average retail price and typical rate design. NOT a filed tariff — verify against your utility's current rate sheet before making decisions.";

/** Build 4 representative rates for one state, scaled so the blended average
 * approximates the EIA state average. TOU spread uses a typical 2.2:1
 * on/off-peak ratio with ~25% of energy on-peak (blend-preserving). */
export function generateStateTariffs(p: StateProfile): SeedTariff[] {
  const res = p.resRateCents / 100;
  const comm = p.commRateCents / 100;
  // Blend-preserving TOU split: 0.25*on + 0.75*off = avg, on = 2.2*off
  const offFactor = 1 / (0.25 * 2.2 + 0.75); // ≈ 0.7692
  const resOff = round4(res * offFactor);
  const resOn = round4(resOff * 2.2);
  const commOff = round4(comm * 0.85 * offFactor);
  const commOn = round4(commOff * 2.2);
  // Commercial TOU+demand: energy component lower because demand recovers ~30%
  const commEnergyShare = 0.7;
  const commDOff = round4(comm * commEnergyShare * offFactor);
  const commDOn = round4(commDOff * 2.2);
  const fixedRes = res > 0.2 ? 12 : 10;
  const fixedComm = 25;
  const mk = (kind: string, name: string, sector: SeedTariff["sector"], structure: Record<string, unknown>, peakKwMin: number | null = null, peakKwMax: number | null = null): SeedTariff => ({
    urdbId: `rep-${p.state.toLowerCase()}-${kind}`,
    utilityName: p.utilityName,
    name,
    sector,
    commodity: "electric",
    state: p.state,
    peakKwMin,
    peakKwMax,
    structure: { ...structure, notes: REP_NOTE } as unknown as SeedTariff["structure"],
    freshness: "urdb_stale",
    effectiveDate: "2026-01-01",
  });
  return [
    mk("res-flat", "Residential Standard (representative)", "residential", {
      fixedMonthly: fixedRes,
      energy: [{ label: "All hours", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: round4(res) }],
      demand: [],
    }),
    mk("res-tou", "Residential Time-of-Use 4-9pm (representative)", "residential", {
      fixedMonthly: fixedRes,
      energy: [
        { label: "On-Peak (4-9pm wkdy)", months: ALL_MONTHS, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 21, ratePerUnit: resOn },
        { label: "Off-Peak", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: resOff },
      ],
      demand: [],
    }),
    mk("comm-flat", "Small Commercial Standard (representative)", "commercial", {
      fixedMonthly: fixedComm,
      energy: [{ label: "All hours", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: round4(comm) }],
      demand: [],
    }, null, 50),
    mk("comm-tou-demand", "Commercial TOU + Demand (representative)", "commercial", {
      fixedMonthly: fixedComm * 2,
      energy: [
        { label: "On-Peak (12-8pm wkdy)", months: ALL_MONTHS, daysOfWeek: WEEKDAYS, hourStart: 12, hourEnd: 20, ratePerUnit: commDOn },
        { label: "Off-Peak", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: commDOff },
      ],
      demand: [
        { label: "Summer peak demand", months: SUMMER, hourStart: 12, hourEnd: 20, daysOfWeek: WEEKDAYS, ratePerKw: p.demandPerKw },
        { label: "Non-summer peak demand", months: NONSUMMER, hourStart: 12, hourEnd: 20, daysOfWeek: WEEKDAYS, ratePerKw: round4(p.demandPerKw * 0.7) },
      ],
    }, 20, null),
  ];
}

export function generateNationalTariffs(existingStates: Set<string>): SeedTariff[] {
  const out: SeedTariff[] = [];
  for (const p of STATE_PROFILES) {
    // AZ already has hand-modeled URDB-derived rates; keep those authoritative
    // but still add the commercial flat rep rate only if missing entirely.
    if (existingStates.has(p.state)) continue;
    out.push(...generateStateTariffs(p));
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/* ---------- ZIP3 → IECC zone overrides for multi-zone states ----------
 * Only ZIP3s whose zone differs from the state-dominant zone are listed.
 * State-dominant zone remains the fallback (STATE_ZONE in shared/wattwise).
 * Sources: IECC climate zone county maps (public domain, DOE/PNNL). */
/* ZIP3 zone overrides now live in shared/wattwise.ts (ZIP3_ZONE) so the
 * inference function and seeders share ONE table. Derived view kept for seeding. */
export const ZIP3_ZONE_OVERRIDES: Array<{ zip3: string; zone: string }> = Object.entries(ZIP3_ZONE).map(
  ([zip3, zone]) => ({ zip3, zone }),
);

/* ---------- one representative weather station per IECC zone ----------
 * NOAA 1991-2020 monthly normals [avgTempF, HDD65, CDD65, diurnalRange].
 * AZ stations (2B, 5B) already seeded — kept for state precision; these fill
 * the remaining zones. */
type MonthTuple = [number, number, number, number];
export const ZONE_STATIONS: Array<{
  stationId: string;
  stationName: string;
  climateZone: string;
  state: string;
  months: MonthTuple[];
}> = [
  { stationId: "PHMI", stationName: "Miami Intl AP", climateZone: "1A", state: "FL", months: [
    [68.9, 25, 146, 13], [70.8, 15, 178, 13], [73.8, 5, 262, 13], [77.6, 0, 378, 12], [81.2, 0, 502, 11], [83.7, 0, 561, 10],
    [84.9, 0, 617, 10], [85.0, 0, 620, 10], [83.7, 0, 561, 10], [80.5, 0, 481, 11], [75.4, 2, 312, 12], [71.4, 14, 198, 13] ] },
  { stationId: "KIAH", stationName: "Houston Intercontinental AP", climateZone: "2A", state: "TX", months: [
    [53.9, 349, 5, 18], [57.6, 240, 33, 18], [63.8, 121, 84, 18], [70.6, 30, 198, 17], [77.9, 2, 402, 16], [82.9, 0, 537, 15],
    [84.9, 0, 617, 15], [85.2, 0, 626, 16], [80.9, 0, 477, 16], [72.7, 22, 261, 17], [62.7, 128, 59, 18], [55.7, 295, 12, 18] ] },
  { stationId: "KATL", stationName: "Atlanta Hartsfield AP", climateZone: "3A", state: "GA", months: [
    [44.8, 626, 0, 17], [48.7, 456, 0, 18], [55.4, 305, 8, 19], [62.9, 121, 58, 20], [71.0, 25, 211, 19], [78.0, 0, 390, 18],
    [80.9, 0, 493, 17], [80.2, 0, 471, 17], [74.6, 5, 293, 18], [64.3, 88, 66, 20], [54.1, 327, 4, 19], [46.9, 561, 0, 17] ] },
  { stationId: "KLAS", stationName: "Las Vegas McCarran AP", climateZone: "3B", state: "NV", months: [
    [48.3, 518, 0, 20], [52.9, 339, 0, 21], [59.5, 194, 24, 22], [66.5, 62, 107, 23], [76.3, 5, 355, 24], [86.6, 0, 648, 24],
    [92.5, 0, 853, 22], [90.6, 0, 794, 22], [82.3, 0, 519, 23], [69.5, 30, 170, 23], [56.6, 258, 6, 21], [47.7, 536, 0, 20] ] },
  { stationId: "KSFO", stationName: "San Francisco Intl AP", climateZone: "3C", state: "CA", months: [
    [51.4, 422, 0, 12], [53.4, 328, 0, 13], [54.9, 313, 0, 14], [56.4, 258, 0, 15], [58.6, 199, 0, 15], [61.2, 122, 8, 16],
    [62.6, 87, 12, 15], [63.4, 68, 18, 15], [64.1, 60, 33, 16], [61.6, 116, 15, 15], [56.5, 255, 0, 13], [51.8, 409, 0, 12] ] },
  { stationId: "KBWI", stationName: "Baltimore-Washington Intl AP", climateZone: "4A", state: "MD", months: [
    [34.7, 939, 0, 17], [37.5, 770, 0, 18], [45.0, 620, 0, 19], [55.5, 293, 14, 20], [65.0, 84, 90, 20], [74.2, 5, 283, 19],
    [78.9, 0, 431, 18], [77.2, 0, 378, 18], [70.3, 20, 184, 19], [58.4, 219, 22, 20], [47.5, 525, 0, 18], [38.9, 809, 0, 17] ] },
  { stationId: "KABQ", stationName: "Albuquerque Intl Sunport", climateZone: "4B", state: "NM", months: [
    [37.1, 865, 0, 22], [42.3, 636, 0, 23], [49.4, 484, 0, 24], [57.4, 240, 12, 25], [67.0, 55, 117, 25], [76.6, 0, 348, 25],
    [79.7, 0, 456, 22], [77.4, 0, 384, 21], [70.5, 15, 180, 23], [58.3, 219, 15, 24], [45.9, 573, 0, 23], [36.8, 874, 0, 22] ] },
  { stationId: "KSEA", stationName: "Seattle-Tacoma Intl AP", climateZone: "4C", state: "WA", months: [
    [42.4, 700, 0, 10], [43.6, 599, 0, 12], [46.6, 570, 0, 14], [51.1, 417, 0, 16], [57.3, 240, 3, 18], [62.2, 111, 27, 19],
    [66.9, 40, 99, 20], [67.2, 33, 101, 19], [62.2, 111, 27, 18], [53.5, 357, 0, 14], [46.2, 564, 0, 11], [41.7, 722, 0, 10] ] },
  { stationId: "KORD", stationName: "Chicago O'Hare Intl AP", climateZone: "5A", state: "IL", months: [
    [24.8, 1246, 0, 15], [28.2, 1030, 0, 16], [38.0, 837, 0, 17], [49.3, 471, 6, 19], [59.9, 178, 55, 19], [70.2, 25, 181, 18],
    [75.2, 3, 319, 17], [73.7, 5, 275, 17], [66.4, 68, 110, 18], [54.2, 335, 8, 18], [41.4, 708, 0, 15], [29.6, 1097, 0, 14] ] },
  { stationId: "KDEN", stationName: "Denver Intl AP", climateZone: "5B", state: "CO", months: [
    [31.7, 1032, 0, 22], [33.8, 874, 0, 22], [41.4, 732, 0, 23], [48.9, 483, 0, 24], [58.6, 219, 21, 24], [69.0, 40, 160, 25],
    [75.4, 0, 322, 25], [73.4, 3, 264, 24], [64.8, 105, 99, 25], [51.5, 419, 5, 24], [39.7, 759, 0, 22], [31.2, 1048, 0, 21] ] },
  { stationId: "KMSP", stationName: "Minneapolis-St Paul Intl AP", climateZone: "6A", state: "MN", months: [
    [15.9, 1522, 0, 15], [20.3, 1252, 0, 16], [32.4, 1011, 0, 17], [46.9, 543, 3, 19], [59.2, 199, 46, 19], [69.3, 30, 159, 18],
    [74.2, 3, 288, 17], [71.9, 8, 221, 17], [63.4, 122, 74, 18], [49.7, 474, 3, 17], [34.9, 903, 0, 14], [21.2, 1358, 0, 13] ] },
  { stationId: "KBIL", stationName: "Billings Logan Intl AP", climateZone: "6B", state: "MT", months: [
    [27.0, 1178, 0, 18], [29.8, 986, 0, 18], [38.8, 812, 0, 19], [46.5, 555, 0, 20], [56.3, 275, 6, 21], [65.8, 62, 86, 22],
    [74.0, 3, 282, 24], [72.4, 8, 238, 24], [61.7, 145, 46, 23], [49.5, 481, 0, 20], [37.4, 828, 0, 18], [27.8, 1153, 0, 17] ] },
  { stationId: "KDLH", stationName: "Duluth Intl AP", climateZone: "7", state: "MN", months: [
    [10.4, 1693, 0, 16], [14.6, 1411, 0, 17], [26.4, 1197, 0, 17], [40.5, 735, 0, 18], [52.6, 384, 8, 19], [61.9, 132, 39, 18],
    [67.4, 40, 115, 17], [65.9, 55, 84, 17], [57.5, 240, 12, 17], [45.4, 608, 0, 15], [30.7, 1029, 0, 13], [16.5, 1504, 0, 13] ] },
  { stationId: "PAFA", stationName: "Fairbanks Intl AP", climateZone: "8", state: "AK", months: [
    [-7.9, 2260, 0, 15], [1.1, 1789, 0, 17], [12.4, 1631, 0, 20], [33.2, 954, 0, 20], [50.5, 450, 0, 20], [61.7, 130, 33, 19],
    [63.4, 90, 40, 17], [57.6, 235, 6, 16], [46.4, 558, 0, 15], [26.7, 1187, 0, 14], [4.8, 1806, 0, 14], [-3.6, 2126, 0, 14] ] },
];

export function zoneStationNormals(months: MonthTuple[]): MonthNormal[] {
  return months.map((m, i) => ({ month: i + 1, avgTempF: m[0], hddBase65: m[1], cddBase65: m[2], diurnalRangeF: m[3] }));
}
