/**
 * Ingestion hardening (handoff Cycle 5, acceptance-testable):
 * (a) magic-byte/MIME validation before parser routing
 * (b) 50 MB pre-parse size cap
 * (c) XXE-safe XML options (no DTD/entity expansion; fast-xml-parser does not
 *     resolve external entities by design — we additionally reject DOCTYPE)
 * (d) formula-injection scrubbing for spreadsheet-derived strings
 * (e) parse-step timeout wrapper
 */
import { MAX_UPLOAD_BYTES, PARSE_TIMEOUT_MS } from "../../shared/wattwise";

export type DetectedType = "xlsx" | "xls" | "csv_text" | "xml" | "pdf" | "png" | "jpeg" | "zip" | "zip_unknown" | "unknown";

/** An OOXML workbook is a zip containing `[Content_Types].xml` and `xl/…`
 * members; generic archives (utility Green Button bundles etc.) are not.
 * Member names appear verbatim in local-file headers AND in the central
 * directory at the END of the archive — writers order members differently
 * (Excel puts [Content_Types].xml first; SheetJS puts xl/_rels first and
 * [Content_Types].xml last), so scan a head window plus a tail window (the
 * central directory always lists every member) without inflating anything.
 * Ingest-fix ING-2 (owner report Jul 19): a raw .zip used to detect as
 * "xlsx", route into XLSX.read, and die with "Unsupported ZIP file". */
function zipLooksLikeOoxml(buf: Buffer): boolean {
  const head = buf.slice(0, 8192).toString("latin1");
  const tail = buf.length > 8192 ? buf.slice(-65536).toString("latin1") : "";
  const w = head + tail;
  return w.includes("[Content_Types].xml") || w.includes("xl/workbook.xml") || w.includes("xl/_rels/workbook.xml.rels");
}

export function detectMagicBytes(buf: Buffer): DetectedType {
  if (buf.length >= 4) {
    // ZIP container — could be an xlsx workbook OR a generic archive
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return zipLooksLikeOoxml(buf) ? "xlsx" : "zip";
    }
    // Legacy xls (OLE compound file)
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "xls";
    // PDF
    if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    // JPEG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  }
  const head = buf.slice(0, 4096).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<feed") || head.startsWith("<entry")) return "xml";
  // Heuristic: printable text with commas/newlines → CSV
  const printable = head.split("").filter((c) => {
    const code = c.charCodeAt(0);
    return (code >= 32 && code < 127) || code === 9 || code === 10 || code === 13;
  }).length;
  if (head.length > 0 && printable / head.length > 0.95) return "csv_text";
  return "unknown";
}

const EXPECTED: Record<string, DetectedType[]> = {
  xlsx: ["xlsx", "xls"],
  csv: ["csv_text"],
  espi_xml: ["xml"],
  zip: ["zip", "xlsx"], // a zip-labeled upload that is really a workbook is still safe to accept
  // "auto": extensionless or unknown-extension files (e.g. Green Button
  // "HourlyIntervalData" members) — any parseable interval content type.
  auto: ["xlsx", "xls", "csv_text", "xml", "zip"],
  bill_pdf: ["pdf"],
  bill_image: ["png", "jpeg"],
};

export interface PreParseResult {
  ok: boolean;
  detected: DetectedType;
  reason?: string;
}

/** Gate (a)+(b): validate size + magic bytes vs the endpoint's expected format. */
export function preParseGate(buf: Buffer, expectedFormat: keyof typeof EXPECTED): PreParseResult {
  if (buf.length === 0) return { ok: false, detected: "unknown", reason: "Empty file" };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, detected: "unknown", reason: `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit` };
  }
  const detected = detectMagicBytes(buf);
  const allowed = EXPECTED[expectedFormat] ?? [];
  if (!allowed.includes(detected)) {
    return {
      ok: false,
      detected,
      reason: `File content (${detected}) does not match expected type (${expectedFormat}) — upload rejected for safety`,
    };
  }
  return { ok: true, detected };
}

/** Gate (c): reject XML carrying DOCTYPE/ENTITY declarations (XXE vector). */
export function rejectXxe(xmlText: string): { ok: boolean; reason?: string } {
  const head = xmlText.slice(0, 65536);
  if (/<!DOCTYPE/i.test(head) || /<!ENTITY/i.test(head)) {
    return { ok: false, reason: "XML with DTD/ENTITY declarations is not accepted (XXE protection)" };
  }
  return { ok: true };
}

