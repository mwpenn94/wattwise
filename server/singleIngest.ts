/**
 * Oct 25 — single-site workbook ingestion under the production envelope
 * (1 vCPU / 512 MiB / 180 s request timeout; CPU only while a request is in
 * flight, so detached background work is not an option).
 *
 * Proven failure this replaces: uploads.ingest parsed EVERY worksheet of a
 * utility workbook on the main thread and held all series (KUSD first half:
 * 20 sheets / 700,800 points) before writing — the container was OOM-killed in
 * 7.9 s (cgroup oom_kill, proxy 503 for every user on the instance).
 *
 * Now: one worksheet at a time is parsed in the bounded worker (same lean
 * parser the bulk importer uses), written, released, and checkpointed on the
 * upload row (uploads.ingestState). Work runs inside the request for at most
 * SLICE_MS; then the request returns {more:true} and the browser calls
 * uploads.ingestContinue. Small workbooks still finish in the first call with
 * the same result shape. A lease + token fences concurrent continuations.
 * Any parse or write failure removes this upload's readings (and meters it
 * created) — never a silent partial import.
 */
import { randomUUID } from "crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { intervals, meters as metersTable, uploads } from "../drizzle/schema";
import { storageGetSignedUrl } from "./storage";
import { parseWorkbookInWorker, preflightWorkbookZip } from "./ingest/hardening";
import { workbookSheetNames } from "./ingest/xlsxSubset";
import { parseSheetRows, type IntervalClock, type ParsedMeterSeries } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { reclaimMemory } from "./ingest/memory";
import { extractSheetHeaderMeta, parseServiceAddress } from "./bulkImportCore";
import { assignTariffForMeter } from "./rateCodes";
import { recordMeterEvent } from "./analytics/costModel";
import { emitDeadEndPersona } from "./personaFingerprint";
import { MAX_UPLOAD_BYTES } from "../shared/wattwise";

const LEASE_MS = 120_000;
const SLICE_MS = () => Number(process.env.SINGLE_INGEST_SLICE_MS ?? 40_000);
/** Measured Oct 25 under 512 MiB: the request that carries a 24.5 MiB base64
 * body keeps ~70 MiB of body/JSON alive for its whole slice (heapUsed 135 vs
 * 62 MiB in later slices). Large files therefore only get stored + header-read
 * in the receiving request; every sheet is processed by a continuation request
 * that re-reads the durable source. Small files still finish in one call. */
const HANDOFF_BYTES = () => Number(process.env.SINGLE_INGEST_HANDOFF_BYTES ?? 4 * 1024 * 1024);
const shouldHandOff = (bodyBytes: number, durable: boolean) => durable && bodyBytes > HANDOFF_BYTES();
const BUSY_WAIT_MS = 20_000;

type Commodity = "electric" | "gas" | "water";
type Tier = Parameters<typeof recordMeterEvent>[0]["tier"];
export interface TzNote { body: string; severity: "info" | "warning"; confidence: "low" | "medium" | "high" }
export interface MeterOut { meterId: number; label: string; points: number; validationPass: boolean }
export type ValidationOut = ParsedMeterSeries["validation"] & { sheet: string; footer: ParsedMeterSeries["footerTotals"] };
export interface IngestProgress { sheetsDone: number; sheetsTotal: number; pointsWritten: number }
export interface IngestChoice { addresses: number; examples: string[]; sheets: number }
/** Uniform result for every uploads.ingest / ingestContinue response. */
export interface IngestResult {
  uploadId: number;
  duplicate: boolean;
  /** true → call uploads.ingestContinue({uploadId}) to keep going */
  more: boolean;
  /** another request currently holds this upload; wait briefly, then continue */
  busy?: boolean;
  meters: MeterOut[];
  totalPoints: number;
  validations: ValidationOut[];
  progress?: IngestProgress;
  /** the workbook lists several service addresses — ask before importing */
  needsChoice?: IngestChoice;
}

