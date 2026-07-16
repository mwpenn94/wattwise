/**
 * Canonical interval writer — idempotent ingestion invariant (handoff §4).
 * - content-hash dedupe at upload level (sha256)
 * - (meter, ts, durationMin) unique key with precedence-aware upsert
 * - Cycle 5: overlap-window detection — an incoming interval whose
 *   [start, start+duration) window overlaps existing records of a DIFFERENT
 *   duration for the same meter resolves by precedence per covered window;
 *   losers get qcFlags='superseded_overlap' (retained for audit).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { intervals } from "../../drizzle/schema";
import type { ParsedMeterSeries } from "./parsers";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

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
  const rowsToInsert: Array<typeof intervals.$inferInsert> = [];

  for (const p of series.points) {
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
    const overlapping = others.filter(
      (e) => e.durationMin !== p.durationMin && e.ts < pEnd && e.ts + e.durationMin * 60000 > p.ts && !supersededIds.has(e.id),
    );
    if (overlapping.length > 0) {
      const maxExistingPrec = Math.max(...overlapping.map((o) => o.precedence));
      if (precedence >= maxExistingPrec) {
        // incoming wins: mark existing as superseded, insert new
        for (const o of overlapping) supersededIds.add(o.id);
        res.overlapsResolved += overlapping.length;
        rowsToInsert.push({ meterId, ts: p.ts, durationMin: p.durationMin, usage: p.usage, demand: p.demand, uploadId, precedence });
        res.inserted++;
      } else {
        // existing wins: skip incoming
        res.skippedDuplicates++;
      }
      continue;
    }
    rowsToInsert.push({ meterId, ts: p.ts, durationMin: p.durationMin, usage: p.usage, demand: p.demand, uploadId, precedence });
    res.inserted++;
  }

  if (supersededIds.size > 0) {
    await db
      .update(intervals)
      .set({ qcFlags: "superseded_overlap" })
      .where(sql`${intervals.id} IN (${sql.join(Array.from(supersededIds), sql`, `)})`);
  }

  // Chunked insert
  const CHUNK = 1000;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK);
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
