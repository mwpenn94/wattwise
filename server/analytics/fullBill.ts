/**
 * Oct 25 (owner decision, binding): an ESTIMATED FULL BILL shown as a range,
 * separate from the modeled tariff subtotal. No bill is available, so every
 * input below is an official published value and every unknown becomes a
 * bound of the range, never a silent assumption.
 *
 * Scope: UNS Electric (UniSource Energy Services) only — the utility whose
 * LFCR rider and tax schedule were reviewed from official documents. Other
 * utilities return null (the subtotal remains the figure shown).
 *
 * Sources (all official):
 *  - LFCR: Rider R-8, sheet 708 (docs.uesaz.com/wp-content/uploads/708-Rider-8-LFCR-Clean.pdf):
 *    a percentage of "the applicable billing amount", applied to all customers
 *    other than lighting. Rates (EE + DG components): 1.0804% + 0.3517% from
 *    2023-08-01 (Statement of Charges 2024 edition, sheet 801-2); 0.7536% +
 *    0.3462% from 2025-10-01 (ACC announcement 2025-09-17); 0.9298% + 0.4138%
 *    from 2026-09-01 (Statement of Charges sheet 801-2, Decision 82125).
 *    The applicable amount's treatment of surcharges is not stated, so the low
 *    bound uses basic + energy + demand charges and the high bound the whole
 *    modeled subtotal including riders.
 *  - Taxes: UES Customer Information Schedule CIS-2 (eff 2021-08-01): franchise
 *    fee 2% in franchise cities; state TPT 5.6%; city and county TPT; sales taxes
 *    applied after the franchise fee and ACC assessment; ACC assessment 0.20%
 *    (electric) applied after the franchise fee and sales taxes; RUCO 0.04%
 *    residential only; Kingman allows the franchise fee to offset city TPT.
 *    County utilities excise for Mohave County is 0% (AZDOR TPT rate table eff
 *    2025-07-01, Utilities code 004: Mohave 5.60% = state only). Kingman city
 *    TPT 2.50% (AZDOR table) → 3.00% from 2026-09-01 (City of Kingman TPT rates page).
 *  - TCA for demand-billed schedules before 2026-06-01: published as "$0.13 per
 *    kW" on the 2024 Statement of Charges but as a credit on the utility's TCA
 *    page. With the sign unconfirmed it is ±$0.13 per billed kW in those months.
 */
import type { CostResult } from "./tariffEngine";
import { utilityToken } from "../utilityMatch";

export interface FullBillRange { low: number; high: number }
export interface FullBillEstimate {
  basis: "estimated_not_bill_confirmed";
  /** Modeled tariff subtotal the estimate starts from (unchanged). */
  subtotal: number;
  lfcr: FullBillRange;
  /** Signed bound for the unconfirmed pre-June-2026 demand TCA. */
  unconfirmedTca: FullBillRange;
  /** Null when the jurisdiction's tax rates are not on file. */
  taxes: FullBillRange | null;
  total: FullBillRange;
  jurisdiction: { label: string; lowBasis: string; highBasis: string } | null;
  /** Plain one-line summary of what the range covers. */
  summary: string;
  assumptions: string[];
  sources: string[];
}

const LFCR_RIDER = "https://docs.uesaz.com/wp-content/uploads/708-Rider-8-LFCR-Clean.pdf";
const UNS_SOC = "https://docs.uesaz.com/wp-content/uploads/801-UNSE-Statement-of-Charges.pdf";
const CIS2 = "https://docs.uesaz.com/wp-content/uploads/2017/08/UES-CIS-2-Taxes-8-1.pdf";
const AZDOR = "https://azdor.gov/sites/default/files/document/TPT_RATETABLE_07012025.pdf";
const KINGMAN_TPT = "https://www.cityofkingman.gov/government/departments-a-h/finance/tpt-sales-tax-administration/tpt-rates-and-classifications";

/** LFCR percentage (EE + DG) in effect on a month's first day. */
const LFCR_HISTORY: Array<{ from: string; rate: number }> = [
  { from: "2023-08-01", rate: 0.010804 + 0.003517 },
  { from: "2025-10-01", rate: 0.007536 + 0.003462 },
  { from: "2026-09-01", rate: 0.009298 + 0.004138 },
];
export function lfcrRateForMonth(month: string): number | null {
  const day = `${month}-01`;
  let rate: number | null = null;
  for (const v of LFCR_HISTORY) if (day >= v.from) rate = v.rate;
  return rate;
}

