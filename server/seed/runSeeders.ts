/**
 * Idempotent, versioned seeder pipeline (handoff §3).
 * Each seeder: checks seeder_runs for (seeder, version) complete → skips;
 * otherwise upserts rows and records license + provenance.
 * Runs automatically at server boot (non-blocking) and via `pnpm seed`.
 */
import { getDb } from "../db";
import {
  archetypeProfiles,
  benchmarks,
  emissionsFactors,
  seederRuns,
  tariffs,
  weatherNormals,
  zipSubregions,
  convergenceLog,
  seedFreshness,
} from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import {
  ARCHETYPE_SPECS,
  EGRID_FACTORS,
  EUI_BENCHMARKS,
  SEED_TARIFFS,
  SEED_VERSION,
  WEATHER_STATIONS_FULL,
  ZIP3_SUBREGIONS,
  generateShape8760,
  synthesizeTmyHourly,
} from "./seedData";
import { LABEL_PROTOTYPE_ARCHETYPE } from "../../shared/wattwise";
import { registerSeedFreshness } from "../seedLifecycle";
import {
  STATE_PROFILES,
  ZONE_STATIONS,
  generateNationalTariffs,
  generateNationalGasWaterTariffs,
  zoneStationNormals,
} from "./nationalData";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function alreadySeeded(db: Db, seeder: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(seederRuns)
    .where(and(eq(seederRuns.seeder, seeder), eq(seederRuns.version, SEED_VERSION)))
    .limit(1);
  return rows.length > 0 && rows[0].status === "complete";
}

async function recordRun(
  db: Db,
  seeder: string,
  rowsSeeded: number,
  license: string,
  licenseUrl: string,
  notes: string,
) {
  await db
    .insert(seederRuns)
    .values({
      seeder,
      version: SEED_VERSION,
      status: "complete",
      rowsSeeded,
      license,
      licenseUrl,
      notes,
      completedAt: new Date(),
    })
    .onDuplicateKeyUpdate({
      set: { status: "complete", rowsSeeded, completedAt: new Date() },
    });
}

export async function seedEgrid(db: Db) {
  if (await alreadySeeded(db, "egrid")) return 0;
  let n = 0;
  for (const f of EGRID_FACTORS) {
    await db
      .insert(emissionsFactors)
      .values({ ...f, source: "epa_egrid", sourceVersion: SEED_VERSION })
      .onDuplicateKeyUpdate({ set: { co2eLbPerMwh: f.co2eLbPerMwh, sourceVersion: SEED_VERSION } });
    n++;
  }
  for (const z of ZIP3_SUBREGIONS) {
    await db
      .insert(zipSubregions)
      .values({ ...z, sourceVersion: SEED_VERSION })
      .onDuplicateKeyUpdate({ set: { subregion: z.subregion, sourceVersion: SEED_VERSION } });
    n++;
  }
  await recordRun(db, "egrid", n, "Public domain (US EPA)", "https://www.epa.gov/egrid", "eGRID2022 subregion CO2e output emission rates + zip3 crosswalk (launch territories)");
  return n;
}

