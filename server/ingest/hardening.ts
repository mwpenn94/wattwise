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