interface IngestState {
  v: 1;
  phase: "receiving" | "awaiting_choice" | "importing";
  token: string | null;
  leaseUntil: number;
  startedAt: number;
  clock: IntervalClock;
  commodityHint: Commodity | null;
  sheetNames: string[];
  headers: Record<string, { rateScheduleCode: string | null; accountNumber: string | null }>;
  addressCount: number;
  addressExamples: string[];
  cursor: number;
  /** sheet index that was mid-write when the previous request stopped */
  resumeSheet: number | null;
  meters: MeterOut[];
  createdMeterIds: number[];
  validations: ValidationOut[];
  seriesCount: number;
  rowsIngested: number;
  rowsSkipped: number;
  storageWarning: string | null;
}

export interface IngestContext {
  userId: number;
  tier: Tier;
  siteId: number;
  siteUtility: string | null;
  tzNote: TzNote | null;
  filename: string;
  format: string;
}

class LeaseLost extends Error {}
class ParserBusy extends Error {}

async function database() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fresh checkpoint written when the upload row is created (lease held by that request). */
export function initialIngestState(clock: IntervalClock, commodityHint: Commodity | null, token: string): IngestState {
  return {
    v: 1, phase: "receiving", token, leaseUntil: Date.now() + LEASE_MS, startedAt: Date.now(), clock, commodityHint,
    sheetNames: [], headers: {}, addressCount: 0, addressExamples: [], cursor: 0, resumeSheet: null,
    meters: [], createdMeterIds: [], validations: [], seriesCount: 0, rowsIngested: 0, rowsSkipped: 0, storageWarning: null,
  };
}
export const newIngestToken = () => randomUUID();

function readState(raw: unknown): IngestState | null {
  if (!raw) return null;
  const s = (typeof raw === "string" ? JSON.parse(raw) : raw) as IngestState;
  return s && s.v === 1 ? s : null;
}

/** A pending sliced upload of the same file to the same site (retry after a dropped connection). */
export async function findResumable(userId: number, siteId: number, sha256: string) {
  const d = await database();
  const [row] = await d.select().from(uploads)
    .where(and(eq(uploads.userId, userId), eq(uploads.siteId, siteId), eq(uploads.sha256, sha256), eq(uploads.status, "pending"), isNotNull(uploads.ingestState)))
    .orderBy(desc(uploads.id)).limit(1);
  return row && readState(row.ingestState) ? row : null;
}

/** Take the lease. Returns null when another live request owns it. */
async function claim(uploadId: number, userId: number, token: string) {
  const d = await database();
  return d.transaction(async (tx) => {
    const [row] = await tx.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
    const state = readState(row.ingestState);
    if (row.status !== "pending" || !state) return { row, state: null as IngestState | null, held: false };
    if (state.token && state.token !== token && state.leaseUntil > Date.now()) return { row, state, held: false };
    state.token = token; state.leaseUntil = Date.now() + LEASE_MS;
    await tx.update(uploads).set({ ingestState: state }).where(eq(uploads.id, uploadId));
    return { row, state, held: true };
  });
}

/** Persist the checkpoint under the lease (fenced); release=true hands the lease back. */
async function save(uploadId: number, userId: number, state: IngestState, token: string, release = false) {
  const d = await database();
  await d.transaction(async (tx) => {
    const [row] = await tx.select({ ingestState: uploads.ingestState, status: uploads.status }).from(uploads)
      .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId))).for("update");
    const current = row ? readState(row.ingestState) : null;
    if (!row || row.status !== "pending" || !current || current.token !== token) throw new LeaseLost("Another request is continuing this upload");
    state.token = release ? null : token;
    state.leaseUntil = release ? 0 : Date.now() + LEASE_MS;
    await tx.update(uploads).set({ ingestState: state }).where(eq(uploads.id, uploadId));
  });
}

