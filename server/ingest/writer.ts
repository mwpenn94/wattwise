/**
 * Canonical interval writer — idempotent ingestion invariant (handoff §4).
 * - content-hash dedupe at upload level (sha256)
 * - (meter, ts, durationMin) unique key with precedence-aware upsert
 * - Cycle 5: overlap-window detection — an incoming interval whose
 *   [start, start+duration) window overlaps existing records of a DIFFERENT
 *   duration for the same meter resolves by precedence per covered window;
 *   losers get qcFlags='superseded_overlap' (retained for audit).
 */
import { reclaimMemory } from "./memory";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { intervals } from "../../drizzle/schema";
import type { ParsedMeterSeries } from "./parsers";

type BaseDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Db = Pick<BaseDb, "select" | "insert" | "update">;

export interface WriteResult {
  inserted: number;
  replaced: number;
  skippedDuplicates: number;
  overlapsResolved: number;
}

/**
 * Write a parsed series into `intervals` for meterId.
 * precedence: interval file = 2, bill-derived = 1, manual = 0 (higher wins).
 */
export async function writeIntervals(
  db: Db,
  meterId: number,
  series: ParsedMeterSeries,
  uploadId: number,
  precedence = 2,
): Promise<WriteResult> {
  const res: WriteResult = { inserted: 0, replaced: 0, skippedDuplicates: 0, overlapsResolved: 0 };
  if (series.points.length === 0) return res;

  const minTs = series.points[0].ts;
  const maxTs = series.points[series.points.length - 1].ts + series.points[series.points.length - 1].durationMin * 60000;

  // Load existing records covering the incoming window once (bounded query).
  const existing = await db
    .select({
      id: intervals.id,
      ts: intervals.ts,
      durationMin: intervals.durationMin,
      precedence: intervals.precedence,
      qcFlags: intervals.qcFlags,
    })
    .from(intervals)
    .where(and(eq(intervals.meterId, meterId), gte(intervals.ts, minTs - 24 * 3600_000), lt(intervals.ts, maxTs)));

  const exactKey = new Map<string, (typeof existing)[number]>();
  for (const e of existing) exactKey.set(`${e.ts}:${e.durationMin}`, e);

  // Overlap index: existing records with different durations, sorted by ts
  const others = existing
    .filter((e) => e.qcFlags !== "superseded_overlap")
    .sort((a, b) => a.ts - b.ts);

  const supersededIds = new Set<number>();
  // Oct 25 (512 MiB envelope): a 140k-point sheet used to materialize 140k
  // insert objects up front (~130 MiB of heap at once, the phase that tipped
  // the container into an OOM kill). Only point indices are kept; each
  // 1,000-row batch object is built right before its INSERT.
  const toInsert: number[] = [];

  let overlapStart = 0;
  for (let pi = 0; pi < series.points.length; pi++) {
    const p = series.points[pi];
    const key = `${p.ts}:${p.durationMin}`;
    const exact = exactKey.get(key);
    if (exact) {
      if (precedence > exact.precedence) {
        // Null-safe demand: a higher-precedence usage-only point must not
        // erase an existing measured demand value (pass-444 finding).
        await db
          .update(intervals)
          .set({
            usage: p.usage,
            demand: p.demand ?? sql`\`demand\``,
            uploadId,
            precedence,
            qcFlags: null,
          })
          .where(eq(intervals.id, exact.id));
        res.replaced++;
      } else {
        res.skippedDuplicates++;
      }
      continue;
    }
    // Cycle 5: partial-overlap detection (different duration records covering this window)
    const pEnd = p.ts + p.durationMin * 60000;
    // Incoming points are sorted. Discard expired prefixes once rather than
    // rescanning a year of records for each new point.
    while (overlapStart < others.length && others[overlapStart].ts + others[overlapStart].durationMin * 60000 <= p.ts) overlapStart++;
    const overlapping: typeof others = [];
    for (let j = overlapStart; j < others.length && others[j].ts < pEnd; j++) {
      const e = others[j];
      if (e.durationMin !== p.durationMin && e.ts + e.durationMin * 60000 > p.ts && !supersededIds.has(e.id)) overlapping.push(e);
    }
    if (overlapping.length > 0) {
      const maxExistingPrec = Math.max(...overlapping.map((o) => o.precedence));
      if (precedence >= maxExistingPrec) {
        // incoming wins: mark existing as superseded, insert new
        for (const o of overlapping) supersededIds.add(o.id);
        res.overlapsResolved += overlapping.length;
        toInsert.push(pi);
        res.inserted++;
      } else {
        // existing wins: skip incoming
        res.skippedDuplicates++;
      }
      continue;
    }
    toInsert.push(pi);
    res.inserted++;
  }
  exactKey.clear();

  if (supersededIds.size > 0) {
    await db
      .update(intervals)
      .set({ qcFlags: "superseded_overlap" })
      .where(sql`${intervals.id} IN (${sql.join(Array.from(supersededIds), sql`, `)})`);
  }

  // Chunked insert
  const CHUNK = 1000;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    // Objects that live across an awaited INSERT get promoted to old space and,
    // with Node sizing its heap from host memory (~3 GiB) instead of the 512 MiB
    // container, are otherwise not collected until the sheet ends. At most one
    // full GC per second; a no-op when the runtime does not expose gc.
    if (i > 0 && (i / CHUNK) % 10 === 0) {
      const ran = reclaimMemory(1000);
      if (process.env.INGEST_MEM_LOG) {
        const m = process.memoryUsage();
        console.log(`[writer] meter ${meterId} batch ${i / CHUNK}/${Math.ceil(toInsert.length / CHUNK)} gc=${ran} rss=${Math.round(m.rss / 1048576)} heapUsed=${Math.round(m.heapUsed / 1048576)} heapTotal=${Math.round(m.heapTotal / 1048576)} external=${Math.round(m.external / 1048576)} ab=${Math.round(m.arrayBuffers / 1048576)}`);
      }
    }
    const chunk: Array<typeof intervals.$inferInsert> = [];
    for (let j = i; j < Math.min(i + CHUNK, toInsert.length); j++) {
      const p = series.points[toInsert[j]];
      chunk.push({ meterId, ts: p.ts, durationMin: p.durationMin, usage: p.usage, demand: p.demand, uploadId, precedence });
    }
    const insRes = await db
      .insert(intervals)
      .values(chunk)
      .onDuplicateKeyUpdate({
        // Race fallback (row appeared between the pre-scan and this insert).
        // Precedence-aware and null-safe: never let a lower-precedence write
        // clobber a higher-precedence row, and never null out an existing
        // non-null demand with an incoming null (usage-only upload).
        set: {
          usage: sql`CASE WHEN VALUES(\`precedence\`) >= \`precedence\` AND VALUES(\`usage\`) IS NOT NULL THEN VALUES(\`usage\`) ELSE \`usage\` END`,
          demand: sql`CASE WHEN VALUES(\`precedence\`) >= \`precedence\` AND VALUES(\`demand\`) IS NOT NULL THEN VALUES(\`demand\`) ELSE \`demand\` END`,
          uploadId: sql`CASE WHEN VALUES(\`precedence\`) >= \`precedence\` THEN VALUES(\`uploadId\`) ELSE \`uploadId\` END`,
          precedence: sql`GREATEST(\`precedence\`, VALUES(\`precedence\`))`,
          // Batch-61 (pass 3134): when the incoming point wins (>= precedence),
          // clear any stale qcFlags — mirroring the exact-match pre-scan path's
          // `qcFlags: null` on replace. Without this, a row flagged
          // 'superseded_overlap' (e.g. by a concurrent upload between the
          // pre-scan and this insert) would keep the flag after being updated
          // with authoritative data, and analytics reads — which exclude
          // superseded rows — would silently drop the winning point.
          qcFlags: sql`CASE WHEN VALUES(\`precedence\`) >= \`precedence\` THEN NULL ELSE \`qcFlags\` END`,
        },
      });
    // Cycle 10 (pass 554): honest WriteResult accounting. MySQL reports
    // affectedRows = inserts + 2×(duplicate-key updates), so rows that hit the
    // race fallback were counted as `inserted` in the pre-scan but were really
    // updates — reclassify them so the report the user sees is accurate.
    const affected = Number((insRes as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? chunk.length);
    const dupUpdates = Math.max(0, affected - chunk.length);
    if (dupUpdates > 0) {
      res.inserted -= dupUpdates;
      res.replaced += dupUpdates;
    }
  }
  return res;
}
