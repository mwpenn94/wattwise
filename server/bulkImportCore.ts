/**
 * BULK-1 (Oct 2026) — pure, DB-free core of the multi-file / multi-sheet bulk
 * setup flow. Everything here is deterministic and unit-tested
 * (server/bulkImport.test.ts); the DB/S3 orchestration lives in bulkImport.ts.
 *
 * Relationship model (dynamic, many-to-many-ready):
 *   owner (user) → entity (district/company, optional) → site (physical
 *   premise / campus) → meter (one per worksheet = one utility service
 *   agreement / service point) → intervals.
 * Files are only TRANSPORT: a district can split its sheets across any number
 * of workbooks, in any order, and the same campus can appear in several files.
 * Grouping is by normalized physical address, never by file.
 */
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { scrubCell } from "./ingest/hardening";

/* ---------------- worksheet header metadata ---------------- */
export interface SheetHeaderMeta {
  sheetName: string;
  accountNumber: string | null;
  serviceAgreementId: string | null;
  servicePointId: string | null;
  rateScheduleCode: string | null;
  addressRaw: string | null;
  /** best-effort: does the sheet look like an interval table at all? */
  looksLikeIntervals: boolean;
}

const LABELS: Array<{ key: keyof Omit<SheetHeaderMeta, "sheetName" | "looksLikeIntervals">; re: RegExp }> = [
  { key: "accountNumber", re: /^acc(?:oun)?t\.?\s*(?:number|no\.?|#)?$/i },
  { key: "serviceAgreementId", re: /^service\s*agreement\s*(?:id|number|no\.?|#)?$/i },
  { key: "servicePointId", re: /^service\s*point\s*(?:id|number|no\.?|#)?$/i },
  { key: "rateScheduleCode", re: /^rate(?:\s*schedule|\s*code|\s*class)?$/i },
  { key: "addressRaw", re: /^(?:service\s*)?address$|^premise\s*address$|^location$/i },
];

function cellText(v: unknown): string {
  if (v == null) return "";
  return scrubCell(String(v)).replace(/\s+/g, " ").trim();
}

/** Excel escapes control chars in sheet names as _x0009_ (TAB) etc. */
export function cleanSheetName(name: string): string {
  return name.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex) => {
    const code = parseInt(hex, 16);
    return code < 32 ? "" : String.fromCharCode(code);
  }).trim();
}

/**
 * Extract label/value metadata from the top-of-sheet block. Utility exports
 * (UNS/MyMeter style) put labels in column A and values a few columns right;
 * we take the first non-empty cell to the right of a recognized label.
 */
export function extractSheetHeaderMeta(sheetName: string, rows: unknown[][]): SheetHeaderMeta {
  const meta: SheetHeaderMeta = {
    sheetName,
    accountNumber: null,
    serviceAgreementId: null,
    servicePointId: null,
    rateScheduleCode: null,
    addressRaw: null,
    looksLikeIntervals: false,
  };
  const scan = rows.slice(0, 12);
  for (const row of scan) {
    if (!Array.isArray(row)) continue;
    const cells = row.map(cellText);
    const labelIdx = cells.findIndex((c) => c.length > 0);
    if (labelIdx < 0) continue;
    const label = cells[labelIdx].replace(/[:：]\s*$/, "").trim();
    const hit = LABELS.find((l) => l.re.test(label));
    if (hit && meta[hit.key] == null) {
      const value = cells.slice(labelIdx + 1).find((c) => c.length > 0) ?? null;
      if (value) meta[hit.key] = value;
    }
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.some((c) => /^date/.test(c)) && lower.some((c) => /kwh|usage|therm|gal|kw$/.test(c))) {
      meta.looksLikeIntervals = true;
    }
  }
  return meta;
}

/** Header-only read: bounded rows per sheet (benchmarked ~3 s for a 19 MB, 20-sheet workbook). */
export function readWorkbookHeaders(buf: Buffer, headerRows = 8): SheetHeaderMeta[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, sheetRows: headerRows });
  const out: SheetHeaderMeta[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    out.push(extractSheetHeaderMeta(name, rows));
  }
  return out;
}

/* ---------------- address normalization + campus grouping ---------------- */
const SUFFIX: Record<string, string> = {
  street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", road: "rd", rd: "rd", drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd", lane: "ln", ln: "ln", court: "ct", ct: "ct", place: "pl", pl: "pl",
  highway: "hwy", hwy: "hwy", parkway: "pkwy", pkwy: "pkwy", way: "way", circle: "cir", cir: "cir", terrace: "ter", ter: "ter",
};
const DIR: Record<string, string> = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w", ne: "ne", nw: "nw", se: "se", sw: "sw" };

export interface ParsedServiceAddress {
  /** street line without unit/facility descriptors, e.g. "4182 N Bank St" */
  street: string | null;
  /** facility/unit descriptors, e.g. ["Unit C"], ["Pump Station"], ["1"] */
  descriptors: string[];
  city: string | null;
  state: string | null;
  zip: string | null;
  /** true when the street line starts with a house number */
  hasStreetNumber: boolean;
  /** normalized campus key: "4182 n bank st|kingman" */
  campusKey: string;
  /** normalized building key: campus key + descriptors */
  buildingKey: string;
}

function normToken(t: string): string {
  const x = t.toLowerCase().replace(/[.,]/g, "");
  return SUFFIX[x] ?? DIR[x] ?? x;
}
function normStreet(s: string): string {
  return s.split(/\s+/).filter(Boolean).map(normToken).join(" ");
}
const STATE_RE = /^([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/;

/**
 * Parse "4182 N Bank St, Unit C, Kingman" / "16500 N Pierce Ferry Rd, 1, Dolan
 * Springs" / "500 Maple St, Kingman, AZ 86401". Convention for utility exports:
 * FIRST comma part = street, LAST non-state part = city, everything between =
 * facility/unit descriptors (meter metadata — never separate sites).
 */
export function parseServiceAddress(raw: string | null | undefined): ParsedServiceAddress {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  let state: string | null = null;
  let zip: string | null = null;
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const m = last.match(STATE_RE);
    if (m) {
      state = m[1].toUpperCase();
      zip = m[2] ?? null;
      parts.pop();
    } else {
      const zm = last.match(/^(.*?)(?:\s+([A-Za-z]{2}))\s+(\d{5})(?:-\d{4})?$/);
      if (zm) {
        parts[parts.length - 1] = zm[1].trim();
        state = zm[2].toUpperCase();
        zip = zm[3];
      }
    }
  }
  const street = parts[0] ?? null;
  const city = parts.length >= 2 ? parts[parts.length - 1] : null;
  const descriptors = parts.length >= 3 ? parts.slice(1, -1) : [];
  const hasStreetNumber = street != null && /^\d+[A-Za-z]?\b/.test(street);
  const cityKey = (city ?? "").toLowerCase().trim();
  const streetKey = street ? normStreet(street) : "";
  const campusKey = `${streetKey}|${cityKey}|${state ?? "?"}|US`;
  const buildingKey = descriptors.length > 0 ? `${campusKey}|${descriptors.map((d) => d.toLowerCase()).join("|")}` : campusKey;
  return { street, descriptors, city, state, zip, hasStreetNumber, campusKey, buildingKey };
}

export type GroupingMode = "campus" | "building";

export interface PlanSheetInput {
  sheetId: number; // import_batch_sheets.id
  fileId: number;
  sheetName: string;
  addressRaw: string | null;
  servicePointId: string | null;
  serviceAgreementId: string | null;
  rateScheduleCode: string | null;
  overrideSiteId?: number | null;
  overrideGroupKey?: string | null;
}

export interface PlanGroup {
  groupKey: string;
  siteName: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** address string used for geocoding/site creation */
  address: string;
  sheetIds: number[];
  fileIds: number[];
  /** facility labels per sheet (meter metadata) */
  facilities: Record<number, string | null>;
  needsReview: string[];
  existingSiteId: number | null;
}

/** Facility label for a meter: descriptors, else the service point. */
export function facilityLabelFor(addr: ParsedServiceAddress, servicePointId: string | null): string | null {
  if (addr.descriptors.length > 0) {
    const d = addr.descriptors.join(" · ");
    return /^\d+$/.test(d) ? `Service ${d}` : d;
  }
  return servicePointId ? `Service point ${servicePointId}` : null;
}

/** Title-case-ish site display name from the street + city. */
export function siteNameFor(addr: ParsedServiceAddress, fallback: string): string {
  if (!addr.street) return fallback;
  const street = prettyCase(addr.street);
  return addr.city ? `${street}, ${prettyCase(addr.city)}` : street;
}

/** "3700 PROSPECTOR ST" → "3700 Prospector St"; mixed-case input is left alone. */
export function prettyCase(s: string): string {
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (/^(n|s|e|w|ne|nw|se|sw)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Build the site plan across ALL staged files. Sheets with an override go to
 * that site; otherwise grouped by campus (default) or building key. Addresses
 * without a street number cannot be grouped safely: they stay their own site
 * and are flagged for review (never silently merged).
 */
export function buildSitePlan(sheets: PlanSheetInput[], mode: GroupingMode): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const s of sheets) {
    const addr = parseServiceAddress(s.addressRaw);
    let key: string;
    const review: string[] = [];
    if (s.overrideSiteId != null) {
      key = `site:${s.overrideSiteId}`;
    } else if (s.overrideGroupKey) {
      key = s.overrideGroupKey;
    } else if (!addr.street) {
      key = `sheet:${s.fileId}:${s.sheetName}`;
      review.push("No service address in the sheet header — assign a site.");
    } else if (!addr.hasStreetNumber) {
      key = `nonum:${addr.buildingKey}:${meterIdentityKey(s)}`;
      review.push(`"${s.addressRaw?.trim()}" has no street number — kept as its own site; merge it into the right campus if needed.`);
    } else {
      key = mode === "campus" ? addr.campusKey : addr.buildingKey;
    }
    let g = groups.get(key);
    if (!g) {
      const displayAddr = mode === "building" && addr.descriptors.length > 0 && addr.street
        ? `${addr.street}, ${addr.descriptors.join(", ")}${addr.city ? `, ${addr.city}` : ""}`
        : null;
      g = {
        groupKey: key,
        siteName: displayAddr ?? siteNameFor(addr, cleanSheetName(s.sheetName)),
        street: addr.street,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        address: [addr.street, ...(mode === "building" ? addr.descriptors : []), addr.city, addr.state].filter(Boolean).join(", ") + (addr.zip ? ` ${addr.zip}` : ""),
        sheetIds: [],
        fileIds: [],
        facilities: {},
        needsReview: [],
        existingSiteId: s.overrideSiteId ?? null,
      };
      groups.set(key, g);
    }
    g.sheetIds.push(s.sheetId);
    if (!g.fileIds.includes(s.fileId)) g.fileIds.push(s.fileId);
    g.facilities[s.sheetId] = facilityLabelFor(addr, s.servicePointId);
    for (const r of review) if (!g.needsReview.includes(r)) g.needsReview.push(r);
  }
  // duplicate service point within the batch → flag (second copy is skipped at commit)
  const seenSp = new Map<string, number>();
  for (const s of sheets) {
    if (!s.servicePointId) continue;
    const prev = seenSp.get(s.servicePointId);
    if (prev != null) {
      for (const g of Array.from(groups.values())) {
        if (g.sheetIds.includes(s.sheetId)) {
          const note = `Service point ${s.servicePointId} appears in more than one sheet — copies merge only when their destination agrees; conflicting destinations are rejected.`;
          if (!g.needsReview.includes(note)) g.needsReview.push(note);
        }
      }
    } else seenSp.set(s.servicePointId, s.sheetId);
  }
  return Array.from(groups.values()).sort((a, b) => a.siteName.localeCompare(b.siteName));
}

/** Read exactly one worksheet's rows (bounded memory: ~2.4 s / ~360 MB for a 35k-row sheet). */
export function readSingleSheetRows(buf: Buffer, sheetName: string): unknown[][] | null {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, sheets: [sheetName] });
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
}

/** Stable meter identity across files/re-imports. */
export function meterIdentityKey(meta: { servicePointId: string | null; serviceAgreementId: string | null; sheetName: string }): string {
  const raw = meta.servicePointId?.trim() ? `sp:${meta.servicePointId.trim()}` : meta.serviceAgreementId?.trim() ? `sa:${meta.serviceAgreementId.trim()}` : null;
  if (!raw) throw new Error("Missing durable meter identity: a service point or service agreement is required. Add the identifier to the source header before importing.");
  return raw.length <= 191 ? raw : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}
