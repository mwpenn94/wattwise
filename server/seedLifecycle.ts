/**
 * v1.22 S-LIFECYCLE / AC18b — seed freshness management.
 *
 * Seeds are living data, not build artifacts. Every seeder declares a refresh
 * cadence recorded in seed_freshness; three mechanisms keep it honest:
 *  1. staleness surfacing — any seed past cadence×1.5 widens the confidence
 *     chips of everything derived from it and shows honest user copy
 *     ("emissions factors from the 2024 grid dataset — update pending"),
 *     never silent rot;
 *  2. non-URDB tariff freshness — currency is EARNED from bills, not assumed
 *     from age: every reconciliation hit resets billVerifiedAt; a non-URDB
 *     tariff unverified for 12 months auto-widens its chips and raises a
 *     template-review task;
 *  3. unknown-tariff crowd discovery — parsed tariff_name_raw values that
 *     match no known record aggregate across users; N≥3 occurrences of the
 *     same unknown name at one utility raises a create-template task; and a
 *     parser-drift monitor raises template-update tasks on success-rate drops.
 *
 * Config-not-constant: thresholds are read from platform_config (seeded with
 * defaults below), never compiled in.
 */
import { and, eq, notLike, sql } from "drizzle-orm";
import { getDb } from "./db";
import { platformConfig, seedFreshness, tariffs, templateTasks } from "../drizzle/schema";

const DAY_MS = 86_400_000;

/** Per-seeder cadence registry (days) — the v1.22 cadence table. Seeded into
 * seed_freshness at boot; the DB row (editable) is the runtime truth. */
export const SEED_CADENCES: Array<{ source: string; cadenceDays: number; label: string }> = [
  { source: "egrid_emissions", cadenceDays: 365, label: "EPA eGRID emissions factors" },
  { source: "eia861_utilities", cadenceDays: 365, label: "EIA-861 electric utility registry" },
  { source: "water_gas_registries", cadenceDays: 365, label: "SDWIS / EIA-176 + PUC gas registries" },
  { source: "assessor_parcels", cadenceDays: 365, label: "County assessor parcel attributes" },
  { source: "urdb_snapshot", cadenceDays: 91, label: "OpenEI URDB bulk tariff snapshot" },
  { source: "incentives_dsire", cadenceDays: 30, label: "DSIRE + utility programs + compliance tables" },
  { source: "gas_water_templates", cadenceDays: 182, label: "Gas/water tariff templates (major providers)" },
  { source: "overture_buildings", cadenceDays: 30, label: "Overture buildings/places extracts" },
  { source: "archetype_profiles", cadenceDays: 365, label: "ResStock/ComStock archetypes + benchmarks" },
  { source: "weather_normals", cadenceDays: 365, label: "NOAA normals / TMY profiles" },
];

/** Config-not-constant defaults, seeded into platform_config. */
export const CONFIG_DEFAULTS: Array<{ key: string; value: string; description: string }> = [
  { key: "seed.staleness_multiplier", value: "1.5", description: "Seed past cadence × this widens derived chips + alerts ops" },
  { key: "tariff.bill_verification_window_days", value: "365", description: "Non-URDB tariff unverified this long → chips widen + review task" },
  { key: "tariff.unknown_name_task_threshold", value: "3", description: "N unmatched tariff_name_raw occurrences at one utility → create-template task" },
  { key: "parser.drift_success_floor", value: "0.7", description: "Per-template parse success below this raises a template-update task" },
  { key: "estimate.daily_ip_cap", value: "20", description: "Anonymous estimator requests per IP per day" },
  { key: "free.site_cap", value: "1", description: "Free-tier site quota" },
  { key: "free.scenario_cap", value: "3", description: "Free-tier scenarios per month" },
];

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  return db;
}