/** Gate (d): scrub spreadsheet formula-injection prefixes from string cells.
 * Batch-30 (pass 1065): the numeric exemption and the danger test now operate
 * on the SAME trimmed string. Previously the prefix test ran on the raw value
 * while the numeric exemption ran on the trimmed value — so "\t123" tested
 * dangerous (leading tab) yet exempt (trims to numeric) and was returned
 * unscrubbed with the tab intact; a genuinely numeric cell with incidental
 * whitespace is now returned trimmed, and non-numeric dangerous values are
 * scrubbed on the trimmed form.
 * Batch-34 (pass 1275): leading single-quote added to the danger class —
 * a value like "'=SUM(1,1)" previously passed unscrubbed; spreadsheet apps
 * treat a leading ' as a formula-escape prefix, but some downstream CSV
 * consumers strip it before evaluation, re-arming the payload. Quoting it
 * again ("''=...") keeps the literal rendering safe everywhere. */
export function scrubCell(value: string): string {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);
  if (/^[=+\-@\t\r']/.test(trimmed) && !isNumeric) {
    return "'" + trimmed;
  }
  // Leading whitespace can itself hide a dangerous prefix from naive consumers
  // (and " 123" is not a valid number in strict CSV contexts) — return the
  // trimmed form whenever trimming changed a value we inspected.
  return trimmed === value ? value : trimmed;
}

/** Gate (e): run a parse function under the compute timeout. */
export async function withParseTimeout<T>(fn: () => Promise<T> | T, label: string, timeoutMs: number = PARSE_TIMEOUT_MS): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded parse timeout (${timeoutMs} ms)`)), timeoutMs);
    Promise.resolve()
      .then(fn)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/** XLSX admission limits, checked from the central directory before inflation. */
export const WORKBOOK_LIMITS = { expandedBytes: 256 * 1024 * 1024, entries: 4096, sheets: 128, rows: 200_000, columns: 256 };
export function preflightWorkbookZip(buf: Buffer) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Invalid XLSX ZIP directory");
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16), expanded = 0, sheets = 0;
  if (count === 65535 || count > WORKBOOK_LIMITS.entries) throw new Error("Workbook ZIP entry limit exceeded (ZIP64 not accepted)");
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("Invalid workbook ZIP member");
    if (buf.readUInt16LE(pos + 8) & 1) throw new Error("Encrypted workbooks are not supported");
    const bytes = buf.readUInt32LE(pos + 24), nameLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    expanded += bytes;
    if (/^xl\/worksheets\/sheet[^/]*\.xml$/.test(name)) sheets++;
    if (bytes === 0xffffffff || expanded > WORKBOOK_LIMITS.expandedBytes) throw new Error("Workbook expands beyond the 256 MiB safety limit");
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    if (pos > end) throw new Error("Invalid workbook ZIP bounds");
  }
  if (sheets > WORKBOOK_LIMITS.sheets) throw new Error("Workbook sheet limit exceeded (128)");
  return { expandedBytes: expanded, entries: count, sheets };
}

// One actual XLSX parser per process, bounded waiting queue; the worker is
// terminated on timeout and owns inflation/worksheet heap away from Express.
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { boundedWorkbookInput, isZip, planSheetChunks } from "./xlsxSubset";
import { reclaimMemory } from "./memory";
import { createRequire } from "node:module";
const xlsxPath = createRequire(import.meta.url).resolve("xlsx");
// Oct 25: raw values only (sheet_to_json raw:true never reads formatted text,
// number formats or styles), dense cell storage. Proven byte-identical rows on
// all 38 KUSD sheets and synthetic 70k/140k/175k-row sheets while cutting
// parse memory ~15-25% and time ~40%. The worker heap cap keeps an oversized
// sheet a contained per-sheet error instead of a container OOM kill.
const WORKER_OLD_GEN_MB = 176;
/** Parser heap cap; the env override exists for deterministic exhaustion tests only. */
const parserHeapMb = () => Number(process.env.XLSX_PARSER_HEAP_MB) > 0 ? Number(process.env.XLSX_PARSER_HEAP_MB) : WORKER_OLD_GEN_MB;
/** Plain per-sheet instruction for a sheet that cannot be read within the container budget. */
export const SHEET_TOO_LARGE_MESSAGE = "This sheet is too large to process in one pass. Split it into smaller date ranges (for example one year per sheet) and add it again; nothing from this sheet was saved.";
const MiB = 1024 * 1024;
/**
 * Oct 25 calibration under the real 512 MiB / 1 vCPU envelope (single-sheet
 * uploads, fresh server each): one-pass sheets of 12–18 MiB XML peaked at
 * 368–434 MiB; 24.8 MiB (140k rows) and 31.2 MiB (175k rows) OOM-killed the
 * container. Real KUSD sheets are 7.2–7.5 MiB and stay one-pass. Larger sheets
 * are parsed in ~6 MiB row chunks; a sheet that cannot be chunked exactly is
 * read in one pass only up to the proven-safe 12 MiB, otherwise rejected.
 */
const SHEET_LIMITS = {
  singlePassBytes: () => Number(process.env.XLSX_SINGLE_PASS_BYTES ?? 10 * MiB),
  chunkBytes: () => Number(process.env.XLSX_CHUNK_BYTES ?? 6 * MiB),
  maxXmlBytes: 64 * MiB,
  unchunkableSinglePassMax: 12 * MiB,
};
const WORKER_SCRIPT = `
  const {parentPort,workerData:w}=require('node:worker_threads');
  const XLSX=require(w.xlsxPath);
  parentPort.on('message',job=>{
    let reply;
    try {
      const bytes=Buffer.from(job.bytes.buffer,job.bytes.byteOffset,job.bytes.byteLength); job.bytes=null;
      const wb=XLSX.read(bytes,{type:'buffer',cellDates:false,dense:true,cellText:false,cellNF:false,cellHTML:false,cellStyles:false,...(job.sheetName?{sheets:[job.sheetName],sheetRows:w.limits.rows+1}:{sheetRows:12})});
      if(wb.SheetNames.length>w.limits.sheets) throw Error('Workbook sheet limit exceeded');
      if(job.chunk){
        const ws=wb.Sheets[job.sheetName]; if(!ws) throw Error('Source sheet missing');
        const [ds,de,lo,hi,cs,ce]=job.chunk.guard;
        // Exactness guard: a chunk may only hold cells inside its own row slice.
        for(let R=ds;R<=de&&R<ws.length;R++){
          if(R>=lo&&R<=hi){R=hi;continue;}
          const row=ws[R]; if(row) for(let C=cs;C<=ce;C++) if(row[C]!=null) throw Error('CHUNK_BOUNDARY');
        }
        reply={rows:job.chunk.range?XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:'',range:job.chunk.range}):[]};
      } else {
        const out=[];
        for(const name of wb.SheetNames){
          const ws=wb.Sheets[name]; if(!ws) continue;
          const range=XLSX.utils.decode_range(ws['!fullref']||ws['!ref']||'A1');
          if(range.e.r>=w.limits.rows||range.e.c>=w.limits.columns) throw Error('Worksheet row/column safety limit exceeded');
          out.push({name,rows:XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:''})});
        }
        reply={out};
      }
    }catch(e){reply={error:e.message}}
    parentPort.postMessage(reply);
  });
