/**
 * GAP AC15 — the incentives layer.
 *
 * A curated seed of federal/state/utility incentives, each with an explicit
 * expiration and a named source. The contract from the spec:
 *  - An EXPIRED incentive must never render anywhere.
 *  - Measure economics show BOTH pre- and post-incentive paybacks, with the
 *    incentive named and sourced — never a silent net number.
 *  - Demand-response enrollments are negative-cost actions: the utility pays
 *    the user. They surface as "they pay you" cards (usd_per_year).
 *  - Every incentive card names who pays (IRS / state / utility) and who
 *    benefits (owner vs occupant), consistent with the tenure model: a renter
 *    is never shown an owner-only tax credit as if it were theirs.
 *
 * Seed honesty: these are real program shapes (ITC 25D/48E, 179D, AZ/WA state
 * and utility programs) captured as a static snapshot. Every card carries the
 * seed disclosure and the source name so the user can verify before acting.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { incentives, type Incentive } from "../drizzle/schema";

/* ------------------------------------------------------------------ */
/* Seed catalog                                                        */
/* ------------------------------------------------------------------ */

interface SeedIncentive {
  code: string;
  name: string;
  level: "federal" | "state" | "utility";
  jurisdiction: string;
  utilityName?: string;
  measureKeys: string[];
  sectorClass: "residential" | "commercial" | "both";
  kind: "tax_credit" | "rebate" | "bill_credit" | "dr_payment";
  amountType: "percent_of_cost" | "fixed_usd" | "usd_per_year";
  amountValue: number;
  amountCapUsd?: number;
  /** ISO date or null for no legislated sunset */
  expires?: string;
  sourceName: string;
  sourceUrl?: string;
  notes?: string;
}

const SEED: SeedIncentive[] = [
  {
    code: "itc_residential_25d",
    name: "Federal Residential Clean Energy Credit (25D)",
    level: "federal",
    jurisdiction: "US",
    measureKeys: ["solar", "battery"],
    sectorClass: "residential",
    kind: "tax_credit",
    amountType: "percent_of_cost",
    amountValue: 0.3,
    expires: "2032-12-31",
    sourceName: "IRS — 26 U.S.C. §25D",
    sourceUrl: "https://www.irs.gov/credits-deductions/residential-clean-energy-credit",
    notes: "30% of system cost, no cap. Requires federal tax liability — who benefits: the property OWNER who files.",
  },
  {
    code: "itc_commercial_48e",
    name: "Federal Clean Electricity Investment Credit (48E)",
    level: "federal",
    jurisdiction: "US",
    measureKeys: ["solar", "battery"],
    sectorClass: "commercial",
    kind: "tax_credit",
    amountType: "percent_of_cost",
    amountValue: 0.3,
    expires: "2033-12-31",
    sourceName: "IRS — 26 U.S.C. §48E",
    notes: "Base 30% with prevailing-wage compliance for systems >1MW; smaller commercial systems qualify at 30%.",
  },
  {
    code: "deduction_179d",
    name: "Federal Energy-Efficient Commercial Buildings Deduction (179D)",
    level: "federal",
    jurisdiction: "US",
    measureKeys: ["hvac_tuneup", "led_retrofit", "smart_thermostat", "baseload_reduction"],
    sectorClass: "commercial",
    kind: "tax_credit",
    amountType: "fixed_usd",
    amountValue: 1.0,
    sourceName: "IRS — 26 U.S.C. §179D",
    notes: "Up to ~$1.00–$5.00 per sqft depending on savings and wage compliance; we quote the conservative floor per sqft. Who benefits: building OWNER (or designer for public buildings).",
  },
  {
    code: "az_aps_thermostat_dr",
    name: "APS Cool Rewards smart-thermostat demand response",
    level: "utility",
    jurisdiction: "AZ",
    utilityName: "APS",
    measureKeys: ["smart_thermostat", "peak_management", "hvac_tuneup"],
    sectorClass: "residential",
    kind: "dr_payment",
    amountType: "usd_per_year",
    amountValue: 50,
    sourceName: "APS Cool Rewards program",
    notes: "Enrollment credit plus annual participation credit — THEY PAY YOU. Utility may briefly adjust your thermostat during summer peak events; you can override.",
  },
  {
    code: "az_srp_thermostat_dr",
    name: "SRP Bring-Your-Own-Thermostat demand response",
    level: "utility",
    jurisdiction: "AZ",
    utilityName: "SRP",
    measureKeys: ["smart_thermostat", "peak_management", "hvac_tuneup"],
    sectorClass: "residential",
    kind: "dr_payment",
    amountType: "usd_per_year",
    amountValue: 25,
    sourceName: "SRP BYOT program",
    notes: "Annual bill credit per enrolled thermostat — THEY PAY YOU.",
  },
  {
    code: "wa_pse_commercial_lighting",
    name: "PSE commercial lighting retrofit rebate",
    level: "utility",
    jurisdiction: "WA",
    utilityName: "PSE",
    measureKeys: ["led_retrofit"],
    sectorClass: "commercial",
    kind: "rebate",
    amountType: "percent_of_cost",
    amountValue: 0.35,
    amountCapUsd: 20_000,
    sourceName: "PSE Business Lighting program",
    notes: "Prescriptive + custom lighting rebates, roughly 20–50% of project cost; we quote 35% capped at $20k.",
  },
  {
    code: "expired_example_ev_credit",
    name: "Expired legacy state solar credit (test guard)",
    level: "state",
    jurisdiction: "AZ",
    measureKeys: ["solar"],
    sectorClass: "both",
    kind: "tax_credit",
    amountType: "fixed_usd",
    amountValue: 1000,
    expires: "2021-12-31",
    sourceName: "Expired program — must never render",
    notes: "Deliberately expired seed row: pins the never-render-expired contract in tests.",
  },
];

