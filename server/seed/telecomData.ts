/**
 * Telecom benchmark seed catalog — national published-rate tiers for the
 * telecom module (server/telecom.ts).
 *
 * Honesty contract (same discipline as STATE_PROFILES / EUI_BENCHMARKS):
 *  - every row carries a verbatim basis string naming its sources and vintage;
 *  - these are PUBLISHED-RATE ranges, not quotes — availability and pricing
 *    vary by address, so market-delta findings always disclose that;
 *  - the catalog is code-reviewed data: refreshed deliberately via a source
 *    edit + SEED bump, never silently mutated at runtime.
 *
 * Sources (gathered Jul 22, 2026):
 *  - FCC Urban Rate Survey 2026: urban average standalone broadband $33.99/mo;
 *    reasonable-comparability benchmark $61.29/mo.
 *  - BroadbandNow "Home Internet Cost 2026" (May 2026): national average $75/mo
 *    for reliable broadband, typical range $40–$100.
 *  - HighSpeedInternet.com (Jul 2026): cable ~$50/mo, fiber ~$58/mo, 5G home
 *    internet ~$80/mo. BroadbandSearch (Apr 2026): fiber average ~$85/mo.
 *  - J.D. Power via T-Mobile (Mar 2026): average household wireless bill
 *    $141/mo. Astound (2026): single-line plans $70–$100.
 *  - Published carrier rates (Jun–Jul 2026): AT&T Unlimited Starter $65/1 line,
 *    $35/line at 4 lines; Verizon/Boost multi-line ~$30/line; MVNO unlimited
 *    Mint $15–30, Visible $25 taxes-in, US Mobile $15–30.
 *  - Lightyear business broadband survey (Jun 2026): 100 Mbps $60–100,
 *    500 Mbps $65–110, 1 Gbps $124–184.
 */

export const TELECOM_SEED_VERSION = "published_2026_07";

const RES_INTERNET_BASIS =
  "Published national pricing, Jul 2026 (FCC Urban Rate Survey 2026; BroadbandNow May 2026; HighSpeedInternet/BroadbandSearch 2026) — market comparison, not a quote; availability and pricing vary by address";
const BIZ_INTERNET_BASIS =
  "Published business broadband pricing, Jul 2026 (Lightyear Jun 2026 survey; published ISP business rates) — market comparison, not a quote; availability and pricing vary by address";
const MOBILE_BASIS =
  "Published carrier pricing, Jul 2026 (J.D. Power avg via T-Mobile Mar 2026; AT&T/Verizon/Boost published multi-line rates; Mint/Visible/US Mobile MVNO rates) — market comparison, not a quote";
const TV_BASIS =
  "Published cable/streaming TV bundle pricing, Jul 2026 (published provider rates) — market comparison, not a quote; bundle composition varies";
const LANDLINE_BASIS =
  "Published fixed-voice pricing, Jul 2026 (FCC Urban Rate Survey voice component; published VoIP/landline rates) — market comparison, not a quote";

export interface TelecomBenchmarkSeed {
  serviceType: "internet" | "mobile" | "tv_bundle" | "phone_landline";
  tierKey: string;
  tierLabel: string;
  minMbps: number | null;
  maxMbps: number | null;
  perLine: boolean;
  typicalLowUsd: number;
  medianUsd: number;
  typicalHighUsd: number;
  basis: string;
}

