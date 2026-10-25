/**
 * Memory-bounded XLSX access (Oct 25).
 *
 * Why: SheetJS inflates EVERY zip member up front, even with `sheets:[...]`
 * or `sheetRows`. A real utility workbook (KUSD: 18 MiB on disk, 20 sheets,
 * 147 MiB of worksheet XML) therefore peaks near 600 MiB, which exceeds the
 * 512 MiB production container and gets the process OOM-killed — users saw a
 * plain-text "Service Unavailable" instead of their import.
 *
 * What: rebuild a small, valid XLSX from the original bytes. Supporting parts
 * (workbook, rels, styles, shared strings, theme...) are copied byte-for-byte
 * in compressed form; worksheets we do not need are replaced with tiny empty
 * stubs; the worksheet(s) we do need are either copied whole ("full") or
 * inflated only up to a bounded prefix and closed cleanly ("header"). The
 * workbook manifest is untouched, so sheet names/order are identical and
 * SheetJS parses the subset exactly like the original for the kept rows.
 *
 * Pure Node (zlib only). Never decompresses an unneeded worksheet.
 */
import * as zlib from "node:zlib";
const { inflateRawSync, constants: zc } = zlib;

export interface ZipEntry {
  name: string; method: number; flags: number; time: number; date: number;
  crc: number; compSize: number; size: number; localOffset: number;
}
export interface WorkbookSheet { name: string; path: string }

const MAX_SMALL_PART = 16 * 1024 * 1024;           // workbook/rels parts read fully
const MAX_SUPPORT_EXPANDED = 96 * 1024 * 1024;     // non-worksheet parts kept in a subset
const HEADER_COMPRESSED_PREFIX = 48 * 1024;        // compressed bytes inflated per sheet in header mode
const HEADER_EXPANDED_CAP = 384 * 1024;            // expanded XML kept per sheet in header mode
const HEADER_MAX_ROWS = 64;                        // rows kept per sheet in header mode (metadata uses <= 12)

let CRC_TABLE: Int32Array | null = null;
function crc32(buf: Buffer): number {
  // Node >= 22.2 ships a native CRC-32 (multi-MiB chunk parts are hashed per chunk).
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === "function") return native(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function readZipDirectory(buf: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("Invalid XLSX ZIP directory");
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("Invalid workbook ZIP member");
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    out.push({
      name: buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8"),
      flags: buf.readUInt16LE(pos + 8), method: buf.readUInt16LE(pos + 10), time: buf.readUInt16LE(pos + 12), date: buf.readUInt16LE(pos + 14),
      crc: buf.readUInt32LE(pos + 16), compSize: buf.readUInt32LE(pos + 20), size: buf.readUInt32LE(pos + 24), localOffset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function compressedData(buf: Buffer, e: ZipEntry): Buffer {
  const L = e.localOffset;
  if (L + 30 > buf.length || buf.readUInt32LE(L) !== 0x04034b50) throw new Error("Invalid workbook ZIP local header");
  const start = L + 30 + buf.readUInt16LE(L + 26) + buf.readUInt16LE(L + 28);
  if (start + e.compSize > buf.length) throw new Error("Invalid workbook ZIP bounds");
  return buf.subarray(start, start + e.compSize);
}

function inflateEntry(buf: Buffer, e: ZipEntry, cap = MAX_SMALL_PART): Buffer {
  if (e.size > cap) throw new Error(`Workbook part ${e.name} is too large to read safely`);
  const data = compressedData(buf, e);
  if (e.method === 0) return Buffer.from(data);
  if (e.method !== 8) throw new Error(`Unsupported workbook compression (${e.method})`);
  return inflateRawSync(data, { maxOutputLength: Math.max(1, cap) });
}

/** Inflate at most a bounded prefix of an entry. Never inflates the whole member. */
function inflatePrefix(buf: Buffer, e: ZipEntry): { xml: Buffer; complete: boolean } {
  const data = compressedData(buf, e);
  if (e.method === 0) return { xml: Buffer.from(data.subarray(0, HEADER_EXPANDED_CAP)), complete: data.length <= HEADER_EXPANDED_CAP };
  if (e.method !== 8) throw new Error(`Unsupported workbook compression (${e.method})`);
  const whole = data.length <= HEADER_COMPRESSED_PREFIX;
  // Z_SYNC_FLUSH returns everything decodable from a truncated stream instead of throwing.
  const out = inflateRawSync(whole ? data : data.subarray(0, HEADER_COMPRESSED_PREFIX), { finishFlush: zc.Z_SYNC_FLUSH });
  const complete = whole && out.length <= HEADER_EXPANDED_CAP;
  return { xml: out.length > HEADER_EXPANDED_CAP ? out.subarray(0, HEADER_EXPANDED_CAP) : out, complete };
}

const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, c: string) => {
  const k = c.toLowerCase();
  if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">"; if (k === "quot") return "\""; if (k === "apos") return "'";
  return String.fromCodePoint(k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
});
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of Array.from(tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g))) out[m[1]] = unescapeXml(m[3] ?? m[4] ?? "");
  return out;
}
/** OOXML escapes control characters in names as _xHHHH_ (SheetJS decodes these). */
const decodeOoxmlName = (s: string) => s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (baseDir ? baseDir.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const p of parts) { if (!p || p === ".") continue; if (p === "..") out.pop(); else out.push(p); }
  return out.join("/");
}

