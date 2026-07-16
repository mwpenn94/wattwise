/**
 * Feature query helpers — every tenant-scoped read/write goes through
 * ownership-asserting wrappers (Cycle 5 multi-tenancy enforcement).
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
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
} from "../drizzle/schema";

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

export async function setMeterTariff(meterId: number, tariffId: number, userId: number) {
  await assertMeterOwner(meterId, userId);
  const db = await requireDb();
  await db.update(meters).set({ currentTariffId: tariffId }).where(eq(meters.id, meterId));
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
  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.userId, userId), eq(uploads.sha256, sha256)))
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
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
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
  const rows = await db.select().from(weatherNormals).where(eq(weatherNormals.climateZone, climateZone)).limit(1);
  return rows[0];
}

export async function getEmissionsFactor(zip3: string) {
  const db = await requireDb();
  const zs = await db.select().from(zipSubregions).where(eq(zipSubregions.zip3, zip3)).limit(1);
  const subregion = zs[0]?.subregion ?? "AZNM";
  const rows = await db.select().from(emissionsFactors).where(eq(emissionsFactors.subregion, subregion)).orderBy(desc(emissionsFactors.year)).limit(1);
  return { factor: rows[0], subregion, mapped: zs.length > 0 };
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
  if (rows.length === 0) {
    rows = await db.select().from(archetypeProfiles).where(eq(archetypeProfiles.buildingType, buildingType)).limit(1);
  }
  return rows[0];
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

export async function saveScenario(data: typeof scenarios.$inferInsert) {
  const db = await requireDb();
  const res = await db.insert(scenarios).values(data);
  return Number((res as unknown as [{ insertId: number }])[0].insertId);
}

export async function listScenarios(siteId: number, userId: number) {
  await assertSiteOwner(siteId, userId);
  const db = await requireDb();
  return db.select().from(scenarios).where(eq(scenarios.siteId, siteId)).orderBy(desc(scenarios.id));
}

export async function countScenariosThisMonth(userId: number): Promise<number> {
  const db = await requireDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
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
  // Corrected-bill handling (Cycle 5): same meter+period → revision
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
  return db
    .select({ bill: bills })
    .from(bills)
    .innerJoin(meters, eq(bills.meterId, meters.id))
    .where(eq(meters.siteId, siteId))
    .orderBy(desc(bills.periodStart))
    .then((rows) => rows.map((r) => r.bill));
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
  // intervals can be large — export summary stats + first/last window per meter
  const intervalSummaries = [];
  for (const mid of meterIds) {
    const st = await db
      .select({ n: sql<number>`COUNT(*)`, minTs: sql<number>`MIN(${intervals.ts})`, maxTs: sql<number>`MAX(${intervals.ts})`, total: sql<number>`SUM(${intervals.usage})` })
      .from(intervals)
      .where(eq(intervals.meterId, mid));
    intervalSummaries.push({ meterId: mid, ...st[0] });
  }
  return {
    exportedAt: new Date().toISOString(),
    sites: userSites,
    meters: userMeters,
    intervalSummaries,
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
