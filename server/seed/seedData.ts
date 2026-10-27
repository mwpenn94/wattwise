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

export const SEED_VERSION = "2026.10.7"; // Oct 26 (RATE-7): City of Phoenix water — filed March 1, 2025 schedule (seasonal user charge, environmental charge, included allowance, meter-size service charge); adds the residential twin. Previously Oct 26 (RATE-2): Southwest Gas G-5 (378th Rev Sheet 11, eff 2026-09-01) and LG&E RS/RTOD-Energy/GS (Electric No. 14, eff 2026-09-01) + RGS/CGS (Gas No. 14, eff 2026-08-14; GSCC 2026-08-01) re-read from the official sheets
// previous: Oct 25: official UNS SGS-TOU / SGS-Demand / SGS-Demand-TOU (sheets 202–204, Decision 79277)

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
  // Accuracy pass (Jul 20): the remaining eGRID2022 subregions referenced by
  // STATE_SUBREGION — previously unseeded, so states outside the launch
  // territory silently fell through to the AZNM default factor. Values are
  // eGRID2022 total output emission rates (CO2e lb/MWh), EPA release.
  { subregion: "AKGD", subregionName: "ASCC Alaska Grid", co2eLbPerMwh: 1067.1, year: 2022 },
  { subregion: "FRCC", subregionName: "FRCC All (Florida)", co2eLbPerMwh: 812.7, year: 2022 },
  { subregion: "HIOA", subregionName: "HICC Oahu", co2eLbPerMwh: 1592.7, year: 2022 },
  { subregion: "MROE", subregionName: "MRO East (Wisconsin)", co2eLbPerMwh: 1180.9, year: 2022 },
  { subregion: "MROW", subregionName: "MRO West (Upper Midwest)", co2eLbPerMwh: 936.5, year: 2022 },
  { subregion: "NEWE", subregionName: "NPCC New England", co2eLbPerMwh: 538.7, year: 2022 },
  { subregion: "RFCM", subregionName: "RFC Michigan", co2eLbPerMwh: 1176.7, year: 2022 },
  { subregion: "RFCW", subregionName: "RFC West (Ohio Valley)", co2eLbPerMwh: 999.6, year: 2022 },
  { subregion: "SPNO", subregionName: "SPP North (Kansas/W. Missouri)", co2eLbPerMwh: 941.0, year: 2022 },
  { subregion: "SPSO", subregionName: "SPP South (Oklahoma/Arkansas)", co2eLbPerMwh: 863.5, year: 2022 },
  { subregion: "SRMV", subregionName: "SERC Mississippi Valley", co2eLbPerMwh: 802.8, year: 2022 },
  { subregion: "SRMW", subregionName: "SERC Midwest (Illinois/Missouri)", co2eLbPerMwh: 1163.7, year: 2022 },
  { subregion: "SRTV", subregionName: "SERC Tennessee Valley", co2eLbPerMwh: 855.0, year: 2022 },
  { subregion: "SRVC", subregionName: "SERC Virginia/Carolinas", co2eLbPerMwh: 619.8, year: 2022 },
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
  // Oct 24: electric EUI rows from EIA CBECS 2018 Table C22 (released Dec 2022),
  // "Distribution of building-level intensities (kWh/square foot)" — 25th
  // percentile / median / 75th percentile. Without these, sites of these types
  // silently skipped the electric benchmark.
  // https://www.eia.gov/consumption/commercial/data/2018/ce/pdf/c22.pdf
  { buildingType: "school", sectorClass: "commercial", commodity: "electric", medianEui: 9.6, p25Eui: 6.2, p75Eui: 13.1, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (K–12)" },
  { buildingType: "hospital", sectorClass: "commercial", commodity: "electric", medianEui: 30.4, p25Eui: 22.2, p75Eui: 35.3, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (inpatient health care)" },
  { buildingType: "hotel", sectorClass: "commercial", commodity: "electric", medianEui: 12.8, p25Eui: 8.7, p75Eui: 18.4, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (hotel)" },
  { buildingType: "grocery", sectorClass: "commercial", commodity: "electric", medianEui: 43.5, p25Eui: 34.9, p75Eui: 77.8, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (grocery store or food market)" },
  { buildingType: "restaurant", sectorClass: "commercial", commodity: "electric", medianEui: 36.7, p25Eui: 20.7, p75Eui: 52.6, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (restaurant or cafeteria)" },
  { buildingType: "municipal", sectorClass: "commercial", commodity: "electric", medianEui: 8.2, p25Eui: 3.7, p75Eui: 14.9, unit: "kWh/sqft/yr", source: "CBECS 2018 Table C22 (public assembly proxy)" },
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
  freshness: "urdb_stale" | "verified";
  effectiveDate: string;
  source?: string;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SUMMER = [5, 6, 7, 8, 9, 10];
const WINTER = [11, 12, 1, 2, 3, 4];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const UNS_ELECTRIC_UTILITY = "UniSource Energy Services (UNS Electric)";
const UNS_OFFICIAL_SOURCE = "uns_official_tariff";
const UNS_SOC = "https://docs.uesaz.com/wp-content/uploads/801-UNSE-Statement-of-Charges.pdf";
const UNS_PPFAC = "https://docs.uesaz.com/wp-content/uploads/701-Rider-1-PPFAC-Clean.pdf";
const UNS_SOC_2024 = "https://docs.uesaz.com/wp-content/uploads/2018/03/Statement-of-Charges.pdf#page=3";
const UNS_REST_PAGE = "https://www.uesaz.com/rest/";
const UNS_EXCLUDED_RIDER_NOTE = "Modeled subtotal; excludes LFCR, taxes/assessments and unconfirmed account-specific terms. LFCR EE/DG rates are 0.7536%/0.3462% from 2025-10-01 (ACC announcement 2025-09-17), then 0.9298%/0.4138% from 2026-09-01 (Statement of Charges sheet 801-2, p.3). The complete assessment base is unverified, so no LFCR dollar charge is invented.";
const UNS_MODEL_TERMS = {
  requiredRiderLabels: ["PPFAC", "DSMS", "REST", "TCA", "TEAM", "Regulatory Expense"],
  verifiedThrough: "2026-10-31",
  billingCaveat: "Modeled subtotal, not a complete utility bill: LFCR, taxes/assessments, actual utility billing-cycle boundaries and unconfirmed account-specific terms are excluded. No definitive switch or solar-savings recommendation is supported.",
  switchRequiresConfirmation: true,
};
const UNS_SWITCH_NOTE = "Switching is limited to once in a rolling 12-month period and requires utility confirmation; TOU service requires an appropriate meter. MGS customers at 750 kW may be moved by the utility to LGS, not automatically excluded. Base schedules effective 2024-02-01; rider versions have independent dates.";

function unsElectricRiders(restCapUsd: number, demandBilled = false): NonNullable<TariffStructure["riders"]> {
  return [
    ...([
      ["2025-10-01", "2025-10-31", 0.016629],
      ["2025-11-01", "2025-11-30", 0.015548],
      ["2025-12-01", "2025-12-31", 0.014480],
      ["2026-01-01", "2026-01-31", 0.013425],
      ["2026-02-01", "2026-02-28", 0.012384],
      ["2026-03-01", "2026-03-31", 0.011356],
      ["2026-04-01", "2026-04-30", 0.010341],
      ["2026-05-01", "2026-05-31", 0.009338],
      ["2026-06-01", "2026-06-30", 0.008348],
      ["2026-07-01", "2026-07-31", 0.007370],
      ["2026-08-01", "2026-08-31", 0.006404],
      ["2026-09-01", "2026-09-30", 0.005450],
      ["2026-10-01", "2026-10-31", 0.004508],
    ] as Array<[string, string, number]>).map(([validFrom, validTo, ratePerUnit]) => ({
      label: "PPFAC", validFrom, validTo, ratePerUnit, source: `${UNS_PPFAC}#page=2 (sheet 701-1, issued 2026-10-01)`,
    })),
    { label: "PPFAC temporary surcharge", ratePerUnit: 0.022259, validFrom: "2025-10-01", validTo: "2025-11-30", source: `${UNS_PPFAC}#page=2 (sheet 701-1)` },
    { label: "PPFAC temporary credit", ratePerUnit: -0.020931, validFrom: "2026-05-01", validTo: "2026-12-31", source: `${UNS_SOC}#page=2 (sheet 801-1)` },
    { label: "DSMS", ratePerUnit: 0.0015, validFrom: "2014-08-01", source: `${UNS_SOC}#page=2 (sheet 801-1)` },
    // Oct 25 (cost audit): the REST version in effect BEFORE May 1 2026 —
    // official Statement of Charges sheet 801-2 (First Revised, eff Jun 1 2024;
    // Decision 78922 values eff May 1 2023), also the values published on
    // uesaz.com/rest/ through at least Feb 2026. Superseded May 1 2026.
    { label: "REST", ratePerUnit: 0.0123, monthlyCapUsd: restCapUsd === 59.5 ? 45 : restCapUsd === 350 ? 238 : 590,
      renewableClassAverageUsd: restCapUsd === 59.5 ? 12.51 : restCapUsd === 350 ? 125.32 : 587.12,
      validFrom: "2023-05-01", validTo: "2026-04-30", source: `${UNS_SOC_2024} (sheet 801-2, First Revised, eff 2024-06-01; Decision 78922, eff 2023-05-01); confirmed on ${UNS_REST_PAGE} (captures 2025-10-16, 2026-02-18)` },
    { label: "REST", ratePerUnit: 0.0126, monthlyCapUsd: restCapUsd,
      renewableClassAverageUsd: restCapUsd === 59.5 ? 13.46 : restCapUsd === 350 ? 203.39 : 911.50,
      validFrom: "2026-05-01", source: `${UNS_SOC}#page=3 (sheet 801-2); renewable eligibility: sheet 706 p.1` },
    // Oct 25 (cost audit): TCA before Jun 1 2026 for NON-demand schedules —
    // $0.000413/kWh eff Jun 1 2024 (official SoC sheet 801-2 First Revised,
    // Decision 79277), still the published value on uesaz.com/tca/ through the
    // 2026-04-18 capture. The demand-customer value is published as "$0.13 per
    // kW" on the sheet but as a ~13¢/kW CREDIT on the utility page; with the
    // sign unconfirmed it is NOT modeled (those months stay "incomplete").
    ...(demandBilled ? [] : [{ label: "TCA", ratePerUnit: 0.000413, basis: "import_kwh" as const,
      validFrom: "2024-06-01", validTo: "2026-05-31", source: `${UNS_SOC_2024} (sheet 801-2, First Revised, eff 2024-06-01; Decision 79277); confirmed on https://www.uesaz.com/tca/ (captures 2025-09-15, 2025-12-15, 2026-04-18)` }]),
    { label: "TCA", ratePerUnit: demandBilled ? 0.36 : 0.001474, basis: demandBilled ? "billing_demand_kw" : "import_kwh",
      validFrom: "2026-06-01", source: `${UNS_SOC}#page=3 (sheet 801-2); basis: sheet 709 p.1` },
    { label: "TEAM", ratePerUnit: -0.0001, validFrom: "2026-01-01", source: `${UNS_SOC}#page=4 (sheet 801-3)` },
    { label: "SRB", ratePerUnit: 0, validFrom: "2024-02-01", source: `${UNS_SOC}#page=4 (sheet 801-3)` },
    { label: "Regulatory Expense", ratePerUnit: 0.000192, validFrom: "2024-02-01", validTo: "2027-01-31", source: `${UNS_SOC}#page=4 (sheet 801-3); three-year recovery: sheet 721 p.1` },
  ];
}

/* RATE-7: City of Phoenix water, inside City, effective 2025-03-01.
 * Rates are stored per GALLON because water is modeled in gallons
 * (usageConversion converts CCF/HCF readings first); 1 CCF = 748 gal per the
 * City schedule. Each season's energy rate = user charge + environmental
 * charge, per CCF / 748. The included allowance (5 CCF Oct–May, 8 CCF Jun–Sep)
 * is a seasonal block CREDIT of the user charge only, because the
 * environmental charge applies to all metered use, including included use. */
const PHX_GAL_PER_CCF = 748;
const PHX_ENV = 0.62;
const phxPerGal = (perCcf: number) => Math.round((perCcf / PHX_GAL_PER_CCF) * 1e9) / 1e9;
const PHX_LOW = [12, 1, 2, 3];
const PHX_MED = [4, 5, 10, 11];
const PHX_HIGH = [6, 7, 8, 9];
const PHX_ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const PHX_WATER_STRUCTURE: TariffStructure = {
  fixedMonthly: 4.64,
  meterSizeCharges: [
    { size: "5/8 in.", monthly: 4.64 }, { size: "3/4 in.", monthly: 6.03 }, { size: "1 in.", monthly: 8.81 }, { size: "1-1/2 in.", monthly: 15.77 },
    { size: "2 in.", monthly: 24.13 }, { size: "3 in.", monthly: 43.62 }, { size: "4 in.", monthly: 71.46 }, { size: "6 in.", monthly: 141.06 },
  ],
  energy: [
    // Low season first: energy[0] is the lowest marginal rate, so callers that
    // read a single $/gal (savings estimates) stay conservative.
    { label: "Low season Dec–Mar (user $4.93 + environmental $0.62 per CCF)", months: PHX_LOW, daysOfWeek: PHX_ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: phxPerGal(4.93 + PHX_ENV) },
    { label: "Medium season Apr–May, Oct–Nov (user $5.65 + environmental $0.62 per CCF)", months: PHX_MED, daysOfWeek: PHX_ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: phxPerGal(5.65 + PHX_ENV) },
    { label: "High season Jun–Sep (user $6.13 + environmental $0.62 per CCF)", months: PHX_HIGH, daysOfWeek: PHX_ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: phxPerGal(6.13 + PHX_ENV) },
  ],
  demand: [],
  seasonalEnergyBlockAdjustments: [
    { label: "5 CCF (3,740 gal) included Dec–Mar", months: PHX_LOW, blocks: [{ upToKwh: 5 * PHX_GAL_PER_CCF, ratePerUnit: -phxPerGal(4.93) }, { upToKwh: null, ratePerUnit: 0 }] },
    { label: "5 CCF (3,740 gal) included Apr–May and Oct–Nov", months: PHX_MED, blocks: [{ upToKwh: 5 * PHX_GAL_PER_CCF, ratePerUnit: -phxPerGal(5.65) }, { upToKwh: null, ratePerUnit: 0 }] },
    { label: "8 CCF (5,984 gal) included Jun–Sep", months: PHX_HIGH, blocks: [{ upToKwh: 8 * PHX_GAL_PER_CCF, ratePerUnit: -phxPerGal(6.13) }, { upToKwh: null, ratePerUnit: 0 }] },
  ],
  notes: [
    "City of Phoenix Water Rate Schedule effective March 1, 2025 (inside City). One unit is 1 CCF = 748 gallons. The monthly service charge includes 5 CCF Oct–May and 8 CCF Jun–Sep; the environmental charge ($0.62/CCF) applies to all use.",
    "Outside-City service is billed at 150% of these rates (except the Town of Paradise Valley) and is not modeled here. Sales taxes and surcharges are not included.",
  ],
};
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
  // UES residential rates verified against live uesaz.com published schedules
  // (Jul 2026): https://www.uesaz.com/residential-service/ (Basic, ERRES) and
  // https://www.uesaz.com/time-of-use/ (TOU, ERREST). Published energy charges
  // EXCLUDE the PPFAC fuel adjustor, which changes monthly — disclosed in the
  // rate name. Basic is a 400-kWh usage-tier rate (10.6¢ ≤400, 12.6¢ above);
  // the engine's TouPeriod model has no monthly-usage tiers, so the upper-tier
  // rate is used (conservative for typical AZ homes averaging >400 kWh/mo) and
  // the tier is disclosed in the label.
  {
    urdbId: "uns-erres",
    utilityName: "UniSource Energy Services (UNS Electric)",
    name: "Basic Residential (ERRES) — excl. PPFAC fuel adjustor",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 17.0,
      energy: [
        // Published: 10.6¢ ≤400 kWh, 12.6¢ >400 kWh — upper tier applied (see note above).
        { label: "All energy (tiered 10.6¢≤400kWh/12.6¢>400kWh; upper tier applied)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.126 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0562, notes: "UNS RCP export rate proxy — confirm current RCP filing" },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "uns-errest",
    utilityName: "UniSource Energy Services (UNS Electric)",
    name: "Residential Time-of-Use (ERREST) — excl. PPFAC fuel adjustor",
    sector: "residential",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 14.0,
      energy: [
        // Summer (May–Oct): on-peak M–F 3–7pm. >400 kWh tier applied (19.86¢ on / 10.87¢ off).
        { label: "Summer on-peak 3-7pm wkdy (>400kWh tier)", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 15, hourEnd: 19, ratePerUnit: 0.1986 },
        { label: "Summer off-peak (>400kWh tier)", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1087 },
        // Winter (Nov–Apr): on-peak M–F 6–9am and 6–9pm.
        { label: "Winter on-peak 6-9am wkdy (>400kWh tier)", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 6, hourEnd: 9, ratePerUnit: 0.1731 },
        { label: "Winter on-peak 6-9pm wkdy (>400kWh tier)", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 18, hourEnd: 21, ratePerUnit: 0.1731 },
        { label: "Winter off-peak (>400kWh tier)", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1036 },
      ],
      demand: [],
      exportRate: { type: "net_billing_avoided_cost", ratePerKwh: 0.0562, notes: "UNS RCP export rate proxy — confirm current RCP filing" },
    },
    freshness: "urdb_stale",
    effectiveDate: "2025-01-01",
  },
  {
    urdbId: "uns-egsgs",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Small General Service (EGSGS) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      ...UNS_MODEL_TERMS,
      fixedMonthly: 25.0,
      migrationAtConsecutiveMonthlyKwh: { kwh: 12000, months: 2 },
      energy: [],
      energyBlocks: [
        { upToKwh: 400, ratePerUnit: 0.104167 },
        { upToKwh: 7500, ratePerUnit: 0.114417 },
        { upToKwh: null, ratePerUnit: 0.159003 },
      ],
      demand: [],
      riders: unsElectricRiders(59.5),
      notes: [
        UNS_EXCLUDED_RIDER_NOTE,
        UNS_SWITCH_NOTE,
        "SGS customers meeting or exceeding 12,000 kWh for two consecutive months migrate to Medium General Service (EGMGS).",
      ],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  /* Oct 25 (owner-approved rate-comparison restore): the three customer-
   * elected Small General Service variants from the official UNS Electric
   * tariff sheets 202–204 (Original sheets, effective 2024-02-01, Decision
   * 79277; index https://www.uesaz.com/electric-rates/).
   * Encoded so an engine that ignores the newer fields OVERSTATES their cost
   * (never invents savings): SGS-TOU prices carry the top delivery block with
   * ≤0 block adjustments; demand tiers carry the top tier in ratePerKw; an
   * unaveraged 15-minute peak is never below the filed 1-hour average. */
  {
    urdbId: "uns-egsgst",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Small General Service Time-of-Use (EGSGST) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      ...UNS_MODEL_TERMS,
      fixedMonthly: 20.0,
      optionalSchedule: true,
      migrationAtConsecutiveMonthlyKwh: { kwh: 12000, months: 2, to: "Medium General Service Time-of-Use (EGMGST)", sheet: "202" },
      // Sheet 202-1: delivery $0.040384 (0–400 kWh) / $0.045509 (401–7,500) /
      // $0.089070 (over 7,500) + base power by season and period. Rates below
      // are the over-7,500-kWh totals; the adjustments restore the lower blocks.
      energy: [
        { label: "Summer on-peak", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, ratePerUnit: 0.233162, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "Summer off-peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.149043 },
        { label: "Winter on-peak morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, ratePerUnit: 0.23185, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter on-peak evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, ratePerUnit: 0.23185, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter off-peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.14161 },
      ],
      energyBlockAdjustments: [
        { upToKwh: 400, ratePerUnit: -0.048686 },
        { upToKwh: 7500, ratePerUnit: -0.043561 },
        { upToKwh: null, ratePerUnit: 0 },
      ],
      demand: [],
      riders: unsElectricRiders(59.5),
      notes: [
        UNS_EXCLUDED_RIDER_NOTE,
        UNS_SWITCH_NOTE,
        "SGS-TOU delivery price steps by monthly kWh (0–400 / 401–7,500 / over 7,500); on-peak is 2–8 pm weekdays May–Oct and 5–9 am & 5–9 pm weekdays Nov–Apr, excluding filed holidays (sheet 202-1). Service starts once a TOU meter is installed. 12,000 kWh in two consecutive months moves the account to MGS-TOU.",
      ],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-egsgsd",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Small General Service Demand (EGSGSD) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    // Sheet 203: at 40 kW measured the utility may move the account to MGS the
    // next billing period, so savings at or above 40 kW are not dependable.
    peakKwMax: 40,
    structure: {
      ...UNS_MODEL_TERMS,
      fixedMonthly: 20.0,
      optionalSchedule: true,
      sizeLimitReason: "Filed rule (sheet 203): at 40 kW or more the utility may move the account to Medium General Service the next billing period.",
      // Sheet 203: all kWh $0.083206 (delivery $0.013273 + base power $0.069933).
      // Two identical seasonal periods keep older code from treating this
      // optional schedule as a default single-period standard rate.
      energy: [
        { label: "All energy — summer", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.083206 },
        { label: "All energy — winter", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.083206 },
      ],
      // Sheet 203-1: billing demand = greatest measured 1-hour average during
      // on-peak TOU hours; $8.46/kW for the first 7 kW, $11.27/kW above 7 kW.
      demand: [
        { label: "On-peak demand — summer", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, demandGroup: "sgsd-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "On-peak demand — winter morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, demandGroup: "sgsd-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "On-peak demand — winter evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, demandGroup: "sgsd-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
      ],
      riders: unsElectricRiders(59.5, true),
      notes: [
        UNS_EXCLUDED_RIDER_NOTE,
        UNS_SWITCH_NOTE,
        "SGS-Demand bills the greatest 1-hour average demand during on-peak hours (2–8 pm weekdays May–Oct; 5–9 am & 5–9 pm weekdays Nov–Apr, excluding filed holidays): $8.46/kW for the first 7 kW and $11.27/kW above that (sheets 203, 203-1). Modeled as the greatest rolling 60-minute average of the uploaded readings.",
      ],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-egsgsdt",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Small General Service Demand Time-of-Use (EGSGSDT) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: 40,
    structure: {
      ...UNS_MODEL_TERMS,
      fixedMonthly: 20.0,
      optionalSchedule: true,
      sizeLimitReason: "Filed rule (sheet 204): at 40 kW or more the utility may move the account to Medium General Service Time-of-Use the next billing period.",
      // Sheet 204-1: delivery $0.013273 + base power by season and period.
      energy: [
        { label: "Summer on-peak", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, ratePerUnit: 0.157365, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "Summer off-peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.073246 },
        { label: "Winter on-peak morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, ratePerUnit: 0.156053, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter on-peak evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, ratePerUnit: 0.156053, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter off-peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.065813 },
      ],
      demand: [
        { label: "On-peak demand — summer", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, demandGroup: "sgsdt-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "On-peak demand — winter morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, demandGroup: "sgsdt-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "On-peak demand — winter evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, demandGroup: "sgsdt-onpeak", ratePerKw: 11.27, tiers: [{ upToKw: 7, ratePerKw: 8.46 }, { upToKw: null, ratePerKw: 11.27 }], averagingMinutes: 60, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
      ],
      riders: unsElectricRiders(59.5, true),
      notes: [
        UNS_EXCLUDED_RIDER_NOTE,
        UNS_SWITCH_NOTE,
        "SGS-Demand-TOU combines on-peak/off-peak energy prices with the SGS-Demand charge: greatest 1-hour average on-peak demand, $8.46/kW for the first 7 kW and $11.27/kW above (sheets 204, 204-1). Service starts once a TOU meter is installed.",
      ],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-egmgs",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Medium General Service (EGMGS) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 100.0,
      energy: [{ label: "All energy", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.074955 }],
      demand: [{ label: "Billing demand", months: ALL_MONTHS, ratePerKw: 14.67 }],
      demandMinKw: 20,
      reclassifyAtKw: { kw: 750, to: "Large General Service (LGS)" },
      ...UNS_MODEL_TERMS,
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" },
      riders: unsElectricRiders(350, true),
      notes: [UNS_EXCLUDED_RIDER_NOTE, UNS_SWITCH_NOTE],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-egmgst",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Medium General Service Time-of-Use (EGMGST) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 100.0,
      energy: [
        { label: "Summer on-peak", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 14, hourEnd: 20, ratePerUnit: 0.155789, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "Summer off-peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.04846 },
        { label: "Winter on-peak morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, ratePerUnit: 0.138183, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter on-peak evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, ratePerUnit: 0.138183, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter off-peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.046609 },
      ],
      demand: [{ label: "Billing demand", months: ALL_MONTHS, ratePerKw: 14.67 }],
      demandMinKw: 20,
      reclassifyAtKw: { kw: 750, to: "Large General Service (LGS)" },
      ...UNS_MODEL_TERMS,
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" },
      riders: unsElectricRiders(350, true),
      notes: [UNS_EXCLUDED_RIDER_NOTE, UNS_SWITCH_NOTE],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-egmgsst",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Time-of-Use for Medium General Service Schools (EGMGSST) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 100.0,
      energy: [
        { label: "Summer on-peak", months: SUMMER, daysOfWeek: WEEKDAYS, hourStart: 15, hourEnd: 19, ratePerUnit: 0.163269, holidayExclusions: ["memorial_day", "independence_day", "labor_day"] },
        { label: "Summer off-peak", months: SUMMER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.05594 },
        { label: "Winter on-peak morning", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 5, hourEnd: 9, ratePerUnit: 0.145108, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter on-peak evening", months: WINTER, daysOfWeek: WEEKDAYS, hourStart: 17, hourEnd: 21, ratePerUnit: 0.145108, holidayExclusions: ["thanksgiving", "christmas_day", "new_years_day"] },
        { label: "Winter off-peak", months: WINTER, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.054089 },
      ],
      demand: [{ label: "Billing demand", months: ALL_MONTHS, ratePerKw: 14.67 }],
      demandMinKw: 20,
      ...UNS_MODEL_TERMS,
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" },
      schoolOnly: true,
      riders: unsElectricRiders(350, true),
      notes: [UNS_EXCLUDED_RIDER_NOTE, UNS_SWITCH_NOTE, "School TOU requires confirmed public/private K–12 status (sheet 212 p.1); a generic school/daycare building label is not proof."],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  {
    urdbId: "uns-lgs",
    utilityName: UNS_ELECTRIC_UTILITY,
    name: "Large General Service (EGLGS) — filed base; modeled subtotal",
    sector: "commercial",
    commodity: "electric",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 300.0,
      energy: [{ label: "All energy", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.074848 }],
      demand: [{ label: "Billing demand", months: ALL_MONTHS, ratePerKw: 14.58 }],
      ...UNS_MODEL_TERMS,
      demandMinKw: 450,
      primaryVoltageDemandCreditPct: 0.03,
      ratchet: { lookbackMonths: 11, ratchetPct: 0.75, applicablePeriod: "all", determinant: "billed" },
      riders: unsElectricRiders(950, true),
      notes: [UNS_EXCLUDED_RIDER_NOTE, UNS_SWITCH_NOTE, "EGLGS service must be below 69 kV; primary metering is required for new installations exceeding 2,500 kW (sheet 220 p.1). Contract capacity may exceed the 450-kW class minimum (sheet 220-1 p.2)."],
    },
    freshness: "verified",
    effectiveDate: "2024-02-01",
    source: UNS_OFFICIAL_SOURCE,
  },
  /* -------------------- LG&E (Louisville Gas and Electric, KY) ----------- */
  // RATE-2 (Oct 26): re-verified against LG&E's current filed electric tariff
  // (P.S.C. Electric No. 14), rates for service on/after Sept 1 2026 (KY PSC
  // Case 2025-00341, Aug 18 2026 FAC order raised base energy by $0.00127/kWh;
  // the increase is IN these sheets). Current book (linked from
  // https://lge-ku.com/regulatory/rates-and-tariffs):
  // https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Electric-Rates-083126.pdf
  // Monthly FAC/OSS (Oct 2026 billed $0.00099/kWh), DSM, ECR and other
  // adjustment clauses are billed separately and are not in these rows.
  // Basic Service Charges are filed PER DAY; the engine's fixedMonthly uses
  // the average-month equivalent (×30.437 days) — disclosed in labels.
  {
    urdbId: "lge-rs",
    utilityName: "Louisville Gas and Electric (LG&E)",
    name: "Residential Service (RS) — $0.48/day BSC billed monthly-equivalent",
    sector: "residential",
    commodity: "electric",
    state: "KY",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 14.61, // $0.48/day × 30.437 avg days (Sheet No. 5, 2nd Rev)
      energy: [
        // Filed total $0.11499/kWh = infrastructure $0.07481 + variable $0.04018.
        { label: "All energy (infra $0.07481 + variable $0.04018)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.11499 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-09-01",
  },
  {
    urdbId: "lge-rtod-energy",
    utilityName: "Louisville Gas and Electric (LG&E)",
    name: "Residential Time-of-Day Energy (RTOD-Energy) — 500-customer pilot cap",
    sector: "residential",
    commodity: "electric",
    state: "KY",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 14.61, // $0.48/day × 30.437 avg days (Sheet No. 6, 2nd Rev)
      // Sheet No. 6.1: rating periods are Eastern Standard Time year-round, so
      // during daylight time each period runs one clock hour later. A legal
      // holiday on a weekday is treated as a weekday (no holiday exclusions).
      touTimezone: "Etc/GMT+5",
      energy: [
        // On-peak periods first (the dispatch signal takes the first match).
        { label: "On-peak Apr–Oct wkdy 1–5 pm EST", months: [4, 5, 6, 7, 8, 9, 10], daysOfWeek: WEEKDAYS, hourStart: 13, hourEnd: 17, ratePerUnit: 0.19307 },
        { label: "On-peak Nov–Mar wkdy 6–10 am EST", months: [11, 12, 1, 2, 3], daysOfWeek: WEEKDAYS, hourStart: 6, hourEnd: 10, ratePerUnit: 0.19307 },
        { label: "On-peak Nov–Mar wkdy 6–10 pm EST", months: [11, 12, 1, 2, 3], daysOfWeek: WEEKDAYS, hourStart: 18, hourEnd: 22, ratePerUnit: 0.19307 },
        // Off-peak $0.09312 = infrastructure $0.05294 + variable $0.04018; on-peak $0.15289 + $0.04018.
        { label: "Off-peak (all other hours; weekends)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.09312 },
      ],
      demand: [],
      notes: ["LG&E files RTOD-Energy hours in Eastern Standard Time all year: during daylight saving time, on-peak runs 2–6 pm (April–October) on the clock."],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-09-01",
  },
  {
    urdbId: "lge-gs",
    utilityName: "Louisville Gas and Electric (LG&E)",
    name: "General Service (GS) single-phase — $1.35/day BSC billed monthly-equivalent",
    sector: "commercial",
    commodity: "electric",
    state: "KY",
    peakKwMin: null,
    peakKwMax: 50,
    structure: {
      fixedMonthly: 41.09, // $1.35/day single-phase × 30.437 avg days ($2.10/day three-phase not modeled; Sheet No. 10, 2nd Rev)
      energy: [
        // Filed total $0.13390/kWh = infrastructure $0.09360 + variable $0.04030.
        { label: "All energy (infra $0.09360 + variable $0.04030)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.1339 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-09-01",
  },
  // RATE-2 (Oct 26): re-verified against LG&E's current filed gas tariff
  // (P.S.C. Gas No. 14), rates for service on/after Aug 14 2026 (KY PSC Case
  // 2025-00114 reconsideration order). Gas Supply Cost Component (Sheet No. 85,
  // 2nd Rev) $0.57318/Ccf effective Aug 1 2026; it is refiled every three
  // months (Feb/May/Aug/Nov 1) — re-verify at the quarterly GSC cadence.
  // https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Gas-Rates-082726.pdf
  // Filed unit is $ per 100 cubic feet (Ccf); the engine prices gas meters in
  // THERMS, so rates are converted at 1 Ccf ≈ 1.037 therms — disclosed in labels.
  {
    urdbId: "lge-rgs",
    utilityName: "Louisville Gas and Electric (LG&E)",
    name: "Residential Gas Service (RGS) — filed $1.21230/Ccf priced per therm",
    sector: "residential",
    commodity: "gas",
    state: "KY",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 21.91, // $0.72/day per delivery point × 30.437 avg days (Sheet No. 5, 3rd Rev)
      energy: [
        // $1.21230/Ccf (distribution $0.63912 + gas supply $0.57318) ÷ 1.037 therms/Ccf.
        { label: "All gas ($1.21230/Ccf ÷ 1.037 therms/Ccf; incl. gas supply cost component)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 1.169 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-08-14",
  },
  {
    urdbId: "lge-cgs",
    utilityName: "Louisville Gas and Electric (LG&E)",
    name: "Firm Commercial Gas Service (CGS) <5,000 cf/hr — filed $1.01178/Ccf priced per therm",
    sector: "commercial",
    commodity: "gas",
    state: "KY",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 88.88, // $2.92/day per delivery point (<5,000 cf/hr meters) × 30.437 avg days (Sheet No. 10.1, 3rd Rev)
      energy: [
        // $1.01178/Ccf (distribution $0.43860 + gas supply $0.57318) ÷ 1.037 therms/Ccf.
        { label: "All gas ($1.01178/Ccf ÷ 1.037 therms/Ccf; incl. gas supply cost component)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.9757 },
      ],
      // Sheet No. 10.1: in the April–October billing periods, distribution on
      // monthly usage over 100,000 cubic feet (1,000 Ccf ≈ 1,037 therms) is
      // reduced by $0.05/Ccf (≈ $0.0482/therm).
      energyBlockAdjustments: [
        { upToKwh: 1037, ratePerUnit: 0 },
        { upToKwh: null, ratePerUnit: -0.0482 },
      ],
      energyBlockAdjustmentMonths: [4, 5, 6, 7, 8, 9, 10],
      demand: [],
      notes: ["April–October: usage over 100,000 cubic feet a month (about 1,037 therms) is billed $0.05 per 100 cubic feet less for distribution, per LG&E Sheet No. 10.1."],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-08-14",
  },
  /* -------------------- UNS Gas (UniSource, AZ) --------------------------- */
  // Verified against the UNS Gas Statement of Rates (Tariff Sheet 1.1,
  // Decision No. 81653), month Oct-26, effective 10/1/2026 (LFCR 0.1877% per
  // Decision No. 82165) — re-read from the official PDF on Oct 24 2026:
  // https://docs.uesaz.com/wp-content/uploads/UNSG-Tariff-Sheet-1.1.pdf
  // Effective tariff rates INCLUDE the PGA gas adjustor and LFCR as filed
  // (taxes/assessments excluded). Serves Mohave, Yavapai, Coconino, Navajo and
  // Santa Cruz counties — NOT Southwest Gas territory (e.g. Kingman).
  {
    urdbId: "unsg-grres",
    utilityName: "UniSource Energy Services (UNS Gas)",
    name: "Residential Gas Service (GRRES) — effective rate incl. PGA + LFCR",
    sector: "residential",
    commodity: "gas",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 11.96,
      energy: [
        // $0.8292/therm = base $0.3801 + PGA $0.4475 + LFCR $0.0016 (eff. 10/1/2026).
        { label: "All gas (base $0.3801 + PGA $0.4475 + LFCR $0.0016)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.8292 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-10-01",
  },
  {
    urdbId: "unsg-ggsvs",
    utilityName: "UniSource Energy Services (UNS Gas)",
    name: "Small Volume Commercial Gas (GGSVS) — effective rate incl. PGA + LFCR",
    sector: "commercial",
    commodity: "gas",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 28.37,
      energy: [
        // $0.7623/therm = base $0.3134 + PGA $0.4475 + LFCR $0.0014 (eff. 10/1/2026).
        { label: "All gas (base $0.3134 + PGA $0.4475 + LFCR $0.0014)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 0.7623 },
      ],
      demand: [],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-10-01",
  },
  /* -------------------- Gas & water (commodity-generality proof) --------- */
  {
    // stable id so the swgas-az-gas currency source's governsUrdbIds binds to
    // this row (was null — change flags could never reach it)
    // RATE-2 (Oct 26): re-read from Southwest Gas's official Arizona Statement
    // of Rates (as of 10/01/2026), 378th Revised A.C.C. Sheet No. 11 (cancels
    // 377th), issued Aug 26 2026, effective Sept 1 2026:
    // https://www.swgas.com/1409184757234/Statement-of-Rates-AZ-2026-10012026.pdf
    // G-5 Basic Service Charge $10.70/month; commodity per therm, all usage:
    // Delivery $1.23580, Rate Adjustment ($0.03556), DOT ($0.00092),
    // DCA $0.16269, Monthly Gas Cost $0.22836 = currently effective $1.59037.
    // The Monthly Gas Cost changes monthly (monthly_pga source cadence).
    urdbId: "swgas-az-res",
    utilityName: "Southwest Gas",
    name: "G-5 Residential Gas Service",
    sector: "residential",
    commodity: "gas",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: {
      fixedMonthly: 10.7,
      energy: [
        { label: "All gas (delivery $1.23580 − adj $0.03556 − DOT $0.00092 + DCA $0.16269 + gas cost $0.22836)", months: ALL_MONTHS, daysOfWeek: ALL_DAYS, hourStart: 0, hourEnd: 24, ratePerUnit: 1.59037 },
      ],
      demand: [],
      notes: ["Southwest Gas G-5 currently effective tariff rate from Sheet No. 11 (effective Sept 1, 2026). The monthly gas cost component changes monthly; taxes and franchise fees are not included."],
    },
    freshness: "urdb_stale",
    effectiveDate: "2026-09-01",
  },
  // RATE-7 (Oct 26 2026): City of Phoenix Water Rate Schedule effective
  // 2025-03-01 (City Code §37-63 as amended by Ordinance G-7128), inside City.
  // The City's general metered-water schedule has no separate commercial
  // class, so the residential and commercial rows carry the same filed
  // structure and sector eligibility keeps them apart (meter size is not a
  // rate choice, so sizes are not separate rows that could look like a switch).
  ...(["commercial", "residential"] as const).map((sector): SeedTariff => ({
    // stable id for currency-source binding (same fix as swgas-az-res)
    urdbId: sector === "commercial" ? "phxwater-az-comm" : "phxwater-az-res",
    utilityName: "City of Phoenix Water Services",
    name: sector === "commercial" ? "Municipal Water — Commercial" : "Municipal Water — Residential",
    sector,
    commodity: "water",
    state: "AZ",
    peakKwMin: null,
    peakKwMax: null,
    structure: PHX_WATER_STRUCTURE,
    freshness: "urdb_stale",
    effectiveDate: "2025-03-01",
  })),
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
