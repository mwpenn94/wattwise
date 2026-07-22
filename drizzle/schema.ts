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
  tinyint,
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
  /** §3f lifecycle: monthly digest opt-in (quiet by default), anchored to the
   * user's bill-cycle day (1–28). Every digest must contain a dollar figure
   * or it doesn't send — enforced at send time, not here. */
  digestOptIn: boolean("digestOptIn").default(false).notNull(),
  digestAnchorDay: int("digestAnchorDay").default(1).notNull(),
  /** Heartbeat cron uid backing this user's digest schedule — lifecycle rule:
   * look up/update/delete by task_uid, never by name (periodic-updates skill) */
  digestCronTaskUid: varchar("digestCronTaskUid", { length: 65 }),
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
    /** §1b portfolio map: geocoded coordinates captured at create/refine when an
     * address is chosen from the places list. Never populated from raw GPS. */
    lat: double("lat"),
    lng: double("lng"),
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
    /** GAP-O pin-drop mode: a prospective site was created from a map pin (or an
     * address the user is only CONSIDERING — pre-purchase / pre-lease). Insights
     * render with a "prospective — modeled only" frame and never claim occupancy. */
    prospective: tinyint("prospective").default(0).notNull(),
    /** provenance for attribute values: user_entered | assessor | archetype_default */
    attrSource: varchar("attrSource", { length: 32 }).default("user_entered"),
    /** v1.18 tenure modes: opportunity generation filters by what the occupant
     * can actually do — a renter shown a solar payback is a spec failure. */
    tenure: mysqlEnum("tenure", ["own", "rent", "condo_hoa"]).default("own").notNull(),
    /** v1.18 technology-conditioned tariff applicability: solar customers may be
     * RESTRICTED to solar plans (SRP pattern) and non-solar users must never see
     * solar-only plans. Confirmed by the user (or PV detection downstream). */
    hasSolar: boolean("hasSolar").default(false).notNull(),
    /** v1.19 away mode / occupancy calendar: one toggle flips the product's
     * voice — the feed quiets to a watchdog card and the only proactive message
     * is usage above the vacant baseline (leak-first for water). */
    awayMode: boolean("awayMode").default(false).notNull(),
    /** optional away window (ms epoch); null = indefinite while awayMode on */
    awayStart: bigint("awayStart", { mode: "number" }),
    awayEnd: bigint("awayEnd", { mode: "number" }),
    /** SVC (owner reports Jul 19): per-commodity service profile — JSON object
     * { electric?: "active"|"none"|"unknown", gas?: ..., water?: ... }. User
     * override tier of the resolution ladder in server/commodityService.ts;
     * null/missing keys mean "unknown" (evidence → territory → default apply). */
    servicesProfile: json("servicesProfile"),
    /** Batch-45 (pass 1959): per-field refinement record for quick-start sites —
     * JSON array of core field names (buildingType/sqft/vintage) the user has
     * explicitly provided. Site-level attrSource flips on the FIRST refinement,
     * which alone cannot say WHICH core placeholders remain; this can. Null for
     * regular (non-quick-start) sites and legacy rows. */
    refinedFields: json("refinedFields"),
    /** AC11/AC18 PV gate: solar signature detection state. 'none' = no signature;
     * 'detected_unconfirmed' = signature found, insights that depend on load shape
     * are BLOCKED until the user resolves net vs gross; 'confirmed_net' /
     * 'confirmed_gross' = resolved; 'dismissed' = user says no solar. */
    pvDetectionStatus: mysqlEnum("pvDetectionStatus", [
      "none",
      "detected_unconfirmed",
      "confirmed_net",
      "confirmed_gross",
      "dismissed",
    ])
      .default("none")
      .notNull(),
    pvDetectedAt: bigint("pvDetectedAt", { mode: "number" }),
    /** what the meter records for a solar site: net of PV, or gross consumption */
    netMeteringBasis: varchar("netMeteringBasis", { length: 16 }),
    /** AC12: occupancy-change event — analytics re-base the baseline from this
     * timestamp forward; verdicts issued before it keep their period attribution. */
    occupancyChangedAt: bigint("occupancyChangedAt", { mode: "number" }),
    /** AC15 who-pays/who-benefits: for leased commercial sites, incentive and
     * capex framing depends on the lease. null = owner-occupied / unknown. */
    leaseType: mysqlEnum("leaseType", ["owner_occupied", "gross", "triple_net"]),
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
    format: mysqlEnum("format", ["xlsx", "csv", "espi_xml", "zip", "auto", "bill_pdf", "bill_image", "manual"]).notNull(),
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
    /** §2.6 estimated reads: utilities sometimes bill on estimated (not actual)
     * meter reads; those periods are down-weighted in baselines and disclosed
     * in any verdict that overlaps them. */
    readType: mysqlEnum("readType", ["actual", "estimated", "unknown"]).default("actual").notNull(),
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
    /** v1.18 applicability conditions beyond sector/size: a closed/grandfathered
     * tariff can be a customer's CURRENT basis but never a switch target. */
    closedToNew: boolean("closedToNew").default(false).notNull(),
    /** Technology-conditioned plans, both directions: solar_only plans hidden
     * from non-solar sites; non_solar_only plans hidden from solar sites. */
    techCondition: mysqlEnum("techCondition", ["none", "solar_only", "non_solar_only"]).default("none").notNull(),
    effectiveDate: date("effectiveDate"),
    source: varchar("source", { length: 64 }).default("urdb_snapshot").notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }),
    /** AC16a bill-reconciliation self-calibration: every parsed bill is scored
     * against the predicted cost on the recorded tariff. Repeated hits upgrade
     * trust; misses flag the record and widen savings chips downstream. */
    trustStatus: mysqlEnum("trustStatus", ["seeded", "verified_against_bill", "mismatch_flagged"])
      .default("seeded")
      .notNull(),
    trustUpdatedAt: bigint("trustUpdatedAt", { mode: "number" }),
    reconcileHits: int("reconcileHits").default(0).notNull(),
    reconcileMisses: int("reconcileMisses").default(0).notNull(),
    /** v1.22 non-URDB tariff freshness: currency is earned from bills, not
     * assumed from age. Every reconciliation hit resets this clock; a non-URDB
     * tariff unverified for 12 months widens chips and raises a review task. */
    billVerifiedAt: bigint("billVerifiedAt", { mode: "number" }),
    /** §5.10 net-metering banking rules: how exported kWh credits carry over.
     * 'monthly' = credits net within the billing month only; 'annual' = banked
     * to an annual true-up. null = not a NEM-relevant tariff. */
    nemBanking: mysqlEnum("nemBanking", ["monthly", "annual", "none"]),
    /** credit expiry / true-up description, e.g. "April true-up at avoided cost" */
    nemCreditExpiry: varchar("nemCreditExpiry", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    index("tariffs_utility_idx").on(t.utilityName),
    index("tariffs_state_sector_idx").on(t.state, t.sector),
  ],
);

