/**
 * Bundled seed assets (Cycle 5 requirement: archetype fallback + reference data
 * ship in-repo so first-run analyses make zero blocking external calls).
 *
 * Sources & licenses (recorded in seeder_runs):
 * - eGRID 2022 subregion CO2e rates — EPA, public domain.
 * - ENERGY STAR / CBECS 2018 / RECS 2020 median EUIs — EIA/EPA, public domain.
 * - NOAA 1991–2020 climate normals (PHX/TUS/HII/IGM stations) — NOAA, public domain.
 * - Tariff structures modeled on published APS/SRP/TEP rate schedules (urdb_stale
 *   freshness — "verify against your bill" flag mandatory).
 * - Archetype shapes: DOE prototype building synthesis, labeled "prototype-archetype".
 */

import type { TariffStructure } from "../../shared/wattwise";

export const SEED_VERSION = "2026.07.6"; // National gas/water representative rates (state-average imputed, territory-aligned LDC names)

/* ================= eGRID subregion factors (lb CO2e / MWh, eGRID2022) ========= */
export const EGRID_FACTORS: Array<{
  subregion: string;
  subregionName: string;
  co2eLbPerMwh: number;
  year: number;
}> = [
  { subregion: "AZNM", subregionName: "WECC Southwest", co2eLbPerMwh: 727.9, year: 2022 },
  { subregion: "CAMX", subregionName: "WECC California", co2eLbPerMwh: 497.4, year: 2022 },
  { subregion: "ERCT", subregionName: "ERCOT All", co2eLbPerMwh: 771.1, year: 2022 },
  { subregion: "RMPA", subregionName: "WECC Rockies", co2eLbPerMwh: 1035.9, year: 2022 },
  { subregion: "NWPP", subregionName: "WECC Northwest", co2eLbPerMwh: 605.5, year: 2022 },
  { subregion: "SRSO", subregionName: "SERC South", co2eLbPerMwh: 823.6, year: 2022 },
  { subregion: "NYCW", subregionName: "NPCC NYC/Westchester", co2eLbPerMwh: 571.5, year: 2022 },
  { subregion: "RFCE", subregionName: "RFC East", co2eLbPerMwh: 655.4, year: 2022 },
];

/** zip3 → subregion for launch territories (AZ + neighbors). */
export const ZIP3_SUBREGIONS: Array<{ zip3: string; state: string; subregion: string }> = [
  { zip3: "850", state: "AZ", subregion: "AZNM" },
  { zip3: "851", state: "AZ", subregion: "AZNM" },
  { zip3: "852", state: "AZ", subregion: "AZNM" },
  { zip3: "853", state: "AZ", subregion: "AZNM" },
  { zip3: "855", state: "AZ", subregion: "AZNM" },
  { zip3: "856", state: "AZ", subregion: "AZNM" },
  { zip3: "857", state: "AZ", subregion: "AZNM" },
  { zip3: "859", state: "AZ", subregion: "AZNM" },
  { zip3: "860", state: "AZ", subregion: "AZNM" },
  { zip3: "863", state: "AZ", subregion: "AZNM" },
  { zip3: "864", state: "AZ", subregion: "AZNM" }, // Lake Havasu / Kingman
  { zip3: "865", state: "AZ", subregion: "AZNM" },
  { zip3: "870", state: "NM", subregion: "AZNM" },
  { zip3: "871", state: "NM", subregion: "AZNM" },
  { zip3: "874", state: "NM", subregion: "AZNM" },
  { zip3: "875", state: "NM", subregion: "AZNM" },
  { zip3: "880", state: "NM", subregion: "AZNM" },
  { zip3: "890", state: "NV", subregion: "NWPP" },
  { zip3: "891", state: "NV", subregion: "NWPP" },
  { zip3: "900", state: "CA", subregion: "CAMX" },
  { zip3: "921", state: "CA", subregion: "CAMX" },
  { zip3: "750", state: "TX", subregion: "ERCT" },
  { zip3: "770", state: "TX", subregion: "ERCT" },
];

