import {
  bigint,
  boolean,
  date,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  tier: mysqlEnum("tier", ["free", "plus", "pro"]).default("free").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/* ============================================================
 * WattWise canonical schema — commodity-agnostic.
 * Every analytic table carries provenance fields (source,
 * sourceVersion, method, confidence) per handoff §2.
 * ============================================================ */

/** 0. entities — the organizational owner layer (Gap-9, Jul 2026):
 *  one household/company/owner → many sites → many meters. Optional — sites
 *  with entityId NULL simply belong directly to the user (no forced setup). */
export const entities = mysqlTable(
  "entities",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    kind: mysqlEnum("kind", ["household", "company", "property_owner", "other"]).default("other").notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("entities_user_idx").on(t.userId)],
);
export type Entity = typeof entities.$inferSelect;

/** 1. sites — a physical premise (building/campus/well site). */
export const sites = mysqlTable(
  "sites",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    /** Gap-9: optional owning entity (household/company). NULL = directly owned. */
    entityId: int("entityId"),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    city: varchar("city", { length: 128 }),
    state: varchar("state", { length: 8 }),
    zip: varchar("zip", { length: 16 }),
    buildingType: varchar("buildingType", { length: 64 }),
    sqft: double("sqft"),
    vintage: int("vintage"),
    climateZone: varchar("climateZone", { length: 16 }),
    occupancyHours: json("occupancyHours"),
    utilityName: varchar("utilityName", { length: 128 }),
    egridSubregion: varchar("egridSubregion", { length: 8 }),
    isHypothetical: boolean("isHypothetical").default(false).notNull(),
    /** provenance for attribute values: user_entered | assessor | archetype_default */
    attrSource: varchar("attrSource", { length: 32 }).default("user_entered"),
    /** Batch-45 (pass 1959): per-field refinement record for quick-start sites —
     * JSON array of core field names (buildingType/sqft/vintage) the user has
     * explicitly provided. Site-level attrSource flips on the FIRST refinement,
     * which alone cannot say WHICH core placeholders remain; this can. Null for
     * regular (non-quick-start) sites and legacy rows. */
    refinedFields: json("refinedFields"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("sites_user_idx").on(t.userId), index("sites_entity_idx").on(t.entityId)],
);

/** 2. meters — one service point / channel; commodity-agnostic. */
export const meters = mysqlTable(
  "meters",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water"]).notNull(),
    label: varchar("label", { length: 255 }),
    accountNumber: varchar("accountNumber", { length: 64 }),
    servicePoint: varchar("servicePoint", { length: 64 }),
    /** canonical units: electric kWh/kW; gas therms; water gallons */
    usageUnit: varchar("usageUnit", { length: 16 }).notNull(),
    demandUnit: varchar("demandUnit", { length: 16 }),
    /** v1.7 §2.4: meter role — aggregation physics key. Submeters nest under mains via parentMeterId;
     * generation meters carry negative/net flow; virtual_total materializes summed main series. */
    meterRole: mysqlEnum("meterRole", ["main", "submeter", "generation", "ev", "virtual_total"])
      .default("main")
      .notNull(),
    parentMeterId: int("parentMeterId"),
    /** Cycle 5: meter-swap handling — serial transitions create a new meter row */
    meterSerial: varchar("meterSerial", { length: 64 }),
    activeFrom: bigint("activeFrom", { mode: "number" }),
    activeTo: bigint("activeTo", { mode: "number" }),
    timezone: varchar("timezone", { length: 64 }).default("America/Phoenix").notNull(),
    currentTariffId: int("currentTariffId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("meters_site_idx").on(t.siteId), index("meters_user_idx").on(t.userId)],
);

/** 3. intervals — canonical interval store; dedupe invariant enforced. */
export const intervals = mysqlTable(
  "intervals",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    meterId: int("meterId").notNull(),
    /** UTC ms of interval START */
    ts: bigint("ts", { mode: "number" }).notNull(),
    durationMin: int("durationMin").notNull(),
    /** usage in the meter's canonical usageUnit, full float precision (D11) */
    usage: double("usage").notNull(),
    /** demand in demandUnit if the source provided it (KW column) */
    demand: double("demand"),
    /** ingestion provenance */
    uploadId: int("uploadId").notNull(),
    /** precedence: higher wins on dedupe conflict (corrected files) */
    precedence: int("precedence").default(0).notNull(),
    qcFlags: varchar("qcFlags", { length: 64 }),
  },
  (t) => [
    uniqueIndex("intervals_dedupe_uq").on(t.meterId, t.ts, t.durationMin),
    index("intervals_meter_ts_idx").on(t.meterId, t.ts),
  ],
);

