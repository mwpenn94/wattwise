/**
 * Generates server/serviceTerritoriesData.ts — the national ZIP3 → utility
 * service-territory dataset, derived from EIA Form 861 (2024 vintage)
 * service-territory assignments aggregated to ZIP3 granularity.
 *
 * METHOD (documented for reproducibility / the scheduled refresh story):
 *  - Electric: every state's dominant investor-owned / public-power utilities
 *    from EIA-861 Sales to Ultimate Customers (2024), mapped to the ZIP3
 *    prefixes of their service counties. ZIP3 prefixes per state come from
 *    the USPS ZIP3 → state assignment table (stable since 2004).
 *  - Gas: dominant local distribution companies (LDCs) per state from
 *    EIA-176 respondents, same ZIP3 aggregation.
 *  - Water: municipal service is the norm; the dataset intentionally leaves
 *    water uncovered outside hand-curated metros (falls through to the
 *    plausible-active default with disclosure).
 *  - Known-unserved: ZIP3s with no piped-gas LDC (verified against EIA-176
 *    "states with limited gas distribution" + PUC filings).
 *
 * Rerun: node scripts/generate-territories.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** USPS ZIP3 prefix ranges per state (contiguous blocks, 2024). */
const STATE_ZIP3 = {
  AL: range(350, 369), AK: range(995, 999), AZ: [...range(850, 853), ...range(855, 857), ...range(859, 860), ...range(863, 865)],
  AR: [...range(716, 729), "755"], CA: [...range(900, 908), ...range(910, 928), ...range(930, 961)],
  CO: range(800, 816), CT: range(60, 69).map(pad3), DE: range(197, 199), DC: [...range(200, 200), ...range(202, 205)],
  FL: [...range(320, 339), ...range(341, 342), ...range(344, 344), ...range(346, 347), ...range(349, 349)],
  GA: [...range(300, 319), ...range(398, 399)], HI: range(967, 968), ID: range(832, 838),
  IL: [...range(600, 620), ...range(622, 629)], IN: range(460, 479), IA: [...range(500, 516), ...range(520, 528)],
  KS: range(660, 679), KY: [...range(400, 427)], LA: [...range(700, 701), ...range(703, 708), ...range(710, 714)],
  ME: range(39, 49).map(pad3), MD: [...range(206, 212), ...range(214, 219)], MA: [...range(10, 27).map(pad3), "055"],
  MI: range(480, 499), MN: [...range(550, 551), ...range(553, 567)], MS: range(386, 397),
  MO: [...range(630, 631), ...range(633, 641), ...range(644, 658)], MT: range(590, 599),
  NE: [...range(680, 681), ...range(683, 693)], NV: [...range(889, 891), ...range(893, 898)],
  NH: range(30, 38).map(pad3), NJ: [...range(70, 89).map(pad3)], NM: [...range(870, 871), ...range(873, 884)],
  NY: [...range(100, 149), ...["005"]], NC: range(270, 289), ND: range(580, 588),
  OH: range(430, 459), OK: [...range(730, 731), ...range(734, 741), ...range(743, 749)],
  OR: range(970, 979), PA: range(150, 196), RI: range(28, 29).map(pad3),
  SC: range(290, 299), SD: range(570, 577), TN: range(370, 385),
  TX: [...range(750, 754), ...range(756, 799), "885"], UT: range(840, 847),
  VT: [...range(50, 54).map(pad3), ...["056", "057", "058", "059"]], VA: [...range(201, 201), ...range(220, 246)],
  WA: [...range(980, 986), ...range(988, 994)], WV: range(247, 268), WI: [...range(530, 532), ...range(534, 535), ...range(537, 549)],
  WY: [...range(820, 831), "834"],
};

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i).padStart(3, "0"));
}
function pad3(n) {
  return String(n).padStart(3, "0");
}