/* ================= EUI benchmarks (kBtu/sqft/yr site energy) ================== */
export const EUI_BENCHMARKS: Array<{
  buildingType: string;
  sectorClass: "residential" | "commercial";
  commodity: "electric" | "gas" | "water" | "site_total";
  medianEui: number;
  p25Eui: number;
  p75Eui: number;
  unit: string;
  source: string;
}> = [
  { buildingType: "office", sectorClass: "commercial", commodity: "site_total", medianEui: 52.9, p25Eui: 34.7, p75Eui: 77.8, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "office", sectorClass: "commercial", commodity: "electric", medianEui: 10.4, p25Eui: 6.8, p75Eui: 15.3, unit: "kWh/sqft/yr", source: "CBECS 2018" },
  { buildingType: "retail", sectorClass: "commercial", commodity: "site_total", medianEui: 51.2, p25Eui: 30.1, p75Eui: 84.3, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "retail", sectorClass: "commercial", commodity: "electric", medianEui: 11.8, p25Eui: 7.0, p75Eui: 18.9, unit: "kWh/sqft/yr", source: "CBECS 2018" },
  { buildingType: "warehouse", sectorClass: "commercial", commodity: "site_total", medianEui: 22.7, p25Eui: 11.7, p75Eui: 45.1, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "warehouse", sectorClass: "commercial", commodity: "electric", medianEui: 4.8, p25Eui: 2.3, p75Eui: 9.7, unit: "kWh/sqft/yr", source: "CBECS 2018" },
  { buildingType: "manufacturing", sectorClass: "commercial", commodity: "site_total", medianEui: 95.1, p25Eui: 45.0, p75Eui: 190.0, unit: "kBtu/sqft/yr", source: "MECS 2018 (approx)" },
  { buildingType: "manufacturing", sectorClass: "commercial", commodity: "electric", medianEui: 19.1, p25Eui: 8.9, p75Eui: 38.5, unit: "kWh/sqft/yr", source: "MECS 2018 (approx)" },
  { buildingType: "school", sectorClass: "commercial", commodity: "site_total", medianEui: 48.9, p25Eui: 33.2, p75Eui: 71.0, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "hospital", sectorClass: "commercial", commodity: "site_total", medianEui: 234.3, p25Eui: 178.0, p75Eui: 306.0, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "hotel", sectorClass: "commercial", commodity: "site_total", medianEui: 63.0, p25Eui: 43.6, p75Eui: 91.0, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "grocery", sectorClass: "commercial", commodity: "site_total", medianEui: 196.0, p25Eui: 141.0, p75Eui: 262.0, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "restaurant", sectorClass: "commercial", commodity: "site_total", medianEui: 223.8, p25Eui: 130.7, p75Eui: 351.6, unit: "kBtu/sqft/yr", source: "CBECS 2018" },
  { buildingType: "municipal", sectorClass: "commercial", commodity: "site_total", medianEui: 55.0, p25Eui: 35.0, p75Eui: 85.0, unit: "kBtu/sqft/yr", source: "CBECS 2018 (public assembly proxy)" },
  { buildingType: "single_family", sectorClass: "residential", commodity: "site_total", medianEui: 42.1, p25Eui: 27.0, p75Eui: 62.0, unit: "kBtu/sqft/yr", source: "RECS 2020" },
  { buildingType: "single_family", sectorClass: "residential", commodity: "electric", medianEui: 5.6, p25Eui: 3.4, p75Eui: 8.7, unit: "kWh/sqft/yr", source: "RECS 2020" },
  { buildingType: "multifamily", sectorClass: "residential", commodity: "site_total", medianEui: 49.5, p25Eui: 31.0, p75Eui: 74.0, unit: "kBtu/sqft/yr", source: "RECS 2020" },
  { buildingType: "office", sectorClass: "commercial", commodity: "gas", medianEui: 0.212, p25Eui: 0.1, p75Eui: 0.38, unit: "therms/sqft/yr", source: "CBECS 2018 (natural gas EUI 21.2 kBtu/sqft ÷ 100 kBtu/therm)" },
  { buildingType: "retail", sectorClass: "commercial", commodity: "gas", medianEui: 0.175, p25Eui: 0.08, p75Eui: 0.33, unit: "therms/sqft/yr", source: "CBECS 2018 (natural gas EUI ÷ 100 kBtu/therm)" },
  { buildingType: "single_family", sectorClass: "residential", commodity: "gas", medianEui: 0.22, p25Eui: 0.1, p75Eui: 0.38, unit: "therms/sqft/yr", source: "RECS 2020 (gas households ÷ 100 kBtu/therm)" },
  { buildingType: "office", sectorClass: "commercial", commodity: "water", medianEui: 14.5, p25Eui: 8.0, p75Eui: 24.0, unit: "gal/sqft/yr", source: "EPA WaterSense (approx)" },
  { buildingType: "single_family", sectorClass: "residential", commodity: "water", medianEui: 35.0, p25Eui: 22.0, p75Eui: 55.0, unit: "gal/sqft/yr", source: "EPA WaterSense (approx)" },
];