export const TELECOM_BENCHMARKS: TelecomBenchmarkSeed[] = [
  // ---- Residential internet by speed tier -------------------------------
  {
    serviceType: "internet",
    tierKey: "internet_res_under_100",
    tierLabel: "Residential internet, under 100 Mbps",
    minMbps: 0,
    maxMbps: 100,
    perLine: false,
    typicalLowUsd: 30,
    medianUsd: 45,
    typicalHighUsd: 60,
    basis: RES_INTERNET_BASIS,
  },
  {
    serviceType: "internet",
    tierKey: "internet_res_100_300",
    tierLabel: "Residential internet, 100–300 Mbps",
    minMbps: 100,
    maxMbps: 300,
    perLine: false,
    typicalLowUsd: 40,
    medianUsd: 55,
    typicalHighUsd: 75,
    basis: RES_INTERNET_BASIS,
  },
  {
    serviceType: "internet",
    tierKey: "internet_res_300_600",
    tierLabel: "Residential internet, 300–600 Mbps",
    minMbps: 300,
    maxMbps: 600,
    perLine: false,
    typicalLowUsd: 45,
    medianUsd: 65,
    typicalHighUsd: 85,
    basis: RES_INTERNET_BASIS,
  },
  {
    serviceType: "internet",
    tierKey: "internet_res_600_1000",
    tierLabel: "Residential internet, 600 Mbps–1 Gbps",
    minMbps: 600,
    maxMbps: 1000,
    perLine: false,
    typicalLowUsd: 55,
    medianUsd: 75,
    typicalHighUsd: 95,
    basis: RES_INTERNET_BASIS,
  },
  {
    serviceType: "internet",
    tierKey: "internet_res_gigabit_plus",
    tierLabel: "Residential internet, 1 Gbps and above",
    minMbps: 1000,
    maxMbps: null,
    perLine: false,
    typicalLowUsd: 70,
    medianUsd: 90,
    typicalHighUsd: 120,
    basis: RES_INTERNET_BASIS,
  },
  // ---- Business internet by speed tier ----------------------------------
  {
    serviceType: "internet",
    tierKey: "internet_biz_under_500",
    tierLabel: "Business internet, under 500 Mbps",
    minMbps: 0,
    maxMbps: 500,
    perLine: false,
    typicalLowUsd: 60,
    medianUsd: 85,
    typicalHighUsd: 110,
    basis: BIZ_INTERNET_BASIS,
  },
  {
    serviceType: "internet",
    tierKey: "internet_biz_500_plus",
    tierLabel: "Business internet, 500 Mbps and above",
    minMbps: 500,
    maxMbps: null,
    perLine: false,
    typicalLowUsd: 90,
    medianUsd: 135,
    typicalHighUsd: 185,
    basis: BIZ_INTERNET_BASIS,
  },
  // ---- Mobile (per line) --------------------------------------------------
  {
    serviceType: "mobile",
    tierKey: "mobile_unlimited_postpaid",
    tierLabel: "Mobile, unlimited postpaid (major carrier, per line)",
    minMbps: null,
    maxMbps: null,
    perLine: true,
    typicalLowUsd: 35,
    medianUsd: 65,
    typicalHighUsd: 100,
    basis: MOBILE_BASIS,
  },
  {
    serviceType: "mobile",
    tierKey: "mobile_unlimited_prepaid_mvno",
    tierLabel: "Mobile, unlimited prepaid / MVNO (per line)",
    minMbps: null,
    maxMbps: null,
    perLine: true,
    typicalLowUsd: 15,
    medianUsd: 25,
    typicalHighUsd: 40,
    basis: MOBILE_BASIS,
  },
  {
    serviceType: "mobile",
    tierKey: "mobile_limited_data",
    tierLabel: "Mobile, capped-data plan (per line)",
    minMbps: null,
    maxMbps: null,
    perLine: true,
    typicalLowUsd: 15,
    medianUsd: 25,
    typicalHighUsd: 40,
    basis: MOBILE_BASIS,
  },
  // ---- TV bundle & landline ----------------------------------------------
  {
    serviceType: "tv_bundle",
    tierKey: "tv_bundle_standard",
    tierLabel: "TV / video bundle",
    minMbps: null,
    maxMbps: null,
    perLine: false,
    typicalLowUsd: 60,
    medianUsd: 95,
    typicalHighUsd: 140,
    basis: TV_BASIS,
  },
  {
    serviceType: "phone_landline",
    tierKey: "phone_landline_standard",
    tierLabel: "Landline / fixed voice",
    minMbps: null,
    maxMbps: null,
    perLine: false,
    typicalLowUsd: 20,
    medianUsd: 35,
    typicalHighUsd: 55,
    basis: LANDLINE_BASIS,
  },
];
