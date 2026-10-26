/**
 * BULK-1 (Oct 2026) — multi-file / multi-sheet bulk setup service.
 *
 *   stageFile  (one call per workbook; files can arrive in any order/split)
 *     → S3 copy + header-only read (≈3 s / 19 MB) → import_batch_sheets rows
 *   preview    (groups ACROSS all staged files by physical address; matches
 *               existing meters by service point and existing sites by address;
 *               geocodes each new site; checks plan limits)
 *   commit     (background, per-sheet, resumable: create/reuse site → create/
 *               reuse meter by service point → parse ONE sheet → write intervals
 *               (dedupe) → assign filed tariff from the bill rate code → campus
 *               total for multi-meter sites → analysis per site)
 *   status     (progress polling; each sheet carries its own disposition)
 *
 * Honesty: nothing is claimed for a sheet that failed; derived fields are
 * disclosed per site; family-inferred rate codes carry their disclosure.
 */
import { createHash, randomUUID } from "crypto";
import { and, desc, eq, inArray, sql, gte } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import * as h from "./dbHelpers";
import { entities, importBatches, importBatchFiles, importBatchSheets, importSiteGroups, meters, sites, users, uploads, intervals, tariffs, billingAccounts } from "../drizzle/schema";
import { storageGetSignedUrl, storagePut } from "./storage";
import { preParseGate, parseWorkbookInWorker } from "./ingest/hardening";
import { reclaimMemory } from "./ingest/memory";
import { PARSER_VERSION, parseSheetRows, type IntervalClock, type ParsedMeterSeries } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { geocodeAddress } from "./places";
import { deriveFromAddress } from "./cascade";
import { TZ_BY_STATE, MAX_UPLOAD_BYTES, FREE_TIER_MAX_UPLOADS_PER_MONTH } from "../shared/wattwise";
import { effectiveEntitlement, loadBillingAccount } from "./billing";
import { resolveRateCode, assignTariffForMeter } from "./rateCodes";
import {
  buildSitePlan,
  cleanSheetName,
  facilityLabelFor,
  meterIdentityKey,
  parseServiceAddress,
  prettyCase,
  extractSheetHeaderMeta,
  type GroupingMode,
  type PlanGroup,
} from "./bulkImportCore";

type Tier = "free" | "plus" | "pro";

async function db() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

async function loadBatch(batchId: number, userId: number) {
  const d = await db();
  const [b] = await d.select().from(importBatches).where(and(eq(importBatches.id, batchId), eq(importBatches.userId, userId))).limit(1);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Import batch not found" });
  return b;
}

type Db = Awaited<ReturnType<typeof db>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const LEASE_MS = 120_000;
/** Oct 25 (prod 512 MiB / 1 vCPU, CPU only while a request is in flight):
 * commit work runs INSIDE each commit request for at most this long before it
 * stops at a checkpoint and returns {more:true}; the client calls again.
 * Detached background work is throttled to ~0 in production and must not be used. */
const COMMIT_SLICE_MS = Number(process.env.BULK_COMMIT_SLICE_MS ?? 45_000);
/** After a slice pauses, the batch is "continuing" (not stalled) for this long. */
const PAUSE_GRACE_MS = 90_000;
/** Consecutive transient-failure slices tolerated before the import is marked failed. */
const MAX_TRANSIENT_RETRIES = 5;
/**
 * Oct 26: a brief database/network interruption (connect timeout, dropped
 * connection, deadlock) is not a failed import. Every unit is checkpointed, so
 * the slice pauses and the page continues it; only persistent faults fail.
 */
export function isTransientInfraError(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const o = cur as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
    parts.push(String(o?.message ?? cur), String(o?.code ?? ""), String(o?.errno ?? ""));
    cur = o?.cause;
  }
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|PROTOCOL_CONNECTION_LOST|PROTOCOL_SEQUENCE_TIMEOUT|Connection lost|Too many connections|ER_LOCK_DEADLOCK|ER_LOCK_WAIT_TIMEOUT|Lock wait timeout|Deadlock found|socket hang up/i.test(parts.join(" "));
}
const MAX_BATCH_FILES = 8, MAX_BATCH_BYTES = 150 * 1024 * 1024, MAX_BATCH_SHEETS = 128;
const running = new Set<number>(); // admission optimization only, never ownership
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const owned = (table: typeof importBatches, id: number, userId: number) => and(eq(table.id, id), eq(table.userId, userId));
async function lockBatch(tx: Tx, batchId: number, userId: number) {
  const [b] = await tx.select().from(importBatches).where(owned(importBatches, batchId, userId)).for("update");
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Import batch not found" });
  return b;
}
async function editable(tx: Tx, batchId: number, userId: number, version?: number) {
  const b = await lockBatch(tx, batchId, userId);
  if (!["staging", "previewed"].includes(b.status) || (version != null && version !== b.planVersion))
    throw new TRPCError({ code: "CONFLICT", message: "Import changed or is already running. Refresh the preview." });
  return b;
}
export async function assertLiveLeaseForUpdate(tx: Tx, batchId: number, userId: number, token: string) {
  const b = await lockBatch(tx, batchId, userId);
  if (b.workerToken !== token || (b.leaseUntil ?? 0) <= Date.now() || b.status !== "committing") throw new Error("Import worker lease lost; stale worker fenced");
  return b;
}
async function fenced<T>(batchId: number, userId: number, token: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await db()).transaction(async tx => {
    await assertLiveLeaseForUpdate(tx, batchId, userId, token);
    const value = await fn(tx);
    await tx.update(importBatches).set({ leaseUntil: Date.now() + LEASE_MS }).where(owned(importBatches, batchId, userId));
    return value;
  });
}
async function lockUser(tx: Tx, userId: number) {
  const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!u) throw new Error("Import owner no longer exists");
  const [account] = await tx.select().from(billingAccounts).where(eq(billingAccounts.userId, userId));
  return u.role === "admin" ? { ...effectiveEntitlement(null), tier: "pro" as const, maxSites: null } : effectiveEntitlement(account ?? null);
}
async function fileBuffer(_fileId: number, fileKey: string | null): Promise<Buffer> {
  if (!fileKey) throw new Error("Staged source is missing. Start a new import and re-stage the original workbook; no data was committed for this sheet.");
  const url = await storageGetSignedUrl(fileKey);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok || !resp.body) throw new Error(`Could not read durable source (${resp.status}); retry when storage is available.`);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_UPLOAD_BYTES) throw new Error("Stored workbook exceeds 50 MiB"); chunks.push(value); }
  } catch (e) { await reader.cancel(); throw e; }
  return Buffer.concat(chunks, size);
}