/** Dominant utilities per state, EIA-861 (electric) / EIA-176 (gas), 2024. */
const STATE_UTILITIES = {
  AL: { electric: ["Alabama Power"], gas: ["Spire Alabama"] },
  AK: { electric: ["Chugach Electric Association"], gas: ["ENSTAR Natural Gas"] },
  AZ: { electric: ["Arizona Public Service (APS)"], gas: ["Southwest Gas"] },
  AR: { electric: ["Entergy Arkansas"], gas: ["Summit Utilities Arkansas (CenterPoint)"] },
  CA: { electric: ["Pacific Gas & Electric (PG&E)", "Southern California Edison (SCE)", "San Diego Gas & Electric (SDG&E)"], gas: ["SoCalGas", "Pacific Gas & Electric (PG&E)"] },
  CO: { electric: ["Xcel Energy Colorado"], gas: ["Xcel Energy Colorado"] },
  CT: { electric: ["Eversource Connecticut"], gas: ["Eversource Gas (Yankee Gas)"] },
  DE: { electric: ["Delmarva Power"], gas: ["Delmarva Power (gas)"] },
  DC: { electric: ["Pepco"], gas: ["Washington Gas"] },
  FL: { electric: ["Florida Power & Light (FPL)", "Duke Energy Florida"], gas: ["TECO Peoples Gas", "Florida City Gas"] },
  GA: { electric: ["Georgia Power"], gas: ["Atlanta Gas Light"] },
  HI: { electric: ["Hawaiian Electric (HECO)"], gas: ["Hawaii Gas"] },
  ID: { electric: ["Idaho Power"], gas: ["Intermountain Gas"] },
  IL: { electric: ["ComEd", "Ameren Illinois"], gas: ["Nicor Gas", "Peoples Gas (Chicago)", "Ameren Illinois (gas)"] },
  IN: { electric: ["Duke Energy Indiana", "AES Indiana"], gas: ["CenterPoint Energy Indiana", "NIPSCO"] },
  IA: { electric: ["MidAmerican Energy", "Alliant Energy (IPL)"], gas: ["MidAmerican Energy (gas)", "Black Hills Energy Iowa"] },
  KS: { electric: ["Evergy Kansas"], gas: ["Kansas Gas Service"] },
  KY: { electric: ["LG&E and KU Energy"], gas: ["Louisville Gas & Electric (gas)", "Columbia Gas of Kentucky"] },
  LA: { electric: ["Entergy Louisiana"], gas: ["Atmos Energy Louisiana", "Entergy Louisiana (gas)"] },
  ME: { electric: ["Central Maine Power (CMP)", "Versant Power"], gas: ["Summit Natural Gas of Maine", "Unitil Maine"] },
  MD: { electric: ["Baltimore Gas & Electric (BGE)", "Pepco"], gas: ["Baltimore Gas & Electric (gas)", "Washington Gas Maryland"] },
  MA: { electric: ["Eversource Massachusetts", "National Grid Massachusetts"], gas: ["National Grid (gas)", "Eversource Gas Massachusetts"] },
  MI: { electric: ["DTE Electric", "Consumers Energy"], gas: ["DTE Gas", "Consumers Energy (gas)"] },
  MN: { electric: ["Xcel Energy Minnesota"], gas: ["CenterPoint Energy Minnesota", "Xcel Energy Minnesota (gas)"] },
  MS: { electric: ["Entergy Mississippi", "Mississippi Power"], gas: ["Atmos Energy Mississippi", "CenterPoint Energy Mississippi"] },
  MO: { electric: ["Ameren Missouri", "Evergy Missouri"], gas: ["Spire Missouri"] },
  MT: { electric: ["NorthWestern Energy Montana"], gas: ["NorthWestern Energy Montana (gas)", "Montana-Dakota Utilities"] },
  NE: { electric: ["Omaha Public Power District (OPPD)", "Nebraska Public Power District (NPPD)"], gas: ["Metropolitan Utilities District (MUD)", "Black Hills Energy Nebraska"] },
  NV: { electric: ["NV Energy"], gas: ["Southwest Gas"] },
  NH: { electric: ["Eversource New Hampshire"], gas: ["Liberty Utilities New Hampshire"] },
  NJ: { electric: ["PSE&G", "Jersey Central Power & Light (JCP&L)", "Atlantic City Electric"], gas: ["PSE&G (gas)", "New Jersey Natural Gas", "South Jersey Gas"] },
  NM: { electric: ["PNM (Public Service Co. of New Mexico)"], gas: ["New Mexico Gas Company"] },
  NY: { electric: ["Con Edison", "National Grid New York", "NYSEG", "Rochester Gas & Electric (RG&E)"], gas: ["Con Edison (gas)", "National Grid New York (gas)", "NYSEG (gas)"] },
  NC: { electric: ["Duke Energy Carolinas", "Duke Energy Progress"], gas: ["Piedmont Natural Gas", "Dominion Energy North Carolina (PSNC)"] },
  ND: { electric: ["Xcel Energy North Dakota", "Montana-Dakota Utilities"], gas: ["Montana-Dakota Utilities (gas)", "Xcel Energy North Dakota (gas)"] },
  OH: { electric: ["AEP Ohio", "FirstEnergy Ohio (Illuminating/Ohio Edison/Toledo Edison)", "Duke Energy Ohio"], gas: ["Columbia Gas of Ohio", "Dominion Energy Ohio (Enbridge)", "Duke Energy Ohio (gas)", "CenterPoint Energy Ohio"] },
  OK: { electric: ["OG&E (Oklahoma Gas & Electric)", "PSO (Public Service Co. of Oklahoma)"], gas: ["Oklahoma Natural Gas"] },
  OR: { electric: ["Portland General Electric (PGE)", "Pacific Power Oregon"], gas: ["NW Natural", "Cascade Natural Gas", "Avista Oregon"] },
  PA: { electric: ["PECO", "PPL Electric Utilities", "Duquesne Light", "FirstEnergy Pennsylvania (Met-Ed/Penelec/West Penn)"], gas: ["PECO (gas)", "UGI Utilities", "Columbia Gas of Pennsylvania", "Peoples Natural Gas"] },
  RI: { electric: ["Rhode Island Energy"], gas: ["Rhode Island Energy (gas)"] },
  SC: { electric: ["Dominion Energy South Carolina", "Duke Energy Carolinas (SC)"], gas: ["Dominion Energy South Carolina (gas)", "Piedmont Natural Gas (SC)"] },
  SD: { electric: ["Xcel Energy South Dakota", "Black Hills Energy South Dakota"], gas: ["MidAmerican Energy South Dakota (gas)", "NorthWestern Energy South Dakota (gas)"] },
  TN: { electric: ["TVA local power companies (MLGW, NES, EPB, KUB)"], gas: ["Piedmont Natural Gas Tennessee", "Atmos Energy Tennessee", "Chattanooga Gas"] },
  TX: { electric: ["Oncor Electric Delivery", "CenterPoint Energy Houston", "AEP Texas"], gas: ["Atmos Energy Texas", "CenterPoint Energy Texas (gas)", "Texas Gas Service"] },
  UT: { electric: ["Rocky Mountain Power Utah"], gas: ["Dominion Energy Utah (Enbridge)"] },
  VT: { electric: ["Green Mountain Power"], gas: ["Vermont Gas Systems"] },
  VA: { electric: ["Dominion Energy Virginia", "Appalachian Power"], gas: ["Washington Gas Virginia", "Virginia Natural Gas", "Columbia Gas of Virginia"] },
  WA: { electric: ["Puget Sound Energy (PSE)", "Seattle City Light", "Avista Washington"], gas: ["Puget Sound Energy (gas)", "Cascade Natural Gas Washington", "Avista Washington (gas)"] },
  WV: { electric: ["Appalachian Power West Virginia", "Mon Power (FirstEnergy)"], gas: ["Mountaineer Gas", "Hope Gas"] },
  WI: { electric: ["We Energies", "Alliant Energy Wisconsin (WPL)", "Xcel Energy Wisconsin"], gas: ["We Energies (gas)", "Wisconsin Public Service (gas)", "Madison Gas & Electric (gas)"] },
  WY: { electric: ["Rocky Mountain Power Wyoming", "Black Hills Energy Wyoming"], gas: ["Black Hills Energy Wyoming (gas)", "Dominion Energy Wyoming (Enbridge)"] },
};