/** Sheet names (in workbook order) mapped to their worksheet part paths. */
export function workbookSheets(buf: Buffer, entries = readZipDirectory(buf)): WorkbookSheet[] {
  const byName = new Map(entries.map(e => [e.name, e] as const));
  const read = (name: string) => { const e = byName.get(name); return e ? inflateEntry(buf, e).toString("utf8") : null; };
  let wbPath = "xl/workbook.xml";
  const rootRels = read("_rels/.rels");
  if (rootRels) for (const m of Array.from(rootRels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g))) {
    const a = attrs(m[0]);
    if (/officeDocument$/.test(a.Type ?? "") && a.Target) { wbPath = resolvePart("", a.Target); break; }
  }
  const wbXml = read(wbPath);
  if (!wbXml) throw new Error("Workbook manifest missing");
  const dir = wbPath.includes("/") ? wbPath.slice(0, wbPath.lastIndexOf("/")) : "";
  const relsXml = read(`${dir ? dir + "/" : ""}_rels/${wbPath.slice(wbPath.lastIndexOf("/") + 1)}.rels`) ?? "";
  const targets = new Map<string, string>();
  for (const m of Array.from(relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g))) { const a = attrs(m[0]); if (a.Id && a.Target) targets.set(a.Id, resolvePart(dir, a.Target)); }
  const out: WorkbookSheet[] = [];
  for (const m of Array.from(wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g))) {
    const a = attrs(m[0]);
    const rid = Object.entries(a).find(([k]) => /:id$/.test(k))?.[1];
    const path = rid ? targets.get(rid) : undefined;
    if (a.name != null && path) out.push({ name: decodeOoxmlName(a.name), path });
  }
  return out;
}

function closeTruncatedSheet(xml: Buffer, maxRows = HEADER_MAX_ROWS): Buffer {
  const s = xml.toString("latin1"); // byte-preserving; only ASCII markup is searched
  const prefix = /<(\w+:)?worksheet\b/.exec(s)?.[1] ?? "";
  let cut = -1, rows = 0, m: RegExpExecArray | null;
  const re = /<\/(?:\w+:)?row>/g;
  while ((m = re.exec(s))) { cut = m.index + m[0].length; if (++rows >= maxRows) break; }
  if (cut < 0) {
    const open = /<(?:\w+:)?sheetData\b[^>]*>/.exec(s);
    if (!open) throw new Error("Worksheet header could not be read");
    if (/\/>$/.test(open[0])) return Buffer.from(s.slice(0, open.index + open[0].length) + `</${prefix}worksheet>`, "latin1");
    cut = open.index + open[0].length;
  }
  return Buffer.from(s.slice(0, cut) + `</${prefix}sheetData></${prefix}worksheet>`, "latin1");
}

const STUB_SHEET = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>', "utf8");

/**
 * Build a bounded XLSX.
 * - mode "header": every worksheet truncated to its first rows (for metadata).
 * - mode "full": `sheetName` copied whole, every other worksheet stubbed.
 */