const STATE_TPT = 0.056;
const ACC = 0.002;
const RUCO = 0.0004;
const FRANCHISE = 0.02;
/** Kingman city TPT on utilities, dated. */
function kingmanCityTpt(month: string) { return `${month}-01` >= "2026-09-01" ? 0.03 : 0.025; }
/**
 * Census-designated (unincorporated) places in Mohave County served by UNS
 * Electric — no franchise fee or city TPT; county utilities excise is 0%.
 */
const UNINCORPORATED_MOHAVE = new Set([
  "dolan springs", "golden valley", "meadview", "chloride", "fort mohave", "mohave valley", "valle vista", "yucca", "topock", "wikieup", "so-hi", "white hills",
]);

/**
 * CIS-2 cascade for a pretax amount B:
 *   franchise F = f·B; sales tax S = (city + county + state)·(B + F + acc·B + ruco·B);
 *   ACC = acc·(B + F + S); RUCO = ruco·(B + F + S). Returns the tax multiplier on B.
 */
export function cis2TaxRate(p: { franchise: number; cityNet: number; county: number; residential: boolean }): number {
  const ruco = p.residential ? RUCO : 0;
  const B = 1;
  const F = p.franchise * B;
  const S = (p.cityNet + p.county + STATE_TPT) * (B + F + ACC * B + ruco * B);
  const assess = (ACC + ruco) * (B + F + S);
  return F + S + assess;
}

type Jurisdiction = { label: string; low: (month: string) => number; high: (month: string) => number; lowBasis: string; highBasis: string };
function jurisdictionFor(city: string | null | undefined, state: string | null | undefined, residential: boolean): Jurisdiction | null {
  if ((state ?? "").toUpperCase() !== "AZ" || !city) return null;
  const c = city.trim().toLowerCase();
  const unincorporated = (_m: string) => cis2TaxRate({ franchise: 0, cityNet: 0, county: 0, residential });
  if (c === "kingman") {
    return {
      label: "Kingman, Mohave County, AZ",
      low: unincorporated,
      high: (m) => cis2TaxRate({ franchise: FRANCHISE, cityNet: Math.max(0, kingmanCityTpt(m) - FRANCHISE), county: 0, residential }),
      lowBasis: "outside Kingman city limits (a Kingman mailing address can be unincorporated county): state TPT 5.6% + ACC 0.20%",
      highBasis: "inside Kingman city limits: 2% franchise fee + city TPT net of the franchise offset (2.5% − 2% before Sep 2026; 3.0% − 2% from Sep 2026) + state TPT 5.6% + ACC 0.20%",
    };
  }
  if (UNINCORPORATED_MOHAVE.has(c)) {
    return {
      label: `${city.trim()}, Mohave County, AZ (unincorporated)`,
      low: unincorporated,
      high: unincorporated,
      lowBasis: "unincorporated Mohave County: state TPT 5.6% + ACC 0.20% (county utilities excise 0%)",
      highBasis: "unincorporated Mohave County: state TPT 5.6% + ACC 0.20% (county utilities excise 0%)",
    };
  }
  return null;
}

export function isUnsElectric(utilityName: string | null | undefined): boolean {
  if (!utilityName) return false;
  const n = utilityName.toLowerCase();
  if (/\bgas\b/.test(n)) return false;
  return utilityToken(utilityName) === "unisource" || n.includes("uns electric") || n.includes("unisource");
}

/**
 * Estimate the full bill for one or more separately billed accounts on the same
 * site. Each account's monthly costs carry its own months, riders and billed demand.
 */