/** 4. uploads — every ingested file, with hash for dedupe + provenance. */
export const uploads = mysqlTable(
  "uploads",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    siteId: int("siteId"),
    filename: varchar("filename", { length: 512 }).notNull(),
    fileKey: varchar("fileKey", { length: 512 }),
    fileUrl: text("fileUrl"),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    format: mysqlEnum("format", ["xlsx", "csv", "espi_xml", "bill_pdf", "bill_image", "manual"]).notNull(),
    parser: varchar("parser", { length: 64 }),
    parserVersion: varchar("parserVersion", { length: 32 }),
    parseConfidence: double("parseConfidence"),
    rowsIngested: int("rowsIngested").default(0),
    rowsSkipped: int("rowsSkipped").default(0),
    sheetsFound: int("sheetsFound").default(0),
    footerTotals: json("footerTotals"),
    validation: json("validation"),
    status: mysqlEnum("status", ["pending", "parsed", "failed", "duplicate"]).default("pending").notNull(),
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("uploads_user_idx").on(t.userId), index("uploads_sha_idx").on(t.sha256)],
);

/** 5. bills — monthly billing records (parsed or manual). */
export const bills = mysqlTable(
  "bills",
  {
    id: int("id").autoincrement().primaryKey(),
    meterId: int("meterId").notNull(),
    periodStart: date("periodStart").notNull(),
    periodEnd: date("periodEnd").notNull(),
    usage: double("usage"),
    /** actual metered peak for the period */
    demandActual: double("demandActual"),
    /** billed demand AFTER ratchet application */
    demandBilled: double("demandBilled"),
    totalCost: double("totalCost"),
    energyCost: double("energyCost"),
    demandCost: double("demandCost"),
    fixedCost: double("fixedCost"),
    source: mysqlEnum("source", ["parsed_pdf", "parsed_image", "manual", "computed"]).notNull(),
    parseConfidence: double("parseConfidence"),
    uploadId: int("uploadId"),
    /** Cycle 5: corrected-bill handling */
    billRevision: int("billRevision").default(0).notNull(),
    supersedesBillId: int("supersedesBillId"),
    /** Cycle 5: demand_billed reconciliation provenance */
    demandBilledSource: mysqlEnum("demandBilledSource", ["parsed_bill", "ratchet_computed"]),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("bills_meter_idx").on(t.meterId)],
);

/** 6. tariffs — seeded URDB + custom tariffs. */
export const tariffs = mysqlTable(
  "tariffs",
  {
    id: int("id").autoincrement().primaryKey(),
    urdbId: varchar("urdbId", { length: 64 }),
    utilityName: varchar("utilityName", { length: 255 }).notNull(),
    name: varchar("name", { length: 512 }).notNull(),
    sector: mysqlEnum("sector", ["residential", "commercial", "industrial", "lighting"]).notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water"]).default("electric").notNull(),
    state: varchar("state", { length: 8 }),
    /** eligibility window on peak demand (kW) */
    peakKwMin: double("peakKwMin"),
    peakKwMax: double("peakKwMax"),
    /** full rate structure JSON: energy TOU periods, demand charges, fixed,
     * ratchets {lookbackMonths, ratchetPct, applicablePeriod},
     * cpCharges {method: cp_proxy_top_n_customer_peaks | cp_omitted_no_interval_data} */
    structure: json("structure").notNull(),
    freshness: mysqlEnum("freshness", ["urdb_refreshed_150", "urdb_stale", "manual", "verified"]).default("urdb_stale").notNull(),
    effectiveDate: date("effectiveDate"),
    source: varchar("source", { length: 64 }).default("urdb_snapshot").notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("tariffs_utility_idx").on(t.utilityName),
    index("tariffs_state_sector_idx").on(t.state, t.sector),
  ],
);