/* ================= Weather normals (NOAA 1991–2020) =========================== */
/** Monthly {hddBase65, cddBase65, avgTempF}; TMY hourly synthesized from
 *  monthly normals + diurnal ranges (labeled accordingly in provenance). */
export interface MonthNormal { month: number; hddBase65: number; cddBase65: number; avgTempF: number; diurnalRangeF: number }

function mn(vals: Array<[number, number, number, number]>): MonthNormal[] {
  return vals.map(([avgTempF, hdd, cdd, diurnal], i) => ({
    month: i + 1,
    avgTempF,
    hddBase65: hdd,
    cddBase65: cdd,
    diurnalRangeF: diurnal,
  }));
}

export const WEATHER_STATIONS_FULL: Array<{
  stationId: string;
  stationName: string;
  climateZone: string;
  state: string;
  monthlyNormals: MonthNormal[];
}> = [
  {
    stationId: "KPHX",
    stationName: "Phoenix Sky Harbor Intl AP",
    climateZone: "2B",
    state: "AZ",
    // [avgTempF, HDD65, CDD65, diurnalRange]
    monthlyNormals: mn([
      [57.3, 248, 10, 22],
      [60.8, 155, 37, 22],
      [66.2, 78, 115, 23],
      [73.6, 12, 270, 24],
      [83.1, 0, 561, 25],
      [92.6, 0, 828, 24],
      [95.8, 0, 955, 21],
      [94.5, 0, 915, 20],
      [89.4, 0, 732, 22],
      [77.5, 3, 390, 24],
      [65.1, 63, 66, 23],
      [56.6, 264, 4, 22],
    ]),
  },
  {
    stationId: "KTUS",
    stationName: "Tucson Intl AP",
    climateZone: "2B",
    state: "AZ",
    monthlyNormals: mn([
      [53.9, 348, 4, 26],
      [56.9, 245, 16, 26],
      [61.9, 137, 55, 27],
      [68.9, 32, 154, 28],
      [77.8, 1, 400, 29],
      [87.4, 0, 672, 28],
      [88.4, 0, 725, 23],
      [86.8, 0, 676, 22],
      [83.0, 0, 546, 24],
      [72.3, 12, 244, 27],
      [61.4, 132, 30, 27],
      [53.5, 360, 2, 26],
    ]),
  },
  {
    stationId: "KHII",
    stationName: "Lake Havasu City AP",
    climateZone: "2B",
    state: "AZ",
    monthlyNormals: mn([
      [56.5, 271, 8, 24],
      [60.5, 168, 42, 24],
      [66.8, 76, 132, 25],
      [74.6, 8, 296, 26],
      [84.3, 0, 598, 27],
      [94.0, 0, 870, 26],
      [98.3, 0, 1032, 23],
      [97.2, 0, 998, 22],
      [90.6, 0, 768, 24],
      [77.9, 2, 402, 26],
      [64.9, 74, 71, 25],
      [55.9, 287, 5, 24],
    ]),
  },
  {
    stationId: "KIGM",
    stationName: "Kingman AP",
    climateZone: "3B",
    state: "AZ",
    monthlyNormals: mn([
      [45.6, 601, 0, 26],
      [48.9, 451, 0, 26],
      [54.6, 322, 6, 27],
      [61.4, 138, 30, 28],
      [70.7, 25, 202, 29],
      [80.5, 0, 465, 28],
      [85.0, 0, 620, 24],
      [83.3, 0, 567, 23],
      [76.7, 3, 354, 25],
      [64.6, 92, 79, 27],
      [53.4, 348, 1, 26],
      [45.1, 616, 0, 26],
    ]),
  },
  {
    stationId: "KFLG",
    stationName: "Flagstaff Pulliam AP",
    climateZone: "5B",
    state: "AZ",
    monthlyNormals: mn([
      [31.4, 1042, 0, 25],
      [33.5, 882, 0, 26],
      [38.7, 815, 0, 27],
      [44.8, 606, 0, 29],
      [53.4, 363, 4, 31],
      [63.3, 110, 59, 32],
      [67.4, 32, 107, 26],
      [65.6, 51, 71, 25],
      [59.7, 172, 13, 27],
      [49.0, 496, 0, 28],
      [39.0, 780, 0, 26],
      [31.5, 1039, 0, 25],
    ]),
  },
];