/** Read a numeric config value with a compiled fallback (fail-open). */
export async function configNumber(key: string, fallback: number): Promise<number> {
  try {
    const db = await requireDb();
    const rows = await db.select().from(platformConfig).where(eq(platformConfig.configKey, key)).limit(1);
    const v = rows[0]?.configValue;
    const n = v != null ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Idempotent boot registration: cadences + config defaults. Existing rows are
 * never overwritten (ops may have tuned them); only missing rows are added. */
export async function registerSeedFreshness(seedVersion: string): Promise<void> {
  const db = await requireDb();
  const now = Date.now();
  for (const c of SEED_CADENCES) {
    await db
      .insert(seedFreshness)
      .values({ source: c.source, version: seedVersion, seededAt: now, cadenceDays: c.cadenceDays, lastCheckedAt: now })
      .onDuplicateKeyUpdate({ set: { lastCheckedAt: now } });
  }
  for (const c of CONFIG_DEFAULTS) {
    await db
      .insert(platformConfig)
      .values({ configKey: c.key, configValue: c.value, description: c.description })
      .onDuplicateKeyUpdate({ set: { configKey: sql`configKey` } }); // no-op if present
  }
}

export interface SeedStaleness {
  source: string;
  label: string;
  version: string;
  seededAt: number;
  cadenceDays: number;
  ageDays: number;
  stale: boolean;
  /** honest user copy — shown on chips derived from this seed */
  userNote: string | null;
}

/** Assess every registered seed. stale = age > cadence × multiplier. */
export async function assessSeedFreshness(now = Date.now()): Promise<SeedStaleness[]> {
  const db = await requireDb();
  const mult = await configNumber("seed.staleness_multiplier", 1.5);
  const rows = await db.select().from(seedFreshness);
  return rows.map((r) => {
    const meta = SEED_CADENCES.find((c) => c.source === r.source);
    const ageDays = Math.floor((now - r.seededAt) / DAY_MS);
    const stale = ageDays > r.cadenceDays * mult;
    return {
      source: r.source,
      label: meta?.label ?? r.source,
      version: r.version,
      seededAt: r.seededAt,
      cadenceDays: r.cadenceDays,
      ageDays,
      stale,
      userNote: stale
        ? `${meta?.label ?? r.source} last refreshed ${ageDays} days ago (cadence ${r.cadenceDays}d) — update pending; treat derived figures as wider than shown.`
        : null,
    };
  });
}

/** Map insight/analysis domains to their underlying seeds so chip-widening
 * can name the reason. Returns the stale seeds relevant to a domain. */
export async function staleSeedsForDomain(
  domain: "emissions" | "tariffs" | "benchmark" | "archetype" | "weather" | "incentives",
  now = Date.now(),
): Promise<SeedStaleness[]> {
  const domainSeeds: Record<string, string[]> = {
    emissions: ["egrid_emissions"],
    tariffs: ["urdb_snapshot", "gas_water_templates", "eia861_utilities", "water_gas_registries"],
    benchmark: ["archetype_profiles"],
    archetype: ["archetype_profiles"],
    weather: ["weather_normals"],
    incentives: ["incentives_dsire"],
  };
  const all = await assessSeedFreshness(now);
  const keys = domainSeeds[domain] ?? [];
  return all.filter((s) => keys.includes(s.source) && s.stale);
}

/** v1.22 non-URDB tariff freshness policy. Called by the reconciliation loop
 * on every HIT (reset the clock) and by the periodic sweep (find 12-month-
 * unverified non-URDB tariffs → widen + review task). */
export async function touchBillVerification(tariffId: number, now = Date.now()): Promise<void> {
  const db = await requireDb();
  await db.update(tariffs).set({ billVerifiedAt: now }).where(eq(tariffs.id, tariffId));
}

export interface TariffFreshnessFinding {
  tariffId: number;
  name: string;
  utilityName: string | null;
  monthsUnverified: number;
}

/** Sweep non-URDB (manual/template) tariffs for the 12-month unverified rule.
 * Widens trust to mismatch-free "seeded" honesty via a review task; never
 * silently deletes or downgrades a customer's current basis. */
export async function sweepUnverifiedTariffs(now = Date.now()): Promise<TariffFreshnessFinding[]> {
  const db = await requireDb();
  const windowDays = await configNumber("tariff.bill_verification_window_days", 365);
  const cutoff = now - windowDays * DAY_MS;
  // Non-URDB records: manual entries, gas/water templates, synthesized state
  // representatives — anything whose currency no feed announces.
  const rows = await db.select().from(tariffs).where(notLike(tariffs.source, "urdb_snapshot%"));
  const findings: TariffFreshnessFinding[] = [];
  for (const t of rows) {
    const anchor = t.billVerifiedAt ?? (t.effectiveDate ? new Date(t.effectiveDate).getTime() : null);
    if (anchor != null && anchor >= cutoff) continue;
    const monthsUnverified = anchor ? Math.floor((now - anchor) / (30 * DAY_MS)) : windowDays / 30;
    findings.push({ tariffId: t.id, name: t.name, utilityName: t.utilityName ?? null, monthsUnverified });
    await db
      .insert(templateTasks)
      .values({
        kind: "template_review",
        utilityName: t.utilityName ?? null,
        tariffNameRaw: t.name,
        note: `Non-URDB tariff unverified by any bill for ${monthsUnverified}+ months — currency is earned from bills, not assumed from age.`,
      })
      .onDuplicateKeyUpdate({ set: { occurrences: sql`occurrences + 1` } });
  }
  return findings;
}

/** v1.22 unknown-tariff crowd discovery: record an unmatched tariff_name_raw;
 * at N≥threshold occurrences for one utility, the create-template task opens
 * (the ON DUPLICATE path counts occurrences on the same task row). Returns
 * whether the task has crossed the threshold. */
export async function recordUnknownTariff(utilityName: string, tariffNameRaw: string): Promise<{ occurrences: number; taskOpen: boolean }> {
  const db = await requireDb();
  const threshold = await configNumber("tariff.unknown_name_task_threshold", 3);
  const cleanName = tariffNameRaw.trim().slice(0, 190);
  const cleanUtility = utilityName.trim().slice(0, 128);
  if (!cleanName) return { occurrences: 0, taskOpen: false };
  await db
    .insert(templateTasks)
    .values({
      kind: "create_template",
      utilityName: cleanUtility,
      tariffNameRaw: cleanName,
      occurrences: 1,
      note: `Users' bills name a tariff we don't carry.`,
    })
    .onDuplicateKeyUpdate({ set: { occurrences: sql`occurrences + 1` } });
  const rows = await db
    .select()
    .from(templateTasks)
    .where(and(eq(templateTasks.kind, "create_template"), eq(templateTasks.utilityName, cleanUtility), eq(templateTasks.tariffNameRaw, cleanName)))
    .limit(1);
  const occurrences = rows[0]?.occurrences ?? 1;
  return { occurrences, taskOpen: occurrences >= threshold };
}

/** v1.22 parser-drift monitor: rolling per-template parse success. Kept simple
 * and DB-backed: counts live in platform_config as parser.stats.<template>
 * "success/total"; below the floor with ≥10 attempts raises a template-update
 * task before users feel the drift. */
export async function recordParseOutcome(templateKey: string, success: boolean): Promise<{ successRate: number; drift: boolean }> {
  const db = await requireDb();
  const key = `parser.stats.${templateKey}`.slice(0, 96);
  const rows = await db.select().from(platformConfig).where(eq(platformConfig.configKey, key)).limit(1);
  const [s0, t0] = (rows[0]?.configValue ?? "0/0").split("/").map((n) => Number(n) || 0);
  const s1 = s0 + (success ? 1 : 0);
  const t1 = t0 + 1;
  const value = `${s1}/${t1}`;
  await db
    .insert(platformConfig)
    .values({ configKey: key, configValue: value, description: `Parser success counter for template ${templateKey}` })
    .onDuplicateKeyUpdate({ set: { configValue: value } });
  const rate = t1 > 0 ? s1 / t1 : 1;
  const floor = await configNumber("parser.drift_success_floor", 0.7);
  const drift = t1 >= 10 && rate < floor;
  if (drift) {
    // MySQL unique keys treat NULL columns as distinct, so the (kind, utility,
    // name) key can't dedupe utilityName=NULL rows — dedupe in code: bump the
    // existing open task instead of inserting a twin.
    const existing = await db
      .select()
      .from(templateTasks)
      .where(and(eq(templateTasks.kind, "template_update"), eq(templateTasks.tariffNameRaw, templateKey), eq(templateTasks.status, "open")))
      .limit(1);
    const note = `Parse success ${(rate * 100).toFixed(0)}% over ${t1} attempts — below the ${(floor * 100).toFixed(0)}% floor. Re-derive the template before users feel it.`;
    if (existing[0]) {
      await db
        .update(templateTasks)
        .set({ occurrences: sql`occurrences + 1`, note })
        .where(eq(templateTasks.id, existing[0].id));
    } else {
      await db.insert(templateTasks).values({ kind: "template_update", utilityName: null, tariffNameRaw: templateKey, note });
    }
  }
  return { successRate: rate, drift };
}