let seededOnce = false;
export async function seedIncentives(): Promise<void> {
  if (seededOnce) return;
  const db = await getDb();
  if (!db) return;
  for (const s of SEED) {
    const existing = await db.select({ id: incentives.id }).from(incentives).where(eq(incentives.code, s.code)).limit(1);
    if (existing.length) continue;
    await db.insert(incentives).values({
      code: s.code,
      name: s.name,
      level: s.level,
      jurisdiction: s.jurisdiction,
      utilityName: s.utilityName ?? null,
      measureKeys: JSON.stringify(s.measureKeys),
      sectorClass: s.sectorClass,
      kind: s.kind,
      amountType: s.amountType,
      amountValue: s.amountValue,
      amountCapUsd: s.amountCapUsd ?? null,
      expiresAt: s.expires ? new Date(s.expires + "T23:59:59Z").getTime() : null,
      sourceName: s.sourceName,
      sourceUrl: s.sourceUrl ?? null,
      notes: s.notes ?? null,
      createdAt: Date.now(),
    });
  }
  seededOnce = true;
}

/* ------------------------------------------------------------------ */
/* Matching + economics                                                */
/* ------------------------------------------------------------------ */

export interface IncentiveMatch {
  code: string;
  name: string;
  level: string;
  kind: string;
  /** computed dollar value against the given capex (capped) */
  valueUsd: number;
  /** for dr_payment: recurring annual payment instead of capex offset */
  annualUsd: number | null;
  whoPays: string;
  whoBenefits: "owner" | "occupant" | "either";
  sourceName: string;
  sourceUrl: string | null;
  expiresAt: number | null;
  disclosure: string;
}

export interface IncentiveEconomics {
  matches: IncentiveMatch[];
  capexUsd: number;
  netCapexUsd: number;
  /** payback on gross capex — null when savings ≤ 0 */
  paybackPreYears: number | null;
  /** payback on net capex after non-recurring incentives */
  paybackPostYears: number | null;
  /** extra annual dollars from DR-style payments */
  annualIncentiveUsd: number;
}

function whoBenefitsFor(inc: Pick<Incentive, "kind" | "sectorClass" | "notes">): "owner" | "occupant" | "either" {
  if (inc.kind === "tax_credit") return "owner";
  if (inc.kind === "dr_payment" || inc.kind === "bill_credit") return "occupant";
  return "either"; // rebates follow whoever pays for the equipment
}

function whoPaysFor(inc: Pick<Incentive, "level" | "utilityName">): string {
  if (inc.level === "federal") return "IRS (federal tax credit)";
  if (inc.level === "state") return "State revenue department";
  return `${inc.utilityName ?? "Your utility"} (utility program)`;
}