async function loadSource(fileKey: string | null): Promise<Buffer> {
  if (!fileKey) throw new Error("The original file is no longer available. Upload it again; nothing from it was kept.");
  const url = await storageGetSignedUrl(fileKey);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok || !resp.body) throw new ParserBusy(`Stored file unavailable (${resp.status})`);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_UPLOAD_BYTES) throw new Error("Stored file exceeds 50 MiB"); chunks.push(value); }
  } catch (e) { await reader.cancel(); throw e; }
  return Buffer.concat(chunks, size);
}

/** Plain-language worker errors (the raw ones are developer-facing). */
function friendlySheetError(sheet: string, e: unknown): string {
  const m = msgOf(e);
  if (/row\/column safety limit/i.test(m)) return `Sheet “${sheet.trim()}” has more than 200,000 rows or 256 columns. Split it into smaller date ranges and upload again.`;
  if (/exceeded \d+ ms/i.test(m)) return `Sheet “${sheet.trim()}” took too long to read. Split it into smaller date ranges and upload again.`;
  if (/too large to process in one pass/i.test(m)) return `Sheet “${sheet.trim()}”: ${m}`;
  return `Sheet “${sheet.trim()}” could not be read (${m}).`;
}

/** Parse one worksheet in the bounded worker; waits briefly while the shared parser is busy. */
async function parseOneSheet(buf: Buffer, sheetName?: string) {
  const until = Date.now() + BUSY_WAIT_MS;
  for (;;) {
    try { return await parseWorkbookInWorker(buf, sheetName); }
    catch (e) {
      if (!/parser is busy/i.test(msgOf(e))) throw e;
      if (Date.now() > until) throw new ParserBusy("Workbook parser is busy");
      await new Promise((r) => setTimeout(r, 750));
    }
  }
}

function progressOfState(s: IngestState): IngestProgress {
  return { sheetsDone: s.cursor, sheetsTotal: s.sheetNames.length, pointsWritten: s.meters.reduce((a, m) => a + m.points, 0) };
}
function partial(uploadId: number, s: IngestState | null, extra: Partial<IngestResult> = {}): IngestResult {
  return {
    uploadId, duplicate: false, more: true,
    meters: s?.meters ?? [], totalPoints: s ? progressOfState(s).pointsWritten : 0, validations: s?.validations ?? [],
    progress: s ? progressOfState(s) : undefined, ...extra,
  };
}
function choiceOf(s: IngestState): IngestChoice {
  return { addresses: s.addressCount, examples: s.addressExamples, sheets: s.sheetNames.length };
}

/** Remove everything this upload wrote, plus meters it created that are now empty. */
async function rollback(uploadId: number, userId: number, s: IngestState, extraMeterIds: number[] = []) {
  const d = await database();
  const ids = Array.from(new Set([...s.meters.map((m) => m.meterId), ...s.createdMeterIds, ...extraMeterIds]));
  for (const id of ids) await d.delete(intervals).where(and(eq(intervals.meterId, id), eq(intervals.uploadId, uploadId)));
  for (const id of Array.from(new Set(s.createdMeterIds))) {
    const [left] = await d.select({ id: intervals.id }).from(intervals).where(eq(intervals.meterId, id)).limit(1);
    if (!left) await h.deleteMeter(id, userId).catch(() => undefined);
  }
}

async function fail(uploadId: number, ctx: IngestContext, s: IngestState, kind: "parse" | "write", message: string, extraMeterIds: number[] = []): Promise<never> {
  await rollback(uploadId, ctx.userId, s, extraMeterIds).catch((e) => console.error("[singleIngest] rollback failed", uploadId, e));
  await h.updateUpload(uploadId, { status: "failed", error: message.slice(0, 4000), ingestState: null, rowsIngested: 0, rowsSkipped: 0 });
  if (kind === "parse") {
    await emitDeadEndPersona({ deadEnd: "parse_failed_xlsx" });
    throw new TRPCError({ code: "BAD_REQUEST", message: `Parse failed: ${message} Nothing from this file was saved.` });
  }
  await recordMeterEvent({ userId: ctx.userId, kind: `parse_${ctx.format}`, computeMs: Date.now() - s.startedAt, tier: ctx.tier });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The file was read, but saving its readings failed partway. Nothing from this file was kept — please upload it again." });
}