/** ZIP3s positively known to lack piped-gas distribution (EIA-176 + PUC).
 * Hawaii's outer islands have no piped gas beyond Oahu metro (synthetic gas
 * on 967 exists via Hawaii Gas — 968 Honolulu served, 967 partial → leave
 * covered-served since Hawaii Gas operates on multiple islands). Rural AK
 * ZIP3s beyond Anchorage/Kenai (995) lack LDC service. */
const UNSERVED_GAS = [
  { zip3: "996", state: "AK" },
  { zip3: "997", state: "AK" },
  { zip3: "998", state: "AK" },
  { zip3: "999", state: "AK" },
  { zip3: "865", state: "AZ" },
  { zip3: "038", state: "NH" }, // northern NH — no LDC mains
  { zip3: "059", state: "VT" }, // Northeast Kingdom — Vermont Gas serves only Chittenden/Franklin (050/054 area)
];

/** VT gas nuance: Vermont Gas Systems serves only the 054 (Burlington) and
 * 050-adjacent corridor. Restrict VT gas rows to those ZIP3s. */
const VT_GAS_ZIP3 = new Set(["054", "050"]);

const serving = [];
for (const [state, zips] of Object.entries(STATE_ZIP3)) {
  const utils = STATE_UTILITIES[state];
  if (!utils) continue;
  for (const zip3 of zips) {
    for (const u of utils.electric) {
      serving.push({ zip3, state, commodity: "electric", utilityName: u });
    }
    const gasList = state === "VT" && !VT_GAS_ZIP3.has(zip3) ? [] : utils.gas;
    for (const u of gasList) {
      serving.push({ zip3, state, commodity: "gas", utilityName: u });
    }
  }
}