export async function seedBenchmarks(db: Db) {
  if (await alreadySeeded(db, "benchmarks")) return 0;
  let n = 0;
  for (const b of EUI_BENCHMARKS) {
    // idempotency: unique on (buildingType, sectorClass, commodity) — emulate upsert
    const existing = await db
      .select({ id: benchmarks.id })
      .from(benchmarks)
      .where(
        and(
          eq(benchmarks.buildingType, b.buildingType),
          eq(benchmarks.sectorClass, b.sectorClass),
          eq(benchmarks.commodity, b.commodity),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      await db.insert(benchmarks).values({ ...b, sourceVersion: SEED_VERSION });
    }
    n++;
  }
  await recordRun(db, "benchmarks", n, "Public domain (EIA/EPA)", "https://www.eia.gov/consumption/", "CBECS 2018 / RECS 2020 / MECS median & quartile EUIs by building type");
  return n;
}

export async function seedWeather(db: Db) {
  if (await alreadySeeded(db, "weather_normals")) return 0;
  let n = 0;
  for (const st of WEATHER_STATIONS_FULL) {
    const tmy = synthesizeTmyHourly(st.monthlyNormals);
    await db
      .insert(weatherNormals)
      .values({
        stationId: st.stationId,
        stationName: st.stationName,
        climateZone: st.climateZone,
        state: st.state,
        monthlyNormals: st.monthlyNormals,
        tmyHourlyTempF: tmy,
        source: "noaa_normals_1991_2020_synthesized_hourly",
        sourceVersion: SEED_VERSION,
      })
      .onDuplicateKeyUpdate({ set: { monthlyNormals: st.monthlyNormals, tmyHourlyTempF: tmy, sourceVersion: SEED_VERSION } });
    n++;
  }
  await recordRun(db, "weather_normals", n, "Public domain (NOAA)", "https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals", "NOAA 1991-2020 monthly normals, AZ launch stations; hourly series synthesized from normals (labeled)");
  return n;
}

export async function seedTariffs(db: Db) {
  if (await alreadySeeded(db, "tariffs")) return 0;
  let n = 0;
  for (const t of SEED_TARIFFS) {
    const existing = await db
      .select({ id: tariffs.id })
      .from(tariffs)
      .where(and(eq(tariffs.utilityName, t.utilityName), eq(tariffs.name, t.name)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(tariffs).values({
        urdbId: t.urdbId,
        utilityName: t.utilityName,
        name: t.name,
        sector: t.sector,
        commodity: t.commodity,
        state: t.state,
        peakKwMin: t.peakKwMin,
        peakKwMax: t.peakKwMax,
        structure: t.structure,
        freshness: t.freshness,
        effectiveDate: new Date(t.effectiveDate),
        source: "urdb_snapshot_modeled",
        sourceVersion: SEED_VERSION,
      });
    } else {
      // Version bump = corrected seed data: refresh structure/eligibility on the
      // existing row (id-stable, so meter tariff assignments are preserved).
      await db
        .update(tariffs)
        .set({
          urdbId: t.urdbId,
          sector: t.sector,
          commodity: t.commodity,
          state: t.state,
          peakKwMin: t.peakKwMin,
          peakKwMax: t.peakKwMax,
          structure: t.structure,
          freshness: t.freshness,
          effectiveDate: new Date(t.effectiveDate),
          sourceVersion: SEED_VERSION,
        })
        .where(eq(tariffs.id, existing[0].id));
    }
    n++;
  }
  await recordRun(db, "tariffs", n, "Public tariff schedules (modeled; verify against bill)", "https://apps.openei.org/USURDB/", "APS/SRP/TEP/UNS electric + SW Gas + Phoenix water; ratchets, TOU, CP, export rates (AZ net-billing) included; freshness=urdb_stale");
  return n;
}

export async function seedArchetypes(db: Db) {
  if (await alreadySeeded(db, "archetypes")) return 0;
  let n = 0;
  // Use each climate zone's station TMY for weather-sensitive shapes
  const zoneTmy = new Map<string, number[]>();
  for (const st of WEATHER_STATIONS_FULL) {
    if (!zoneTmy.has(st.climateZone)) zoneTmy.set(st.climateZone, synthesizeTmyHourly(st.monthlyNormals));
  }
  for (const [zone, tmy] of Array.from(zoneTmy.entries())) {
    for (const spec of ARCHETYPE_SPECS) {
      const shape = generateShape8760(spec, tmy);
      const existing = await db
        .select({ id: archetypeProfiles.id })
        .from(archetypeProfiles)
        .where(
          and(
            eq(archetypeProfiles.buildingType, spec.buildingType),
            eq(archetypeProfiles.climateZone, zone),
            eq(archetypeProfiles.vintageBand, spec.vintageBand),
            eq(archetypeProfiles.sizeBandSqft, spec.sizeBandSqft),
            eq(archetypeProfiles.commodity, "electric"),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        await db.insert(archetypeProfiles).values({
          buildingType: spec.buildingType,
          sectorClass: spec.sectorClass,
          climateZone: zone,
          vintageBand: spec.vintageBand,
          sizeBandSqft: spec.sizeBandSqft,
          commodity: "electric",
          shape8760: shape,
          endUseFractions: spec.endUseFractions,
          annualUsePerSqft: spec.annualKwhPerSqft,
          peakWPerSqft: spec.peakWPerSqft,
          source: LABEL_PROTOTYPE_ARCHETYPE,
          sourceVersion: SEED_VERSION,
          confidenceLabel: LABEL_PROTOTYPE_ARCHETYPE,
          calibMinSqft: spec.calibMinSqft,
          calibMaxSqft: spec.calibMaxSqft,
        });
      }
      n++;
    }
  }
  await recordRun(
    db,
    "archetypes",
    n,
    "Synthesized from DOE prototype building characteristics (public domain)",
    "https://www.energycodes.gov/prototype-building-models",
    `Prototype-derived 8760 shapes per (type x zone x vintage x size); label "${LABEL_PROTOTYPE_ARCHETYPE}" — OEDI EULP empirical shapes not fetched at build time (fallback path per handoff §8.5)`,
  );
  return n;
}

/** National zone-representative weather stations (one per IECC zone not
 * already covered by the AZ launch stations). */
export async function seedNationalWeather(db: Db) {
  if (await alreadySeeded(db, "weather_normals_national")) return 0;
  let n = 0;
  for (const st of ZONE_STATIONS) {
    const normals = zoneStationNormals(st.months);
    const tmy = synthesizeTmyHourly(normals);
    await db
      .insert(weatherNormals)
      .values({
        stationId: st.stationId,
        stationName: st.stationName,
        climateZone: st.climateZone,
        state: st.state,
        monthlyNormals: normals,
        tmyHourlyTempF: tmy,
        source: "noaa_normals_1991_2020_synthesized_hourly",
        sourceVersion: SEED_VERSION,
      })
      .onDuplicateKeyUpdate({ set: { monthlyNormals: normals, tmyHourlyTempF: tmy, sourceVersion: SEED_VERSION } });
    n++;
  }
  await recordRun(db, "weather_normals_national", n, "Public domain (NOAA)", "https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals", "One representative NOAA-normals station per IECC zone (1A-8) so weather-normalized baselines resolve nationwide; hourly synthesized from normals (labeled)");
  return n;
}

/** eGRID 2022 CO2e defaults for subregions not in the AZ-launch set (lb/MWh).
 * Accuracy pass (Jul 20): this was a second hand-copied factor table that had
 * drifted from the canonical seedData.EGRID_FACTORS (e.g. MROE 1395.4 vs
 * 1180.9, SRMW 1500.5 vs 1163.7). EGRID_FACTORS now carries every subregion
 * referenced by STATE_SUBREGION and is the single authority; this map derives
 * from it (plus the two NY splits not used by any state default), so the two
 * sources can never diverge again. */
const NATIONAL_EGRID_DEFAULTS: Record<string, number> = {
  ...Object.fromEntries(EGRID_FACTORS.map((f) => [f.subregion, f.co2eLbPerMwh])),
  NYLI: 1200.7, // NPCC Long Island — kept for ZIP3-level NY splits
  NYUP: 262.5, // NPCC Upstate NY
};

/** National representative tariffs: 4 per state (res flat/TOU, comm flat,
 * comm TOU+demand) scaled from EIA-861 state average rates. Honestly labeled
 * source=state_representative_synthesized — NOT filed tariffs. Also fills
 * eGRID factors for subregions outside the launch set. */
export async function seedNationalTariffs(db: Db) {
  if (await alreadySeeded(db, "tariffs_national")) return 0;
  // AZ keeps its hand-modeled URDB-derived rates as the authoritative set.
  const existingStates = new Set(["AZ"]);
  const natTariffs = generateNationalTariffs(existingStates);
  let n = 0;
  for (const t of natTariffs) {
    const existing = await db
      .select({ id: tariffs.id })
      .from(tariffs)
      .where(and(eq(tariffs.utilityName, t.utilityName), eq(tariffs.name, t.name)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(tariffs).values({
        urdbId: t.urdbId,
        utilityName: t.utilityName,
        name: t.name,
        sector: t.sector,
        commodity: t.commodity,
        state: t.state,
        peakKwMin: t.peakKwMin,
        peakKwMax: t.peakKwMax,
        structure: t.structure,
        freshness: t.freshness,
        effectiveDate: new Date(t.effectiveDate),
        source: "state_representative_synthesized",
        sourceVersion: SEED_VERSION,
      });
    } else {
      await db
        .update(tariffs)
        .set({
          urdbId: t.urdbId,
          sector: t.sector,
          state: t.state,
          peakKwMin: t.peakKwMin,
          peakKwMax: t.peakKwMax,
          structure: t.structure,
          effectiveDate: new Date(t.effectiveDate),
          sourceVersion: SEED_VERSION,
        })
        .where(eq(tariffs.id, existing[0].id));
    }
    n++;
  }
  // Fill eGRID factors for subregions not covered by the launch seed.
  const seenSub = new Set<string>();
  for (const p of STATE_PROFILES) {
    if (seenSub.has(p.subregion)) continue;
    seenSub.add(p.subregion);
    const egridExisting = await db
      .select({ id: emissionsFactors.id })
      .from(emissionsFactors)
      .where(eq(emissionsFactors.subregion, p.subregion))
      .limit(1);
    if (egridExisting.length === 0) {
      await db.insert(emissionsFactors).values({
        subregion: p.subregion,
        subregionName: `eGRID ${p.subregion}`,
        co2eLbPerMwh: NATIONAL_EGRID_DEFAULTS[p.subregion] ?? 850,
        year: 2022,
        source: "epa_egrid",
        sourceVersion: SEED_VERSION,
      });
      n++;
    }
  }
  await recordRun(db, "tariffs_national", n, "Synthesized from EIA-861 2024 state average retail prices (public domain)", "https://www.eia.gov/electricity/data.php", "4 representative rates per state (50 states + DC); source=state_representative_synthesized, NOT filed tariffs; every structure carries a verify-against-your-bill note; AZ retains hand-modeled URDB rates; eGRID subregion factors extended nationwide");
  return n;
}

/** Upsert one SeedTariff row keyed on (utilityName, name) — shared by the
 * boot seeders and the weekly refresh re-assert path. Returns "inserted" |
 * "updated". */
async function upsertSeedTariff(db: Db, t: ReturnType<typeof generateNationalGasWaterTariffs>[number], sourceVersion: string): Promise<"inserted" | "updated"> {
  const existing = await db
    .select({ id: tariffs.id })
    .from(tariffs)
    .where(and(eq(tariffs.utilityName, t.utilityName), eq(tariffs.name, t.name)))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(tariffs).values({
      urdbId: t.urdbId,
      utilityName: t.utilityName,
      name: t.name,
      sector: t.sector,
      commodity: t.commodity,
      state: t.state,
      peakKwMin: t.peakKwMin,
      peakKwMax: t.peakKwMax,
      structure: t.structure,
      freshness: t.freshness,
      effectiveDate: new Date(t.effectiveDate),
      source: "state_representative_synthesized",
      sourceVersion,
    });
    return "inserted";
  }
  await db
    .update(tariffs)
    .set({
      urdbId: t.urdbId,
      sector: t.sector,
      state: t.state,
      peakKwMin: t.peakKwMin,
      peakKwMax: t.peakKwMax,
      structure: t.structure,
      effectiveDate: new Date(t.effectiveDate),
      sourceVersion,
    })
    .where(eq(tariffs.id, existing[0].id));
  return "updated";
}

/** RATE-2 (Jul 19): national gas + water representative rates — ~2 gas rows
 * per state (res + comm flat $/therm, EIA-176 2024 state averages) named for
 * the territory registry's dominant LDC so ZIP → territory attribution →
 * tariff lookup chains by utilityName, plus 1 municipal water row per state
 * ($/kgal stored per-gallon). Owner directive: actual as able, imputed where
 * required, notated accordingly — every row's name AND structure.notes say
 * "state-average imputed"; AZ's hand-modeled filed tariffs stay authoritative. */
export async function seedNationalGasWaterTariffs(db: Db) {
  if (await alreadySeeded(db, "tariffs_gas_water_national")) return 0;
  let n = 0;
  for (const t of generateNationalGasWaterTariffs()) {
    await upsertSeedTariff(db, t, SEED_VERSION);
    n++;
  }
  await recordRun(db, "tariffs_gas_water_national", n, "Public domain (EIA-176 2024 gas averages; AWWA/state water rate surveys)", "https://www.eia.gov/naturalgas/data.php", "Gas res+comm per state (50 states + DC, dominant-LDC named to match the service-territory registry) + 1 municipal water volumetric row per state; source=state_representative_synthesized, every row labeled state-average imputed with a verify-against-your-bill note; AZ hand-modeled Southwest Gas G-5 + City of Phoenix rows remain authoritative");
  return n;
}

/** Weekly-refresh re-assert (RATE-4): re-emits every national representative
 * rate row (electric + gas + water) under the given sourceVersion so drifted
 * or manually damaged rows are healed and the vintage stamp advances. Rows
 * whose values changed are updated in place (same identity key), so assigned
 * meters keep their tariff ids. Returns counts for the owner notification. */
export async function reassertNationalRates(sourceVersion: string): Promise<{ inserted: number; updated: number }> {
  const db = await getDb();
  if (!db) return { inserted: 0, updated: 0 };
  const all = [...generateNationalTariffs(new Set(["AZ"])), ...generateNationalGasWaterTariffs()];
  let inserted = 0;
  let updated = 0;
  for (const t of all) {
    const r = await upsertSeedTariff(db, t, sourceVersion);
    if (r === "inserted") inserted++;
    else updated++;
  }
  // Advance the freshness stamp for the rate-averages source so the staleness
  // sweep reflects this re-assert (seededAt = verification time).
  const now = Date.now();
  await db
    .insert(seedFreshness)
    .values({ source: "national_rate_averages", version: sourceVersion, seededAt: now, cadenceDays: 365, lastCheckedAt: now })
    .onDuplicateKeyUpdate({ set: { version: sourceVersion, seededAt: now, lastCheckedAt: now } })
    .catch(() => undefined);
  return { inserted, updated };
}

export async function seedConvergenceLog(db: Db) {
  if (await alreadySeeded(db, "convergence_log")) return 0;
  const entries = [
    { cycle: "Cycle 1 (v1.0)", phase: "Authoring — UHOP core passes", summary: "Landscape → Depth → Adversarial → Cost → Compliance → Synthesis; 6 change-producing passes (seed pipeline, demand-first module, commodity abstraction, hypothetical/scenario unification, offline acceptance test, tier gating).", passes: 6, cleanStreak: 0, resets: 6, materialFindings: 6 },
    { cycle: "Cycle 2 (v1.1)", phase: "Authoring — verification battery", summary: "7 change-producing passes then 100 consecutive fresh verification lenses with zero changes (counter 100/100 in-session).", passes: 107, cleanStreak: 100, resets: 7, materialFindings: 7 },
    { cycle: "Cycle 3 (v1.2)", phase: "Independent-review escalation", summary: "Strict re-read found 4 material issues (offline-AC/LLM contradiction, cross-commodity deltas, AC3↔S12 sequencing, eemeter water misscope); standalone cold-context runner produced for Session A0.", passes: 4, cleanStreak: 0, resets: 4, materialFindings: 4 },
    { cycle: "Cycle 4 (v1.4)", phase: "Session A0 — independent cold-context series", summary: "Genuine fresh zero-context API passes; 5 confirmed-material findings integrated (NILMTK resolution gate, disaggregation_method enum + AC8, OEDI S3 correction, CP/4CP methodology, ratchet sub-module).", passes: 2, cleanStreak: 0, resets: 2, materialFindings: 5 },
    { cycle: "Cycle 5 (v1.5)", phase: "Session A0 — continuation series", summary: "31 passes produced 25 confirmed-material findings → 12 integration items (solar/battery physics + export-rate asymmetry, ingestion security hardening, multi-tenancy enforcement, corrected bills/meter swaps/partial overlaps, predictive-baseline provenance, CP N=4, billed-demand reconciliation, free-tier solar teaser).", passes: 31, cleanStreak: 0, resets: 9, materialFindings: 25 },
  ];
  let n = 0;
  for (const e of entries) {
    await db.insert(convergenceLog).values(e);
    n++;
  }
  await recordRun(db, "convergence_log", n, "N/A (project governance record)", "", "UHOP v4 convergence history seeded for the transparency page; live series appends further cycles");
  return n;
}

let seedPromise: Promise<void> | null = null;

/** Boot-time entry — runs once, never throws to the caller. */
export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      try {
        const db = await getDb();
        if (!db) {
          console.warn("[Seed] Database unavailable; skipping seeders");
          return;
        }
        const results = {
          egrid: await seedEgrid(db),
          benchmarks: await seedBenchmarks(db),
          weather: await seedWeather(db),
          tariffs: await seedTariffs(db),
          nationalWeather: await seedNationalWeather(db),
          nationalTariffs: await seedNationalTariffs(db),
          gasWaterTariffs: await seedNationalGasWaterTariffs(db),
          archetypes: await seedArchetypes(db),
          convergence: await seedConvergenceLog(db),
        };
        // v1.22 S-LIFECYCLE: register per-seeder refresh cadences + config
        // defaults (idempotent; existing ops-tuned rows are preserved).
        await registerSeedFreshness(SEED_VERSION).catch((e) =>
          console.warn("[Seed] freshness registration failed", e),
        );
        console.log("[Seed] complete", JSON.stringify(results));
      } catch (err) {
        console.error("[Seed] failed", err);
        seedPromise = null; // allow retry on next call
        throw err;
      }
    })().catch(() => undefined);
  }
  return seedPromise;
}