/** Synthesize a TMY-like 8760 hourly dry-bulb series from monthly normals +
 *  diurnal range (sinusoidal day cycle, min at 5am, max at 4pm).
 *  Provenance label: "synthesized-from-normals" — used for degree-hour math,
 *  clearly below true TMY fidelity and labeled as such. */
// NOTE: always generates an 8760-hour (365-day) series on the "normal-year basis"
// convention — leap days are intentionally not modeled; annual figures are
// normal-year totals, matching the LABEL_NORMAL_YEAR disclosure downstream.
export function synthesizeTmyHourly(normals: MonthNormal[]): number[] {
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const out: number[] = [];
  for (let m = 0; m < 12; m++) {
    const { avgTempF, diurnalRangeF } = normals[m];
    for (let d = 0; d < daysInMonth[m]; d++) {
      for (let h = 0; h < 24; h++) {
        // sinusoid: min at 5:00, max at 16:00
        const phase = ((h - 5 + 24) % 24) / 24;
        const temp = avgTempF + (diurnalRangeF / 2) * Math.sin(Math.PI * (2 * phase - 0.5));
        out.push(Math.round(temp * 10) / 10);
      }
    }
  }
  return out; // 8760
}

/* ================= Tariffs (APS / SRP / TEP + gas + water) ==================== */