/** Header pass: sheet list, bill identity per sheet, and distinct service addresses. */
async function readHeaders(buf: Buffer, s: IngestState) {
  preflightWorkbookZip(buf);
  const names = workbookSheetNames(buf);
  if (!names || names.length === 0) throw new Error("No worksheets found in this workbook.");
  s.sheetNames = names;
  try {
    const metas = (await parseOneSheet(buf)).map((x) => extractSheetHeaderMeta(x.name, x.rows));
    const campuses = new Map<string, string>();
    for (const m of metas) {
      s.headers[m.sheetName] = { rateScheduleCode: m.rateScheduleCode, accountNumber: m.accountNumber };
      const raw = m.addressRaw?.trim();
      if (!raw) continue;
      const a = parseServiceAddress(raw);
      if (!a.street) continue;
      if (!campuses.has(a.campusKey)) campuses.set(a.campusKey, raw.slice(0, 80));
    }
    s.addressCount = campuses.size;
    s.addressExamples = Array.from(campuses.values()).slice(0, 3);
  } catch (e) {
    if (e instanceof ParserBusy) throw e;
    /* header metadata is enrichment only — never fail an upload on it */
  } finally {
    reclaimMemory();
  }
}

/**
 * First request for a freshly received workbook (lease already held via the
 * creation token). askOnMultiAddress → a workbook with several service
 * addresses stops for the user's choice before anything is written.
 */
export async function startWorkbookIngest(uploadId: number, ctx: IngestContext, buf: Buffer, opts: { token: string; storageWarning: string | null; durable: boolean; askOnMultiAddress: boolean; fromRequestBody?: boolean }): Promise<IngestResult> {
  const deadline = Date.now() + SLICE_MS();
  const handOff = opts.fromRequestBody !== false && shouldHandOff(buf.length, opts.durable);
  const got = await claim(uploadId, ctx.userId, opts.token);
  if (!got.held || !got.state) return partial(uploadId, got.state, { busy: true });
  const s = got.state;
  if (s.phase !== "receiving") {
    if (handOff && s.phase === "importing") { await save(uploadId, ctx.userId, s, opts.token, true); return partial(uploadId, s); }
    return runSheets(uploadId, ctx, s, opts.token, buf, deadline, opts.durable);
  }
  s.storageWarning = opts.storageWarning;
  try { await readHeaders(buf, s); }
  catch (e) {
    if (e instanceof ParserBusy && opts.durable) { await save(uploadId, ctx.userId, s, opts.token, true); return partial(uploadId, s, { busy: true }); }
    return fail(uploadId, ctx, s, "parse", e instanceof ParserBusy ? "The server is busy reading another workbook. Please try again in a minute." : msgOf(e));
  }
  if (opts.askOnMultiAddress && s.addressCount > 1) {
    s.phase = "awaiting_choice";
    await save(uploadId, ctx.userId, s, opts.token, true);
    return { ...partial(uploadId, s), more: false, needsChoice: choiceOf(s) };
  }
  s.phase = "importing";
  if (handOff) { await save(uploadId, ctx.userId, s, opts.token, true); return partial(uploadId, s); }
  await save(uploadId, ctx.userId, s, opts.token);
  return runSheets(uploadId, ctx, s, opts.token, buf, deadline, opts.durable);
}

