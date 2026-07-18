/**
 * Feature query helpers — every tenant-scoped read/write goes through
 * ownership-asserting wrappers (Cycle 5 multi-tenancy enforcement).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { STATE_SUBREGION } from "./seed/nationalData";
import {
  analyses,
  archetypeProfiles,
  auditLog,
  baselines,
  benchmarks,
  bills,
  convergenceLog,
  emissionsFactors,
  insights,
  intervals,
  meters,
  metering,
  opportunities,
  scenarios,
  seederRuns,
  sites,
  tariffs,
  uploads,
  weatherNormals,
  zipSubregions,
  entities,
  users,
  siteGroups,
  siteGroupMembers,
  siteGeometry,
  measureImplementations,
  reportArtifacts,
  planBaskets,
  alerts,
} from "../drizzle/schema";
import type { Alert } from "../drizzle/schema";

export class TenancyError extends Error {
  constructor(msg = "Access denied: resource does not belong to this account") {
    super(msg);
    this.name = "TenancyError";
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
}

/**
 * Batch-13 (passes 56/76/86/95): serialize quota check-then-create sequences
 * per user with a MySQL named lock so concurrent requests cannot all pass a
 * count-based free-tier check before any row is inserted (sites, uploads,
 * scenarios). The 5s wait bound keeps pile-ups from becoming timeout cascades;
 * GET_LOCK is released in finally and auto-releases if the session dies.
 */