export function buildWorkbookSubset(buf: Buffer, opts: { mode: "header" } | { mode: "full"; sheetName: string; replaceXml?: Buffer }): Buffer {
  const entries = readZipDirectory(buf);
  const sheets = workbookSheets(buf, entries);
  const sheetPaths = new Set(sheets.map(s => s.path));
  let keepPath: string | null = null;
  const replaceXml = opts.mode === "full" ? opts.replaceXml : undefined;
  if (opts.mode === "full") {
    keepPath = sheets.find(s => s.name === opts.sheetName)?.path ?? null;
    if (!keepPath) throw new Error("Source sheet missing");
  }
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, supportExpanded = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue; // directory records
    // Only worksheet XML carries bulk cell data; chartsheets etc. are copied as-is.
    const isSheet = /(^|\/)worksheets\/[^/]+\.xml$/.test(e.name);
    let method = e.method, crc = e.crc, size = e.size, data: Buffer;
    if (!isSheet) {
      supportExpanded += e.size;
      if (supportExpanded > MAX_SUPPORT_EXPANDED) throw new Error("Workbook has very large non-data parts (for example pivot caches or images). Save a copy with only the interval sheets and try again.");
      data = compressedData(buf, e);
    } else if (opts.mode === "full" && e.name === keepPath) {
      if (replaceXml) { method = 0; data = replaceXml; size = replaceXml.length; crc = crc32(replaceXml); }
      else data = compressedData(buf, e);
    } else if (opts.mode === "header") {
      const p = inflatePrefix(buf, e);
      const xml = closeTruncatedSheet(p.xml);
      method = 0; data = xml; size = xml.length; crc = crc32(xml);
    } else {
      method = 0; data = STUB_SHEET; size = STUB_SHEET.length; crc = crc32(STUB_SHEET);
    }
    const name = Buffer.from(e.name, "utf8");
    const flags = e.flags & ~0x0008 & ~0x0001; // sizes are known; never encrypted (rejected upstream)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.time, 10); local.writeUInt16LE(e.date, 12); local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(e.time, 12); cd.writeUInt16LE(e.date, 14); cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, data); central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central), eocd = Buffer.alloc(22);
  const count = central.length / 2;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** True when the bytes are a ZIP container (xlsx); legacy .xls is not. */
export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** Small workbooks may fall back to a whole read if a subset cannot be built. */
const SMALL_WORKBOOK_EXPANDED = 40 * 1024 * 1024;
function expandedBytes(buf: Buffer): number {
  try { return readZipDirectory(buf).reduce((n, e) => n + e.size, 0); } catch { return Number.POSITIVE_INFINITY; }
}
/**
 * Bytes to hand SheetJS: a bounded subset for .xlsx, the original for legacy
 * .xls (not a zip). If a subset cannot be built, only small workbooks fall back
 * to a whole read; large ones fail with the subset error instead of risking
 * an out-of-memory crash of the whole server.
 */
export function boundedWorkbookInput(buf: Buffer, opts: { mode: "header" } | { mode: "full"; sheetName: string }): Buffer {
  if (!isZip(buf)) return buf;
  try { return buildWorkbookSubset(buf, opts); }
  catch (e) { if (expandedBytes(buf) <= SMALL_WORKBOOK_EXPANDED) return buf; throw e; }
}
/** Sheet names in workbook order without inflating any worksheet. */
export function workbookSheetNames(buf: Buffer): string[] | null {
  if (!isZip(buf)) return null;
  try { return workbookSheets(buf).map(s => s.name); } catch { return null; }
}

/**
 * Oct 25 (3rd OOM path): a single worksheet with ~25+ MiB of XML (≈140k+
 * 15-minute rows) OOM-killed the 512 MiB container even with the worker heap
 * cap — SheetJS holds the XML string, its row splits and the cell grid at once,
 * and much of that is outside the capped old generation. Large sheets are
 * therefore split at </row> boundaries into self-contained worksheet parts
 * (identical prefix — incl. <dimension> — and suffix, a slice of the rows), so
 * each SheetJS pass only ever sees a few MiB of rows.
 *
 * Exactness rules (otherwise the plan is "unsupported" and the caller decides):
 *  - every chunk after the first starts with a <row> carrying an explicit r=
 *    (SheetJS numbers an r-less row from the previous one), rows ascending;
 *  - no shared/array formulas (their definitions span rows).
 */
export type SheetChunkPlan =
  | { kind: "single"; xmlBytes: number }
  | { kind: "unsupported"; xmlBytes: number; reason: string }
  | { kind: "chunked"; xmlBytes: number; chunks: number; dimension: string; firstRows: Array<number | null>; build: (k: number) => Buffer };

/** SheetJS reads <dimension> from the text before <sheetData> with /"(\w*:\w*)"/
 * on the 50 chars after the tag; only a strict A1:B2 form is accepted here. */
function declaredDimension(beforeSheetData: string): string | null {
  const ridx = beforeSheetData.search(/<(?:\w*:)?dimension/);
  if (ridx <= 0) return null;
  const m = beforeSheetData.slice(ridx, ridx + 50).match(/"(\w*:\w*)"/);
  return m && /^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(m[1]) ? m[1] : null;
}

export function planSheetChunks(buf: Buffer, sheetName: string, opts: { singlePassBytes: number; targetBytes: number; maxXmlBytes: number }): SheetChunkPlan {
  const entries = readZipDirectory(buf);
  const sheet = workbookSheets(buf, entries).find(s => s.name === sheetName);
  if (!sheet) throw new Error("Source sheet missing");
  const entry = entries.find(e => e.name === sheet.path);
  if (!entry) throw new Error("Source sheet missing");
  const xmlBytes = entry.size;
  if (xmlBytes <= opts.singlePassBytes) return { kind: "single", xmlBytes };
  if (xmlBytes > opts.maxXmlBytes) return { kind: "unsupported", xmlBytes, reason: "sheet XML above the chunking ceiling" };
  const xml = inflateEntry(buf, entry, opts.maxXmlBytes);
  const head = xml.subarray(0, Math.min(xml.length, 1024 * 1024)).toString("latin1");
  const open = /<(\w+:)?sheetData\b[^>]*>/.exec(head);
  if (!open || open[0].endsWith("/>")) return { kind: "unsupported", xmlBytes, reason: "sheetData not found near the start" };
  const ns = open[1] ?? "";
  const openEnd = open.index + open[0].length;
  const dimension = declaredDimension(head.slice(0, open.index));
  if (!dimension) return { kind: "unsupported", xmlBytes, reason: "no usable <dimension> range" };
  const closeStart = xml.lastIndexOf(Buffer.from(`</${ns}sheetData>`, "latin1"));
  if (closeStart < openEnd) return { kind: "unsupported", xmlBytes, reason: "sheetData end not found" };
  for (const marker of ['t="shared"', "t='shared'", 't="array"', "t='array'"]) {
    const at = xml.indexOf(marker, openEnd, "latin1");
    if (at >= 0 && at < closeStart) return { kind: "unsupported", xmlBytes, reason: "shared or array formulas" };
  }
  const rowClose = Buffer.from(`</${ns}row>`, "latin1");
  const rowOpen = new RegExp(`<${ns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}row\\b([^>]*)>`);
  const bounds: Array<[number, number]> = [];
  const firstRows: Array<number | null> = [];
  let start = openEnd, lastFirst = -1;
  while (start < closeStart) {
    let end = closeStart;
    if (start + opts.targetBytes < closeStart) {
      const idx = xml.indexOf(rowClose, start + opts.targetBytes);
      if (idx >= 0 && idx < closeStart) end = idx + rowClose.length;
    }
    if (bounds.length > 0) {
      const tag = rowOpen.exec(xml.subarray(start, Math.min(end, start + 4096)).toString("latin1"));
      const r = tag ? /\br\s*=\s*["'](\d+)["']/.exec(tag[1]) : null;
      if (!tag) {
        // Only whitespace may remain after the last full row.
        if (/^\s*$/.test(xml.subarray(start, end).toString("latin1"))) { bounds[bounds.length - 1][1] = end; break; }
        return { kind: "unsupported", xmlBytes, reason: "row element not found at a chunk boundary" };
      }
      if (!r) return { kind: "unsupported", xmlBytes, reason: "row without an explicit r attribute at a chunk boundary" };
      const first = Number(r[1]) - 1;
      if (!(first > lastFirst)) return { kind: "unsupported", xmlBytes, reason: "rows are not in ascending order" };
      lastFirst = first;
      firstRows.push(first);
    } else firstRows.push(null);
    bounds.push([start, end]);
    start = end;
  }
  if (bounds.length < 2) return { kind: "single", xmlBytes };
  const prefix = xml.subarray(0, openEnd), suffix = xml.subarray(closeStart);
  const name = sheetName;
  return {
    kind: "chunked", xmlBytes, chunks: bounds.length, dimension, firstRows,
    build: (k: number) => buildWorkbookSubset(buf, { mode: "full", sheetName: name, replaceXml: Buffer.concat([prefix, xml.subarray(bounds[k][0], bounds[k][1]), suffix]) }),
  };
}
