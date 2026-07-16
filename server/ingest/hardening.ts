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

export type DetectedType = "xlsx" | "xls" | "csv_text" | "xml" | "pdf" | "png" | "jpeg" | "zip_unknown" | "unknown";

export function detectMagicBytes(buf: Buffer): DetectedType {
  if (buf.length >= 4) {
    // ZIP container (xlsx is a zip)
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return "xlsx";
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

/** Gate (d): scrub spreadsheet formula-injection prefixes from string cells. */
export function scrubCell(value: string): string {
  if (typeof value !== "string") return value;
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return "'" + value;
  }
  return value;
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
