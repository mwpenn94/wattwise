/**
 * NEXT-3 (Jul 21) — DB adapter for the persistent footprint-resolve cache.
 *
 * geometry.ts stays dependency-free (pure math + injected transports); this
 * module gives it a database backing so successful footprint resolves survive
 * autoscale cold starts. Registered once at server startup (routers.ts import
 * side effect via registerGeometryCacheDb()).
 *
 * Rules mirrored from the in-memory layer: only successes (or confirmed
 * empty-with-both-sources-reachable results) are stored; the 180-day read TTL
 * lives in geometry.ts; every operation fails open.
 */
import { eq } from "drizzle-orm";
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
    async put(gridKey, provider, candidates) {
      const db = await getDb();
      if (!db) return;
      const now = Date.now();
      await db
        .insert(geometryResolveCache)
        .values({ gridKey, provider, candidates, resolvedAt: now })
        .onDuplicateKeyUpdate({ set: { provider, candidates, resolvedAt: now } });
    },
  });
}