/** 7. archetype_profiles — 8760 normalized shapes + end-use fractions. */
export const archetypeProfiles = mysqlTable(
  "archetype_profiles",
  {
    id: int("id").autoincrement().primaryKey(),
    buildingType: varchar("buildingType", { length: 64 }).notNull(),
    sectorClass: mysqlEnum("sectorClass", ["residential", "commercial"]).notNull(),
    climateZone: varchar("climateZone", { length: 16 }).notNull(),
    vintageBand: varchar("vintageBand", { length: 32 }).notNull(),
    sizeBandSqft: varchar("sizeBandSqft", { length: 32 }).notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water"]).default("electric").notNull(),
    /** 8760 hourly weights normalized to sum=1.0 (stored as JSON array) */
    shape8760: json("shape8760").notNull(),
    /** end-use fractions {cooling, heating, lighting, plug, dhw, other} */
    endUseFractions: json("endUseFractions").notNull(),
    /** annual kWh (or unit) per sqft for scaling */
    annualUsePerSqft: double("annualUsePerSqft").notNull(),
    peakWPerSqft: double("peakWPerSqft"),
    /** provenance: oedi_eulp | prototype-archetype */
    source: varchar("source", { length: 64 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }),
    confidenceLabel: varchar("confidenceLabel", { length: 64 }).notNull(),
    /** calibration envelope for extrapolation flagging */
    calibMinSqft: double("calibMinSqft"),
    calibMaxSqft: double("calibMaxSqft"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("archetype_cell_uq").on(
      t.buildingType,
      t.climateZone,
      t.vintageBand,
      t.sizeBandSqft,
      t.commodity,
    ),
  ],
);

/** 8. baselines — fitted baseline models with stats + provenance. */
export const baselines = mysqlTable(
  "baselines",
  {
    id: int("id").autoincrement().primaryKey(),
    meterId: int("meterId"),
    siteId: int("siteId").notNull(),
    method: mysqlEnum("method", [
      "billing_hdd_cdd",
      "daily_hdd_cdd",
      "hourly_towt",
      "archetype_synthetic",
      "custom_water_seasonal",
      "predictive_baseline",
    ]).notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water"]).notNull(),
    /** model params: balance points, coefficients, occupied/unoccupied regimes */
    params: json("params").notNull(),
    rSquared: double("rSquared"),
    cvrmse: double("cvrmse"),
    trainStart: bigint("trainStart", { mode: "number" }),
    trainEnd: bigint("trainEnd", { mode: "number" }),
    /** weather basis: actual | normal-year basis */
    weatherBasis: varchar("weatherBasis", { length: 32 }).notNull(),
    confidenceLabel: varchar("confidenceLabel", { length: 128 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("baselines_site_idx").on(t.siteId)],
);

/** 9. insights — analytic findings surfaced to the user. */
export const insights = mysqlTable(
  "insights",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    meterId: int("meterId"),
    analysisId: int("analysisId"),
    kind: varchar("kind", { length: 64 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    body: text("body").notNull(),
    severity: mysqlEnum("severity", ["info", "opportunity", "warning", "anomaly"]).default("info").notNull(),
    /** honest-labeling: archetype_prior_only | regression_split | nilmtk_1min_plus */
    disaggregationMethod: mysqlEnum("disaggregationMethod", [
      "archetype_prior_only",
      "regression_split",
      "nilmtk_1min_plus",
    ]),
    confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("medium").notNull(),
    provenance: json("provenance"),
    metrics: json("metrics"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("insights_site_idx").on(t.siteId)],
);

/** 10. opportunities — ranked efficiency measures. */
export const opportunities = mysqlTable(
  "opportunities",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    analysisId: int("analysisId"),
    measure: varchar("measure", { length: 128 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    description: text("description"),
    estEnergySavingsPerYr: double("estEnergySavingsPerYr"),
    energyUnit: varchar("energyUnit", { length: 16 }),
    /** post-ratchet achievable kW reduction (never raw peak reduction) */
    estDemandSavingsKw: double("estDemandSavingsKw"),
    estCostSavingsPerYr: double("estCostSavingsPerYr"),
    paybackBandYears: varchar("paybackBandYears", { length: 32 }),
    confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("medium").notNull(),
    disaggregationMethod: mysqlEnum("disaggregationMethod", [
      "archetype_prior_only",
      "regression_split",
      "nilmtk_1min_plus",
    ]),
    ratchetAware: boolean("ratchetAware").default(false).notNull(),
    rank: int("rank").default(0).notNull(),
    provenance: json("provenance"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("opps_site_idx").on(t.siteId)],
);

/** 11. scenarios — what-if runs; actual & hypothetical share this path. */
export const scenarios = mysqlTable(
  "scenarios",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    transform: mysqlEnum("transform", [
      "rate_switch",
      "solar",
      "battery_peak_shave",
      "schedule_shift",
      "led_equipment",
      "electrification",
      "ev_charging",
      "occupancy_change",
      "hypothetical_building",
    ]).notNull(),
    params: json("params").notNull(),
    /** load basis: measured_intervals | archetype_scaled */
    loadBasis: varchar("loadBasis", { length: 32 }).notNull(),
    /** results: baseline cost, scenario cost, deltas, CO2e, ratchet detail,
     * cpMethodology, confidence band, extrapolation flag */
    results: json("results"),
    status: mysqlEnum("status", ["pending", "complete", "failed"]).default("pending").notNull(),
    confidenceLabel: varchar("confidenceLabel", { length: 128 }),
    extrapolated: boolean("extrapolated").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("scenarios_site_idx").on(t.siteId)],
);

/** 12. emissions_factors — eGRID subregion factors (seeded). */
export const emissionsFactors = mysqlTable(
  "emissions_factors",
  {
    id: int("id").autoincrement().primaryKey(),
    subregion: varchar("subregion", { length: 8 }).notNull(),
    subregionName: varchar("subregionName", { length: 128 }),
    /** lb CO2e per MWh delivered */
    co2eLbPerMwh: double("co2eLbPerMwh").notNull(),
    year: int("year").notNull(),
    source: varchar("source", { length: 64 }).default("epa_egrid").notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex("egrid_sub_year_uq").on(t.subregion, t.year)],
);

/** 12b. zip→eGRID subregion mapping (seeded). */
export const zipSubregions = mysqlTable(
  "zip_subregions",
  {
    id: int("id").autoincrement().primaryKey(),
    zip3: varchar("zip3", { length: 3 }).notNull(),
    state: varchar("state", { length: 8 }),
    subregion: varchar("subregion", { length: 8 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }).notNull(),
  },
  (t) => [index("zip3_idx").on(t.zip3)],
);

/** 13. benchmarks — EUI medians (seeded ENERGY STAR/CBECS/RECS). */
export const benchmarks = mysqlTable(
  "benchmarks",
  {
    id: int("id").autoincrement().primaryKey(),
    buildingType: varchar("buildingType", { length: 64 }).notNull(),
    sectorClass: mysqlEnum("sectorClass", ["residential", "commercial"]).notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water", "site_total"]).notNull(),
    /** kBtu/sqft/yr for energy; gal/sqft/yr for water */
    medianEui: double("medianEui").notNull(),
    p25Eui: double("p25Eui"),
    p75Eui: double("p75Eui"),
    unit: varchar("unit", { length: 32 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }).notNull(),
  },
  (t) => [index("bench_type_idx").on(t.buildingType)],
);

/** 14. weather_normals — per climate zone/station normals + TMY (seeded). */
export const weatherNormals = mysqlTable(
  "weather_normals",
  {
    id: int("id").autoincrement().primaryKey(),
    stationId: varchar("stationId", { length: 32 }).notNull(),
    stationName: varchar("stationName", { length: 128 }),
    climateZone: varchar("climateZone", { length: 16 }).notNull(),
    state: varchar("state", { length: 8 }),
    /** monthly normals: [{month, hddBase65, cddBase65, avgTempF}] */
    monthlyNormals: json("monthlyNormals").notNull(),
    /** TMY 8760 hourly dry-bulb F (JSON array) */
    tmyHourlyTempF: json("tmyHourlyTempF"),
    source: varchar("source", { length: 64 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex("station_uq").on(t.stationId)],
);

/** 15. seeder_runs — idempotent, versioned, license-logged registry. */
export const seederRuns = mysqlTable(
  "seeder_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    seeder: varchar("seeder", { length: 64 }).notNull(),
    version: varchar("version", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["running", "complete", "failed"]).notNull(),
    rowsSeeded: int("rowsSeeded").default(0),
    license: varchar("license", { length: 128 }).notNull(),
    licenseUrl: text("licenseUrl"),
    notes: text("notes"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [uniqueIndex("seeder_version_uq").on(t.seeder, t.version)],
);

/** 16. metering — per-account unit-economics instrumentation. */
export const metering = mysqlTable(
  "metering",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    analysisId: int("analysisId"),
    kind: varchar("kind", { length: 64 }).notNull(),
    llmTokensIn: int("llmTokensIn").default(0),
    llmTokensOut: int("llmTokensOut").default(0),
    llmCostUsd: double("llmCostUsd").default(0),
    computeMs: int("computeMs").default(0),
    computeCostUsd: double("computeCostUsd").default(0),
    totalCostUsd: double("totalCostUsd").default(0),
    tierAtTime: varchar("tierAtTime", { length: 16 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("metering_user_idx").on(t.userId)],
);

/** 17. analyses — one full pipeline run over a site/meter. */
export const analyses = mysqlTable(
  "analyses",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    status: mysqlEnum("status", ["pending", "running", "complete", "failed", "timeout"]).default("pending").notNull(),
    stagesCompleted: json("stagesCompleted"),
    weatherBasis: varchar("weatherBasis", { length: 32 }),
    marginalCostUsd: double("marginalCostUsd").default(0),
    durationMs: int("durationMs"),
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => [index("analyses_site_idx").on(t.siteId)],
);

/** 18. audit_log — provenance/audit of significant actions. */
export const auditLog = mysqlTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId"),
    action: varchar("action", { length: 128 }).notNull(),
    entity: varchar("entity", { length: 64 }),
    entityId: varchar("entityId", { length: 64 }),
    detail: json("detail"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("audit_user_idx").on(t.userId)],
);

/** 19. convergence_log — UHOP convergence transparency page data. */
export const convergenceLog = mysqlTable("convergence_log", {
  id: int("id").autoincrement().primaryKey(),
  cycle: varchar("cycle", { length: 32 }).notNull(),
  phase: varchar("phase", { length: 128 }).notNull(),
  summary: text("summary").notNull(),
  passes: int("passes").default(0),
  cleanStreak: int("cleanStreak").default(0),
  resets: int("resets").default(0),
  materialFindings: int("materialFindings").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 20. site_groups — v1.7 §2.2a: org-scoped tags (region, manager, brand) for portfolio rollups.
 * Flat user→site scales to hundreds of sites without a hierarchy rewrite. */
export const siteGroups = mysqlTable(
  "site_groups",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    /** optional owning entity scope (household/company), mirrors sites.entityId semantics */
    entityId: int("entityId"),
    name: varchar("name", { length: 128 }).notNull(),
    kind: mysqlEnum("kind", ["region", "manager", "brand", "custom"]).default("custom").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("site_groups_user_idx").on(t.userId)],
);

/** 20b. site_group_members — many-to-many: sites carry group ids. */
export const siteGroupMembers = mysqlTable(
  "site_group_members",
  {
    id: int("id").autoincrement().primaryKey(),
    groupId: int("groupId").notNull(),
    siteId: int("siteId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("sgm_group_idx").on(t.groupId),
    index("sgm_site_idx").on(t.siteId),
    uniqueIndex("sgm_unique").on(t.groupId, t.siteId),
  ],
);

/** 21. site_geometry — v1.7 §2.9a: footprint/height/roof geometry with per-field provenance.
 * A prism estimate is never presented with LiDAR confidence. ODbL-derived rows flagged for isolation. */
export const siteGeometry = mysqlTable(
  "site_geometry",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    /** GeoJSON polygon of the building footprint */
    footprint: json("footprint"),
    footprintSource: mysqlEnum("footprintSource", ["assessor_gis", "microsoft", "osm", "user_drawn"]),
    /** footprint area in sqft (derived from polygon or dataset attribute) */
    footprintSqft: double("footprintSqft"),
    heightM: double("heightM"),
    heightSource: mysqlEnum("heightSource", ["lidar", "footprint_dataset", "stories_estimate"]),
    stories: int("stories"),
    roofType: mysqlEnum("roofType", ["flat", "pitched", "complex"]),
    /** roof segments (pitch, azimuth, area) from Solar API or LiDAR when available */
    roofSegments: json("roofSegments"),
    orientationDeg: double("orientationDeg"),
    exposedWallAreaByOrientation: json("exposedWallAreaByOrientation"),
    neighborShadingFactor: double("neighborShadingFactor"),
    exposureScore: double("exposureScore"),
    treeCanopyPct: double("treeCanopyPct"),
    /** per-field provenance + confidence JSON: { field: { source, confidence } } */
    geometryConfidence: json("geometryConfidence"),
    /** ODbL share-alike isolation flag (S8 rule) */
    odblDerived: boolean("odblDerived").default(false).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("site_geometry_site_unique").on(t.siteId), index("site_geometry_user_idx").on(t.userId)],
);

export type Site = typeof sites.$inferSelect;
export type SiteGroup = typeof siteGroups.$inferSelect;
export type SiteGeometry = typeof siteGeometry.$inferSelect;
export type Meter = typeof meters.$inferSelect;
export type Interval = typeof intervals.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type Tariff = typeof tariffs.$inferSelect;
export type ArchetypeProfile = typeof archetypeProfiles.$inferSelect;
export type Baseline = typeof baselines.$inferSelect;
export type Insight = typeof insights.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type EmissionsFactor = typeof emissionsFactors.$inferSelect;
export type Benchmark = typeof benchmarks.$inferSelect;
export type WeatherNormal = typeof weatherNormals.$inferSelect;
export type SeederRun = typeof seederRuns.$inferSelect;
export type Metering = typeof metering.$inferSelect;
export type Analysis = typeof analyses.$inferSelect;