/** Continue (or confirm) a sliced upload from its durable source. */
export async function continueWorkbookIngest(uploadId: number, ctx: IngestContext, opts: { confirmMultiAddress?: boolean; buf?: Buffer; askOnMultiAddress?: boolean } = {}): Promise<IngestResult> {
  const deadline = Date.now() + SLICE_MS();
  // Measured Oct 25 (175k-row sheet, 512 MiB): the receiving request's ~44 MiB
  // base64 body and its JSON copies were still uncollected when this request
  // reloaded the source, pushing the container to 510 MiB. Collect first.
  if (!opts.buf) reclaimMemory(0);
  const token = newIngestToken();
  const got = await claim(uploadId, ctx.userId, token);
  if (!got.state) {
    // Finished or failed meanwhile: report the final record instead of erroring.
    const r = got.row;
    if (r.status === "parsed") return { uploadId, duplicate: false, more: false, meters: [], totalPoints: Number(r.rowsIngested ?? 0), validations: (r.validation as ValidationOut[] | null) ?? [] };
    throw new TRPCError({ code: "BAD_REQUEST", message: r.error ? `This upload did not complete: ${r.error.slice(0, 300)}` : "This upload is no longer in progress." });
  }
  if (!got.held) return partial(uploadId, got.state, { busy: true });
  const s = got.state;
  const durable = !!got.row.fileKey;
  let buf = opts.buf ?? null;
  const source = async () => (buf ??= await loadSource(got.row.fileKey));
  try {
    if (s.phase === "receiving") {
      return await startWorkbookIngest(uploadId, ctx, await source(), { token, storageWarning: s.storageWarning, durable, askOnMultiAddress: opts.askOnMultiAddress ?? true, fromRequestBody: !!opts.buf });
    }
    if (s.phase === "awaiting_choice") {
      if (!opts.confirmMultiAddress) { await save(uploadId, ctx.userId, s, token, true); return { ...partial(uploadId, s), more: false, needsChoice: choiceOf(s) }; }
      s.phase = "importing";
      await save(uploadId, ctx.userId, s, token);
    }
    // A re-sent large file (resume after a dropped connection) also hands off.
    if (opts.buf && shouldHandOff(opts.buf.length, durable)) { await save(uploadId, ctx.userId, s, token, true); return partial(uploadId, s); }
    return await runSheets(uploadId, ctx, s, token, buf, deadline, durable, source);
  } catch (e) {
    if (e instanceof ParserBusy) { await save(uploadId, ctx.userId, s, token, true).catch(() => undefined); return partial(uploadId, s, { busy: true }); }
    if (e instanceof LeaseLost) return partial(uploadId, s, { busy: true });
    if (e instanceof TRPCError) throw e;
    return fail(uploadId, ctx, s, "parse", msgOf(e));
  }
}