/** 6b. telecom_services — internet / mobile / phone / TV services attached to a
 * site. TELECOM (Jul 22): telecom is deliberately NOT a commodity-enum member —
 * it has no meters, intervals, weather sensitivity, or tariff structure. It is
 * a recurring-subscription spend with plan attributes, so it gets its own
 * table and analytics module (server/telecom.ts) patterned on the vertical-
 * pack honesty discipline: right-sizing findings only when the user supplied
 * actual usage, market comparisons always disclosed as published-rate
 * comparisons, never fabricated. */
export const telecomServices = mysqlTable(
  "telecom_services",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    serviceType: mysqlEnum("serviceType", ["internet", "mobile", "tv_bundle", "phone_landline"]).notNull(),
    provider: varchar("provider", { length: 128 }).notNull(),
    planName: varchar("planName", { length: 255 }),
    /** current monthly recurring cost, all-in as billed */
    monthlyCostUsd: double("monthlyCostUsd").notNull(),
    /** promo pricing honesty: if the current price is promotional, what it
     * jumps to and when — the single biggest telecom savings lever. */
    promoEndsAt: bigint("promoEndsAt", { mode: "number" }),
    postPromoCostUsd: double("postPromoCostUsd"),
    /** contract lock: early-termination window ends here (null = no contract) */
    contractEndsAt: bigint("contractEndsAt", { mode: "number" }),
    /** internet plan attributes */
    downloadMbps: double("downloadMbps"),
    isBusiness: boolean("isBusiness").default(false).notNull(),
    /** mobile plan attributes */
    lines: int("lines"),
    dataAllowanceGb: double("dataAllowanceGb"),
    /** true when the plan is unlimited data (dataAllowanceGb ignored) */
    unlimitedData: boolean("unlimitedData").default(false).notNull(),
    /** user-reported ACTUAL usage — right-sizing only ever computes from these,
     * never from assumptions. */
    actualDataUsedGb: double("actualDataUsedGb"),
    actualDownloadNeedMbps: double("actualDownloadNeedMbps"),
    /** intake provenance */
    source: mysqlEnum("source", ["manual", "bill_parsed"]).default("manual").notNull(),
    notes: varchar("notes", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("telecom_site_idx").on(t.siteId), index("telecom_user_idx").on(t.userId)],
);