export async function withUserQuotaLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const db = await requireDb();
  const lockName = `ww:quota:${userId}`;
  const got = await db.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS ok`);
  const rows = (got as unknown as [Array<{ ok: number | string | null }>])[0];
  if (Number(rows?.[0]?.ok) !== 1) throw new Error("Could not acquire quota lock; please retry");
  try {
    return await fn();
  } finally {
    try {
      await db.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
    } catch {
      /* auto-released when the session ends; never mask fn()'s outcome */
    }
  }
}

/* ---------------- tenancy assertions ---------------- */
export async function assertSiteOwner(siteId: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.userId, userId))).limit(1);
  if (rows.length === 0) throw new TenancyError();
}

export async function assertMeterOwner(meterId: number, userId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ id: meters.id })
    .from(meters)
    .innerJoin(sites, eq(meters.siteId, sites.id))
    .where(and(eq(meters.id, meterId), eq(sites.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw new TenancyError();
}

/* ---------------- entities (Gap-9 organizational layer) ---------------- */
export async function listEntities(userId: number) {
  const db = await requireDb();
  return db.select().from(entities).where(eq(entities.userId, userId)).orderBy(asc(entities.name));
}

export async function createEntity(data: typeof entities.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(entities).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function assertEntityOwner(entityId: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.id, entityId), eq(entities.userId, userId))).limit(1);
  if (rows.length === 0) throw new TenancyError();
}

export async function updateEntity(
  entityId: number,
  userId: number,
  patch: Partial<Pick<typeof entities.$inferInsert, "name" | "kind" | "notes">>,
) {
  await assertEntityOwner(entityId, userId);
  const db = await requireDb();
  await db.update(entities).set(patch).where(eq(entities.id, entityId));
}

/** Delete an entity. Sites keep their rows — entityId is nulled, never cascaded:
 *  deleting an organizational grouping must not delete analytic data. */
export async function deleteEntity(entityId: number, userId: number) {
  await assertEntityOwner(entityId, userId);
  const db = await requireDb();
  await db.update(sites).set({ entityId: null }).where(and(eq(sites.entityId, entityId), eq(sites.userId, userId)));
  await db.delete(entities).where(eq(entities.id, entityId));
}

export async function assignSiteEntity(siteId: number, entityId: number | null, userId: number) {
  await assertSiteOwner(siteId, userId);
  if (entityId != null) await assertEntityOwner(entityId, userId);
  const db = await requireDb();
  await db.update(sites).set({ entityId }).where(eq(sites.id, siteId));
}

/* ---------------- sites ---------------- */
export async function listSites(userId: number) {
  const db = await requireDb();
  return db.select().from(sites).where(eq(sites.userId, userId)).orderBy(desc(sites.createdAt));
}

export async function getSite(siteId: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.userId, userId))).limit(1);
  if (rows.length === 0) throw new TenancyError();
  return rows[0];
}

export async function createSite(data: typeof sites.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(sites).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

/** Progressive participation: refine a quick-start site's attributes. Only the
 *  provided fields change; attrSource flips to user_entered once the user has
 *  supplied real values for the core placeholder fields. */
export async function updateSite(
  siteId: number,
  userId: number,
  patch: Partial<Pick<typeof sites.$inferInsert, "name" | "address" | "city" | "state" | "zip" | "buildingType" | "sqft" | "vintage" | "climateZone" | "occupancyHours" | "utilityName" | "attrSource" | "refinedFields" | "tenure" | "hasSolar" | "awayMode" | "awayStart" | "awayEnd">>,
) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  await db.update(sites).set(patch).where(eq(sites.id, siteId));
}

/** Full site removal with cascade: meters → intervals, plus all derived data.
 * Derived analytics rows (insights/opportunities/baselines/analyses/scenarios/
 * bills/geometry/group memberships) reference the site and would orphan. */
export async function deleteSite(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  const meterRows = await db.select({ id: meters.id }).from(meters).where(eq(meters.siteId, siteId));
  for (const m of meterRows) {
    await db.delete(intervals).where(eq(intervals.meterId, m.id));
  }
  await db.delete(insights).where(eq(insights.siteId, siteId));
  await db.delete(opportunities).where(eq(opportunities.siteId, siteId));
  await db.delete(baselines).where(eq(baselines.siteId, siteId));
  await db.delete(analyses).where(eq(analyses.siteId, siteId));
  await db.delete(scenarios).where(eq(scenarios.siteId, siteId));
  for (const m of meterRows) {
    await db.delete(bills).where(eq(bills.meterId, m.id));
  }
  await db.delete(siteGeometry).where(eq(siteGeometry.siteId, siteId));
  await db.delete(siteGroupMembers).where(eq(siteGroupMembers.siteId, siteId));
  await db.delete(measureImplementations).where(eq(measureImplementations.siteId, siteId));
  await db.delete(planBaskets).where(eq(planBaskets.siteId, siteId));
  await db.delete(alerts).where(eq(alerts.siteId, siteId));
  await db.delete(meters).where(eq(meters.siteId, siteId));
  // uploads keep their file provenance but detach from the deleted site
  await db.update(uploads).set({ siteId: null }).where(eq(uploads.siteId, siteId));
  await db.delete(sites).where(eq(sites.id, siteId));
}

export async function countSites(userId: number): Promise<number> {
  const db = await requireDb();
  const rows = await db.select({ n: sql<number>`COUNT(*)` }).from(sites).where(eq(sites.userId, userId));
  return Number(rows[0]?.n ?? 0);
}

/* ---------------- meters ---------------- */
export async function listMeters(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db.select().from(meters).where(eq(meters.siteId, siteId)).orderBy(asc(meters.id));
}

export async function createMeter(data: typeof meters.$inferInsert, userId: number) {
  await assertSiteOwner(data.siteId, userId);
  const db = await requireDb();
  const res = await db.insert(meters).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

/** Meter attribute edit: name, timezone, utility, units. Role/parent go through
 * setMeterRole (which validates nesting); tariff through setMeterTariff. */
export async function updateMeter(
  meterId: number,
  userId: number,
  patch: Partial<Pick<typeof meters.$inferInsert, "label" | "timezone" | "usageUnit" | "demandUnit" | "commodity" | "accountNumber">>,
) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  await db.update(meters).set(patch).where(eq(meters.id, meterId));
}

/** Meter removal with cascade: its intervals and bills go with it; any submeters
 * that pointed at it are detached (parent cleared) rather than deleted. */
export async function deleteMeter(meterId: number, userId: number) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  await db.delete(intervals).where(eq(intervals.meterId, meterId));
  await db.delete(bills).where(eq(bills.meterId, meterId));
  await db.update(meters).set({ parentMeterId: null }).where(eq(meters.parentMeterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
}

export async function setMeterTariff(meterId: number, tariffId: number, userId: number) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  await db.update(meters).set({ currentTariffId: tariffId }).where(eq(meters.id, meterId));
}

/** v1.7 §2.4: meter role assignment. Parent (when named) must be owned by the same
 * user AND belong to the same site — cross-site nesting would corrupt aggregation.
 * Only one nesting level: a submeter cannot parent another submeter. */
export async function setMeterRole(
  meterId: number,
  role: "main" | "submeter" | "generation" | "ev" | "virtual_total",
  parentMeterId: number | null,
  userId: number,
) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  if (parentMeterId != null) {
    await assertMeterOwner(parentMeterId, userId);
    const [child] = await db.select({ siteId: meters.siteId }).from(meters).where(eq(meters.id, meterId));
    const [parent] = await db
      .select({ siteId: meters.siteId, role: meters.meterRole })
      .from(meters)
      .where(eq(meters.id, parentMeterId));
    if (!child || !parent || child.siteId !== parent.siteId) {
      throw new Error("Parent meter must belong to the same site as the submeter.");
    }
    if (parent.role === "submeter") {
      throw new Error("Cannot nest under a submeter — only one level of nesting is supported (parent must be a main meter).");
    }
  }
  await db.update(meters).set({ meterRole: role, parentMeterId }).where(eq(meters.id, meterId));
}

/* ---------------- intervals ---------------- */
export async function getIntervalPoints(meterId: number, userId: number, fromTs?: number, toTs?: number) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  const conds = [eq(intervals.meterId, meterId), sql`${intervals.qcFlags} IS NULL OR ${intervals.qcFlags} != 'superseded_overlap'`];
  if (fromTs != null) conds.push(gte(intervals.ts, fromTs));
  if (toTs != null) conds.push(lte(intervals.ts, toTs));
  return db
    .select({ ts: intervals.ts, durationMin: intervals.durationMin, usage: intervals.usage, demand: intervals.demand })
    .from(intervals)
    .where(and(...conds))
    .orderBy(asc(intervals.ts));
}

export async function intervalStats(meterId: number, userId: number) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  const rows = await db
    .select({
      n: sql<number>`COUNT(*)`,
      minTs: sql<number>`MIN(${intervals.ts})`,
      maxTs: sql<number>`MAX(${intervals.ts})`,
      totalUsage: sql<number>`SUM(${intervals.usage})`,
      maxDemand: sql<number>`MAX(${intervals.demand})`,
    })
    .from(intervals)
    .where(and(eq(intervals.meterId, meterId), sql`(${intervals.qcFlags} IS NULL OR ${intervals.qcFlags} != 'superseded_overlap')`));
  return rows[0];
}

/* ---------------- uploads ---------------- */
export async function createUpload(data: typeof uploads.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(uploads).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function findUploadByHash(userId: number, sha256: string) {
  const db = await requireDb();
  // Only treat as duplicate when the prior upload fully succeeded AND the raw
  // file was durably stored (fileKey present). A prior attempt whose storagePut
  // failed must NOT short-circuit a re-upload, or the raw source becomes
  // permanently unrecoverable for re-parse/audit.
  const rows = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.userId, userId),
        eq(uploads.sha256, sha256),
        eq(uploads.status, "parsed"),
        isNotNull(uploads.fileKey),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function updateUpload(id: number, data: Partial<typeof uploads.$inferInsert>) {
  const db = await requireDb();
  await db.update(uploads).set(data).where(eq(uploads.id, id));
}

export async function listUploads(userId: number) {
  const db = await requireDb();
  return db.select().from(uploads).where(eq(uploads.userId, userId)).orderBy(desc(uploads.createdAt)).limit(50);
}

export async function countUploadsThisMonth(userId: number): Promise<number> {
  const db = await requireDb();
  // UTC month boundary — createdAt is stored in UTC; a server-local boundary
  // would mis-count quota near month edges.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(uploads)
    .where(and(eq(uploads.userId, userId), gte(uploads.createdAt, monthStart)));
  return Number(rows[0]?.n ?? 0);
}

/* ---------------- reference data (global, not tenant-scoped) ---------------- */
export async function listTariffs(commodity?: "electric" | "gas" | "water", state?: string) {
  const db = await requireDb();
  const conds = [];
  if (commodity) conds.push(eq(tariffs.commodity, commodity));
  if (state) conds.push(eq(tariffs.state, state));
  return conds.length > 0 ? db.select().from(tariffs).where(and(...conds)) : db.select().from(tariffs);
}

export async function getTariff(id: number) {
  const db = await requireDb();
  const rows = await db.select().from(tariffs).where(eq(tariffs.id, id)).limit(1);
  return rows[0];
}

export async function getWeatherStation(climateZone: string) {
  const db = await requireDb();
  const zone = climateZone.trim().toUpperCase();
  const rows = await db.select().from(weatherNormals).where(eq(weatherNormals.climateZone, zone)).limit(1);
  if (rows[0]) return rows[0];
  // National coverage (Jul 2026): one station per IECC zone is seeded, so an
  // exact match should exist for canonical zones. For user-typed zones like
  // "4" (no moisture letter) or rare variants, fall back to the nearest
  // numeric band rather than returning nothing.
  const band = parseInt(zone, 10);
  if (Number.isFinite(band)) {
    const all = await db.select().from(weatherNormals);
    const scored = all
      .map((r) => {
        const rb = parseInt(r.climateZone, 10);
        return { r, d: Number.isFinite(rb) ? Math.abs(rb - band) : 99 };
      })
      .sort((a, b) => a.d - b.d);
    return scored[0]?.r;
  }
  return undefined;
}

export async function getEmissionsFactor(zip3: string, state?: string | null) {
  const db = await requireDb();
  const zs = await db.select().from(zipSubregions).where(eq(zipSubregions.zip3, zip3)).limit(1);
  // National coverage (Jul 2026): ZIP3 crosswalk first, then the state's
  // dominant eGRID subregion, then AZNM only as the final legacy default.
  const stateSub = state ? STATE_SUBREGION[state.toUpperCase()] : undefined;
  const subregion = zs[0]?.subregion ?? stateSub ?? "AZNM";
  const rows = await db.select().from(emissionsFactors).where(eq(emissionsFactors.subregion, subregion)).orderBy(desc(emissionsFactors.year)).limit(1);
  return { factor: rows[0], subregion, mapped: zs.length > 0 || Boolean(stateSub) };
}

export async function getBenchmark(buildingType: string, commodity: "electric" | "gas" | "water" | "site_total") {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(benchmarks)
    .where(and(eq(benchmarks.buildingType, buildingType), eq(benchmarks.commodity, commodity)))
    .limit(1);
  return rows[0];
}

export async function getArchetype(buildingType: string, climateZone: string, vintageBand: string) {
  const db = await requireDb();
  // exact match first; degrade gracefully (zone → any zone; vintage → 'all')
  let rows = await db
    .select()
    .from(archetypeProfiles)
    .where(
      and(
        eq(archetypeProfiles.buildingType, buildingType),
        eq(archetypeProfiles.climateZone, climateZone),
        inArray(archetypeProfiles.vintageBand, [vintageBand, "all"]),
      ),
    )
    .limit(1);
  if (rows.length > 0) return { ...rows[0], zoneMatched: true };
  // Cycle 10 (pass 546): graduated degradation — same building type in the SAME
  // climate zone (any vintage) before falling back to any-zone. A cold-climate
  // archetype silently substituted for a hot-climate site materially skews the
  // baseline, so the any-zone fallback is flagged via zoneMatched=false and
  // callers disclose the mismatch.
  rows = await db
    .select()
    .from(archetypeProfiles)
    .where(and(eq(archetypeProfiles.buildingType, buildingType), eq(archetypeProfiles.climateZone, climateZone)))
    .limit(1);
  if (rows.length > 0) return { ...rows[0], zoneMatched: true };
  rows = await db.select().from(archetypeProfiles).where(eq(archetypeProfiles.buildingType, buildingType)).limit(1);
  return rows.length > 0 ? { ...rows[0], zoneMatched: false } : undefined;
}

/* ---------------- site groups (v1.7 §2.2a portfolio rollups) ---------------- */
export async function listSiteGroups(userId: number) {
  const db = await requireDb();
  const groups = await db.select().from(siteGroups).where(eq(siteGroups.userId, userId)).orderBy(asc(siteGroups.name));
  if (groups.length === 0) return [];
  const members = await db
    .select()
    .from(siteGroupMembers)
    .where(inArray(siteGroupMembers.groupId, groups.map((g) => g.id)));
  return groups.map((g) => ({ ...g, siteIds: members.filter((m) => m.groupId === g.id).map((m) => m.siteId) }));
}

export async function createSiteGroup(userId: number, name: string, kind: "region" | "manager" | "brand" | "custom", entityId: number | null) {
  const db = await requireDb();
  if (entityId != null) await assertEntityOwner(entityId, userId);
  const res = await db.insert(siteGroups).values({ userId, name, kind, entityId });
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function assertGroupOwner(groupId: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select({ id: siteGroups.id }).from(siteGroups).where(and(eq(siteGroups.id, groupId), eq(siteGroups.userId, userId))).limit(1);
  if (rows.length === 0) throw new TenancyError();
}

export async function setGroupMembership(groupId: number, siteId: number, member: boolean, userId: number) {
  await assertGroupOwner(groupId, userId);
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  if (member) {
    await db
      .insert(siteGroupMembers)
      .values({ groupId, siteId })
      .onDuplicateKeyUpdate({ set: { siteId: sql`VALUES(siteId)` } });
  } else {
    await db.delete(siteGroupMembers).where(and(eq(siteGroupMembers.groupId, groupId), eq(siteGroupMembers.siteId, siteId)));
  }
}

export async function deleteSiteGroup(groupId: number, userId: number) {
  await assertGroupOwner(groupId, userId);
  const db = await requireDb();
  await db.delete(siteGroupMembers).where(eq(siteGroupMembers.groupId, groupId));
  await db.delete(siteGroups).where(eq(siteGroups.id, groupId));
}

/* ---------------- site geometry (v1.7 §2.9a) ---------------- */
export async function getSiteGeometry(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  const rows = await db.select().from(siteGeometry).where(eq(siteGeometry.siteId, siteId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertSiteGeometry(siteId: number, userId: number, patch: Partial<typeof siteGeometry.$inferInsert>) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  const existing = await db.select({ id: siteGeometry.id }).from(siteGeometry).where(eq(siteGeometry.siteId, siteId)).limit(1);
  if (existing.length > 0) {
    await db.update(siteGeometry).set(patch).where(eq(siteGeometry.id, existing[0].id));
    return existing[0].id;
  }
  const res = await db.insert(siteGeometry).values({ ...patch, siteId, userId } as typeof siteGeometry.$inferInsert);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function listSeederRuns() {
  const db = await requireDb();
  return db.select().from(seederRuns).orderBy(desc(seederRuns.startedAt));
}

export async function listConvergenceLog() {
  const db = await requireDb();
  return db.select().from(convergenceLog).orderBy(asc(convergenceLog.id));
}

export async function appendConvergenceLog(entry: typeof convergenceLog.$inferInsert) {
  const db = await requireDb();
  await db.insert(convergenceLog).values(entry);
}

/* ---------------- analysis artifacts ---------------- */
export async function createAnalysis(data: typeof analyses.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(analyses).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function updateAnalysis(id: number, data: Partial<typeof analyses.$inferInsert>) {
  const db = await requireDb();
  await db.update(analyses).set(data).where(eq(analyses.id, id));
}

export async function getLatestAnalysis(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  const rows = await db.select().from(analyses).where(eq(analyses.siteId, siteId)).orderBy(desc(analyses.id)).limit(1);
  return rows[0];
}

export async function saveBaseline(data: typeof baselines.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(baselines).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function getLatestBaseline(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  const rows = await db.select().from(baselines).where(eq(baselines.siteId, siteId)).orderBy(desc(baselines.id)).limit(1);
  return rows[0];
}

export async function replaceInsights(siteId: number, rows: Array<typeof insights.$inferInsert>) {
  const db = await requireDb();
  await db.delete(insights).where(eq(insights.siteId, siteId));
  if (rows.length > 0) await db.insert(insights).values(rows);
}

/** Insert a single standalone insight row (quick-start assumption disclosures).
 *  NOTE: replaceInsights wipes all site insights on each analysis run, so the
 *  pipeline re-emits the intake-assumption insight itself when the site's
 *  attrSource is quick_start_defaults — this helper covers the pre-analysis
 *  window so the disclosure exists from the moment the site is created. */
export async function addInsight(row: typeof insights.$inferInsert) {
  const db = await requireDb();
  await db.insert(insights).values(row);
}

export async function listInsights(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db.select().from(insights).where(eq(insights.siteId, siteId)).orderBy(asc(insights.id));
}

export async function replaceOpportunities(siteId: number, rows: Array<typeof opportunities.$inferInsert>) {
  const db = await requireDb();
  await db.delete(opportunities).where(eq(opportunities.siteId, siteId));
  if (rows.length > 0) await db.insert(opportunities).values(rows);
}

export async function listOpportunities(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db.select().from(opportunities).where(eq(opportunities.siteId, siteId)).orderBy(asc(opportunities.rank));
}

/* ---------- §3e prove-it loop: measure implementations ---------- */

export async function createMeasureImplementation(data: typeof measureImplementations.$inferInsert) {
  await assertSiteOwner(data.siteId, data.userId);
  const db = await requireDb();
  const res = await db.insert(measureImplementations).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function listMeasureImplementations(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db
    .select()
    .from(measureImplementations)
    .where(eq(measureImplementations.siteId, siteId))
    .orderBy(desc(measureImplementations.implementedAt));
}

export async function getMeasureImplementation(id: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(measureImplementations).where(eq(measureImplementations.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new TenancyError();
  return row;
}

export async function updateMeasureVerdicts(
  id: number,
  userId: number,
  patch: {
    status: "awaiting_data" | "on_track" | "verified" | "underperforming" | "inconclusive";
    verdicts: unknown;
    verifiedSavingsUsd: number;
    lastEvaluatedAt: number;
  },
) {
  await getMeasureImplementation(id, userId); // tenancy assert
  const db = await requireDb();
  await db.update(measureImplementations).set(patch).where(eq(measureImplementations.id, id));
}

export async function deleteMeasureImplementation(id: number, userId: number) {
  await getMeasureImplementation(id, userId); // tenancy assert
  const db = await requireDb();
  await db.delete(measureImplementations).where(eq(measureImplementations.id, id));
}

/** Sum of verified savings across all of a user's implementations (home-feed greeting). */
export async function totalVerifiedSavings(userId: number): Promise<number> {
  const db = await requireDb();
  const rows = await db
    .select({ s: sql<number>`COALESCE(SUM(${measureImplementations.verifiedSavingsUsd}), 0)` })
    .from(measureImplementations)
    .where(eq(measureImplementations.userId, userId));
  return Number(rows[0]?.s ?? 0);
}

export async function saveScenario(data: typeof scenarios.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(scenarios).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function renameScenario(scenarioId: number, userId: number, name: string) {
  const db = await requireDb();
  const [row] = await db.select({ userId: scenarios.userId }).from(scenarios).where(eq(scenarios.id, scenarioId));
  if (!row || row.userId !== userId) throw new TenancyError();
  await db.update(scenarios).set({ name }).where(eq(scenarios.id, scenarioId));
}

export async function deleteScenario(scenarioId: number, userId: number) {
  const db = await requireDb();
  const [row] = await db.select({ userId: scenarios.userId }).from(scenarios).where(eq(scenarios.id, scenarioId));
  if (!row || row.userId !== userId) throw new TenancyError();
  await db.delete(scenarios).where(eq(scenarios.id, scenarioId));
}

/** Upload removal: deletes the upload row AND every interval it ingested
 * (provenance-linked via intervals.uploadId), so bad files can be fully backed
 * out. Bills parsed from the upload are also removed. */
export async function deleteUpload(uploadId: number, userId: number) {
  const db = await requireDb();
  const [row] = await db.select({ userId: uploads.userId }).from(uploads).where(eq(uploads.id, uploadId));
  if (!row || row.userId !== userId) throw new TenancyError();
  const removedIntervals = await db.delete(intervals).where(eq(intervals.uploadId, uploadId));
  await db.delete(bills).where(eq(bills.uploadId, uploadId));
  await db.delete(uploads).where(eq(uploads.id, uploadId));
  return Number((removedIntervals as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
}

export async function listScenarios(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db.select().from(scenarios).where(eq(scenarios.siteId, siteId)).orderBy(desc(scenarios.id));
}

export async function countScenariosThisMonth(userId: number): Promise<number> {
  const db = await requireDb();
  // UTC month boundary — createdAt is stored in UTC (see countUploadsThisMonth).
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(scenarios)
    .where(and(eq(scenarios.userId, userId), gte(scenarios.createdAt, monthStart)));
  return Number(rows[0]?.n ?? 0);
}

/* ---------------- bills ---------------- */
export async function createBill(data: typeof bills.$inferInsert, userId: number) {
  await assertMeterOwner(data.meterId, userId);
  const db = await requireDb();
  // Corrected-bill handling (Cycle 5): same meter+period → revision.
  // Cycle 5, pass 146b: a caller-provided supersedesBillId is authoritative —
  // the user knows which bill they are correcting (e.g. period dates were also
  // wrong on the original). Auto-detection only runs when it is absent, and it
  // never overwrites an explicit link.
  if (data.supersedesBillId != null) {
    const target = await db
      .select({ id: bills.id, billRevision: bills.billRevision, meterId: bills.meterId })
      .from(bills)
      .where(eq(bills.id, data.supersedesBillId))
      .limit(1);
    if (target.length === 0 || target[0].meterId !== data.meterId) {
      throw new Error("supersedesBillId does not reference an existing bill on this meter");
    }
    data = { ...data, billRevision: (target[0].billRevision ?? 0) + 1 };
    const res = await db.insert(bills).values(data);
    return { id: Number((res as unknown as [{ insertId: number }])[0].insertId), isRevision: true };
  }
  // Auto-detect path: the WHERE clause below is scoped to eq(bills.meterId,
  // data.meterId), so existing[0] is guaranteed same-meter by construction —
  // cross-meter linkage is structurally impossible here (pass-446 adjudicated:
  // the meterId filter IS the ownership constraint; no separate check needed).
  const existing = await db
    .select({ id: bills.id, billRevision: bills.billRevision })
    .from(bills)
    .where(
      and(
        eq(bills.meterId, data.meterId),
        eq(bills.periodStart, data.periodStart),
        eq(bills.periodEnd, data.periodEnd),
      ),
    )
    .orderBy(desc(bills.billRevision))
    .limit(1);
  if (existing.length > 0) {
    data = { ...data, billRevision: (existing[0].billRevision ?? 0) + 1, supersedesBillId: existing[0].id };
  }
  const res = await db.insert(bills).values(data);
  return { id: Number((res as unknown as [{ insertId: number }])[0].insertId), isRevision: existing.length > 0 };
}

export async function listBills(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  // Batch-42 (pass 1836): defense-in-depth — the query itself binds rows to
  // sites.userId instead of trusting the meters.siteId join alone. Without
  // this, a meter row whose siteId was erroneously (or via some future write
  // path, maliciously) repointed at another user's site would leak that
  // user's bills through this endpoint even though assertSiteOwner passed
  // for the caller's own siteId. The sites join makes cross-tenant rows
  // structurally unreturnable regardless of meter-row integrity.
  return db
    .select({ bill: bills })
    .from(bills)
    .innerJoin(meters, eq(bills.meterId, meters.id))
    .innerJoin(sites, eq(meters.siteId, sites.id))
    .where(and(eq(meters.siteId, siteId), eq(sites.userId, userId)))
    .orderBy(desc(bills.periodStart))
    .then((rows) => rows.map((r) => r.bill));
}

/* ---------------- account tier ---------------- */
/** Gap-6 (Jul 2026): self-serve beta tier switching — users update their own
 *  row only; admin role is unaffected (tierOf gives admins pro regardless). */
export async function setUserTier(userId: number, tier: "free" | "plus" | "pro") {
  const db = await requireDb();
  await db.update(users).set({ tier }).where(eq(users.id, userId));
}

/* ---------------- audit + export ---------------- */
export async function audit(userId: number | null, action: string, entity?: string, entityId?: string, detail?: unknown) {
  const db = await getDb();
  if (!db) return;
  await db.insert(auditLog).values({ userId, action, entity, entityId, detail: detail ?? null });
}

export async function exportUserData(userId: number) {
  const db = await requireDb();
  const userSites = await db.select().from(sites).where(eq(sites.userId, userId));
  const siteIds = userSites.map((s) => s.id);
  const userMeters = siteIds.length > 0 ? await db.select().from(meters).where(inArray(meters.siteId, siteIds)) : [];
  const meterIds = userMeters.map((m) => m.id);
  const userBills = meterIds.length > 0 ? await db.select().from(bills).where(inArray(bills.meterId, meterIds)) : [];
  const userScenarios = siteIds.length > 0 ? await db.select().from(scenarios).where(inArray(scenarios.siteId, siteIds)) : [];
  const userBaselines = siteIds.length > 0 ? await db.select().from(baselines).where(inArray(baselines.siteId, siteIds)) : [];
  const userInsights = siteIds.length > 0 ? await db.select().from(insights).where(inArray(insights.siteId, siteIds)) : [];
  const userOpps = siteIds.length > 0 ? await db.select().from(opportunities).where(inArray(opportunities.siteId, siteIds)) : [];
  const userUploads = await db.select().from(uploads).where(eq(uploads.userId, userId));
  const userMetering = await db.select().from(metering).where(eq(metering.userId, userId));
  // Cycle 5, pass 196: a data export must include the user's raw interval
  // readings, not only summary stats — capped at 100k rows per meter with an
  // explicit truncation note so completeness is never silently lost.
  const INTERVAL_EXPORT_CAP = 100_000;
  const intervalSummaries = [];
  // Batch-45 (pass 1926b): the DSAR export intentionally queries the intervals
  // table DIRECTLY (no qcFlags filter) so superseded_overlap rows — real meter
  // readings displaced by a later higher-precedence import — are never omitted
  // from a data-subject export. qcFlags is included on every exported point so
  // the subject can distinguish active rows from superseded ones.
  const intervalPoints: Array<{ meterId: number; truncatedAtRows: number | null; points: Array<{ ts: number; durationMin: number; usage: number; demand: number | null; qcFlags: string | null }> }> = [];
  for (const mid of meterIds) {
    const st = await db
      .select({ n: sql<number>`COUNT(*)`, minTs: sql<number>`MIN(${intervals.ts})`, maxTs: sql<number>`MAX(${intervals.ts})`, total: sql<number>`SUM(${intervals.usage})` })
      .from(intervals)
      .where(eq(intervals.meterId, mid));
    intervalSummaries.push({ meterId: mid, ...st[0] });
    // Batch-16 (passes 256/266): when a meter exceeds the cap, keep the MOST
    // RECENT rows (a data subject's recent history is the valuable part) and
    // say so accurately in the note. Query newest-first, then reverse so the
    // export artifact itself stays chronological (oldest→newest).
    const rows = await db
      .select({ ts: intervals.ts, durationMin: intervals.durationMin, usage: intervals.usage, demand: intervals.demand, qcFlags: intervals.qcFlags })
      .from(intervals)
      .where(eq(intervals.meterId, mid))
      .orderBy(desc(intervals.ts))
      .limit(INTERVAL_EXPORT_CAP + 1);
    const truncated = rows.length > INTERVAL_EXPORT_CAP;
    const kept = (truncated ? rows.slice(0, INTERVAL_EXPORT_CAP) : rows).reverse();
    intervalPoints.push({
      meterId: mid,
      truncatedAtRows: truncated ? INTERVAL_EXPORT_CAP : null,
      points: kept.map((r) => ({
        ts: Number(r.ts),
        durationMin: r.durationMin,
        usage: Number(r.usage),
        demand: r.demand == null ? null : Number(r.demand),
        qcFlags: r.qcFlags ?? null,
      })),
    });
  }
  return {
    exportedAt: new Date().toISOString(),
    sites: userSites,
    meters: userMeters,
    intervalSummaries,
    intervalPoints,
    intervalExportNote:
      "Raw interval readings included per meter in chronological order, INCLUDING rows superseded by later higher-precedence imports (qcFlags='superseded_overlap' — these are excluded from analysis but remain part of your data record). Meters with more than 100,000 stored rows are capped to the MOST RECENT 100,000 (older rows omitted) and flagged via truncatedAtRows; intervalSummaries reflect the full stored range and, like the raw points, INCLUDE superseded rows — so totals here may exceed analysis views, which exclude superseded rows.",
    bills: userBills,
    baselines: userBaselines,
    scenarios: userScenarios,
    insights: userInsights,
    opportunities: userOpps,
    // Cycle 1 pass 16: destructuring genuinely removes the keys (assigning
    // undefined leaves them present in superjson serialization).
    uploads: userUploads.map(({ fileKey: _fk, fileUrl: _fu, ...rest }: Record<string, unknown>) => rest),
    metering: userMetering,
  };
}

/* ---------------- §3l report artifacts (verify tokens) ---------------- */
export async function createReportArtifact(data: typeof reportArtifacts.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(reportArtifacts).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

/** Public lookup by token — used by the /verify page. No tenancy check by
 * design (the unguessable token IS the capability, like a share link), and
 * the page renders only report-headline figures, never account data. */
export async function getReportArtifactByToken(token: string) {
  const db = await requireDb();
  const rows = await db.select().from(reportArtifacts).where(eq(reportArtifacts.token, token)).limit(1);
  return rows[0] ?? null;
}

export async function listReportArtifacts(userId: number) {
  const db = await requireDb();
  return db.select().from(reportArtifacts).where(eq(reportArtifacts.userId, userId)).orderBy(desc(reportArtifacts.createdAt)).limit(50);
}

/* ---------------- §3f digest settings ---------------- */
export async function setDigestPrefs(userId: number, optIn: boolean, anchorDay: number) {
  const db = await requireDb();
  const day = Math.min(28, Math.max(1, Math.round(anchorDay)));
  await db.update(users).set({ digestOptIn: optIn, digestAnchorDay: day }).where(eq(users.id, userId));
}

export async function getDigestPrefs(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ digestOptIn: users.digestOptIn, digestAnchorDay: users.digestAnchorDay, digestCronTaskUid: users.digestCronTaskUid })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? { digestOptIn: false, digestAnchorDay: 1, digestCronTaskUid: null };
}

/* ------------------------------------------------------------------ */
/* Plan baskets (§3m manifest) — persisted Bill Builder plans           */
/* ------------------------------------------------------------------ */

export async function savePlanBasket(row: {
  siteId: number;
  userId: number;
  name: string;
  measures: unknown;
  composedResults?: unknown;
}) {
  await assertSiteOwner(row.siteId, row.userId);
  const db = await requireDb();
  const res = await db.insert(planBaskets).values({
    siteId: row.siteId,
    userId: row.userId,
    name: row.name,
    measures: row.measures as object,
    composedResults: (row.composedResults ?? null) as object | null,
  });
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function listPlanBaskets(userId: number, siteId?: number) {
  const db = await requireDb();
  const where = siteId != null ? and(eq(planBaskets.userId, userId), eq(planBaskets.siteId, siteId)) : eq(planBaskets.userId, userId);
  return db.select().from(planBaskets).where(where).orderBy(desc(planBaskets.updatedAt));
}

export async function getPlanBasket(id: number, userId: number) {
  const db = await requireDb();
  const rows = await db.select().from(planBaskets).where(and(eq(planBaskets.id, id), eq(planBaskets.userId, userId))).limit(1);
  return rows[0] ?? null;
}

export async function deletePlanBasket(id: number, userId: number) {
  const db = await requireDb();
  await db.delete(planBaskets).where(and(eq(planBaskets.id, id), eq(planBaskets.userId, userId)));
}

/* ================= §3i alerts framework ================= */
/** Upsert an alert with daily batching: at most one OPEN alert per
 * (site, kind). If an open one exists, refresh its figures instead of
 * creating a duplicate — persisted conditions update in place. Alerts
 * without a material dollar figure are refused here (dollar-first rule). */
export async function upsertAlert(row: {
  userId: number;
  siteId: number;
  kind: "anomaly" | "demand_spike" | "rate_opportunity" | "verdict" | "digest" | "away_watchdog";
  title: string;
  body?: string;
  dollarImpactUsd: number;
  confidence?: string;
}): Promise<{ id: number; refreshed: boolean } | null> {
  // dollar-first honesty gate: conservative $25/yr materiality floor —
  // below that we stay quiet rather than nag (quiet-by-default rule).
  // v1.19 exception: away-watchdog findings are SAFETY alerts (a running leak
  // grows past any dollar floor); the 6h-sustained vacant-baseline gate
  // upstream is the honesty filter for these, not dollars.
  if (row.kind !== "away_watchdog" && (!Number.isFinite(row.dollarImpactUsd) || Math.abs(row.dollarImpactUsd) < 25)) return null;
  const db = await requireDb();
  const existing = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.siteId, row.siteId), eq(alerts.kind, row.kind), eq(alerts.status, "open")));
  if (existing.length > 0) {
    await db
      .update(alerts)
      .set({
        title: row.title,
        body: row.body ?? null,
        dollarImpactUsd: row.dollarImpactUsd,
        confidence: row.confidence ?? null,
      })
      .where(eq(alerts.id, existing[0]!.id));
    return { id: existing[0]!.id, refreshed: true };
  }
  const res = await db.insert(alerts).values({
    userId: row.userId,
    siteId: row.siteId,
    kind: row.kind,
    title: row.title,
    body: row.body ?? null,
    dollarImpactUsd: row.dollarImpactUsd,
    confidence: row.confidence ?? null,
  });
  return { id: Number((res as unknown as [{ insertId: number }])[0].insertId), refreshed: false };
}

export async function listAlerts(userId: number, status?: "open" | "read" | "dismissed"): Promise<Alert[]> {
  const db = await requireDb();
  const cond = status ? and(eq(alerts.userId, userId), eq(alerts.status, status)) : eq(alerts.userId, userId);
  return db.select().from(alerts).where(cond).orderBy(desc(alerts.createdAt)).limit(100);
}

export async function setAlertStatus(id: number, userId: number, status: "read" | "dismissed"): Promise<boolean> {
  const db = await requireDb();
  const rows = await db.select().from(alerts).where(and(eq(alerts.id, id), eq(alerts.userId, userId)));
  if (rows.length === 0) return false;
  await db.update(alerts).set({ status }).where(eq(alerts.id, id));
  return true;
}

/* ------------- digest cron bookkeeping (Heartbeat) ------------- */
/** Look up by taskUid ONLY — never by request-body fields (cron security rule). */
export async function getUserByDigestTaskUid(taskUid: string) {
  const db = await requireDb();
  const rows = await db.select().from(users).where(eq(users.digestCronTaskUid, taskUid));
  return rows[0] ?? null;
}

export async function setDigestCronTaskUid(userId: number, taskUid: string | null): Promise<void> {
  const db = await requireDb();
  await db.update(users).set({ digestCronTaskUid: taskUid }).where(eq(users.id, userId));
}