`;
type ParserJob = { bytes: Buffer; sheetName?: string; chunk?: { range: { s: { r: number; c: number }; e: { r: number; c: number } } | null; guard: number[] } };
type ParserReply = { out?: Array<{ name: string; rows: unknown[][] }>; rows?: unknown[][]; error?: string };
type Parser = { run(job: ParserJob, timeoutMs: number): Promise<ParserReply>; close(): Promise<void> };
/**
 * Oct 25 — the parser runs in a short-lived CHILD PROCESS by default. Measured
 * under the 512 MiB envelope: worker threads share the server's allocator, and
 * glibc keeps each finished worker's native memory (≈270 MiB non-heap retained
 * at heapTotal 127 MiB), so a large sheet could still push the container over
 * its limit nondeterministically. A child process returns every byte to the
 * OS when it exits, and its allocator can be tuned here (the server's own
 * start command cannot). Same script, same options, same rows. If the
 * platform refuses to spawn, the worker thread remains the fallback.
 */
const PROCESS_SCRIPT = WORKER_SCRIPT
  .replace("const {parentPort,workerData:w}=require('node:worker_threads');", "const w=JSON.parse(process.env.WW_PARSER);const parentPort={on:(e,f)=>process.on(e,f),postMessage:(m)=>process.send(m)};process.on('disconnect',()=>process.exit(0));");
let processParserUnavailable = process.env.XLSX_PARSER === "worker";
function openProcessParser(): Parser {
  const child = spawn(process.execPath, [`--max-old-space-size=${parserHeapMb()}`, "--max-semi-space-size=8", "-e", PROCESS_SCRIPT], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production", MALLOC_ARENA_MAX: "2", WW_PARSER: JSON.stringify({ xlsxPath, limits: WORKBOOK_LIMITS }) },
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-4000); });
  let pending: { resolve: (m: ParserReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  let dead: Error | null = null;
  let timedOut = 0;
  // Oct 25: a child that runs out of heap while the parent is still sending it
  // a large sheet makes the send fail with EPIPE *before* it exits. Transport
  // errors are therefore recorded and the outcome is decided only on "close"
  // (after stderr is fully read), so heap exhaustion is always reported as the
  // plain per-sheet message, never "write EPIPE".
  let transportError: Error | null = null;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stop = async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  };
  const fail = (e: Error) => {
    if (dead) return; dead = e;
    const p = pending; pending = null;
    if (p) clearTimeout(p.timer);
    void stop().finally(() => p?.reject(e));
  };
  const transport = (e: Error) => {
    transportError ??= e;
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  };
  child.on("message", (m: ParserReply) => {
    const p = pending; pending = null; if (!p) return; clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
  });
  child.on("error", (e) => {
    if ((e as NodeJS.ErrnoException).syscall?.startsWith("spawn")) { processParserUnavailable = true; return fail(e); }
    transport(e);
  });
  child.on("close", (code, signal) => {
    if (timedOut) return fail(new Error(`Workbook parser exceeded ${timedOut} ms; worker terminated`));
    // V8 heap exhaustion inside the parser is a per-sheet size problem, never a container crash.
    if (/heap limit|heap out of memory|Allocation failed/i.test(stderr)) return fail(new Error(SHEET_TOO_LARGE_MESSAGE));
    if (transportError) return fail(transportError);
    fail(new Error(`Workbook parser exited (${code ?? signal})`));
  });
  return {
    run(job, timeoutMs) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => { timedOut = timeoutMs; child.kill("SIGKILL"); }, timeoutMs) };
        child.send(job, (err) => { if (err) transport(err); });
      });
    },
    async close() { if (!dead) dead = new Error("Workbook parser closed"); if (child.connected) child.disconnect(); await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]); await stop(); },
  };
}
const isSpawnError = (e: unknown) => typeof (e as NodeJS.ErrnoException)?.syscall === "string" && (e as NodeJS.ErrnoException).syscall!.startsWith("spawn");
/** Child-process parser; if the platform refuses to spawn, this call (and later ones) use the worker thread. */
function openAnyParser(original: Buffer): Parser {
  if (processParserUnavailable) return openParser(original);
  let inner: Parser;
  try { inner = openProcessParser(); }
  catch (e) { processParserUnavailable = true; console.warn("[hardening] child-process parser unavailable; using worker thread", e instanceof Error ? e.message : e); return openParser(original); }
  let switched = false;
  return {
    async run(job, timeoutMs) {
      try { return await inner.run(job, timeoutMs); }
      catch (e) {
        if (switched || !isSpawnError(e)) throw e;
        switched = true; processParserUnavailable = true;
        console.warn("[hardening] child-process parser unavailable; using worker thread", (e as Error).message);
        await inner.close().catch(() => {});
        inner = openParser(original);
        return inner.run(job, timeoutMs);
      }
    },
    close: () => inner.close(),
  };
}
/** One worker for a whole parse call (all chunks of one sheet), terminated at the end. */
function openParser(original: Buffer): Parser {
  const worker = new Worker(WORKER_SCRIPT, { eval: true, workerData: { xlsxPath, limits: WORKBOOK_LIMITS }, resourceLimits: { maxOldGenerationSizeMb: parserHeapMb(), maxYoungGenerationSizeMb: 16 } });
  let pending: { resolve: (m: ParserReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  let dead: Error | null = null;
  let exited: Promise<number> | null = null;
  const stop = () => (exited ??= worker.terminate());
  const fail = (e: Error) => {
    if (dead) return; dead = e;
    const p = pending; pending = null;
    if (p) clearTimeout(p.timer);
    void stop().finally(() => p?.reject(e));
  };
  worker.on("message", (m: ParserReply) => {
    const p = pending; pending = null; if (!p) return; clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
  });
  worker.on("error", (e) => fail((e as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error(SHEET_TOO_LARGE_MESSAGE) : e));
  worker.on("exit", (code) => fail(new Error(`Workbook parser exited (${code})`)));
  return {
    run(job: ParserJob, timeoutMs: number): Promise<ParserReply> {
      if (dead) return Promise.reject(dead);
      const b = job.bytes;
      // Hand freshly built subsets to the worker without a copy; never detach the caller's buffer.
      const transfer = b !== original && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? [b.buffer as ArrayBuffer] : [];
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail(new Error(`Workbook parser exceeded ${timeoutMs} ms; worker terminated`)), timeoutMs) };
        worker.postMessage(job, transfer);
      });
    },
    async close() { if (!dead) dead = new Error("Workbook parser closed"); await stop(); },
  };
}
const colIndex = (s: string) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
function decodeDimension(ref: string) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  const d = { s: { r: Number(m[2]) - 1, c: colIndex(m[1]) }, e: { r: Number(m[4]) - 1, c: colIndex(m[3]) } };
  return d.s.r <= d.e.r && d.s.c <= d.e.c && d.s.r >= 0 && d.s.c >= 0 ? d : null;
}
class ChunkBoundary extends Error {}
/** Parse one large worksheet chunk by chunk; rows are identical to a one-pass read. */
async function parseSheetChunked(parser: Parser, plan: Extract<ReturnType<typeof planSheetChunks>, { kind: "chunked" }>, sheetName: string, timeoutMs: number) {
  const dim = decodeDimension(plan.dimension);
  if (!dim) throw new ChunkBoundary("dimension");
  // Same admission rule the one-pass read applies to the declared range.
  if (dim.e.r >= WORKBOOK_LIMITS.rows || dim.e.c >= WORKBOOK_LIMITS.columns) throw new Error("Worksheet row/column safety limit exceeded");
  const rows: unknown[][] = [];
  for (let k = 0; k < plan.chunks; k++) {
    // Each chunk builds a few MiB of subset bytes and returns its rows; collect
    // between chunks so a 6-chunk sheet never stacks every chunk's garbage.
    reclaimMemory(0);
    const lo = Math.max(k === 0 ? dim.s.r : plan.firstRows[k]!, dim.s.r);
    const hi = Math.min(k === plan.chunks - 1 ? dim.e.r : plan.firstRows[k + 1]! - 1, dim.e.r);
    const range = lo <= hi ? { s: { r: lo, c: dim.s.c }, e: { r: hi, c: dim.e.c } } : null;
    let reply: ParserReply;
    try { reply = await parser.run({ bytes: plan.build(k), sheetName, chunk: { range, guard: [dim.s.r, dim.e.r, lo, hi, dim.s.c, dim.e.c] } }, timeoutMs); }
    catch (e) { if (e instanceof Error && e.message === "CHUNK_BOUNDARY") throw new ChunkBoundary("rows out of order"); throw e; }
    for (const r of reply.rows ?? []) rows.push(r);
  }
  return [{ name: sheetName, rows }];
}
let parsing = false;
const parserQueue: Array<() => void> = [];
export async function parseWorkbookInWorker(buf: Buffer, sheetName?: string, timeoutMs = 45_000): Promise<Array<{ name: string; rows: unknown[][] }>> {
  preflightWorkbookZip(buf);
  if (parsing) {
    if (parserQueue.length >= 4) throw new Error("Workbook parser is busy; retry staging shortly");
    await new Promise<void>(resolve => parserQueue.push(resolve));
  } else parsing = true;
  const parser = openAnyParser(buf);
  try {
    // Oct 25: SheetJS inflates every zip member up front. Hand the worker a
    // bounded subset (header rows only, or the one requested sheet) so a large
    // utility workbook never exceeds the 512 MiB production container. Built
    // inside the single parser slot so concurrent requests cannot stack it.
    const onePass = async () => (await parser.run({ bytes: boundedWorkbookInput(buf, sheetName ? { mode: "full", sheetName } : { mode: "header" }), sheetName }, timeoutMs)).out ?? [];
    if (!sheetName || !isZip(buf)) return await onePass();
    let plan: ReturnType<typeof planSheetChunks>;
    // Structure the planner cannot read keeps the previous behavior (subset or small-workbook fallback, else its error).
    try { plan = planSheetChunks(buf, sheetName, { singlePassBytes: SHEET_LIMITS.singlePassBytes(), targetBytes: SHEET_LIMITS.chunkBytes(), maxXmlBytes: SHEET_LIMITS.maxXmlBytes }); }
    catch { return await onePass(); }
    if (plan.kind === "single") return await onePass();
    const unchunkable = () => { if (plan.xmlBytes <= SHEET_LIMITS.unchunkableSinglePassMax) return onePass(); throw new Error(SHEET_TOO_LARGE_MESSAGE); };
    if (plan.kind === "unsupported") return await unchunkable();
    try { return await parseSheetChunked(parser, plan, sheetName, timeoutMs); }
    catch (e) { if (e instanceof ChunkBoundary) return await unchunkable(); throw e; }
  } finally {
    await parser.close();
    const next = parserQueue.shift(); if (next) next(); else parsing = false;
  }
}