async function runSheets(
  uploadId: number, ctx: IngestContext, s: IngestState, token: string, buf: Buffer | null, deadline: number, durable: boolean,
  source: () => Promise<Buffer> = async () => { if (!buf) throw new Error("The original file is no longer available. Upload it again; nothing from it was kept."); return buf; },
): Promise<IngestResult> {
  const d = await database();
  // Every request finishes at least one sheet before it may pause, so slow
  // claims/source loads can never turn continuation into a no-progress loop.
  let processed = 0;
  try {
    for (let i = s.cursor; i < s.sheetNames.length; i++) {
      if (durable && processed > 0 && Date.now() >= deadline) { await save(uploadId, ctx.userId, s, token, true); return partial(uploadId, s); }
      const name = s.sheetNames[i];
      const resumed = s.resumeSheet === i;
      s.resumeSheet = i;
      await save(uploadId, ctx.userId, s, token);
      let series: ParsedMeterSeries[] = [];
      try {
        const bytes = buf ?? (buf = await source());
        const parsed = await parseOneSheet(bytes, name);
        const rows = (parsed.find((x) => x.name === name) ?? (parsed.length === 1 ? parsed[0] : undefined))?.rows;
        series = rows ? parseSheetRows(name, rows, s.clock) : [];
      } catch (e) {
        if (e instanceof ParserBusy && durable) { await save(uploadId, ctx.userId, s, token, true); return partial(uploadId, s, { busy: true }); }
        if (e instanceof ParserBusy) return fail(uploadId, ctx, s, "parse", "The server is busy reading another workbook. Please try again in a minute.");
        return fail(uploadId, ctx, s, "parse", friendlySheetError(name, e));
      }
      const touched: number[] = [];
      // Results for this sheet join the checkpoint only once the whole sheet is
      // written, so a resumed sheet is never counted twice.
      const sheetMeters: MeterOut[] = [];
      let sheetRowsIn = 0, sheetRowsSkip = 0;
      try {
        for (const ser of series) {
          if (ser.points.length === 0) continue;
          const commodity = s.commodityHint ?? ser.commodity;
          const label = ser.sourceKey;
          let meter = (await h.listMeters(ctx.siteId, ctx.userId)).find((m) => m.label === label && m.commodity === commodity);
          if (!meter) {
            const meterId = await h.createMeter({
              siteId: ctx.siteId, userId: ctx.userId, commodity, label, usageUnit: ser.usageUnit, demandUnit: ser.demandUnit,
              timezone: s.clock.timeZone, timestampBasis: s.clock.timestampBasis,
            }, ctx.userId);
            s.createdMeterIds.push(meterId);
            await save(uploadId, ctx.userId, s, token);
            meter = (await h.listMeters(ctx.siteId, ctx.userId)).find((m) => m.id === meterId)!;
          }
          touched.push(meter.id);
          // RC2: the bill's rate code reconciles to the official filed schedule —
          // never over an assignment the user (or a prior import) made.
          const code = s.headers[name]?.rateScheduleCode?.trim().slice(0, 32) || (Object.keys(s.headers).length === 1 ? Object.values(s.headers)[0]?.rateScheduleCode?.trim().slice(0, 32) : null) || null;
          if (code && !meter.rateScheduleCode) {
            try {
              await d.update(metersTable).set({ rateScheduleCode: code }).where(eq(metersTable.id, meter.id));
              if (!meter.currentTariffId) {
                const a = await assignTariffForMeter(meter.id, ctx.userId, code, ctx.siteUtility);
                if (a.assigned) ser.validation.notes.push(a.disclosure);
              }
            } catch {
              /* fail-open: the analysis falls back to the disclosed basis ladder */
            }
          }
          let already = 0;
          if (resumed) {
            const [c] = await d.select({ n: sql<number>`COUNT(*)` }).from(intervals).where(and(eq(intervals.meterId, meter.id), eq(intervals.uploadId, uploadId)));
            already = Number(c?.n ?? 0);
          }
          const w = await writeIntervals(d, meter.id, ser, uploadId, 2);
          sheetRowsIn += ser.rowsIngested;
          sheetRowsSkip += ser.rowsSkipped;
          sheetMeters.push({ meterId: meter.id, label, points: w.inserted + w.replaced + already, validationPass: ser.validation.pass });
        }
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        console.error("[singleIngest] write failed", uploadId, name, e);
        return fail(uploadId, ctx, s, "write", `Saving readings from sheet “${name.trim()}” failed: ${msgOf(e)}`, [...touched, ...sheetMeters.map((m) => m.meterId)]);
      }
      s.meters.push(...sheetMeters);
      s.rowsIngested += sheetRowsIn;
      s.rowsSkipped += sheetRowsSkip;
      for (const ser of series) {
        s.seriesCount++;
        s.validations.push({ sheet: ser.sourceKey, ...ser.validation, footer: ser.footerTotals });
      }
      series = [];
      s.cursor = i + 1;
      s.resumeSheet = null;
      await save(uploadId, ctx.userId, s, token);
      processed++;
      reclaimMemory();
      if (process.env.INGEST_MEM_LOG) {
        const m = process.memoryUsage();
        console.log(`[singleIngest] upload ${uploadId} sheet ${i + 1}/${s.sheetNames.length} rss=${Math.round(m.rss / 1048576)} heapUsed=${Math.round(m.heapUsed / 1048576)} heapTotal=${Math.round(m.heapTotal / 1048576)} external=${Math.round(m.external / 1048576)} arrayBuffers=${Math.round(m.arrayBuffers / 1048576)}`);
      }
    }
    return await finalize(uploadId, ctx, s, token);
  } catch (e) {
    if (e instanceof LeaseLost) return partial(uploadId, s, { busy: true });
    throw e;
  }
}