/* ---------------- stage ---------------- */
export async function stageFile(userId: number, input: { batchId?: number | null; filename: string; buf: Buffer; storedKey?: string }) {
  const d = await db();
  if (input.batchId != null) await loadBatch(input.batchId, userId);
  const buf = input.buf;
  const gate = preParseGate(buf, "xlsx");
  if (!gate.ok || gate.detected !== "xlsx") throw new TRPCError({ code: "BAD_REQUEST", message: gate.reason ?? "Bulk import requires an .xlsx workbook" });
  const headers = (await parseWorkbookInWorker(buf)).map(s => extractSheetHeaderMeta(s.name, s.rows));
  reclaimMemory();
  const sha256 = createHash("sha256").update(buf).digest("hex");
  // Recognize editable batches staged before raw-byte hashes were introduced.
  // New rows and repaired duplicates always persist the real file checksum.
  const legacySha256 = input.batchId != null ? digest(buf.toString("base64")) : null;
  // Durable source FIRST. A failed upload never publishes a staged file.
  let fileKey: string;
  // Oct 25: bytes that arrived via POST /api/uploads/raw are already durable
  // (checksum re-verified on load) — reuse them rather than buffering a copy.
  if (input.storedKey) fileKey = input.storedKey;
  else {
    try { fileKey = (await storagePut(`bulk-imports/${userId}/${sha256}.xlsx`, buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).key; }
    catch { throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Workbook was not saved. Retry staging; imports require a durable source." }); }
  }
  return d.transaction(async tx => {
    await lockUser(tx, userId);
    let batchId = input.batchId;
    if (batchId == null) {
      const active = await tx.select({ id: importBatches.id }).from(importBatches).where(and(eq(importBatches.userId, userId), inArray(importBatches.status, ["staging", "previewed", "committing"])));
      if (active.length >= 8) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Finish an existing import before staging another (8 active batches maximum)." });
      const [r] = await tx.insert(importBatches).values({ userId }); batchId = Number(r.insertId);
    }
    await editable(tx, batchId, userId);
    const current = await tx.select().from(importBatchFiles).where(and(eq(importBatchFiles.batchId, batchId), eq(importBatchFiles.userId, userId)));
    const duplicate = current.find(f => f.sha256 === sha256) ?? current.find(f => f.sha256 === legacySha256);
    if (duplicate) {
      await tx.update(importBatchFiles).set({ fileKey, sha256 }).where(eq(importBatchFiles.id, duplicate.id));
      return { batchId, fileId: duplicate.id, duplicate: true, sheets: duplicate.sheetCount, skippedSheets: 0, filename: input.filename };
    }
    if (current.length >= MAX_BATCH_FILES || current.reduce((n,f) => n + f.sizeBytes, buf.length) > MAX_BATCH_BYTES || current.reduce((n,f) => n + f.sheetCount, headers.length) > MAX_BATCH_SHEETS)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Import limit: 8 workbooks, 150 MiB compressed total, 128 sheets. Split this portfolio into successive imports." });
    const [r] = await tx.insert(importBatchFiles).values({ batchId, userId, filename: input.filename.slice(0,500), sha256, fileKey, sizeBytes: buf.length, sheetCount: headers.length });
    const fileId = Number(r.insertId);
    if (headers.length) await tx.insert(importBatchSheets).values(headers.map(m => {
      const addr = parseServiceAddress(m.addressRaw);
      const invalid = (m.accountNumber?.length ?? 0) > 64 || (m.serviceAgreementId?.length ?? 0) > 64 || (m.servicePointId?.length ?? 0) > 64 || (m.rateScheduleCode?.length ?? 0) > 32 || (m.addressRaw?.length ?? 0) > 512;
      return { batchId: batchId!, fileId, userId, sheetName: m.sheetName.slice(0,250), accountNumber: m.accountNumber?.slice(0,64), serviceAgreementId: m.serviceAgreementId?.slice(0,64), servicePointId: m.servicePointId?.slice(0,64), rateScheduleCode: m.rateScheduleCode?.slice(0,32), addressRaw: m.addressRaw?.slice(0,512), baseAddress: [addr.street,addr.city,addr.state].filter(Boolean).join(", ").slice(0,512), facilityLabel: facilityLabelFor(addr,m.servicePointId)?.slice(0,255), status: invalid || !m.looksLikeIntervals ? "skipped" as const : "pending" as const, detail: invalid ? "Header metadata exceeds supported lengths; correct this sheet before re-uploading (not imported)." : !m.looksLikeIntervals ? "No interval table detected; not imported." : null };
    }));
    await tx.update(importBatches).set({ status: "staging", plan: null, planVersion: sql`${importBatches.planVersion}+1` }).where(owned(importBatches,batchId,userId));
    return { batchId, fileId, duplicate: false, sheets: headers.filter(m => m.looksLikeIntervals).length, skippedSheets: headers.filter(m=>!m.looksLikeIntervals).length, filename: input.filename };
  });
}
export async function removeFile(userId: number, batchId: number, fileId: number) {
  return (await db()).transaction(async tx => {
    await editable(tx,batchId,userId);
    const [f] = await tx.select().from(importBatchFiles).where(and(eq(importBatchFiles.id,fileId),eq(importBatchFiles.batchId,batchId),eq(importBatchFiles.userId,userId)));
    if (!f) throw new TRPCError({code:"NOT_FOUND",message:"Staged file not found in this import"});
    await tx.delete(importBatchSheets).where(and(eq(importBatchSheets.fileId,fileId),eq(importBatchSheets.userId,userId)));
    await tx.delete(importBatchFiles).where(eq(importBatchFiles.id,fileId));
    await tx.update(importBatches).set({status:"staging",plan:null,planVersion:sql`${importBatches.planVersion}+1`}).where(owned(importBatches,batchId,userId));
    return {ok:true};
  });
}

/* ---------------- preview ---------------- */
export interface PreviewMeter {
  sheetId: number;
  fileId: number;
  filename: string;
  sheetName: string;
  facility: string | null;
  servicePointId: string | null;
  serviceAgreementId: string | null;
  accountNumber: string | null;
  rateScheduleCode: string | null;
  tariff: { urdbId: string; match: "exact" | "family_inferred"; disclosure: string } | null;
  existingMeterId: number | null;
  existingSiteId: number | null;
}
export interface PreviewSite extends Omit<PlanGroup, "facilities"> {
  formattedAddress: string | null;
  lat: number | null;
  lng: number | null;
  geocode: "precise" | "not_precise" | "failed" | "existing_site";
  /** Utility implied by the bills' rate codes (strongest evidence), else null. */
  billUtility: { utilityName: string; state: string; codes: string[] } | null;
  meters: PreviewMeter[];
  sourceClock: IntervalClock;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/**
 * Oct 2026 localization fix: the bill's rate-schedule code is the strongest
 * utility evidence a workbook carries (EGSGS/EGMGS/EGMGSQ are UNS Electric
 * schedules). It decides the site's utility and state before any
 * address-level guess, and it biases geocoding toward the right state so a
 * bare "350 Eastern Ave, Kingman" is not matched to Springfield, MA.
 */
const RATE_CODE_UTILITY: Record<string, { utilityName: string; state: string }> = {
  "uns-": { utilityName: "UniSource Energy Services (UNS Electric)", state: "AZ" },
};
export function utilityFromRateCodes(codes: Array<string | null | undefined>): { utilityName: string; state: string; codes: string[] } | null {
  const hits = new Map<string, { utilityName: string; state: string; codes: string[] }>();
  for (const c of codes) {
    if (!c) continue;
    const rc = resolveRateCode(null, c);
    if (!rc) continue;
    const prefix = Object.keys(RATE_CODE_UTILITY).find((p) => rc.urdbId.startsWith(p));
    if (!prefix) continue;
    const u = RATE_CODE_UTILITY[prefix]!;
    const e = hits.get(u.utilityName) ?? { ...u, codes: [] };
    if (!e.codes.includes(c.trim().toUpperCase())) e.codes.push(c.trim().toUpperCase());
    hits.set(u.utilityName, e);
  }
  // only unambiguous evidence: every recognized code points to ONE utility
  return hits.size === 1 ? Array.from(hits.values())[0]! : null;
}
/** Reject geocoder matches that contradict the sheet's own city/state. */
export function geocodeIsPlausible(
  geo: { city: string | null; state: string | null },
  expected: { city: string | null; state: string | null },
): { ok: true } | { ok: false; reason: string } {
  const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (expected.state && geo.state && norm(expected.state) !== norm(geo.state)) {
    return { ok: false, reason: `the address lookup matched ${geo.city ?? "a place"}, ${geo.state}, but this site's bills point to ${expected.state}` };
  }
  if (expected.city && geo.city && norm(expected.city) !== norm(geo.city)) {
    return { ok: false, reason: `the address lookup matched ${geo.city}${geo.state ? `, ${geo.state}` : ""}, not ${prettyCase(expected.city)}` };
  }
  return { ok: true };
}

function normStreetCity(street: string | null | undefined, city: string | null | undefined): string {
  const p = parseServiceAddress(`${street ?? ""}, ${city ?? ""}`);
  return p.campusKey;
}

async function siteLimit(user: { id: number; tier?: string | null; role?: string }): Promise<number | null> {
  if (user.role === "admin") return null;
  const account = await loadBillingAccount(user.id);
  return effectiveEntitlement(account).maxSites;
}

export async function preview(
  user: { id: number; tier?: string | null; role?: string },
  input: { batchId: number; planVersion?: number; groupingMode: GroupingMode; stateHint?: string | null; timeZone?: string; timestampBasis?: "start" | "end" | "auto"; overrides?: Array<{ sheetId: number; siteId: number | null; groupKey?: string | null }> },
) {
  const userId = user.id;
  const d = await db();
  const b = await loadBatch(input.batchId, userId);
  if (b.status !== "staging" && b.status !== "previewed") throw new TRPCError({ code: "BAD_REQUEST", message: "Import already committed" });
  const files = await d.select().from(importBatchFiles).where(eq(importBatchFiles.batchId, b.id));
  const sheetRows = (await d.select().from(importBatchSheets).where(eq(importBatchSheets.batchId, b.id))).filter((s) => s.status !== "skipped");
  if (sheetRows.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "No interval sheets found in the staged files." });
  const overrides = new Map((input.overrides ?? []).map(o => [o.sheetId,o]));
  const userSites = await h.listSites(userId);
  const ownedSiteIds = new Set(userSites.map(s=>s.id));
  const ownedSheetIds = new Set(sheetRows.map(s=>s.id));
  for (const o of input.overrides ?? []) {
    if (!ownedSheetIds.has(o.sheetId) || (o.siteId != null && !ownedSiteIds.has(o.siteId))) throw new TRPCError({code:"NOT_FOUND",message:"Sheet or target site not found"});
    if (o.siteId != null && o.groupKey) throw new TRPCError({code:"BAD_REQUEST",message:"Choose one destination"});
  }
  for (const s of sheetRows) {
    const o=overrides.get(s.id);
    if (o) { s.overrideSiteId=o.siteId; s.overrideGroupKey=o.groupKey ?? null; }
    if (s.overrideSiteId != null && !ownedSiteIds.has(s.overrideSiteId)) throw new TRPCError({code:"NOT_FOUND",message:"Target site no longer available"});
  }
  const userMeters = await d.select().from(meters).where(eq(meters.userId,userId));
  const meterByIdentity = new Map<string,(typeof userMeters)[number]>();
  for (const m of userMeters.filter(m=>m.meterRole!=="virtual_total")) {
    const identity=m.importIdentity ?? (m.servicePoint ? meterIdentityKey({servicePointId:m.servicePoint,serviceAgreementId:m.serviceAgreementId,sheetName:""}) : m.serviceAgreementId ? `sa:${m.serviceAgreementId}` : null);
    if (identity) {
      if (meterByIdentity.has(identity)) throw new TRPCError({code:"CONFLICT",message:"Existing duplicate service identities need reconciliation before import"});
      meterByIdentity.set(identity,m);
    }
  }
  const groupRows = await d.select().from(importSiteGroups).where(and(eq(importSiteGroups.userId,userId),eq(importSiteGroups.groupingMode,input.groupingMode)));
  const planInput = sheetRows.map(s => {
    const em = meterByIdentity.get(meterIdentityKey(s));
    if (em && s.overrideSiteId != null && em.siteId!==s.overrideSiteId) throw new TRPCError({code:"CONFLICT",message:"This service point already belongs to another site. Use an explicit meter move, not import."});
    const a=parseServiceAddress(s.addressRaw);
    const state=a.state ?? utilityFromRateCodes([s.rateScheduleCode])?.state ?? input.stateHint;
    const addressRaw = !a.state && state ? `${s.addressRaw ?? ""}, ${state}` : s.addressRaw;
    return {...s, sheetId:s.id, addressRaw, overrideSiteId:s.overrideSiteId ?? em?.siteId ?? null};
  });
  // Planned-group targets refer to the base plan, not arbitrary strings. Reject
  // chained/cyclic remappings so every target has one unambiguous anchor.
  const baseGroups=buildSitePlan(planInput.map(s=>({...s,overrideGroupKey:null})),input.groupingMode);
  const baseByKey=new Map(baseGroups.map(g=>[g.groupKey,g]));
  for (const s of planInput) if (s.overrideGroupKey) {
    const target=baseByKey.get(s.overrideGroupKey);
    if (!target || target.sheetIds.some(id=>planInput.find(p=>p.sheetId===id)?.overrideGroupKey)) throw new TRPCError({code:"BAD_REQUEST",message:"Planned destination is missing or forms a chained/cyclic mapping; choose an unchanged campus."});
    if (meterByIdentity.has(meterIdentityKey(s))) throw new TRPCError({code:"CONFLICT",message:"An existing meter cannot be reassigned by import."});
  }
  const groups = buildSitePlan(planInput,input.groupingMode).map(g=> {
    const target=baseByKey.get(g.groupKey);
    return target ? {...target,sheetIds:g.sheetIds,fileIds:g.fileIds,facilities:g.facilities,needsReview:g.needsReview} : g;
  });
  const destinationByIdentity=new Map<string,string>();
  for (const g of groups) for (const id of g.sheetIds) {
    const identity=meterIdentityKey(sheetRows.find(s=>s.id===id)!);
    if (destinationByIdentity.has(identity) && destinationByIdentity.get(identity)!==g.groupKey) throw new TRPCError({code:"CONFLICT",message:"A service point has conflicting destinations; choose the same site for all copies."});
    destinationByIdentity.set(identity,g.groupKey);
  }
  const fileName = new Map(files.map((f) => [f.id, f.filename]));
  const sheetById = new Map(sheetRows.map((s) => [s.id, s]));
  const stateHint = input.stateHint?.trim().toUpperCase() || null;

  const previewSites: PreviewSite[] = await mapLimit(groups, 6, async (g) => {
    let existingSiteId = g.existingSiteId;
    if (existingSiteId == null) existingSiteId = groupRows.find(r=>r.groupHash===digest(g.groupKey) && ownedSiteIds.has(r.siteId))?.siteId ?? null;
    if (existingSiteId == null && g.street && g.state) {
      const candidates=userSites.filter(site=> {
        if (!site.state) return false;
        const a=parseServiceAddress(`${(site.address ?? "").replace(/, USA$/, "")}`);
        const canonical=parseServiceAddress([a.street,...a.descriptors,site.city ?? a.city,site.state].filter(Boolean).join(", "));
        return (input.groupingMode==="campus" ? canonical.campusKey : canonical.buildingKey)===g.groupKey;
      });
      // A legacy campus address has lost building identity: never guess a unit.
      if (candidates.length > 1) throw new TRPCError({code:"CONFLICT",message:"Multiple sites match this address; choose an existing destination explicitly."});
      if (candidates.length===1 && (input.groupingMode==="campus" || parseServiceAddress(candidates[0].address).descriptors.length)) existingSiteId=candidates[0].id;
    }
    const existingSite = existingSiteId != null ? userSites.find((s) => s.id === existingSiteId) : undefined;
    let formattedAddress: string | null = existingSite?.address ?? null;
    let lat: number | null = existingSite?.lat ?? null;
    let lng: number | null = existingSite?.lng ?? null;
    let city = existingSite?.city ?? g.city;
    let state = existingSite?.state ?? g.state;
    let zip = existingSite?.zip ?? g.zip;
    let geocode: PreviewSite["geocode"] = existingSite ? "existing_site" : "not_precise";
    const review = [...g.needsReview];
    const billUtility = utilityFromRateCodes(g.sheetIds.map((sid) => sheetById.get(sid)?.rateScheduleCode));
    // state evidence order: the sheet's own address → the bills' utility → the user's hint
    const expectedState = state ?? billUtility?.state ?? stateHint;
    if (!existingSite && !expectedState) throw new TRPCError({code:"BAD_REQUEST",message:"Source address state is unknown. Add the state to the workbook header, supply a state hint, or explicitly choose an existing destination; ambiguous partial addresses cannot be merged automatically."});
    if (!existingSite && !state && expectedState) state = expectedState;
    if (!existingSite && g.street) {
      const q = g.state || !expectedState ? g.address : `${g.address}, ${expectedState}`;
      try {
        const geo = await geocodeAddress(q);
        const plausible = geo.kind === "precise" ? geocodeIsPlausible(geo, { city: g.city, state: expectedState }) : null;
        if (geo.kind === "precise" && plausible?.ok) {
          geocode = "precise";
          const sheetStreet = parseServiceAddress(`${g.street}, ${g.city ?? ""}`).campusKey.split("|")[0];
          const matchedStreet = parseServiceAddress(geo.formattedAddress).campusKey.split("|")[0];
          if (sheetStreet && matchedStreet && sheetStreet !== matchedStreet) {
            review.push(`Address matched as "${geo.formattedAddress.replace(/, USA$/, "")}" — the sheet says "${g.street}". Confirm this is the right building.`);
          }
          formattedAddress = geo.formattedAddress.replace(/, USA$/, "");
          lat = geo.lat;
          lng = geo.lng;
          city = geo.city ?? city;
          state = geo.state ?? state;
          zip = geo.zip ?? zip;
        } else if (geo.kind === "precise" && plausible && !plausible.ok) {
          review.push(`Address not pinned: ${plausible.reason}. The site is created from the sheet's address text; edit it to add a map pin.`);
        } else {
          review.push("Address could not be matched to a street-level location — the site is created without a map pin; edit the address to fix.");
        }
      } catch {
        geocode = "failed";
        review.push("Address lookup failed — the site is created from the sheet's address text; edit it later to add a map pin.");
      }
    }
    const metersOut: PreviewMeter[] = g.sheetIds.map((sid) => {
      const s = sheetById.get(sid)!;
      const em = meterByIdentity.get(meterIdentityKey(s));
      const rc = resolveRateCode(null, s.rateScheduleCode);
      return {
        sheetId: sid,
        fileId: s.fileId,
        filename: fileName.get(s.fileId) ?? "",
        sheetName: cleanSheetName(s.sheetName),
        facility: g.facilities[sid] ?? null,
        servicePointId: s.servicePointId,
        serviceAgreementId: s.serviceAgreementId,
        accountNumber: s.accountNumber,
        rateScheduleCode: s.rateScheduleCode,
        tariff: rc ? { urdbId: rc.urdbId, match: rc.match, disclosure: rc.disclosure } : null,
        existingMeterId: em?.id ?? null,
        existingSiteId: em?.siteId ?? null,
      };
    });
    const { facilities: _f, ...rest } = g;
    void _f;
    return {
      ...rest,
      siteName: existingSite?.name ?? g.siteName,
      existingSiteId: existingSiteId ?? null,
      city: city ? prettyCase(city) : null,
      state,
      zip,
      formattedAddress,
      lat,
      lng,
      geocode,
      billUtility,
      needsReview: review,
      meters: metersOut,
      sourceClock: { timeZone: input.timeZone ?? (metersOut.map(m=>userMeters.find(x=>x.id===m.existingMeterId)?.timezone).find(Boolean)) ?? TZ_BY_STATE[state ?? ""] ?? "UTC", timestampBasis: input.timestampBasis === "end" ? "end" : "start", detectBasis: !input.timestampBasis || input.timestampBasis === "auto", ambiguousTime: "reject" },
    };
  });

  const newSites = previewSites.filter((s) => s.existingSiteId == null).length;
  const limit = await siteLimit(user);
  const currentSites = userSites.length;
  const planLimit =
    limit == null
      ? { ok: true as const, limit: null, currentSites, newSites }
      : { ok: currentSites + newSites <= limit, limit, currentSites, newSites };
  const totals = {
    files: files.length,
    sheets: sheetRows.length,
    sites: previewSites.length,
    newSites,
    reusedSites: previewSites.length - newSites,
    meters: previewSites.reduce((a, s) => a + s.meters.length, 0),
    reusedMeters: previewSites.reduce((a, s) => a + s.meters.filter((m) => m.existingMeterId != null).length, 0),
    multiMeterSites: previewSites.filter((s) => s.meters.length > 1).length,
    needsReview: previewSites.filter((s) => s.needsReview.length > 0).length,
    tariffMatched: previewSites.reduce((a, s) => a + s.meters.filter((m) => m.tariff).length, 0),
  };
  const planVersion=await d.transaction(async tx=> {
    await editable(tx,b.id,userId,input.planVersion ?? b.planVersion);
    for (const s of sheetRows) {
      const ps=previewSites.find(p=>p.sheetIds.includes(s.id))!;
      // Validate IANA metadata before publishing the preview.
      new Intl.DateTimeFormat("en",{timeZone:ps.sourceClock.timeZone});
      await tx.update(importBatchSheets).set({overrideSiteId:s.overrideSiteId,overrideGroupKey:s.overrideGroupKey,groupKey:ps.groupKey,sourceClock:ps.sourceClock}).where(and(eq(importBatchSheets.id,s.id),eq(importBatchSheets.userId,userId)));
    }
    const version=b.planVersion+1;
    await tx.update(importBatches).set({status:"previewed",groupingMode:input.groupingMode,planVersion:version,plan:{sites:previewSites,totals,planLimit}}).where(owned(importBatches,b.id,userId));
    return version;
  });
  return { batchId:b.id,planVersion,groupingMode:input.groupingMode,sites:previewSites,totals,planLimit,files:files.map(f=>({id:f.id,filename:f.filename,sheets:f.sheetCount,sizeBytes:f.sizeBytes})) };
}

/* ---------------- commit ---------------- */
export interface CommitOptions {
  buildingType?: string | null;
  entityName?: string | null;
  runAnalysis?: boolean;
  clockConfirmed?: boolean;
}
interface CommitSummary {
  phase: "importing" | "totals" | "enriching" | "analyzing" | "done";
  sheetsTotal: number; sheetsDone: number; sheetsImported: number; sheetsFailed: number; sheetsDuplicate: number; pointsWritten: number;
  sitesCreated: number; sitesReused: number; metersCreated: number; metersReused: number; tariffsAssigned: number;
  campusTotals: number; analysesRun: number; analysesFailed: number;
  /** Consecutive slices ended by a transient infrastructure error (reset on progress). */
  transientRetries?: number;
  currentSheet: string | null; currentSite: string | null; siteIds: number[]; entityId: number | null;
  options: CommitOptions; startedAt: number; notes: string[];
  postProcessing: Record<string, { totals?: "done" | "failed"; analysis?: "done" | "failed"; detail?: string; propertyFacts?: "done" | "skipped" | "unavailable"; floorAreaApplied?: boolean }>;
  /** Oct 24 property facts: sites whose floor area came from public records */
  floorAreaEstimated?: number;
}
function emptySummary(options: CommitOptions): CommitSummary {
  return { phase:"importing",sheetsTotal:0,sheetsDone:0,sheetsImported:0,sheetsFailed:0,sheetsDuplicate:0,pointsWritten:0,sitesCreated:0,sitesReused:0,metersCreated:0,metersReused:0,tariffsAssigned:0,campusTotals:0,analysesRun:0,analysesFailed:0,currentSheet:null,currentSite:null,siteIds:[],entityId:null,options,startedAt:Date.now(),notes:[],postProcessing:{} };
}
async function deriveProgress(tx: Tx, batchId: number, userId: number, summary: CommitSummary) {
  const all=await tx.select().from(importBatchSheets).where(and(eq(importBatchSheets.batchId,batchId),eq(importBatchSheets.userId,userId)));
  const rows=all.filter(s=>s.status!=="skipped");
  summary.sheetsTotal=rows.length;
  summary.sheetsImported=rows.filter(s=>s.status==="imported").length;
  summary.sheetsDuplicate=rows.filter(s=>s.status==="duplicate").length;
  summary.sheetsFailed=rows.filter(s=>s.status==="failed").length;
  summary.sheetsDone=summary.sheetsImported+summary.sheetsDuplicate+summary.sheetsFailed;
  summary.pointsWritten=rows.reduce((n,s)=>n+s.pointsWritten,0);
  summary.siteIds=Array.from(new Set(rows.flatMap(s=>s.siteId ? [s.siteId] : [])));
  const groups=await tx.select().from(importSiteGroups).where(and(eq(importSiteGroups.batchId,batchId),eq(importSiteGroups.userId,userId)));
  summary.sitesCreated=new Set(groups.map(g=>g.siteId)).size;
  summary.sitesReused=Math.max(0,summary.siteIds.length-summary.sitesCreated);
  const ms=await tx.select().from(meters).where(eq(meters.userId,userId));
  summary.metersCreated=ms.filter(m=>m.importBatchId===batchId).length;
  const ids=new Set(rows.flatMap(s=>(s.meterIds as number[] | null) ?? (s.meterId ? [s.meterId] : [])));
  summary.metersReused=Array.from(ids).filter(id=>ms.find(m=>m.id===id)?.importBatchId!==batchId).length;
  summary.tariffsAssigned=ms.filter(m=>ids.has(m.id)&&m.currentTariffId!=null).length;
  summary.analysesRun=Object.values(summary.postProcessing).filter(p=>p.analysis==="done").length;
  summary.analysesFailed=Object.values(summary.postProcessing).filter(p=>p.analysis==="failed").length;
  summary.campusTotals=Object.values(summary.postProcessing).filter(p=>p.totals==="done").length;
  return all;
}
export async function commit(user: {id:number;tier?:string|null;role?:string}, input: {batchId:number;planVersion:number} & CommitOptions) {
  const d=await db(), token=randomUUID(), userId=user.id;
  const claim=await d.transaction(async tx=> {
    const b=await lockBatch(tx,input.batchId,userId);
    if (b.planVersion!==input.planVersion) throw new TRPCError({code:"CONFLICT",message:"Preview changed. Refresh before committing."});
    if (b.workerToken && (b.leaseUntil??0)>Date.now()) return null;
    if (b.status==="complete") return null;
    if (running.size>=2) throw new TRPCError({code:"TOO_MANY_REQUESTS",message:"Import workers are busy. Retry shortly."});
    const plan=b.plan as {sites:PreviewSite[]}|null;
    if (!plan || !["previewed","committing","partial","failed"].includes(b.status)) throw new TRPCError({code:"BAD_REQUEST",message:"Preview the import first."});
    const prev=b.summary as CommitSummary|null;
    const options={...(prev?.options??{}),...Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined))};
    if (!options.clockConfirmed) throw new TRPCError({code:"BAD_REQUEST",message:"Confirm the source timezone and whether timestamps label interval starts or ends."});
    const files=await tx.select().from(importBatchFiles).where(eq(importBatchFiles.batchId,b.id));
    if (files.some(f=>!f.fileKey)) throw new TRPCError({code:"BAD_REQUEST",message:"A durable source is missing; start a new import with the original workbooks."});
    const entitlement=await lockUser(tx,userId);
    // Reserve capacity by rejecting new bulk creation on limited plans until
    // all legacy creation paths share this row-lock protocol (F8 interim).
    if (entitlement.maxSites!==null) throw new TRPCError({code:"FORBIDDEN",message:"Bulk imports are temporarily restricted to Founding/Pro accounts while shared site-capacity reservations are hardened. Use single-site upload on limited plans."});
    // A paused/stalled slice continues in its current phase; a retry of a
    // finished partial/failed import re-walks from the import phase.
    const continuing=b.status==="committing";
    const summary=prev ? {...prev,options,phase:continuing ? prev.phase : "importing" as const,postProcessing:prev.postProcessing??{}} : emptySummary(options);
    await deriveProgress(tx,b.id,userId,summary);
    await tx.update(importBatches).set({status:"committing",workerToken:token,leaseUntil:Date.now()+LEASE_MS,error:null,summary}).where(owned(importBatches,b.id,userId));
    return {plan,summary,tier:entitlement.tier};
  });
  if (!claim) return {batchId:input.batchId,started:false,alreadyRunning:true,more:false};
  running.add(input.batchId);
  try {
    const outcome=await runCommit(input.batchId,userId,claim.tier,claim.plan.sites,claim.summary,token,Date.now()+COMMIT_SLICE_MS);
    return {batchId:input.batchId,started:true,alreadyRunning:false,more:outcome==="paused"};
  } catch(e) {
    const tries=(claim.summary.transientRetries??0)+1;
    if (isTransientInfraError(e) && tries<=MAX_TRANSIENT_RETRIES) {
      // Keep the batch resumable: release the lease into the pause grace so
      // the page (or Resume) continues from the last checkpoint.
      const paused=await d.update(importBatches).set({status:"committing",error:null,summary:{...claim.summary,transientRetries:tries},workerToken:null,leaseUntil:Date.now()+PAUSE_GRACE_MS}).where(and(owned(importBatches,input.batchId,userId),eq(importBatches.workerToken,token))).then(()=>true,()=>false);
      return {batchId:input.batchId,started:true,alreadyRunning:false,more:true,transient:true,pausedOk:paused};
    }
    await d.update(importBatches).set({status:"failed",error:message(e).slice(0,4000),workerToken:null,leaseUntil:null}).where(and(owned(importBatches,input.batchId,userId),eq(importBatches.workerToken,token)));
    return {batchId:input.batchId,started:true,alreadyRunning:false,more:false};
  } finally { running.delete(input.batchId); }
}