export function estimateFullBill(input: {
  accounts: CostResult[];
  utilityName: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
  residential?: boolean;
}): FullBillEstimate | null {
  if (!isUnsElectric(input.utilityName) || input.accounts.length === 0) return null;
  const residential = input.residential ?? false;
  const jur = jurisdictionFor(input.city, input.state, residential);
  let subtotal = 0, lfcrLo = 0, lfcrHi = 0, tcaAbs = 0, taxLo = 0, taxHi = 0, tcaMonths = 0;
  const lfcrUnknownMonths = new Set<string>();
  for (const cost of input.accounts) {
    subtotal += cost.breakdown.total;
    const billed = new Map(cost.monthlyDetails.map((d) => [d.month, d.billedDemandKw]));
    const missingTca = new Set((cost.missingRiderCoverage ?? []).filter((r) => r.labels.includes("TCA")).map((r) => r.month));
    // Breakdown-level adjustments not split by month (e.g. minimum-bill) go with the last month.
    const monthlySum = cost.monthlyCosts.reduce((s, m) => s + m.total, 0);
    const residual = cost.breakdown.total - monthlySum;
    cost.monthlyCosts.forEach((m, i) => {
      const rate = lfcrRateForMonth(m.month);
      const total = m.total + (i === cost.monthlyCosts.length - 1 ? residual : 0);
      const baseLo = m.fixed + m.energy + m.demand + m.cp;
      const lLo = rate == null ? 0 : rate * Math.max(0, Math.min(baseLo, total));
      const lHi = rate == null ? 0 : rate * Math.max(0, total);
      if (rate == null) lfcrUnknownMonths.add(m.month);
      lfcrLo += lLo; lfcrHi += lHi;
      const tca = missingTca.has(m.month) ? 0.13 * (billed.get(m.month) ?? 0) : 0;
      if (tca > 0) tcaMonths++;
      tcaAbs += tca;
      if (jur) {
        taxLo += jur.low(m.month) * Math.max(0, total + lLo - tca);
        taxHi += jur.high(m.month) * Math.max(0, total + lHi + tca);
      }
    });
  }
  const lfcr = { low: lfcrLo, high: lfcrHi };
  const unconfirmedTca = { low: -tcaAbs, high: tcaAbs };
  const taxes = jur ? { low: taxLo, high: taxHi } : null;
  const total = {
    low: subtotal + lfcr.low + unconfirmedTca.low + (taxes?.low ?? 0),
    high: subtotal + lfcr.high + unconfirmedTca.high + (taxes?.high ?? 0),
  };
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const assumptions = [
    "Estimated from published UNS Electric and Arizona sources; not confirmed against a utility bill.",
    `Lost Fixed Cost Recovery (Rider R-8) is a percentage of the applicable billing amount: ${usd(lfcr.low)}–${usd(lfcr.high)}. The low end applies it to basic, energy and demand charges only; the high end to the whole subtotal including surcharges.`,
    ...(tcaAbs > 0.5 ? [`The transmission adjustor for demand-billed accounts before June 2026 is published as $0.13 per kW but its sign (charge or credit) is unconfirmed: ±${usd(tcaAbs)} over ${tcaMonths} account-month${tcaMonths === 1 ? "" : "s"}.`] : []),
    ...(jur
      ? [`Taxes and assessments follow UNS schedule CIS-2: ${usd(taxes!.low)}–${usd(taxes!.high)}. Low: ${jur.lowBasis}. High: ${jur.highBasis}.`,
         "Arizona has no general sales-tax exemption for public entities on utility service, so taxes are included; a bill or the district's tax status would settle the exact amount."]
      : [`Taxes are not included: the tax rates for ${input.city ?? "this location"} are not on file. The range covers the subtotal, LFCR and adjustor only.`]),
    "Calendar months stand in for the utility's billing cycles, which may start mid-month.",
    ...(lfcrUnknownMonths.size ? [`LFCR before August 2023 is not on file (${Array.from(lfcrUnknownMonths).sort().join(", ")}); those months exclude LFCR.`] : []),
  ];
  const summary = jur
    ? `Estimated full bill with LFCR and taxes: ${usd(total.low)}–${usd(total.high)} (modeled subtotal ${usd(subtotal)}).`
    : `Estimated bill before taxes, with LFCR: ${usd(total.low)}–${usd(total.high)} (modeled subtotal ${usd(subtotal)}).`;
  return {
    basis: "estimated_not_bill_confirmed",
    subtotal,
    lfcr,
    unconfirmedTca,
    taxes,
    total,
    jurisdiction: jur ? { label: jur.label, lowBasis: jur.lowBasis, highBasis: jur.highBasis } : null,
    summary,
    assumptions,
    sources: [LFCR_RIDER, `${UNS_SOC} (sheet 801-2: LFCR, TCA)`, CIS2, AZDOR, KINGMAN_TPT],
  };
}