async function finalize(uploadId: number, ctx: IngestContext, s: IngestState, token: string): Promise<IngestResult> {
  await save(uploadId, ctx.userId, s, token); // fence: still ours
  if (s.meters.length === 0) {
    await rollback(uploadId, ctx.userId, s).catch(() => undefined);
    await h.updateUpload(uploadId, { status: "failed", error: "No interval data found in file", ingestState: null });
    await emitDeadEndPersona({ deadEnd: "empty_file_xlsx" });
    throw new TRPCError({ code: "BAD_REQUEST", message: "No interval data recognized in this file." });
  }
  // Split-timezone disclosure for every meter this file created (same as before).
  if (ctx.tzNote) {
    for (const meterId of Array.from(new Set(s.createdMeterIds))) {
      await h.addInsight({
        siteId: ctx.siteId, kind: "data_coverage", title: "Meter timezone assumption — verify if incorrect for this site",
        body: ctx.tzNote.body, severity: ctx.tzNote.severity, confidence: ctx.tzNote.confidence,
        provenance: { method: "tz_state_inference_v1", meterId, source: "file_upload" }, metrics: null,
      });
    }
  }
  const stored = s.validations.map(({ sheet: _sheet, footer: _footer, ...v }) => (s.storageWarning ? { ...v, notes: [...v.notes, s.storageWarning] } : v));
  await h.updateUpload(uploadId, {
    status: "parsed",
    rowsIngested: s.rowsIngested,
    rowsSkipped: s.rowsSkipped,
    sheetsFound: s.seriesCount,
    parseConfidence: s.validations.every((v) => v.pass) ? 1 : 0.8,
    footerTotals: s.validations.map((v) => v.footer),
    validation: stored,
    ingestState: null,
  });
  await recordMeterEvent({ userId: ctx.userId, kind: `parse_${ctx.format}`, computeMs: Date.now() - s.startedAt, tier: ctx.tier });
  await h.audit(ctx.userId, "upload_ingested", "upload", String(uploadId), { filename: ctx.filename, meters: s.meters.length, rows: s.rowsIngested, slicedSheets: s.sheetNames.length });
  return {
    uploadId, duplicate: false, more: false,
    meters: s.meters,
    totalPoints: s.meters.reduce((a, m) => a + m.points, 0),
    validations: s.validations,
    progress: progressOfState(s),
  };
}

/** Public progress for the upload history (no lease internals). */
export function ingestProgressOf(row: { status: string; ingestState: unknown }) {
  const s = row.status === "pending" ? readState(row.ingestState) : null;
  if (!s) return null;
  return { sheetsDone: s.cursor, sheetsTotal: s.sheetNames.length, awaitingChoice: s.phase === "awaiting_choice", active: !!s.token && s.leaseUntil > Date.now(), choice: s.phase === "awaiting_choice" ? choiceOf(s) : null };
}

/** Deleting a file that is mid-import would race the writer — refuse while a request holds it. */
export async function assertNotImporting(uploadId: number, userId: number) {
  const d = await database();
  const [row] = await d.select({ status: uploads.status, ingestState: uploads.ingestState }).from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)));
  const p = row ? ingestProgressOf(row) : null;
  if (p?.active) throw new TRPCError({ code: "CONFLICT", message: "This file is still importing. Wait a moment for the current step to finish, then delete it." });
}

/** Sites with an unfinished sliced upload must not be analyzed on partial data. */
export async function unfinishedUploadFor(siteId: number) {
  const d = await database();
  const [row] = await d.select({ id: uploads.id, filename: uploads.filename, ingestState: uploads.ingestState, status: uploads.status }).from(uploads)
    .where(and(eq(uploads.siteId, siteId), eq(uploads.status, "pending"), isNotNull(uploads.ingestState))).limit(1);
  const p = row ? ingestProgressOf(row) : null;
  return row && p ? { uploadId: row.id, filename: row.filename, ...p } : null;
}
