/**
 * GAP AC16b — building performance-standard compliance.
 *
 * Seeded snapshot of the WA Clean Buildings Performance Standard (RCW
 * 19.27A.200+): commercial buildings ≥50,000 sqft face binding EUI targets on
 * a phased deadline schedule (Tier 1 ≥220k sqft by Jun 2026, 90k–220k by Jun
 * 2027, 50k–90k by Jun 2028), with penalties up to $5,000 + $1/sqft/yr for
 * non-compliance. Tier 2 (20k–50k sqft) has a later, lighter reporting
 * obligation — we surface it as "reporting only" awareness.
 *
 * The card contract from the spec:
 *  - only renders for sites where a program plausibly applies (jurisdiction,
 *    sector, floor area) — never noise for everyone else;
 *  - shows a COUNTDOWN to the deadline, the site's measured/estimated EUI vs
 *    its target, the gap as a path-to-target sentence, and the penalty
 *    exposure in dollars if it misses;
 *  - EUI basis is disclosed (measured interval/bill data vs archetype
 *    estimate) — an estimated EUI never masquerades as measured.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { compliancePrograms } from "../drizzle/schema";

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

interface SeedProgram {
  code: string;
  name: string;
  jurisdiction: string;
  minSqft: number;
  buildingTypes: string[] | null; // null = all commercial
  /** kBtu/sqft/yr targets by building type, "default" fallback */
  targetEuiByType: Record<string, number>;
  deadline: string; // ISO
  penaltyPerSqftUsd: number;
  sourceName: string;
  sourceUrl?: string;
}

const SEED: SeedProgram[] = [
  {
    code: "wa_clean_buildings_t1_mid",
    name: "WA Clean Buildings Performance Standard (Tier 1, 90k–220k sqft)",
    jurisdiction: "WA",
    minSqft: 90_000,
    buildingTypes: null,
    targetEuiByType: { office: 47, retail: 51, warehouse: 30, restaurant: 165, school: 42, default: 55 },
    deadline: "2027-06-01",
    penaltyPerSqftUsd: 1.0,
    sourceName: "WA Dept. of Commerce — Clean Buildings (RCW 19.27A)",
    sourceUrl: "https://www.commerce.wa.gov/growing-the-economy/energy/buildings/",
  },
  {
    code: "wa_clean_buildings_t1_small",
    name: "WA Clean Buildings Performance Standard (Tier 1, 50k–90k sqft)",
    jurisdiction: "WA",
    minSqft: 50_000,
    buildingTypes: null,
    targetEuiByType: { office: 47, retail: 51, warehouse: 30, restaurant: 165, school: 42, default: 55 },
    deadline: "2028-06-01",
    penaltyPerSqftUsd: 1.0,
    sourceName: "WA Dept. of Commerce — Clean Buildings (RCW 19.27A)",
    sourceUrl: "https://www.commerce.wa.gov/growing-the-economy/energy/buildings/",
  },
  {
    code: "wa_clean_buildings_t2",
    name: "WA Clean Buildings Tier 2 (20k–50k sqft — reporting obligation)",
    jurisdiction: "WA",
    minSqft: 20_000,
    buildingTypes: null,
    targetEuiByType: { default: 0 }, // reporting only — no binding EUI target yet
    deadline: "2027-07-01",
    penaltyPerSqftUsd: 0,
    sourceName: "WA Dept. of Commerce — Clean Buildings Tier 2",
  },
];