export interface SeedTariff {
  urdbId: string | null;
  utilityName: string;
  name: string;
  sector: "residential" | "commercial" | "industrial" | "lighting";
  commodity: "electric" | "gas" | "water";
  state: string;
  peakKwMin: number | null;
  peakKwMax: number | null;
  structure: TariffStructure;
  freshness: "urdb_stale";
  effectiveDate: string;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SUMMER = [5, 6, 7, 8, 9, 10];
const WINTER = [11, 12, 1, 2, 3, 4];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export const SEED_TARIFFS: SeedTariff[] = [
  /* -------------------- APS (Arizona Public Service) -------------------- */
  {
    urdbId: "aps-r-tou-4pm7pm",
    utilityName: "Arizona Public Service Co (APS)",
    name: "Residential TOU 4pm-7pm Weekdays (Saver Choice)",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 13.0,
      energy: [
        { label: "On-Peak (4-7pm wkdy)", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.3237 },
        { label: "Off-Peak Summer", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1173 },
        { label: "On-Peak Winter (4-7pm wkdy)", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.2405 },
        { label: "Off-Peak Winter", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1103 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0665, notes: "APS RCP export rate; steps down ~10%/yr for new customers" },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "aps-r-tou-demand",
    utilityName: "Arizona Public Service Co (APS)",
    name: "Residential TOU + Demand (Saver Choice Max)",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 13.0,
      energy: [
        { label: "On-Peak (4-7pm wkdy)", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.089 },
        { label: "Off-Peak Summer", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0743 },
        { label: "On-Peak Winter", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.0855 },
        { label: "Off-Peak Winter", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0731 },
      ],
      demand: [
        { label: "Summer on-peak demand", months: SUMMER, hourStart: 16, hourEnd: 19, daysOfWeek: WEEKDAYS, ratePerKw: 17.44 },
        { label: "Winter on-peak demand", months: WINTER, hourStart: 16, hourEnd: 19, daysOfWeek: WEEKDAYS, ratePerKw: 12.24 },
      ],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0665 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "aps-e32-m",
    utilityName: "Arizona Public Service Co (APS)",
    name: "E-32 M General Service Medium (21-100 kW)",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 21,
    peakKwMax: 100,
    structure: {
      fixedMonthly: 32.0,
      energy: [
        { label: "Summer energy", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.09314 },
        { label: "Winter energy", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.08498 },
      ],
      demand: [
        { label: "Summer demand", months: SUMMER, ratePerKw: 14.577 },
        { label: "Winter demand", months: WINTER, ratePerKw: 10.813 },
      ],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0665 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "aps-e32-l",
    utilityName: "Arizona Public Service Co (APS)",
    name: "E-32 L General Service Large (101-400 kW) w/ 80% ratchet",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 101,
    peakKwMax: 400,
    structure: {
      fixedMonthly: 60.0,
      energy: [
        { label: "Summer energy", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.07213 },
        { label: "Winter energy", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.06301 },
      ],
      demand: [
        { label: "Summer demand", months: SUMMER, ratePerKw: 18.481 },
        { label: "Winter demand", months: WINTER, ratePerKw: 13.276 },
      ],
      ratchet: { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" },
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0665 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "aps-e34",
    utilityName: "Arizona Public Service Co (APS)",
    name: "E-34 General Service Extra Large (>400 kW) w/ 80% ratchet",
    sector: "industrial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 401,
    peakKwMax: null,
    structure: {
      fixedMonthly: 250.0,
      energy: [
        { label: "Summer on-peak 4-7pm wkdy", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.06522 },
        { label: "Summer off-peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.04982 },
        { label: "Winter on-peak 4-7pm wkdy", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 16, hourEnd: 19, ratePerUnit: 0.05877 },
        { label: "Winter off-peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.04516 },
      ],
      demand: [
        { label: "Summer demand", months: SUMMER, ratePerKw: 16.294 },
        { label: "Winter demand", months: WINTER, ratePerKw: 11.641 },
      ],
      ratchet: { lookbackMonths: 11, ratchetPct: 0.8, applicablePeriod: "all" },
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0665 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  /* -------------------- SRP (Salt River Project) -------------------- */
  {
    urdbId: "srp-e23",
    utilityName: "Salt River Project (SRP)",
    name: "E-23 Residential Basic",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 20.0,
      energy: [
        { label: "Summer (May-Oct)", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1265 },
        { label: "Winter", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1029 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0281, notes: "SRP average annual export credit (E-27 P customer generation); well below retail" },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-11-01",
  },
  {
    urdbId: "srp-e26-tou",
    utilityName: "Salt River Project (SRP)",
    name: "E-26 Residential TOU (3-6pm peak)",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 20.0,
      energy: [
        { label: "Summer On-Peak 3-6pm wkdy", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 15, hourEnd: 18, ratePerUnit: 0.2941 },
        { label: "Summer Off-Peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0916 },
        { label: "Winter On-Peak", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 15, hourEnd: 18, ratePerUnit: 0.1479 },
        { label: "Winter Off-Peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0796 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0281 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-11-01",
  },
  {
    urdbId: "srp-e36-genl",
    utilityName: "Salt River Project (SRP)",
    name: "E-36 General Service TOU (Commercial) w/ demand",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: 300,
    structure: {
      fixedMonthly: 45.0,
      energy: [
        { label: "Summer On-Peak 2-8pm wkdy", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, ratePerUnit: 0.0919 },
        { label: "Summer Off-Peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0577 },
        { label: "Winter On-Peak 5-9am wkdy", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, ratePerUnit: 0.0721 },
        { label: "Winter On-Peak 5-9pm wkdy", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, ratePerUnit: 0.0721 },
        { label: "Winter Off-Peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0533 },
      ],
      demand: [
        { label: "Summer on-peak demand", months: SUMMER, hourStart: 14, hourEnd: 20, daysOfWeek: WEEKDAYS, ratePerKw: 21.86 },
        // SRP E-36 winter has TWO on-peak windows (5-9am and 5-9pm weekdays); the billed
        // winter demand is the max kW across BOTH windows at a single rate. Both windows
        // are enumerated so the window scan captures morning-peaking loads.
        { label: "Winter on-peak demand 5-9am", months: WINTER, hourStart: 5, hourEnd: 9, daysOfWeek: WEEKDAYS, ratePerKw: 14.33, demandGroup: "e36-winter" },
        { label: "Winter on-peak demand 5-9pm", months: WINTER, hourStart: 17, hourEnd: 21, daysOfWeek: WEEKDAYS, ratePerKw: 14.33, demandGroup: "e36-winter" },
      ],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0281 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-11-01",
  },
  {
    urdbId: "srp-e65-cpp",
    utilityName: "Salt River Project (SRP)",
    name: "E-65 Large General Service w/ CP demand (proxy-priced)",
    sector: "industrial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 300,
    peakKwMax: null,
    structure: {
      fixedMonthly: 250.0,
      energy: [
        { label: "Summer energy", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0552 },
        { label: "Winter energy", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0489 },
      ],
      demand: [
        { label: "Billing demand", months: ALL_MONTHS, ratePerKw: 9.47 },
      ],
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all" },
      cp: { topN: 4, peakSeasonMonths: [6, 7, 8, 9], ratePerKw: 4.12 },
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0281 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-11-01",
  },
  /* -------------------- TEP (Tucson Electric Power) -------------------- */
  {
    urdbId: "tep-res-basic",
    utilityName: "Tucson Electric Power (TEP)",
    name: "Residential Basic",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 13.0,
      energy: [
        { label: "Summer", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1288 },
        { label: "Winter", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1173 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0562, notes: "TEP RCP export rate" },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-09-01",
  },
  {
    urdbId: "tep-lgs-14",
    utilityName: "Tucson Electric Power (TEP)",
    name: "LGS-14 Large General Service w/ 85% ratchet",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 200,
    peakKwMax: null,
    structure: {
      fixedMonthly: 190.0,
      energy: [
        { label: "Summer energy", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0631 },
        { label: "Winter energy", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0576 },
      ],
      demand: [
        { label: "Billing demand", months: ALL_MONTHS, ratePerKw: 16.12 },
      ],
      ratchet: { lookbackMonths: 11, ratchetPct: 0.85, applicablePeriod: "all" },
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0562 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-09-01",
  },
  /* -------------------- UniSource / Lake Havasu territory ---------------- */
  {
    urdbId: "uns-lgs",
    utilityName: "UniSource Energy Services (UNS Electric)",
    name: "Large General Service (Mohave/Santa Cruz) w/ demand",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: 100,
    peakKwMax: null,
    structure: {
      fixedMonthly: 150.0,
      energy: [
        { label: "All energy", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.0782 },
      ],
      demand: [
        { label: "Billing demand", months: ALL_MONTHS, ratePerKw: 13.55 },
      ],
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all" },
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0581 },
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-06-01",
  },
  /* -------------------- Gas & water (commodity-generality proof) --------- */
  {
    urdbId: null,
    utilityName: "Southwest Gas",
    name: "G-5 Residential Gas Service",
    sector: "residential",
    commodity: "gas",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 12.7,
      energy: [
        { label: "All gas", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 1.1245 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-01-01",
  },
  {
    urdbId: null,
    utilityName: "City of Phoenix Water Services",
    name: "Municipal Water — Commercial",
    sector: "commercial",
    commodity: "water",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 35.0,
      energy: [
        // Unit semantics: the cost engine multiplies ratePerUnit by usage in the
        // METER'S unit (gallons for water) — the published $5.19/kgal rate is
        // therefore stored per-gallon so a gallons meter prices correctly.
        { label: "Volumetric ($5.19/kgal, priced per gallon)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.00519 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2024-10-01",
  },
];

/* ================= Archetype 8760 shapes ("prototype-archetype") ============= */

/**
 * DOE-prototype-style synthetic load shapes. Each generator produces a
 * normalized 8760 (sums to 1.0) shaped by schedule + weather sensitivity
 * using the station TMY series. Labeled "prototype-archetype" per handoff —
 * NOT OEDI EULP empirical shapes (network fetch not available at build time;
 * fallback path exercised, which the handoff explicitly requires to work).
 */
export interface ArchetypeSpec {
  buildingType: string;
  sectorClass: "residential" | "commercial";
  vintageBand: string;
  sizeBandSqft: string;
  annualKwhPerSqft: number;
  peakWPerSqft: number;
  endUseFractions: Record<string, number>;
  calibMinSqft: number;
  calibMaxSqft: number;
  schedule: { occupiedStart: number; occupiedEnd: number; weekendFactor: number; baseloadFrac: number; coolingSlope: number; heatingSlope: number };
}

export const ARCHETYPE_SPECS: ArchetypeSpec[] = [
  {
    buildingType: "office",
    sectorClass: "commercial",
    vintageBand: "pre_2000",
    sizeBandSqft: "10k_100k",
    annualKwhPerSqft: 14.2,
    peakWPerSqft: 4.4,
    endUseFractions: { cooling: 0.31, heating: 0.05, lighting: 0.22, plug: 0.26, dhw: 0.03, other: 0.13 },
    calibMinSqft: 5000,
    calibMaxSqft: 200000,
    schedule: { occupiedStart: 7, occupiedEnd: 19, weekendFactor: 0.35, baseloadFrac: 0.3, coolingSlope: 0.045, heatingSlope: 0.012 },
  },
  {
    buildingType: "office",
    sectorClass: "commercial",
    vintageBand: "post_2000",
    sizeBandSqft: "10k_100k",
    annualKwhPerSqft: 11.6,
    peakWPerSqft: 3.8,
    endUseFractions: { cooling: 0.33, heating: 0.04, lighting: 0.17, plug: 0.3, dhw: 0.03, other: 0.13 },
    calibMinSqft: 5000,
    calibMaxSqft: 250000,
    schedule: { occupiedStart: 7, occupiedEnd: 19, weekendFactor: 0.3, baseloadFrac: 0.28, coolingSlope: 0.042, heatingSlope: 0.01 },
  },
  {
    buildingType: "retail",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "5k_50k",
    annualKwhPerSqft: 13.1,
    peakWPerSqft: 4.1,
    endUseFractions: { cooling: 0.35, heating: 0.04, lighting: 0.3, plug: 0.16, dhw: 0.02, other: 0.13 },
    calibMinSqft: 2000,
    calibMaxSqft: 120000,
    schedule: { occupiedStart: 9, occupiedEnd: 21, weekendFactor: 0.95, baseloadFrac: 0.25, coolingSlope: 0.048, heatingSlope: 0.01 },
  },
  {
    buildingType: "warehouse",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "20k_500k",
    annualKwhPerSqft: 5.3,
    peakWPerSqft: 1.9,
    endUseFractions: { cooling: 0.18, heating: 0.08, lighting: 0.38, plug: 0.2, dhw: 0.01, other: 0.15 },
    calibMinSqft: 10000,
    calibMaxSqft: 800000,
    schedule: { occupiedStart: 6, occupiedEnd: 18, weekendFactor: 0.4, baseloadFrac: 0.35, coolingSlope: 0.02, heatingSlope: 0.015 },
  },
  {
    buildingType: "manufacturing",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "20k_500k",
    annualKwhPerSqft: 21.5,
    peakWPerSqft: 5.6,
    endUseFractions: { cooling: 0.14, heating: 0.04, lighting: 0.16, plug: 0.52, dhw: 0.02, other: 0.12 },
    calibMinSqft: 10000,
    calibMaxSqft: 600000,
    schedule: { occupiedStart: 6, occupiedEnd: 22, weekendFactor: 0.55, baseloadFrac: 0.45, coolingSlope: 0.022, heatingSlope: 0.01 },
  },
  {
    buildingType: "school",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "20k_200k",
    annualKwhPerSqft: 9.8,
    peakWPerSqft: 3.4,
    endUseFractions: { cooling: 0.32, heating: 0.07, lighting: 0.24, plug: 0.22, dhw: 0.04, other: 0.11 },
    calibMinSqft: 8000,
    calibMaxSqft: 300000,
    schedule: { occupiedStart: 7, occupiedEnd: 16, weekendFactor: 0.15, baseloadFrac: 0.22, coolingSlope: 0.04, heatingSlope: 0.014 },
  },
  {
    buildingType: "grocery",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "10k_80k",
    annualKwhPerSqft: 48.0,
    peakWPerSqft: 8.8,
    endUseFractions: { cooling: 0.22, heating: 0.02, lighting: 0.18, plug: 0.45, dhw: 0.02, other: 0.11 },
    calibMinSqft: 5000,
    calibMaxSqft: 150000,
    schedule: { occupiedStart: 6, occupiedEnd: 23, weekendFactor: 1.0, baseloadFrac: 0.62, coolingSlope: 0.03, heatingSlope: 0.005 },
  },
  {
    buildingType: "restaurant",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "1k_10k",
    annualKwhPerSqft: 44.0,
    peakWPerSqft: 9.5,
    endUseFractions: { cooling: 0.26, heating: 0.03, lighting: 0.1, plug: 0.5, dhw: 0.06, other: 0.05 },
    calibMinSqft: 800,
    calibMaxSqft: 20000,
    schedule: { occupiedStart: 10, occupiedEnd: 23, weekendFactor: 1.1, baseloadFrac: 0.4, coolingSlope: 0.035, heatingSlope: 0.008 },
  },
  {
    buildingType: "municipal",
    sectorClass: "commercial",
    vintageBand: "all",
    sizeBandSqft: "5k_100k",
    annualKwhPerSqft: 12.0,
    peakWPerSqft: 3.9,
    endUseFractions: { cooling: 0.3, heating: 0.06, lighting: 0.22, plug: 0.24, dhw: 0.03, other: 0.15 },
    calibMinSqft: 2000,
    calibMaxSqft: 250000,
    schedule: { occupiedStart: 7, occupiedEnd: 18, weekendFactor: 0.3, baseloadFrac: 0.3, coolingSlope: 0.04, heatingSlope: 0.013 },
  },
  {
    buildingType: "single_family",
    sectorClass: "residential",
    vintageBand: "pre_2000",
    sizeBandSqft: "1k_4k",
    annualKwhPerSqft: 6.4,
    peakWPerSqft: 2.4,
    endUseFractions: { cooling: 0.38, heating: 0.08, lighting: 0.08, plug: 0.28, dhw: 0.12, other: 0.06 },
    calibMinSqft: 600,
    calibMaxSqft: 6000,
    schedule: { occupiedStart: 6, occupiedEnd: 23, weekendFactor: 1.08, baseloadFrac: 0.3, coolingSlope: 0.055, heatingSlope: 0.02 },
  },
  {
    buildingType: "single_family",
    sectorClass: "residential",
    vintageBand: "post_2000",
    sizeBandSqft: "1k_4k",
    annualKwhPerSqft: 5.1,
    peakWPerSqft: 2.1,
    endUseFractions: { cooling: 0.4, heating: 0.06, lighting: 0.06, plug: 0.3, dhw: 0.12, other: 0.06 },
    calibMinSqft: 800,
    calibMaxSqft: 7000,
    schedule: { occupiedStart: 6, occupiedEnd: 23, weekendFactor: 1.08, baseloadFrac: 0.28, coolingSlope: 0.05, heatingSlope: 0.018 },
  },
  {
    buildingType: "multifamily",
    sectorClass: "residential",
    vintageBand: "all",
    sizeBandSqft: "50k_500k",
    annualKwhPerSqft: 5.8,
    peakWPerSqft: 2.0,
    endUseFractions: { cooling: 0.34, heating: 0.07, lighting: 0.12, plug: 0.3, dhw: 0.12, other: 0.05 },
    calibMinSqft: 10000,
    calibMaxSqft: 800000,
    schedule: { occupiedStart: 6, occupiedEnd: 24, weekendFactor: 1.05, baseloadFrac: 0.35, coolingSlope: 0.045, heatingSlope: 0.018 },
  },
];

/**
 * Generate a normalized 8760 shape from a spec + hourly TMY temps.
 * Weather-sensitive: cooling above 65F balance, heating below 60F.
 */
export function generateShape8760(spec: ArchetypeSpec, tmyHourly: number[]): number[] {
  const { schedule } = spec;
  const raw: number[] = new Array(8760);
  // Jan 1 of a non-leap reference year (2023) was a Sunday → dow = (dayIndex + 0) % 7
  for (let h = 0; h < 8760; h++) {
    const dayIndex = Math.floor(h / 24);
    const hourOfDay = h % 24;
    const dow = (dayIndex + 0) % 7; // 0 = Sunday
    const isWeekend = dow === 0 || dow === 6;
    // Batch-41 (pass 1782): overnight-safe occupancy — a schedule like 19→7
    // (bar/nightclub) wraps midnight; the naive range check evaluated false for
    // EVERY hour on such schedules, silently flattening the load shape. All 13
    // currently-seeded archetypes are daytime (start < end), so no re-seed is
    // required — identical output for existing shapes — but the function must
    // be correct for any overnight archetype added later. Same wrap convention
    // as hourSpan/demandWindowMatch/inHourWindow.
    const occupied =
      schedule.occupiedStart <= schedule.occupiedEnd
        ? hourOfDay >= schedule.occupiedStart && hourOfDay < schedule.occupiedEnd
        : hourOfDay >= schedule.occupiedStart || hourOfDay < schedule.occupiedEnd;
    let load = schedule.baseloadFrac;
    if (occupied) {
      load += (1 - schedule.baseloadFrac) * (isWeekend ? schedule.weekendFactor : 1.0);
    } else {
      load += (1 - schedule.baseloadFrac) * 0.08;
    }
    const t = tmyHourly[h] ?? 70;
    if (t > 65) load += schedule.coolingSlope * (t - 65) * (occupied ? 1 : 0.55);
    if (t < 60) load += schedule.heatingSlope * (60 - t) * (occupied ? 1 : 0.45);
    raw[h] = load;
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / sum);
}