async function runCommit(batchId:number,userId:number,tier:Tier,planSites:PreviewSite[],summary:CommitSummary,token:string,deadline:number):Promise<"paused"|"done"> {
  const d=await db();
  // Stop at a checkpoint boundary once the slice budget is spent. Every unit
  // (sheet, campus total, property lookup, analysis) is already checkpointed,
  // so the next commit call resumes exactly where this one stopped.
  const timeUp=()=>Date.now()>=deadline;
  const pause=async()=>{
    await d.transaction(async tx=> {
      await assertLiveLeaseForUpdate(tx,batchId,userId,token);
      await deriveProgress(tx,batchId,userId,summary);
      summary.transientRetries=0;
      await tx.update(importBatches).set({summary:{...summary},workerToken:null,leaseUntil:Date.now()+PAUSE_GRACE_MS}).where(owned(importBatches,batchId,userId));
    });
    return "paused" as const;
  };
  const save=async(extra:Partial<typeof importBatches.$inferInsert>={})=>fenced(batchId,userId,token,async tx=> {
    await deriveProgress(tx,batchId,userId,summary);
    await tx.update(importBatches).set({summary:{...summary},...extra}).where(owned(importBatches,batchId,userId));
  });
  // Heartbeat cannot revive an expired lease. It remains live while off-thread
  // parsing proceeds; every durable write also locks and validates the token.
  const heartbeat=setInterval(()=>void d.update(importBatches).set({leaseUntil:Date.now()+LEASE_MS}).where(and(owned(importBatches,batchId,userId),eq(importBatches.workerToken,token),sql`${importBatches.leaseUntil}>${Date.now()}`)).catch(()=>{}),20_000);
  heartbeat.unref();
  try {
    if (!summary.entityId && summary.options.entityName?.trim()) await fenced(batchId,userId,token,async tx=> {
      await lockUser(tx,userId);
      const name=summary.options.entityName!.trim().slice(0,250);
      const [existing]=await tx.select().from(entities).where(and(eq(entities.userId,userId),eq(entities.name,name)));
      if (existing) summary.entityId=existing.id;
      else { const [r]=await tx.insert(entities).values({userId,name,kind:"property_owner",notes:`Created by bulk import #${batchId}`}); summary.entityId=Number(r.insertId); }
      await tx.update(importBatches).set({entityId:summary.entityId,summary}).where(owned(importBatches,batchId,userId));
    });
    const files=await d.select().from(importBatchFiles).where(and(eq(importBatchFiles.batchId,batchId),eq(importBatchFiles.userId,userId)));
    // Only one workbook buffer is retained by a worker, never a global cache.
    let loadedFileId:number|null=null, buffer:Buffer|null=null;
    for (const ps of planSites) {
      if (timeUp()) return await pause();
      summary.currentSite=ps.siteName;
      let site:typeof sites.$inferSelect;
      try {
        site=await fenced(batchId,userId,token,async tx=> {
          const ent=await lockUser(tx,userId);
          const checkpoints=await tx.select().from(importBatchSheets).where(and(eq(importBatchSheets.batchId,batchId),inArray(importBatchSheets.id,ps.sheetIds)));
          const [mapping]=await tx.select().from(importSiteGroups).where(and(eq(importSiteGroups.userId,userId),eq(importSiteGroups.groupHash,digest(ps.groupKey)),eq(importSiteGroups.groupingMode,(await lockBatch(tx,batchId,userId)).groupingMode)));
          let siteId=ps.existingSiteId ?? checkpoints.find(s=>s.siteId)?.siteId ?? mapping?.siteId;
          let found:typeof sites.$inferSelect|undefined;
          if (siteId) [found]=await tx.select().from(sites).where(and(eq(sites.id,siteId),eq(sites.userId,userId)));
          if (siteId && !found) throw new Error("Destination site no longer belongs to this owner");
          if (!found) {
            const [count]=await tx.select({n:sql<number>`COUNT(*)`}).from(sites).where(eq(sites.userId,userId));
            if (ent.maxSites!==null && Number(count.n)>=ent.maxSites) throw new Error("Site capacity exhausted; upgrade before resuming");
            const cascade=deriveFromAddress(ps.formattedAddress??ps.address,{state:ps.state,zip:ps.zip,city:ps.city,buildingType:summary.options.buildingType??null,placeVerified:ps.geocode==="precise"} as Parameters<typeof deriveFromAddress>[1]);
            const state=ps.state??ps.billUtility?.state??cascade.state.value??null;
            const [r]=await tx.insert(sites).values({userId,entityId:summary.entityId,name:ps.siteName.slice(0,250),address:ps.address || ps.formattedAddress,city:ps.city??cascade.city.value,state,zip:ps.zip??cascade.zip.value,lat:ps.lat,lng:ps.lng,climateZone:cascade.climateZone.value,egridSubregion:cascade.egridSubregion.value,utilityName:ps.billUtility?.utilityName??cascade.utilityName.value,buildingType:summary.options.buildingType,attrSource:"user_entered"});
            siteId=Number(r.insertId);
            await tx.insert(importSiteGroups).values({userId,groupingMode:(await lockBatch(tx,batchId,userId)).groupingMode,groupKey:ps.groupKey.slice(0,512),groupHash:digest(ps.groupKey),siteId,batchId});
            [found]=await tx.select().from(sites).where(eq(sites.id,siteId));
          }
          await tx.update(importBatchSheets).set({siteId:found!.id,groupKey:ps.groupKey}).where(and(eq(importBatchSheets.batchId,batchId),inArray(importBatchSheets.id,ps.sheetIds),eq(importBatchSheets.userId,userId)));
          return found!;
        });
      } catch(e) {
        await fenced(batchId,userId,token,async tx=> { await tx.update(importBatchSheets).set({status:"failed",detail:message(e).slice(0,4000)}).where(and(eq(importBatchSheets.batchId,batchId),inArray(importBatchSheets.id,ps.sheetIds),inArray(importBatchSheets.status,["pending","importing","failed"]))); });
        await save(); continue;
      }
      for (const pm of ps.meters) {
        const [checkpoint]=await d.select().from(importBatchSheets).where(and(eq(importBatchSheets.id,pm.sheetId),eq(importBatchSheets.userId,userId)));
        if (!checkpoint || ["imported","duplicate"].includes(checkpoint.status)) continue;
        if (timeUp()) return await pause();
        summary.currentSheet=pm.sheetName;
        try {
          const file=files.find(f=>f.id===pm.fileId); if (!file) throw new Error("Source file missing");
          if (loadedFileId!==file.id) { buffer=null; buffer=await fileBuffer(file.id,file.fileKey); loadedFileId=file.id; }
          const rows=(await parseWorkbookInWorker(buffer!,checkpoint.sheetName)).find(s=>s.name===checkpoint.sheetName)?.rows;
          if (!rows) throw new Error("Source sheet missing");
          const identity=meterIdentityKey(pm);
          const [known]=await d.select().from(meters).where(and(eq(meters.userId,userId),eq(meters.importIdentity,identity)));
          // Oct 25 (cost audit): with detection on, each sheet's convention is
          // read from its own first/last readings; an explicit choice still wins.
          const detect=!!ps.sourceClock.detectBasis;
          const clock:IntervalClock={...ps.sourceClock,timeZone:known?.timezone??ps.sourceClock.timeZone,timestampBasis:detect?ps.sourceClock.timestampBasis:(known?.timestampBasis??ps.sourceClock.timestampBasis)};
          if (!detect && known?.timestampBasis && known.timestampBasis!==ps.sourceClock.timestampBasis) throw new Error("Existing meter timestamp convention differs; explicit source correction is required");
          const series=parseSheetRows(cleanSheetName(checkpoint.sheetName),rows,clock).filter(s=>s.points.length);
          if (detect && known?.timestampBasis && series[0]?.timestampBasis && series[0].timestampBasis!==known.timestampBasis) throw new Error(`This sheet's timestamps look like interval ${series[0].timestampBasis.toUpperCase()}S, but this meter's earlier data was imported as interval ${known.timestampBasis.toUpperCase()}S. Nothing was changed; choose the convention explicitly or remove the earlier data first.`);
          if (!series.length) throw new Error("No interval rows could be parsed");
          // Interim safety: multi-channel sheets require a durable channel map.
          // Reject rather than use unstable row-order suffixes or lose lineage.
          if (series.length!==1) throw new Error("Multiple channels in one sheet are not supported by bulk setup yet. Split into one sheet per durable service-point/channel identifier.");
          await fenced(batchId,userId,token,async tx=> {
            const ent=await lockUser(tx,userId);
            if (ent.maxSites!==null) throw new Error("Bulk entitlement changed; restore Founding/Pro before resuming");
            const [f]=await tx.select().from(importBatchFiles).where(and(eq(importBatchFiles.id,file.id),eq(importBatchFiles.userId,userId))).for("update");
            let uploadId=f.uploadId;
            if (!uploadId) {
              const month=new Date(); month.setUTCDate(1); month.setUTCHours(0,0,0,0);
              const [n]=await tx.select({n:sql<number>`COUNT(*)`}).from(uploads).where(and(eq(uploads.userId,userId),gte(uploads.createdAt,month),sql`COALESCE(${uploads.parser},'') NOT LIKE 'virtual_total%'`));
              if (ent.tier==="free" && Number(n.n)>=FREE_TIER_MAX_UPLOADS_PER_MONTH) throw new Error("Monthly source upload quota exhausted");
              const [r]=await tx.insert(uploads).values({userId,siteId:null,filename:f.filename,fileKey:f.fileKey,sha256:f.sha256,format:"xlsx",parser:"bulk_import_v2",parserVersion:PARSER_VERSION,status:"pending"});
              uploadId=Number(r.insertId);
              await tx.update(importBatchFiles).set({uploadId}).where(eq(importBatchFiles.id,f.id));
            }
            const candidates=await tx.select().from(meters).where(and(eq(meters.userId,userId),sql`(${meters.importIdentity}=${identity} OR (${meters.importIdentity} IS NULL AND ${pm.servicePointId ? sql`${meters.servicePoint}=${pm.servicePointId}` : sql`${meters.serviceAgreementId}=${pm.serviceAgreementId}`}))`));
            if (candidates.length>1) throw new Error("Duplicate legacy service identities require reconciliation");
            let meter=candidates[0];
            if (meter && meter.siteId!==site.id) throw new Error("Service point belongs to another site; import cannot move or duplicate it");
            if (meter && !meter.importIdentity) {
              // Do not silently mix old timezone-naive timestamps with corrected data.
              const [n]=await tx.select({n:sql<number>`COUNT(*)`}).from(intervals).where(eq(intervals.meterId,meter.id));
              if (Number(n.n)>0 && !meter.timestampBasis) throw new Error("Legacy meter has unverified timestamp provenance. Audit/reparse existing data before attaching corrected intervals.");
              await tx.update(meters).set({importIdentity:identity,timestampBasis:series[0].timestampBasis??clock.timestampBasis}).where(eq(meters.id,meter.id));
            }
            const s=series[0];
            if (!meter) {
              const [r]=await tx.insert(meters).values({userId,siteId:site.id,importIdentity:identity,commodity:s.commodity,label:[pm.facility,pm.serviceAgreementId?`SA ${pm.serviceAgreementId}`:pm.sheetName].filter(Boolean).join(" · ").slice(0,250),accountNumber:pm.accountNumber,servicePoint:pm.servicePointId,serviceAgreementId:pm.serviceAgreementId,rateScheduleCode:pm.rateScheduleCode,facilityLabel:pm.facility,importBatchId:batchId,usageUnit:s.usageUnit,demandUnit:s.demandUnit,meterRole:"main",timezone:clock.timeZone,timestampBasis:s.timestampBasis??clock.timestampBasis});
              [meter]=await tx.select().from(meters).where(eq(meters.id,Number(r.insertId)));
            }
            const w=await writeIntervals(tx,meter.id,s,uploadId,2);
            const notes=[...s.validation.notes];
            if (w.skippedDuplicates) notes.push(`${w.skippedDuplicates} intervals already stored (de-duplicated).`);
            // Tariff lookup/assignment is in the same transaction, not an external
            // helper writing through a different database connection.
            const rc=resolveRateCode(null,pm.rateScheduleCode);
            if (!meter.currentTariffId && rc) {
              const [t]=await tx.select({id:tariffs.id}).from(tariffs).where(eq(tariffs.urdbId,rc.urdbId));
              if (t) { await tx.update(meters).set({currentTariffId:t.id}).where(eq(meters.id,meter.id)); notes.push(rc.disclosure); }
              else notes.push("Filed tariff enrichment unavailable; review the rate before relying on costs.");
            }
            const points=w.inserted+w.replaced;
            await tx.update(importBatchSheets).set({status:points?"imported":"duplicate",siteId:site.id,meterId:meter.id,meterIds:[meter.id],pointsWritten:points,rowsIngested:s.rowsIngested,rowsSkipped:s.rowsSkipped,validation:[{sheet:pm.sheetName,...s.validation}],sourceClock:clock,detail:notes.join(" ").slice(0,4000)}).where(and(eq(importBatchSheets.id,pm.sheetId),eq(importBatchSheets.userId,userId)));
          });
        } catch(e) {
          await fenced(batchId,userId,token,async tx=> { await tx.update(importBatchSheets).set({status:"failed",pointsWritten:0,rowsIngested:0,rowsSkipped:0,validation:null,detail:message(e).slice(0,4000)}).where(and(eq(importBatchSheets.id,pm.sheetId),eq(importBatchSheets.userId,userId))); });
        }
        await save();
        // Collect this sheet's rows/series/insert batches before the next one
        // allocates (512 MiB container; see ingest/memory.ts).
        reclaimMemory();
      }
    }
    buffer=null;
    await fenced(batchId,userId,token,async tx=> {
      const all=await deriveProgress(tx,batchId,userId,summary);
      for (const f of files) {
        const [actual]=await tx.select().from(importBatchFiles).where(eq(importBatchFiles.id,f.id));
        if (!actual.uploadId) continue;
        const rows=all.filter(s=>s.fileId===f.id), failed=rows.some(s=>s.status==="failed" || s.status==="skipped");
        const validations=rows.flatMap(s=>(s.validation as Array<ParsedMeterSeries["validation"]>|null)??[]);
        const verified=!failed&&validations.length>0&&validations.every(v=>v.pass&&v.footerUsageDelta!=null);
        await tx.update(uploads).set({status:failed?"failed":"parsed",error:failed?"Some sheets failed or were skipped; see bulk import details.":null,rowsIngested:rows.reduce((n,s)=>n+s.rowsIngested,0),rowsSkipped:rows.reduce((n,s)=>n+s.rowsSkipped,0),sheetsFound:rows.length,parseConfidence:verified?1:0.5,validation:validations}).where(eq(uploads.id,actual.uploadId));
      }
    });
    summary.phase="totals"; summary.currentSheet=null; await save();
    const vt=await import("./virtualTotal");
    const blockedSites=new Set<number>();
    for (const siteId of summary.siteIds) {
      const post=summary.postProcessing[siteId]??{}; summary.postProcessing[siteId]=post;
      if (post.totals!=="done" && timeUp()) return await pause();
      const bad=await d.select({id:importBatchSheets.id}).from(importBatchSheets).where(and(eq(importBatchSheets.batchId,batchId),eq(importBatchSheets.siteId,siteId),eq(importBatchSheets.status,"failed")));
      if (bad.length) { blockedSites.add(siteId); post.detail="Some source sheets failed; totals/analysis withheld until retry succeeds."; await save(); continue; }
      try {
        if (post.totals!=="done") {
          // The locked batch row is a fence around legacy downstream helpers.
          // They cannot race a replacement worker, though downstream rollback
          // remains separate from the already-committed source sheet outcomes.
          const ms=await h.listMeters(siteId,userId);
          const mains=ms.filter(m=>m.commodity==="electric"&&m.meterRole==="main");
          if (mains.length>=2) {
            const [count]=await d.select({n:sql<number>`COUNT(*)`}).from(intervals).where(inArray(intervals.meterId,mains.map(m=>m.id)));
            if (Number(count.n)>600_000) throw new Error("Campus total exceeds the 600,000-component-reading safety limit; use a bounded analysis window.");
            await fenced(batchId,userId,token,async()=>{ await vt.materializeVirtualTotal(siteId,userId); });
            post.totals="done";
          }
        }
        // Preserve an analysis error until that analysis actually succeeds.
        if (post.analysis!=="failed") delete post.detail;
      } catch(e) { blockedSites.add(siteId); post.totals="failed"; post.detail=`Campus total incomplete: ${message(e).slice(0,300)}`; }
      await save();
      reclaimMemory();
    }
    // Property facts (Oct 24): look up official/public records for each new
    // site BEFORE analysis so floor area (and therefore EUI / benchmark /
    // league ranking) is filled automatically with its basis disclosed.
    // Network I/O stays outside the fenced transaction; enrichment is
    // best-effort and never fails or blocks the import.
    const pf=await import("./propertyFacts");
    if (pf.propertyFactsNetworkAvailable()) {
      summary.phase="enriching"; await save();
      let estimated=0;
      for (const siteId of summary.siteIds) {
        const post=summary.postProcessing[siteId]??{}; summary.postProcessing[siteId]=post;
        if (post.propertyFacts==="done") { if (post.floorAreaApplied) estimated++; continue; }
        if (timeUp()) return await pause();
        try {
          const site=await h.getSite(siteId,userId); if (!site) continue;
          summary.currentSite=site.name; await save();
          const before=site.sqft;
          const row=await pf.refreshPropertyFacts(siteId,{allowAutoApply:true});
          const after=(await h.getSite(siteId,userId))?.sqft??null;
          post.propertyFacts=row ? (row.status==="unavailable" ? "unavailable" : "done") : "skipped";
          post.floorAreaApplied=before==null && after!=null && row?.appliedSqft!=null && Math.abs(after-row.appliedSqft)<0.5;
          if (post.floorAreaApplied) estimated++;
        } catch { post.propertyFacts="unavailable"; }
        await save();
        reclaimMemory();
      }
      summary.floorAreaEstimated=estimated; summary.currentSite=null; await save();
    }
    if (summary.options.runAnalysis!==false) {
      summary.phase="analyzing"; await save();
      const {runAnalysisPipeline}=await import("./analytics/pipeline");
      for (const siteId of summary.siteIds) {
        const post=summary.postProcessing[siteId];
        // Error text is not a checkpoint: retry failed/incomplete analysis once
        // this attempt's source-sheet and totals dependencies are healthy.
        if (post.analysis==="done" || blockedSites.has(siteId)) continue;
        if (timeUp()) return await pause();
        try {
          await fenced(batchId,userId,token,async()=> {
            const site=await h.getSite(siteId,userId); if (!site) throw new Error("Site removed");
            summary.currentSite=site.name;
            await runAnalysisPipeline(site,vt.pickSiteAnalysisMeter(await h.listMeters(siteId,userId)),userId,tier);
          });
          post.analysis="done";
          delete post.detail;
        } catch(e) { post.analysis="failed"; post.detail=`Analysis incomplete: ${message(e).slice(0,300)}. Retry or run analysis from Explore.`; }
        await save();
        reclaimMemory();
      }
    }
    summary.phase="done"; summary.currentSite=null; summary.currentSheet=null; summary.transientRetries=0;
    await fenced(batchId,userId,token,async tx=> {
      const all=await deriveProgress(tx,batchId,userId,summary);
      const warnings=all.some(s=>s.status==="skipped" || ((s.validation as Array<{pass:boolean}>|null)??[]).some(v=>!v.pass))||Object.values(summary.postProcessing).some(p=>p.detail||p.totals==="failed"||p.analysis==="failed");
      summary.notes=all.some(s=>s.status==="skipped") ? ["Some sheets were skipped; review every sheet disposition below."] : [];
      const status=summary.sheetsFailed ? (summary.sheetsImported+summary.sheetsDuplicate ? "partial" : "failed") : warnings ? "partial" : "complete";
      await tx.update(importBatches).set({status,summary,completedAt:Date.now(),workerToken:null,leaseUntil:null}).where(owned(importBatches,batchId,userId));
    });
    return "done";
  } finally { clearInterval(heartbeat); }
}