export type TelecomService = typeof telecomServices.$inferSelect;
export type InsertTelecomService = typeof telecomServices.$inferInsert;

/** 6c. telecom_benchmarks — seeded national published-rate catalog (FCC Urban
 * Rate Survey + published carrier/ISP pricing). Code-reviewed seed like
 * STATE_PROFILES; refreshed deliberately, never silently mutated. */
export const telecomBenchmarks = mysqlTable(
  "telecom_benchmarks",
  {
    id: int("id").autoincrement().primaryKey(),
    serviceType: mysqlEnum("serviceType", ["internet", "mobile", "tv_bundle", "phone_landline"]).notNull(),
    /** tier key, e.g. internet_100_300, mobile_unlimited_postpaid */
    tierKey: varchar("tierKey", { length: 64 }).notNull().unique(),
    tierLabel: varchar("tierLabel", { length: 255 }).notNull(),
    /** applicability window for matching an internet service to this tier */
    minMbps: double("minMbps"),
    maxMbps: double("maxMbps"),
    /** true when prices are per line (mobile) */
    perLine: boolean("perLine").default(false).notNull(),
    typicalLowUsd: double("typicalLowUsd").notNull(),
    medianUsd: double("medianUsd").notNull(),
    typicalHighUsd: double("typicalHighUsd").notNull(),
    /** verbatim disclosure basis */
    basis: varchar("basis", { length: 512 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("telecom_bench_type_idx").on(t.serviceType)],
);

export type TelecomBenchmark = typeof telecomBenchmarks.$inferSelect;

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
    /** Batch-audit (Jul 18): widened 32→64 — the flat-mean fallback fit writes
     * "observed-period basis (not weather-normalized)" (46 chars), which
     * crashed ANY analysis whose weather regression degenerated. */
    weatherBasis: varchar("weatherBasis", { length: 64 }).notNull(),
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

/** 10b. measure_implementations — prove-it loop (§3e): user marks a measure as
 * done; monthly verdicts compare counterfactual baseline vs actuals. Honesty
 * gates: no verdict before one full billing cycle; wide bands are named. */
export const measureImplementations = mysqlTable(
  "measure_implementations",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    siteId: int("siteId").notNull(),
    /** nullable — an implementation may reference a ranked opportunity or be free-form */
    opportunityId: int("opportunityId"),
    measure: varchar("measure", { length: 128 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    /** ms epoch: when the user says the change went in */
    implementedAt: bigint("implementedAt", { mode: "number" }).notNull(),
    /** expected annual $ savings at mark time (from the opportunity), for comparison */
    expectedSavingsUsd: double("expectedSavingsUsd"),
    status: mysqlEnum("status", ["awaiting_data", "on_track", "verified", "underperforming", "inconclusive"])
      .default("awaiting_data")
      .notNull(),
    /** verdict history: [{month, expectedUsd, actualDeltaUsd, bandUsd, verdict, note}] */
    verdicts: json("verdicts"),
    /** cumulative verified savings to date (recomputed on each verdict pass) */
    verifiedSavingsUsd: double("verifiedSavingsUsd"),
    lastEvaluatedAt: bigint("lastEvaluatedAt", { mode: "number" }),
    /** AC12 model pinning: the analytics engine version that issued the latest
     * verdicts; a verdict is never silently re-scored by a newer model. */
    engineVersion: varchar("engineVersion", { length: 32 }),
    /** AC12 occupancy re-base: which occupancy period the verdicts belong to,
     * e.g. "pre-2026-03" — verdicts issued before an occupancy change keep
     * their period attribution instead of being re-based. */
    occupancyPeriod: varchar("occupancyPeriod", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("mi_site_idx").on(t.siteId), index("mi_user_idx").on(t.userId)],
);

export type MeasureImplementation = typeof measureImplementations.$inferSelect;

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
      "gas_efficiency",
      "water_efficiency",
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

/** 11b. plan_baskets — §3m manifest: persisted Bill Builder plans (selected
 * measures + composed-results cache) so a composed plan survives the session
 * and can feed the My Energy Plan report. */
export const planBaskets = mysqlTable(
  "plan_baskets",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** selected measures: PlanMeasure[] as chosen in the Bill Builder */
    measures: json("measures").notNull(),
    /** cache of the last composed result (composeMeasures output) — display
     * cache only; re-composed on load if the baseline has since changed */
    composedResults: json("composedResults"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [index("plan_baskets_site_idx").on(t.siteId), index("plan_baskets_user_idx").on(t.userId)],
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

/** 12c. service_territories — ZIP3→utility service-territory registry (TERR,
 * Jul 19). Seeded from EIA Form 861 (electric, 2024) + state PUC territory
 * filings (gas/water). Rows with utilityName = "" are sentinel "positively
 * known unserved" markers; a ZIP3 with no rows at all is NOT covered by the
 * registry and callers must fall back to state-level presence. */
export const serviceTerritories = mysqlTable(
  "service_territories",
  {
    id: int("id").autoincrement().primaryKey(),
    zip3: varchar("zip3", { length: 3 }).notNull(),
    state: varchar("state", { length: 8 }).notNull(),
    commodity: mysqlEnum("commodity", ["electric", "gas", "water"]).notNull(),
    /** Empty string = sentinel: territory positively known unserved. */
    utilityName: varchar("utilityName", { length: 255 }).notNull(),
    sourceVersion: varchar("sourceVersion", { length: 64 }).notNull(),
    /** CUR (Jul 19) — ms epoch of last refresh that confirmed this row. */
    lastVerifiedAt: bigint("lastVerifiedAt", { mode: "number" }),
  },
  (t) => [index("territory_zip3_idx").on(t.zip3, t.commodity)],
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
    footprintSource: mysqlEnum("footprintSource", ["assessor_gis", "microsoft", "usa_structures", "osm", "user_drawn"]),
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

/** §3l reports — verification tokens. Every exported report carries a footer
 * link to /verify/<token> which re-renders the CURRENT numbers live, so a
 * forwarded PDF is never silently stale. Snapshot stores what was printed;
 * the live page shows both printed-at and current figures. */
export const reportArtifacts = mysqlTable(
  "report_artifacts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    siteId: int("siteId").notNull(),
    token: varchar("token", { length: 64 }).notNull().unique(),
    kind: mysqlEnum("kind", ["energy_plan", "verified_savings", "practitioner", "site_insights"]).notNull(),
    /** snapshot of the headline numbers at print time (for drift display) */
    snapshot: json("snapshot"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("report_artifacts_user_idx").on(t.userId), index("report_artifacts_token_idx").on(t.token)],
);

/** §3i alerts framework — dollar-first alert records, quiet by default.
 * Alerts are GENERATED at analysis time (post-upload) and by the digest cron;
 * they live in-app on the home feed + a bell entry. Delivery beyond in-app is
 * honestly labeled post-beta. Rules:
 *  - every alert carries a dollar figure or it isn't created
 *  - conservative default thresholds (material $ only), user-tunable later
 *  - daily batching: at most one open alert per (site, kind) — refreshed, not
 *    duplicated, when the same condition persists across uploads
 */
export const alerts = mysqlTable(
  "alerts",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    siteId: int("siteId").notNull(),
    kind: mysqlEnum("kind", ["anomaly", "demand_spike", "rate_opportunity", "verdict", "digest", "away_watchdog", "pv_signature"]).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    /** the dollar figure that justifies this alert's existence */
    dollarImpactUsd: double("dollarImpactUsd").notNull(),
    /** provenance/confidence chip carried into the UI */
    confidence: varchar("confidence", { length: 32 }),
    status: mysqlEnum("status", ["open", "read", "dismissed"]).default("open").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index("alerts_user_idx").on(t.userId),
    index("alerts_site_kind_idx").on(t.siteId, t.kind),
    index("alerts_status_idx").on(t.userId, t.status),
  ],
);

export type Alert = typeof alerts.$inferSelect;

/** AC15 incentives — curated seed of federal/state/utility incentives with
 * expirations. An expired incentive must never render; economics show pre- and
 * post-incentive paybacks with named sources. */
export const incentives = mysqlTable(
  "incentives",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 48 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    /** federal | state | utility */
    level: varchar("level", { length: 16 }).notNull(),
    /** 'US', 'AZ', 'WA', or utility territory shorthand */
    jurisdiction: varchar("jurisdiction", { length: 32 }).notNull(),
    utilityName: varchar("utilityName", { length: 64 }),
    /** JSON array of opportunity measure keys this incentive applies to */
    measureKeys: text("measureKeys").notNull(),
    /** residential | commercial | both */
    sectorClass: varchar("sectorClass", { length: 16 }).default("both").notNull(),
    /** tax_credit | rebate | bill_credit | dr_payment */
    kind: varchar("kind", { length: 24 }).notNull(),
    /** percent_of_cost | fixed_usd | usd_per_year (DR) | usd_per_unit_saved (custom rebates) */
    amountType: varchar("amountType", { length: 24 }).notNull(),
    amountValue: double("amountValue").notNull(),
    /** for usd_per_unit_saved: commodity whose first-year unit savings the rate pays on (electric|gas|water) */
    unitCommodity: varchar("unitCommodity", { length: 16 }),
    /** for usd_per_unit_saved: the quoted unit (kWh, therm, kgal) */
    unitLabel: varchar("unitLabel", { length: 16 }),
    amountCapUsd: double("amountCapUsd"),
    /** ms epoch; null = no legislated sunset */
    expiresAt: bigint("expiresAt", { mode: "number" }),
    sourceName: varchar("sourceName", { length: 120 }).notNull(),
    sourceUrl: varchar("sourceUrl", { length: 255 }),
    notes: text("notes"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    /** CUR (Jul 19) currency maintenance — ms epoch of the last automated
     * re-verification against the authoritative source; null = never verified
     * since seed. Reports disclose freshness from this. */
    lastVerifiedAt: bigint("lastVerifiedAt", { mode: "number" }),
    /** Versioned provenance of the row's current values (e.g. "seed.1",
     * "verify.2026-07-19"). Refresh runs supersede by writing a new version. */
    sourceVersion: varchar("sourceVersion", { length: 64 }).default("seed.1").notNull(),
  },
);
export type Incentive = typeof incentives.$inferSelect;

/** AC14 vertical packs — user-entered production series (monthly quantities)
 * that unlock production-normalized KPIs and a production regressor. */
export const productionSeries = mysqlTable(
  "production_series",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    /** e.g. water_pumped_mg, units_produced, irrigated_acres */
    metricKey: varchar("metricKey", { length: 48 }).notNull(),
    metricLabel: varchar("metricLabel", { length: 96 }).notNull(),
    unit: varchar("unit", { length: 32 }).notNull(),
    periodStart: bigint("periodStart", { mode: "number" }).notNull(),
    periodEnd: bigint("periodEnd", { mode: "number" }).notNull(),
    quantity: double("quantity").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => [index("ps_site_idx").on(t.siteId), index("ps_user_idx").on(t.userId)],
);
export type ProductionSeriesRow = typeof productionSeries.$inferSelect;

/** §3i roles — owner / facility_manager / read_only membership per site.
 * The owning userId on sites stays the root owner; members extend access. */
export const siteMembers = mysqlTable(
  "site_members",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    /** facility_manager can act (mark measures, refine); read_only can look */
    role: varchar("role", { length: 24 }).default("read_only").notNull(),
    invitedBy: int("invitedBy").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("sm_site_user").on(t.siteId, t.userId),
    index("sm_user_idx").on(t.userId),
  ],
);
export type SiteMember = typeof siteMembers.$inferSelect;

/** AC16b compliance programs — seeded building-performance mandates
 * (WA Clean Buildings first). targetEuiByType is JSON {buildingType: kBtu/sqft}. */
export const compliancePrograms = mysqlTable(
  "compliance_programs",
  {
    id: int("id").autoincrement().primaryKey(),
    code: varchar("code", { length: 48 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    jurisdiction: varchar("jurisdiction", { length: 32 }).notNull(),
    minSqft: double("minSqft").notNull(),
    /** JSON array of covered buildingTypes; null = all commercial */
    buildingTypes: text("buildingTypes"),
    targetEuiByType: text("targetEuiByType").notNull(),
    deadline: bigint("deadline", { mode: "number" }).notNull(),
    penaltyPerSqftUsd: double("penaltyPerSqftUsd").notNull(),
    sourceName: varchar("sourceName", { length: 120 }).notNull(),
    sourceUrl: varchar("sourceUrl", { length: 255 }),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
);
export type ComplianceProgram = typeof compliancePrograms.$inferSelect;

/** AC13 equipment intelligence — probable inventory inferred from archetype +
 * building attributes, confirmable by the user; drives lifecycle horizon. */
export const equipmentInventory = mysqlTable(
  "equipment_inventory",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    equipKey: varchar("equipKey", { length: 48 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /** inferred | user_confirmed | user_entered */
    source: varchar("source", { length: 24 }).default("inferred").notNull(),
    confidence: varchar("confidence", { length: 16 }).default("medium").notNull(),
    /** null when inferred from vintage; user can correct */
    installYear: int("installYear"),
    serviceLifeYears: int("serviceLifeYears").notNull(),
    notes: text("notes"),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("eq_site_key").on(t.siteId, t.equipKey),
    index("eq_user_idx").on(t.userId),
  ],
);
export type EquipmentRow = typeof equipmentInventory.$inferSelect;

/** AC16a bill reconciliations — one row per parsed bill scored against the
 * predicted cost on the recorded tariff. */
export const billReconciliations = mysqlTable(
  "bill_reconciliations",
  {
    id: int("id").autoincrement().primaryKey(),
    siteId: int("siteId").notNull(),
    userId: int("userId").notNull(),
    billId: int("billId").notNull(),
    tariffId: int("tariffId"),
    predictedUsd: double("predictedUsd").notNull(),
    actualUsd: double("actualUsd").notNull(),
    deltaPct: double("deltaPct").notNull(),
    /** match (<=4%) | near (<=12%) | mismatch (>12%) */
    verdict: varchar("verdict", { length: 24 }).notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("br_bill").on(t.billId), index("br_site_idx").on(t.siteId)],
);
export type BillReconciliation = typeof billReconciliations.$inferSelect;

/** 15/15-gated cohort stats — de-identified aggregates computed across users;
 * a cohort renders NOTHING below n=15. */
export const cohortStats = mysqlTable(
  "cohort_stats",
  {
    id: int("id").autoincrement().primaryKey(),
    /** e.g. "AZ|office|10k-50k sqft" */
    cohortKey: varchar("cohortKey", { length: 96 }).notNull(),
    metricKey: varchar("metricKey", { length: 48 }).notNull(),
    n: int("n").notNull(),
    p25: double("p25").notNull(),
    median: double("median").notNull(),
    p75: double("p75").notNull(),
    computedAt: bigint("computedAt", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("cs_key").on(t.cohortKey, t.metricKey)],
);
export type CohortStat = typeof cohortStats.$inferSelect;

/** v1.22 S-LIFECYCLE / AC18b — seeds are living data, not build artifacts.
 * Every seeder declares a refresh cadence; a seed past cadence×1.5 widens the
 * confidence chips of everything derived from it. Queryable per source. */
export const seedFreshness = mysqlTable("seed_freshness", {
  id: int("id").autoincrement().primaryKey(),
  source: varchar("source", { length: 64 }).notNull().unique(),
  version: varchar("version", { length: 32 }).notNull(),
  seededAt: bigint("seededAt", { mode: "number" }).notNull(),
  cadenceDays: int("cadenceDays").notNull(),
  upstreamReleaseSeen: varchar("upstreamReleaseSeen", { length: 64 }),
  lastCheckedAt: bigint("lastCheckedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type SeedFreshnessRow = typeof seedFreshness.$inferSelect;

/** v1.22 — ops task queue for the tariff-template landscape: crowd-sourced
 * unknown-tariff discovery (N≥3 unmatched names → create-template), 12-month
 * unverified non-URDB tariffs (template_review), parser drift (template_update). */
export const templateTasks = mysqlTable("template_tasks", {
  id: int("id").autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["create_template", "template_review", "template_update"]).notNull(),
  utilityName: varchar("utilityName", { length: 128 }),
  tariffNameRaw: varchar("tariffNameRaw", { length: 190 }),
  occurrences: int("occurrences").default(1).notNull(),
  status: mysqlEnum("status", ["open", "resolved"]).default("open").notNull(),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type TemplateTaskRow = typeof templateTasks.$inferSelect;

/** NEXT-3 (Jul 21) — persisted footprint-resolve cache. The in-memory ~6h
 * cache in geometry.ts dies with every autoscale cold start; footprints
 * change on the timescale of YEARS, so successful resolves are also written
 * here (keyed by the same ~11m grid cell) and consulted before hitting the
 * raced OSM/Esri upstreams. 180-day TTL enforced at read time; transport
 * failures are never persisted. */
export const geometryResolveCache = mysqlTable("geometry_resolve_cache", {
  id: int("id").autoincrement().primaryKey(),
  /** ~11m grid cell key: `lat.toFixed(4),lng.toFixed(4)` */
  gridKey: varchar("gridKey", { length: 32 }).notNull().unique(),
  /** which source family produced the candidates */
  provider: mysqlEnum("provider", ["osm", "esri", "none"]).notNull(),
  /** FootprintCandidate[] JSON exactly as resolveFootprints returned it */
  candidates: json("candidates").notNull(),
  resolvedAt: bigint("resolvedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type GeometryResolveCacheRow = typeof geometryResolveCache.$inferSelect;

/** v1.22 config-not-constant rule: external numeric limits (API caps,
 * free-tier thresholds, cache TTLs, service lives) ship as seeded config. */
export const platformConfig = mysqlTable("platform_config", {
  id: int("id").autoincrement().primaryKey(),
  configKey: varchar("configKey", { length: 96 }).notNull().unique(),
  configValue: varchar("configValue", { length: 190 }).notNull(),
  description: text("description"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type PlatformConfigRow = typeof platformConfig.$inferSelect;