let seededOnce = false;
export async function seedCompliancePrograms(): Promise<void> {
  if (seededOnce) return;
  const db = await getDb();
  if (!db) return;
  for (const s of SEED) {
    const existing = await db
      .select({ id: compliancePrograms.id })
      .from(compliancePrograms)
      .where(eq(compliancePrograms.code, s.code))
      .limit(1);
    if (existing.length) continue;
    await db.insert(compliancePrograms).values({
      code: s.code,
      name: s.name,
      jurisdiction: s.jurisdiction,
      minSqft: s.minSqft,
      buildingTypes: s.buildingTypes ? JSON.stringify(s.buildingTypes) : null,
      targetEuiByType: JSON.stringify(s.targetEuiByType),
      deadline: new Date(s.deadline + "T00:00:00Z").getTime(),
      penaltyPerSqftUsd: s.penaltyPerSqftUsd,
      sourceName: s.sourceName,
      sourceUrl: s.sourceUrl ?? null,
      createdAt: Date.now(),
    });
  }
  seededOnce = true;
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

export interface ComplianceAssessment {
  programCode: string;
  programName: string;
  deadline: number;
  monthsToDeadline: number;
  bindingTarget: boolean;
  targetEuiKbtu: number | null;
  siteEuiKbtu: number | null;
  euiBasis: "measured" | "estimated" | "unknown";
  gapPct: number | null; // positive = over target (bad)
  onTrack: boolean | null;
  penaltyExposureUsd: number | null;
  pathToTarget: string;
  disclosure: string;
}

const KBTU_PER_KWH = 3.412;

/** Assess a site against seeded programs. `annualKwh` is total site electric
 * usage; callers pass euiBasis to keep the measured/estimated distinction
 * honest. Residential and small sites return []. */
export async function assessCompliance(opts: {
  state: string | null;
  buildingType: string | null;
  sqft: number | null;
  annualKwh: number | null;
  euiBasis: "measured" | "estimated" | "unknown";
  now?: number;
}): Promise<ComplianceAssessment[]> {
  const db = await getDb();
  if (!db) return [];
  if (!opts.state || !opts.sqft || opts.sqft <= 0) return [];
  if (opts.buildingType && ["single_family", "multifamily"].includes(opts.buildingType)) return [];
  await seedCompliancePrograms();
  const now = opts.now ?? Date.now();
  const rows = await db.select().from(compliancePrograms);
  const out: ComplianceAssessment[] = [];
  // Pick the single most specific program per jurisdiction: the one with the
  // highest minSqft the site still clears (tiers are mutually exclusive bands).
  const applicable = rows
    .filter((p) => p.jurisdiction === opts.state && opts.sqft! >= p.minSqft && p.deadline > now)
    .sort((a, b) => b.minSqft - a.minSqft);
  const program = applicable[0];
  if (!program) return [];

  let targets: Record<string, number> = {};
  try {
    targets = JSON.parse(program.targetEuiByType);
  } catch {
    /* fall through with empty targets */
  }
  const binding = program.penaltyPerSqftUsd > 0;
  const target = binding ? (targets[opts.buildingType ?? "default"] ?? targets.default ?? null) : null;
  const siteEui =
    opts.annualKwh != null && opts.annualKwh > 0 ? Math.round(((opts.annualKwh * KBTU_PER_KWH) / opts.sqft) * 10) / 10 : null;
  const gapPct = target != null && siteEui != null && target > 0 ? Math.round(((siteEui - target) / target) * 100) : null;
  const monthsToDeadline = Math.max(0, Math.round((program.deadline - now) / (30.44 * 24 * 3600 * 1000)));
  const over = gapPct != null && gapPct > 0;
  const penalty = binding && over ? Math.round(5000 + program.penaltyPerSqftUsd * opts.sqft) : binding ? 0 : null;

  const pathToTarget = !binding
    ? `Tier 2 is a reporting obligation — benchmark and submit energy data by the deadline; no binding EUI target yet.`
    : siteEui == null
      ? `We can't compute your EUI yet — add 12 months of bills or interval data to see where you stand against the ${target} kBtu/sqft target.`
      : over
        ? `Your EUI is ${siteEui} kBtu/sqft vs a ${target} target — a ${gapPct}% gap. Closing it typically means HVAC scheduling, lighting, and envelope work; your opportunity feed already prices the first steps.`
        : `Your EUI is ${siteEui} kBtu/sqft vs a ${target} target — you're under the line. Keep monitoring; the standard tightens in later cycles.`;

  out.push({
    programCode: program.code,
    programName: program.name,
    deadline: program.deadline,
    monthsToDeadline,
    bindingTarget: binding,
    targetEuiKbtu: target,
    siteEuiKbtu: siteEui,
    euiBasis: opts.euiBasis,
    gapPct,
    onTrack: gapPct == null ? null : !over,
    penaltyExposureUsd: penalty,
    pathToTarget,
    disclosure:
      `Seeded from ${program.sourceName} — a static snapshot; verify current requirements with the program before acting. ` +
      (opts.euiBasis === "measured"
        ? "EUI computed from your measured usage data."
        : opts.euiBasis === "estimated"
          ? "EUI is an archetype-based ESTIMATE — upload bills or intervals to replace it with your real number."
          : "EUI basis unknown — insufficient usage data."),
  });
  return out;
}