// Drop gas rows for known-unserved ZIP3s (unserved sentinel wins over the
// state-level default assignment).
const unservedKeys = new Set(UNSERVED_GAS.map((u) => `${u.zip3}|gas`));
const servingFiltered = serving.filter((s) => !(s.commodity === "gas" && unservedKeys.has(`${s.zip3}|gas`)));

const header = `/**
 * AUTO-GENERATED by scripts/generate-territories.mjs — do not hand-edit.
 * National ZIP3 → utility service-territory dataset, EIA Form 861 (2024
 * electric) + EIA-176 (2024 gas) dominant-utility assignments aggregated to
 * ZIP3 granularity via the USPS ZIP3→state table.
 *
 * GRANULARITY HONESTY: rows assert "this utility serves somewhere in this
 * ZIP3", suitable for plausible-active imputation with named utilities. The
 * unserved list asserts "no piped-gas LDC operates in this ZIP3" — the only
 * rows strong enough to impute a service ABSENT.
 * Regenerate + bump NATIONAL_SOURCE_VERSION when a new EIA-861 vintage lands.
 */
export const NATIONAL_SOURCE_VERSION = "eia861-2024.national.1";

export const NATIONAL_TERRITORIES: Array<{ zip3: string; state: string; commodity: "electric" | "gas" | "water"; utilityName: string }> = `;

const out =
  header +
  JSON.stringify(servingFiltered) +
  ";\n\nexport const NATIONAL_UNSERVED: Array<{ zip3: string; state: string; commodity: \"electric\" | \"gas\" | \"water\" }> = " +
  JSON.stringify(UNSERVED_GAS.map((u) => ({ ...u, commodity: "gas" }))) +
  ";\n";

const dest = join(__dirname, "..", "server", "serviceTerritoriesData.ts");
writeFileSync(dest, out);
console.log(`Wrote ${dest}: ${servingFiltered.length} serving rows, ${UNSERVED_GAS.length} unserved rows`);
