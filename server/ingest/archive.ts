/**
 * Zip-archive ingestion support (ING-2/ING-3, owner report Jul 19).
 *
 * Utility Green Button portals ship interval data as .zip bundles — typically
 * an (often extensionless) ESPI Atom XML file plus a companion
 * GreenButtonDataStyleSheet.xslt. Users also batch multiple CSV/XLSX exports
 * into one archive. This module safely extracts data-bearing members so each
 * flows through the existing gate + parser pipeline:
 *
 * - unzipSync (fflate) — pure JS, no external binaries (works on Autoscale).
 * - Zip-bomb protection: member count cap, per-member and total decompressed
 *   byte caps enforced with a filter BEFORE inflation.
 * - Non-data members (stylesheets, manifests, hidden/OS metadata) are skipped
 *   and reported — never a hard failure.
 * - Extensionless members (e.g. "HourlyIntervalData") are routed by CONTENT
 *   (magic bytes) rather than filename.
 */
import { unzipSync } from "fflate";
import { MAX_UPLOAD_BYTES } from "../../shared/wattwise";
import { detectMagicBytes, type DetectedType } from "./hardening";

export const MAX_ZIP_MEMBERS = 200;

export interface ZipMember {
  /** member path inside the archive (directories stripped for display) */
  name: string;
  bytes: Buffer;
  /** content-detected type (magic bytes — never trusts the extension) */
  detected: DetectedType;
  /** parser family the member routes to, or null when skipped */
  route: "xlsx" | "csv" | "espi_xml" | null;
  /** human-readable reason when route === null */
  skipReason?: string;
}

export interface ZipExtraction {
  ok: boolean;
  reason?: string;
  members: ZipMember[];
}

/** Members that are never interval data, matched case-insensitively on the
 * basename. XSLT/XSL stylesheets ship with virtually every Green Button
 * export; the rest are OS/build metadata commonly found in user archives. */
const NON_DATA_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\.(xslt|xsl)$/i, reason: "stylesheet (presentation only — contains no readings)" },
  { re: /\.(css|js|html?|txt|md|json|pdf)$/i, reason: "non-interval document" },
  { re: /\.(png|jpe?g|gif|svg|ico)$/i, reason: "image" },
  { re: /^(\.ds_store|thumbs\.db|desktop\.ini)$/i, reason: "OS metadata" },
];

function classifyMember(name: string, bytes: Buffer): { route: ZipMember["route"]; detected: DetectedType; skipReason?: string } {
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".") || name.includes("__MACOSX/")) {
    return { route: null, detected: "unknown", skipReason: "hidden/OS metadata" };
  }
  for (const p of NON_DATA_PATTERNS) {
    if (p.re.test(base)) return { route: null, detected: "unknown", skipReason: p.reason };
  }
  // Route by CONTENT — extensionless Green Button XML members are the norm.
  const detected = detectMagicBytes(bytes);
  if (detected === "xlsx" || detected === "xls") return { route: "xlsx", detected };
  if (detected === "xml") return { route: "espi_xml", detected };
  if (detected === "csv_text") {
    // A printable-text member that is actually XML missing its declaration
    // (some utilities strip <?xml?>) — sniff for an Atom/ESPI root.
    const head = bytes.slice(0, 2048).toString("utf8").trimStart();
    if (head.startsWith("<")) return { route: "espi_xml", detected: "xml" };
    return { route: "csv", detected };
  }
  if (detected === "zip") return { route: null, detected, skipReason: "nested archive (not supported — extract and upload its files directly)" };
  return { route: null, detected, skipReason: `unrecognized content (${detected})` };
}

/** Extract data-bearing members from a zip upload. Never throws for content
 * issues — returns ok:false with a reason for structural problems only. */
export function extractZipMembers(buf: Buffer): ZipExtraction {
  let raw: Record<string, Uint8Array>;
  let total = 0;
  let memberCount = 0;
  try {
    raw = unzipSync(new Uint8Array(buf), {
      filter: (file) => {
        memberCount++;
        if (memberCount > MAX_ZIP_MEMBERS) throw new Error(`Archive has too many members (limit ${MAX_ZIP_MEMBERS})`);
        if (file.originalSize > MAX_UPLOAD_BYTES) throw new Error(`Archive member "${file.name}" exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
        total += file.originalSize;
        if (total > MAX_UPLOAD_BYTES * 2) throw new Error("Archive decompresses beyond the safety limit");
        // skip directory entries
        return !file.name.endsWith("/");
      },
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not read the zip archive", members: [] };
  }
  const members: ZipMember[] = [];
  for (const [name, data] of Object.entries(raw)) {
    const bytes = Buffer.from(data);
    if (bytes.length === 0) continue;
    const cls = classifyMember(name, bytes);
    members.push({ name, bytes, detected: cls.detected, route: cls.route, skipReason: cls.skipReason });
  }
  if (members.length === 0) return { ok: false, reason: "The archive contains no files", members: [] };
  return { ok: true, members };
}