/** Match live (non-expired) incentives for a measure in a jurisdiction. */
export async function matchIncentives(opts: {
  measureKey: string;
  state: string | null;
  utilityName?: string | null;
  sectorClass: "residential" | "commercial";
  capexUsd: number;
  now?: number;
}): Promise<IncentiveMatch[]> {
  const db = await getDb();
  if (!db) return [];
  await seedIncentives();
  const now = opts.now ?? Date.now();
  const rows = await db.select().from(incentives);
  const out: IncentiveMatch[] = [];
  for (const r of rows) {
    // HARD RULE: an expired incentive must never render.
    if (r.expiresAt != null && r.expiresAt < now) continue;
    let keys: string[] = [];
    try {
      keys = JSON.parse(r.measureKeys);
    } catch {
      continue;
    }
    if (!keys.includes(opts.measureKey)) continue;
    if (r.sectorClass !== "both" && r.sectorClass !== opts.sectorClass) continue;
    if (r.jurisdiction !== "US" && r.jurisdiction !== (opts.state ?? "")) continue;
    if (r.utilityName && opts.utilityName && r.utilityName.toLowerCase() !== opts.utilityName.toLowerCase()) continue;

    let valueUsd = 0;
    let annualUsd: number | null = null;
    if (r.amountType === "percent_of_cost") {
      valueUsd = opts.capexUsd * r.amountValue;
      if (r.amountCapUsd != null) valueUsd = Math.min(valueUsd, r.amountCapUsd);
    } else if (r.amountType === "fixed_usd") {
      valueUsd = r.amountCapUsd != null ? Math.min(r.amountValue, r.amountCapUsd) : r.amountValue;
    } else {
      annualUsd = r.amountValue;
    }
    const benefits = whoBenefitsFor(r);
    out.push({
      code: r.code,
      name: r.name,
      level: r.level,
      kind: r.kind,
      valueUsd: Math.round(valueUsd),
      annualUsd,
      whoPays: whoPaysFor(r),
      whoBenefits: benefits,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      expiresAt: r.expiresAt,
      disclosure:
        `Seeded from ${r.sourceName}` +
        (r.expiresAt ? `; expires ${new Date(r.expiresAt).toLocaleDateString("en-US")}` : "") +
        `. Who pays: ${whoPaysFor(r)}. Who benefits: ${benefits === "owner" ? "the property owner" : benefits === "occupant" ? "the occupant paying the bill" : "whoever funds the equipment"}.` +
        " Verify current terms before committing — programs change and our snapshot may lag.",
    });
  }
  return out;
}

/** Pre/post-incentive payback economics for a measure. Tenure-honest: pass
 * `tenure` so a renter is never quoted an owner-only credit as if theirs. */
export async function incentiveEconomics(opts: {
  measureKey: string;
  state: string | null;
  utilityName?: string | null;
  sectorClass: "residential" | "commercial";
  capexUsd: number;
  annualSavingsUsd: number;
  tenure?: string | null;
  now?: number;
}): Promise<IncentiveEconomics> {
  const all = await matchIncentives(opts);
  // Tenure filter: renters only see occupant/either benefits.
  const matches = (opts.tenure === "rent" ? all.filter((m) => m.whoBenefits !== "owner") : all);
  const oneTime = matches.reduce((s, m) => s + (m.annualUsd == null ? m.valueUsd : 0), 0);
  const annual = matches.reduce((s, m) => s + (m.annualUsd ?? 0), 0);
  const netCapex = Math.max(0, opts.capexUsd - oneTime);
  const effAnnual = opts.annualSavingsUsd + annual;
  const pre = opts.annualSavingsUsd > 0 && opts.capexUsd > 0 ? opts.capexUsd / opts.annualSavingsUsd : opts.capexUsd === 0 ? 0 : null;
  const post = effAnnual > 0 ? netCapex / effAnnual : netCapex === 0 ? 0 : null;
  return {
    matches,
    capexUsd: opts.capexUsd,
    netCapexUsd: netCapex,
    paybackPreYears: pre != null ? Math.round(pre * 10) / 10 : null,
    paybackPostYears: post != null ? Math.round(post * 10) / 10 : null,
    annualIncentiveUsd: Math.round(annual),
  };
}