/* ---------------- status / list ---------------- */
export async function status(userId:number,batchId:number) {
  const d=await db(),b=await loadBatch(batchId,userId);
  const files=await d.select().from(importBatchFiles).where(and(eq(importBatchFiles.batchId,b.id),eq(importBatchFiles.userId,userId)));
  const sheets=await d.select().from(importBatchSheets).where(and(eq(importBatchSheets.batchId,b.id),eq(importBatchSheets.userId,userId)));
  const isRunning=b.workerToken!=null&&(b.leaseUntil??0)>Date.now()&&b.status==="committing";
  // Between request slices: no worker holds the lease, but the client is expected to continue.
  const paused=b.status==="committing"&&b.workerToken==null&&(b.leaseUntil??0)>Date.now();
  return {batch:{id:b.id,status:b.status,groupingMode:b.groupingMode,planVersion:b.planVersion,summary:b.summary as CommitSummary|null,plan:b.plan as {sites:PreviewSite[];totals:Record<string,number>;planLimit:{ok:boolean;limit:number|null;currentSites:number;newSites:number}}|null,error:b.error,createdAt:b.createdAt,completedAt:b.completedAt},running:isRunning,paused,stalled:b.status==="committing"&&!isRunning&&!paused,files:files.map(f=>({id:f.id,filename:f.filename,sheets:f.sheetCount,sizeBytes:f.sizeBytes})),sheets:sheets.map(s=>({id:s.id,fileId:s.fileId,sheetName:cleanSheetName(s.sheetName),facility:s.facilityLabel,address:s.addressRaw,servicePointId:s.servicePointId,rateScheduleCode:s.rateScheduleCode,status:s.status,siteId:s.siteId,meterId:s.meterId,pointsWritten:s.pointsWritten,detail:s.detail,overrideSiteId:s.overrideSiteId,overrideGroupKey:s.overrideGroupKey,sourceClock:s.sourceClock,validation:s.validation}))};
}
export async function listBatches(userId:number) {
  const rows=await (await db()).select().from(importBatches).where(eq(importBatches.userId,userId)).orderBy(desc(importBatches.id)).limit(10);
  return rows.map(b=>({id:b.id,status:b.status,groupingMode:b.groupingMode,summary:b.summary as CommitSummary|null,createdAt:b.createdAt,completedAt:b.completedAt,running:b.workerToken!=null&&(b.leaseUntil??0)>Date.now()}));
}
