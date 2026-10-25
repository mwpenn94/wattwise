/**
 * NEXT-3 (Jul 21) — DB adapter for the persistent footprint-resolve cache.
 *
 * geometry.ts stays dependency-free (pure math + injected transports); this
 * module gives it a database backing so successful footprint resolves survive
 * autoscale cold starts. Registered once at server startup (routers.ts import
 * side effect via registerGeometryCacheDb()).
 *
 * Rules mirrored from the in-memory layer: only non-empty successes are stored;
 * the 180-day read TTL lives in geometry.ts; every operation fails open.
 */
import { eq, sql } from "drizzle-orm";
import { geometryResolveCache } from "../drizzle/schema";
import { getDb } from "./db";
import { setPersistentResolveCache, type FootprintCandidate } from "./geometry";

export function registerGeometryCacheDb(): void {
  setPersistentResolveCache({
    async get(gridKey) {
      const db = await getDb();
      if (!db) return null;
      const rows = await db.select().from(geometryResolveCache).where(eq(geometryResolveCache.gridKey, gridKey)).limit(1);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        provider: r.provider,
        candidates: (r.candidates ?? []) as FootprintCandidate[],
        resolvedAt: r.resolvedAt,
      };
    },
    async put(gridKey, provider, candidates, resolvedAt) {
      if (candidates.length === 0) return;
      const db = await getDb();
      if (!db) return;
      await db
        .insert(geometryResolveCache)
        .values({ gridKey, provider, candidates, resolvedAt })
        .onDuplicateKeyUpdate({ set: {
          provider: sql`IF(VALUES(resolvedAt) >= resolvedAt, VALUES(provider), provider)`,
          candidates: sql`IF(VALUES(resolvedAt) >= resolvedAt, VALUES(candidates), candidates)`,
          resolvedAt: sql`GREATEST(resolvedAt, VALUES(resolvedAt))`,
        } });
    },
  });
}

/* Geometry/location persistence. Kept here so the pure resolver stays DB-free. */
import { and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { analyses, insights, opportunities, siteGeometry, sites, type Site } from "../drizzle/schema";

export function sameLocation(a: Site, b: Site): boolean {
  return (["address", "city", "state", "zip", "lat", "lng", "locationRevision"] as const)
    .every((key) => a[key] === b[key]);
}

/** Caller must authorize before invoking; no lock is held during geocoding. */
export async function saveLocationEdit(before: Site, patch: Partial<typeof sites.$inferInsert>, changed: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(sites).where(eq(sites.id, before.id)).for("update");
    if (!current || !sameLocation(current, before)) {
      throw new TRPCError({ code: "CONFLICT", message: "The site location changed during lookup. Reload and try again." });
    }
    await tx.update(sites).set({ ...patch, ...(changed ? {
      locationRevision: current.locationRevision + 1, locationChangedAt: Date.now(),
    } : {}) }).where(eq(sites.id, before.id));
    if (!changed) return;
    // Keep drawings and historical analyses, but retire live model outputs.
    // Existing baselines are preserved for immutable measurement episodes.
    await tx.update(analyses).set({ status: "failed", error: "Site location changed. Previous analysis is stale; rerun analysis for the current location." })
      .where(eq(analyses.siteId, before.id));
    await tx.delete(insights).where(eq(insights.siteId, before.id));
    await tx.delete(opportunities).where(eq(opportunities.siteId, before.id));
    await tx.insert(insights).values({
      siteId: before.id, kind: "location_changed", severity: "warning", confidence: "high",
      title: "Location changed — confirm your footprint and rerun analysis",
      body: "Previous location-derived geometry and analysis are no longer current. Any hand-drawn footprint is retained for protection, not shown as the new building. Confirm a footprint at the new location and rerun analysis before using modeled results.",
      provenance: { method: "location_revision_v1", locationRevision: current.locationRevision + 1 },
    });
  });
}

/** Atomic compare-and-set; a concurrent edit or recovered point wins over stale geocoding. */
export async function saveRecoveredPoint(before: Site, patch: Partial<typeof sites.$inferInsert>): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const result = await db.update(sites).set(patch).where(and(
    eq(sites.id, before.id), eq(sites.locationRevision, before.locationRevision),
    sql`${sites.address} <=> ${before.address}`, sql`${sites.city} <=> ${before.city}`,
    sql`${sites.state} <=> ${before.state}`, sql`${sites.zip} <=> ${before.zip}`,
    sql`${sites.lat} <=> ${before.lat}`, sql`${sites.lng} <=> ${before.lng}`,
  ));
  return result[0].affectedRows === 1;
}

/** Parent-row lock protects both first inserts and drawn precedence across processes. */
export async function confirmGeometryAtomic(
  siteId: number,
  patch: Partial<typeof siteGeometry.$inferInsert>,
  options: { force?: boolean; locationRevision?: number } = {},
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(sites).where(eq(sites.id, siteId)).for("update");
    if (!parent) throw new TRPCError({ code: "NOT_FOUND" });
    if ((options.locationRevision != null && options.locationRevision !== parent.locationRevision) ||
        (options.locationRevision == null && parent.locationRevision > 0)) {
      throw new TRPCError({ code: "CONFLICT", message: "The site location changed. Retry lookup before confirming a footprint." });
    }
    const [existing] = await tx.select().from(siteGeometry).where(eq(siteGeometry.siteId, siteId)).limit(1);
    if (existing?.footprintSource === "user_drawn" && patch.footprintSource !== "user_drawn" && !options.force) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This site has a footprint you drew yourself. Explicit replacement is required." });
    }
    const values = { ...patch, locationRevision: parent.locationRevision };
    if (existing) {
      await tx.update(siteGeometry).set(values).where(eq(siteGeometry.id, existing.id));
      return existing.id;
    }
    const result = await tx.insert(siteGeometry).values({ ...values, siteId, userId: parent.userId });
    return Number(result[0].insertId);
  });
}

/** Caller must authorize; raw historical rows remain available for overwrite protection only. */
export async function getCurrentGeometry(siteId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select({ geometry: siteGeometry }).from(siteGeometry)
    .innerJoin(sites, and(eq(sites.id, siteGeometry.siteId), eq(sites.locationRevision, siteGeometry.locationRevision)))
    .where(eq(siteGeometry.siteId, siteId)).limit(1);
  return rows[0]?.geometry ?? null;
}
