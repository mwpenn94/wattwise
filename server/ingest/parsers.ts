/**
 * Interval file parsers — Excel (multi-sheet, BUILD-010.3 semantics),
 * CSV (BUILD-010.3 parseCSV), ESPI Green Button XML.
 * Every parser emits ParsedMeterSeries[] in canonical form; validation
 * compares ingested sums against the workbook's own Total=/Max= footers.
 */
import * as XLSX from "xlsx";
import { boundedWorkbookInput, workbookSheetNames } from "./xlsxSubset";
import { XMLParser } from "fast-xml-parser";
import {
  Row,
  airIsSummaryRow,
  airIsBlankRow,
  findHeader,
  numberValue,
  parseCSV,
  rowsToFile,
  type ParsedTable,
} from "../../shared/build0103";
import { rejectXxe, scrubCell } from "./hardening";
import { inferColumns } from "./columnInference";
import { heapGuard } from "./memory";

export const PARSER_VERSION = "BUILD-010.3-clock2";

export interface ParsedMeterSeries {
  /** sheet name or channel identifier — one meter per sheet/UsagePoint */
  sourceKey: string;
  commodity: "electric" | "gas" | "water";
  usageUnit: string;
  demandUnit: string | null;
  points: Array<{ ts: number; durationMin: number; usage: number; demand: number | null }>;
  /** workbook footer totals for validation (D2 rows are excluded from data but retained) */
  footerTotals: { totalUsage?: number; maxDemand?: number; raw: string[] };
  validation: {
    ingestedUsageSum: number;
    ingestedMaxDemand: number | null;
    footerUsageDelta?: number;
    footerUsageDeltaPct?: number;
    footerMaxDelta?: number;
    pass: boolean;
    notes: string[];
  };
  headerRowIndex: number;
  rowsIngested: number;
  rowsSkipped: number;
  /** The start/end convention actually applied (detected when the clock asked for detection). */
  timestampBasis?: "start" | "end";
}

/* ---------------- footer extraction ---------------- */
function extractFooterTotals(summaryRows: string[]): { totalUsage?: number; maxDemand?: number; raw: string[] } {
  const out: { totalUsage?: number; maxDemand?: number; raw: string[] } = { raw: summaryRows };
  for (const s of summaryRows) {
    const tm = s.match(/total\s*=?\s*([\d,]+\.?\d*)/i);
    if (tm && out.totalUsage === undefined) out.totalUsage = parseFloat(tm[1].replace(/,/g, ""));
    const mm = s.match(/max\s*=?\s*([\d,]+\.?\d*)/i);
    if (mm && out.maxDemand === undefined) out.maxDemand = parseFloat(mm[1].replace(/,/g, ""));
  }
  return out;
}

/* ---------------- time parsing ---------------- */
export interface IntervalClock {
  timeZone: string;
  /** Applied as-is, or the fallback when `detectBasis` cannot decide. */
  timestampBasis: "start" | "end";
  ambiguousTime?: "reject";
  /**
   * Oct 25 (cost audit): detect the start/end convention from the readings
   * themselves. A wrong default turned an end-labeled year into a 13th billing
   * month, so detection is the default for new uploads.
   */
  detectBasis?: boolean;
}
/**
 * Decide whether timestamps label interval STARTS or ENDS from the data's
 * edges: a day-aligned export labeled by interval end begins at 00:<len> and
 * ends at 00:00 (e.g. 00:15 … 00:00); one labeled by start begins at 00:00
 * and ends at 24:00 minus one interval (00:00 … 23:45). Returns null when the
 * edges do not clearly match either pattern.
 */
export function detectTimestampBasis(firstLabelTs: number, lastLabelTs: number, durationMin: number, zone: string): "start" | "end" | null {
  if (!(durationMin > 0) || durationMin >= 1440 || 1440 % durationMin !== 0) return null;
  const minuteOfDay = (ts: number) => Math.round((((wallAt(ts, zone) % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  const first = minuteOfDay(firstLabelTs), last = minuteOfDay(lastLabelTs);
  const end = Number(first === durationMin) + Number(last === 0);
  const start = Number(first === 0) + Number(last === 1440 - durationMin);
  if (end > start) return "end";
  if (start > end) return "start";
  return null;
}
// Legacy pure-parser callers have a deterministic UTC default. All ingestion
// entry points supply the confirmed/source or existing-meter clock explicitly.
const DEFAULT_CLOCK: IntervalClock = { timeZone: "UTC", timestampBasis: "start", ambiguousTime: "reject" };
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneDayOffsets = new Map<string, number[]>();
function formatter(zone: string) {
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    if (zoneFormatters.size >= 128) zoneFormatters.clear();
    zoneFormatters.set(zone, f);
  }
  return f;
}
function wallAt(ts: number, zone: string) {
  const p = Object.fromEntries(formatter(zone).formatToParts(ts).map(p => [p.type, p.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
/** Intl uses the runtime's IANA tzdata, never the host default timezone.
 * Enumerate the offsets surrounding the civil day and validate every candidate:
 * zero matches = spring gap; two matches = fall fold. Both fail closed. */
function civilToInstant(wall: number, zone: string): number {
  const day = Math.floor(wall / 86_400_000);
  const key = `${zone}:${day}`;
  let offsets = zoneDayOffsets.get(key);
  if (!offsets) {
    offsets = Array.from(new Set([-36, -24, -12, 0, 12, 24, 36].map(h => {
      const t = day * 86_400_000 + h * 3_600_000;
      return wallAt(t, zone) - t;
    })));
    if (zoneDayOffsets.size > 4096) zoneDayOffsets.clear();
    zoneDayOffsets.set(key, offsets);
  }
  const ms = ((wall % 1000) + 1000) % 1000;
  const candidates = offsets.map(o => wall - o).filter(t => wallAt(t, zone) + ms === wall);
  if (candidates.length !== 1) throw new Error(`${candidates.length ? "Ambiguous" : "Nonexistent"} DST wall-clock time ${new Date(wall).toISOString()} in ${zone}; supply explicit UTC offsets.`);
  return candidates[0];
}
/** Parse compact dates, Excel serials, US/ISO civil strings and explicit ISO
 * offsets. 24:00 rolls into the next civil day before timezone resolution. */
export function parseIntervalInstant(dateCell: unknown, timeCell: unknown, clock: IntervalClock = DEFAULT_CLOCK): number | null {
  if (dateCell == null || dateCell === "") return null;
  formatter(clock.timeZone); // validate even an offset-only source's metadata
  if (dateCell instanceof Date) return Number.isFinite(dateCell.getTime()) ? dateCell.getTime() : null;
  const raw = String(dateCell).trim();
  const explicit = /[T ]\d{1,2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (explicit) { const t = Date.parse(raw); return Number.isFinite(t) ? t : null; }
  let y: number, mo: number, d: number, hh = 0, mm = 0, ss = 0, ms = 0;
  let tail = "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](.*))?$/);
  const us = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(.*))?$/);
  if (compact || iso) { const m = (compact ?? iso)!; y = +m[1]; mo = +m[2]; d = +m[3]; tail = m[4] ?? ""; }
  else if (us) { y = +us[3]; mo = +us[1]; d = +us[2]; tail = us[4] ?? ""; }
  else if (typeof dateCell === "number" && dateCell > 0 && dateCell < 2958466) {
    const c = XLSX.SSF.parse_date_code(dateCell);
    if (!c) return null;
    y = c.y; mo = c.m; d = c.d; hh = c.H; mm = c.M; ss = c.S; ms = Math.round((c.u ?? 0) * 1000);
  } else return null;
  const day = Date.UTC(y, mo - 1, d);
  const check = new Date(day);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const time = timeCell != null && timeCell !== "" ? timeCell : tail;
  if (time !== "") {
    if (typeof time === "number" && time >= 0 && time <= 1) {
      const total = Math.round(time * 86_400_000); hh = Math.floor(total / 3_600_000); mm = Math.floor(total / 60_000) % 60; ss = Math.floor(total / 1000) % 60; ms = total % 1000;
    } else {
      const m = String(time).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*([ap]m)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i);
      if (!m) throw new Error(`Malformed interval time: ${String(time).slice(0, 80)}`);
      hh = +m[1]; mm = +m[2]; ss = +(m[3] ?? 0); ms = +(m[4] ?? "0").padEnd(3, "0");
      if (m[5]) { if (hh < 1 || hh > 12) throw new Error("Invalid 12-hour interval time"); hh = hh % 12 + (m[5].toLowerCase() === "pm" ? 12 : 0); }
      if (hh > 24 || mm > 59 || ss > 59 || (hh === 24 && (mm || ss || ms))) throw new Error("Invalid interval time (only 24:00 is a valid rollover)");
      if (m[6]) {
        const wall = new Date(day + hh * 3_600_000 + mm * 60_000 + ss * 1000 + ms).toISOString().replace(/Z$/, m[6]);
        const instant = Date.parse(wall); if (!Number.isFinite(instant)) throw new Error("Invalid explicit interval offset"); return instant;
      }
    }
  }
  return civilToInstant(day + hh * 3_600_000 + mm * 60_000 + ss * 1000 + ms, clock.timeZone);
}

/** Infer interval duration (minutes) from consecutive timestamps (mode). */
function inferDurationMin(tss: number[]): number {
  const diffs = new Map<number, number>();
  for (let i = 1; i < Math.min(tss.length, 500); i++) {
    const d = Math.round((tss[i] - tss[i - 1]) / 60000);
    if (d > 0 && d <= 24 * 60) diffs.set(d, (diffs.get(d) ?? 0) + 1);
  }
  let best = 15;
  let bestCount = 0;
  for (const [d, c] of Array.from(diffs.entries())) {
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/* ---------------- core table → series ---------------- */
/**
 * LGE-2: multi-series wrapper — when the table carries a per-meter column
 * (MyMeter multi-meter downloads interleave rows for several meters), split
 * rows by meter value and emit one series per meter. Otherwise delegate to
 * the single-series path unchanged.
 */
function tableToSeriesMulti(name: string, rows: Row[], clock: IntervalClock): ParsedMeterSeries[] {
  // Oct 25: the probe table IS the single-series table (same name, same rows),
  // so reuse it rather than building a second full copy — on a 175k-row sheet
  // each copy is ~80 MiB of heap inside a 512 MiB container.
  let probe: ParsedTable | null = rowsToFile(name, rows);
  const meterCol = findHeader(probe.headers, [/^meter\s*(#|number|id)?$/i], [/read/i]);
  if (meterCol) {
    const meterValues = new Set<string>();
    for (const r of probe.data) {
      const v = String(r[meterCol] ?? "").trim();
      if (v) meterValues.add(v);
    }
    if (meterValues.size > 1) {
      const out: ParsedMeterSeries[] = [];
      const headerRows = rows.slice(0, probe.headerRowIndex + 1);
      const meterIdx = probe.headers.indexOf(meterCol);
      const dataStart = probe.headerRowIndex + 1;
      probe = null; // per-meter subsets build their own tables
      for (const mv of Array.from(meterValues)) {
        const subset = [
          ...headerRows,
          ...rows.slice(dataStart).filter((r) => String(r?.[meterIdx] ?? "").trim() === mv),
        ];
        const s = tableToSeries(`${name} · meter ${mv}`, subset, clock);
        if (s) out.push(s);
      }
      if (out.length > 0) return out;
    }
  }
  const single = tableToSeries(name, rows, clock, probe ?? undefined);
  return single ? [single] : [];
}

function tableToSeries(name: string, rows: Row[], clock: IntervalClock, prebuilt?: ParsedTable): ParsedMeterSeries | null {
  const table = prebuilt ?? rowsToFile(name, rows);
  if (table.data.length < 3) return null;
  const headers = table.headers;

  // Column precedence (batch-15, pass 144): a combined datetime/timestamp column
  // (dtCol) always wins in the timestamp calculation below — dateCol is only the
  // date-only fallback (its exclusion list drops headers containing "time", so a
  // "DateTime" header cannot be picked as the date-only column). The trailing
  // `?? findHeader(datetime)` on dateCol only guarantees dateCol is non-null when
  // ONLY a datetime column exists; it never overrides dtCol's priority in the
  // row loop (`dtCol ? … : combineDateTime(…)`).
  const dateCol = findHeader(headers, [/^date$/i, /^date[^a-z]/i, /date/i], [/time/i]) ?? findHeader(headers, [/date.?time|timestamp/i]);
  // LGE-2 (owner report Jul 19 PM): utility portal CSVs (MyMeter platform —
  // LG&E/KU and others) name the single datetime column "Start", "Read Date",
  // or "End" with values like "03/30/2025 7:00:00 PM". Treat those as combined
  // datetime columns — but ONLY when the values actually carry a time component
  // (checked below), so a date-only "Read Date" monthly export still routes
  // through the date+time combiner.
  const dtCol =
    findHeader(headers, [/date.?time|timestamp/i]) ??
    findHeader(headers, [/^start$/i, /^read\s*date/i, /^start\s*date/i, /^end$/i, /^interval\s*start/i], [/direction/i]);
  const timeCol = findHeader(headers, [/^time$/i, /interval.?time|^end.?time|^start.?time/i], [/date/i]);
  const kwhCol = findHeader(headers, [/kwh/i], [/cost|charge|\$/i]);
  const kwCol = findHeader(headers, [/(^|[^a-z])kw([^a-z]|$)/i, /demand/i], [/kwh/i]);
  // Unit-named usage headers: MyMeter names the usage column after the UNIT
  // itself ("kWh", "CCF", "Mcf", "Therms", "Gallons", "HCF") — exact-match
  // these FIRST so a literal "$" cost column can never be picked as usage.
  const unitCol = findHeader(headers, [/^kwh$/i, /^ccf$/i, /^mcf$/i, /^therms?$/i, /^gallons?$/i, /^gal$/i, /^hcf$/i, /^cubic\s*feet$/i, /^m3$/i, /^wh$/i]);
  let usageCol =
    kwhCol ??
    unitCol ??
    findHeader(headers, [/usage|consumption|energy|therms?|ccf|mcf|gallons?|gal\b|hcf|volume|flow/i], [/cost|charge|\$|direction/i]);

  // MyMeter "Usage Direction" column: "Delivered" rows are consumption;
  // "Received" rows are export (net-metering) and must not be summed into
  // usage. Keep only Delivered (or blank) rows; count the rest as skipped.
  let directionCol = findHeader(headers, [/usage\s*direction|^direction$/i]);

  // INFER-1/2 (owner follow-up Jul 19 PM): header names vary wildly across
  // utility portals. When name-based matching leaves a required role (timestamp
  // or usage) unfilled, classify columns by VALUE SHAPE and fill the gaps.
  // Every structural inference is disclosed in validation notes (INFER-2), and
  // currency-shaped columns are hard-blocked from the usage role (INFER-3) —
  // even a header literally named "Usage" whose values are "$0.20" is cost.
  const inferenceNotes: string[] = [];
  let dtColFinal = dtCol;
  let dateColFinal = dateCol;
  let timeColFinal = timeCol;
  // A name-matched usage column whose values are NOT numeric (e.g. a "FLOW"
  // header holding Delivered/Received text) is a false positive — drop it so
  // structural inference can find the real usage column.
  if (usageCol) {
    const vals = table.data.slice(0, 50).map((r) => String(r[usageCol!] ?? "").trim()).filter(Boolean);
    const numericish = vals.filter((v) => /^-?[\d,]+(\.\d+)?$/.test(v.replace(/,/g, ""))).length;
    if (vals.length >= 3 && numericish < vals.length * 0.5) {
      inferenceNotes.push(`Column "${usageCol}" matched a usage-like name but its values are not numeric — not used as usage`);
      usageCol = null;
    }
  }
  if ((!usageCol && !kwCol) || (!dateColFinal && !dtColFinal)) {
    const inf = inferColumns(headers, table.data);
    if (!dtColFinal && !dateColFinal) {
      if (inf.dtCol) dtColFinal = inf.dtCol;
      else if (inf.dateCol) {
        dateColFinal = inf.dateCol;
        if (!timeColFinal && inf.timeCol) timeColFinal = inf.timeCol;
      }
    }
    if (!usageCol && !kwCol && inf.usageCol) usageCol = inf.usageCol;
    if (!directionCol && inf.directionCol) directionCol = inf.directionCol;
    inferenceNotes.push(...inf.disclosures);
  }
  // INFER-3 hard block: whatever path selected the usage column, currency-
  // shaped values must never be summed as consumption.
  if (usageCol) {
    const sampleVals = table.data.slice(0, 50).map((r) => String(r[usageCol!] ?? "").trim()).filter(Boolean);
    const currencyLike = sampleVals.filter((v) => /^-?\s*[$€£]/.test(v) || /^\(\s*[$€£]/.test(v)).length;
    if (sampleVals.length >= 3 && currencyLike >= sampleVals.length * 0.8) {
      inferenceNotes.push(`Column "${usageCol}" rejected as usage — values are currency-shaped (cost, not consumption)`);
      usageCol = null;
    }
  }

  if (!usageCol && !kwCol) return null;
  if (!dateColFinal && !dtColFinal) return null;

  let commodity: "electric" | "gas" | "water" = "electric";
  const headerBlob = headers.join(" ").toLowerCase();
  if (/therm|ccf|mcf|gas/.test(headerBlob)) commodity = "gas";
  else if (/gallon|gal\b|hcf|water/.test(headerBlob)) commodity = "water";
  // LGE-2: report the unit the file ACTUALLY carries — a CCF column must not
  // be silently relabeled therms (×1.037 error), nor HCF relabeled gallons
  // (×748 error). Derive from the matched usage column when it is unit-named.
  const usageColLower = (usageCol ?? "").toLowerCase();
  let usageUnit: string;
  if (/ccf/.test(usageColLower)) usageUnit = "CCF";
  else if (/mcf/.test(usageColLower)) usageUnit = "Mcf";
  else if (/therm/.test(usageColLower)) usageUnit = "therms";
  else if (/hcf/.test(usageColLower)) usageUnit = "HCF";
  else if (/gallon|^gal$|gal\b/.test(usageColLower)) usageUnit = "gal";
  else if (/cubic\s*feet/.test(usageColLower)) usageUnit = "cf";
  else if (/m3/.test(usageColLower)) usageUnit = "m3";
  else usageUnit = commodity === "electric" ? "kWh" : commodity === "gas" ? "therms" : "gal";
  // Batch-15 (pass 144): a bare "Wh" usage header (matched by the generic
  // usage/energy regex, NOT the kwh regex) would be ingested as-is yet labeled
  // kWh — a 1000× unit error. Detect Watt-hour headers and convert to kWh.
  const usageIsWh = commodity === "electric" && usageCol != null && kwhCol == null && /(^|[^km])wh\b/i.test(usageCol);
  const usageScale = usageIsWh ? 1 / 1000 : 1;

  const points: Array<{ ts: number; durationMin: number; usage: number; demand: number | null }> = [];
  let skipped = 0;
  let receivedRows = 0;
  // Bounded garbage on very long sheets (no effect on results).
  const tick = heapGuard();
  for (const r of table.data) {
    tick();
    // LGE-2: "Usage Direction" — only Delivered (or blank) rows are consumption;
    // Received rows are net-metering export and are excluded with disclosure.
    if (directionCol) {
      const dir = String(r[directionCol] ?? "").trim().toLowerCase();
      if (dir && dir !== "delivered") {
        receivedRows++;
        skipped++;
        continue;
      }
    }
    const ts = parseIntervalInstant(r[dtColFinal ?? dateColFinal!], dtColFinal ? null : timeColFinal ? r[timeColFinal] : null, clock);
    if (ts == null || !Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    const usageRaw = usageCol ? numberValue(r[usageCol]) : null;
    const usage = usageRaw != null ? usageRaw * usageScale : null;
    const demand = kwCol ? numberValue(r[kwCol]) : null;
    if (usage == null && demand == null) {
      skipped++;
      continue;
    }
    points.push({ ts, durationMin: 0, usage: usage ?? 0, demand });
  }
  if (points.length < 3) return null;
  points.sort((a, b) => a.ts - b.ts);
  const dur = inferDurationMin(points.map((p) => p.ts));
  let basis: "start" | "end" = clock.timestampBasis;
  let basisNote: string | null = null;
  if (clock.detectBasis) {
    const detected = detectTimestampBasis(points[0].ts, points[points.length - 1].ts, dur, clock.timeZone);
    const fmt = (ts: number) => new Date(wallAt(ts, clock.timeZone)).toISOString().slice(11, 16);
    const edges = `first reading ${fmt(points[0].ts)}, last ${fmt(points[points.length - 1].ts)}`;
    if (detected) {
      basis = detected;
      basisNote = `Timestamps were detected as the ${detected === "end" ? "END" : "START"} of each ${dur}-minute interval (${edges}).`;
    } else {
      basisNote = `Could not tell from the readings whether timestamps mark the start or end of each interval (${edges}); treated them as interval ${basis === "end" ? "ENDS" : "STARTS"}. If your utility labels the other way, re-upload choosing it explicitly.`;
    }
  }
  for (const p of points) { p.durationMin = dur; if (basis === "end") p.ts -= dur * 60_000; }

  const footerTotals = extractFooterTotals(table.summaryRows);
  const ingestedUsageSum = points.reduce((a, p) => a + p.usage, 0);
  // Cycle 5, pass 154: iterative max — spreading a large array into Math.max
  // risks the engine's argument-count limit on very large files, and the old
  // slice(0, 1M) silently ignored demand rows past the first million.
  let ingestedMaxDemand: number | null = null;
  for (const p of points) {
    if (p.demand != null && (ingestedMaxDemand == null || p.demand > ingestedMaxDemand)) ingestedMaxDemand = p.demand;
  }

  const notes: string[] = [...inferenceNotes, ...(basisNote ? [basisNote] : []), `Source clock: ${clock.timeZone}; ${basis}-labeled intervals stored as UTC starts. Explicit offsets preserved; unresolved DST folds/gaps rejected.`];
  if (receivedRows > 0) {
    notes.push(`${receivedRows} "Received" (export) rows excluded from consumption — net-metering export is not usage`);
  }
  let pass = true;
  let footerUsageDelta: number | undefined;
  let footerUsageDeltaPct: number | undefined;
  let footerMaxDelta: number | undefined;
  if (footerTotals.totalUsage !== undefined) {
    footerUsageDelta = ingestedUsageSum - footerTotals.totalUsage;
    footerUsageDeltaPct = footerTotals.totalUsage !== 0 ? (footerUsageDelta / footerTotals.totalUsage) * 100 : 0;
    if (Math.abs(footerUsageDeltaPct) > 0.5) {
      pass = false;
      notes.push(`Ingested usage sum differs from workbook Total= footer by ${footerUsageDeltaPct.toFixed(3)}%`);
    } else {
      notes.push(`Usage sum matches workbook Total= footer within ${Math.abs(footerUsageDeltaPct).toFixed(4)}%`);
    }
  } else {
    notes.push("No workbook Total= footer available; usage sum has not been independently reconciled.");
  }
  if (footerTotals.maxDemand !== undefined && ingestedMaxDemand != null) {
    footerMaxDelta = ingestedMaxDemand - footerTotals.maxDemand;
    if (Math.abs(footerMaxDelta) > 0.01 * Math.max(1, footerTotals.maxDemand)) {
      pass = false;
      notes.push(`Max demand differs from workbook Max= footer by ${footerMaxDelta.toFixed(3)}`);
    } else {
      notes.push("Max demand matches workbook Max= footer");
    }
  }

  return {
    sourceKey: name,
    commodity,
    usageUnit,
    // Cycle 10 (pass 554) + Batch-13 (pass 64): report kW ONLY when demand
    // values were actually ingested — a kW-labeled header whose cells are all
    // empty/non-numeric must not claim demand data exists (matches ESPI's
    // espiHasDemand rule).
    demandUnit: ingestedMaxDemand != null ? "kW" : null,
    points,
    footerTotals,
    validation: { ingestedUsageSum, ingestedMaxDemand, footerUsageDelta, footerUsageDeltaPct, footerMaxDelta, pass, notes },
    headerRowIndex: table.headerRowIndex,
    rowsIngested: points.length,
    rowsSkipped: skipped,
    timestampBasis: basis,
  };
}

/* ---------------- Excel (D3: every sheet; D11: raw floats) ---------------- */
export function parseExcelIntervals(buf: Buffer, clock: IntervalClock = DEFAULT_CLOCK): ParsedMeterSeries[] {
  const out: ParsedMeterSeries[] = [];
  const pushSheet = (sheetName: string, ws: XLSX.WorkSheet | undefined) => {
    if (!ws) return;
    // D11: raw:true preserves full float precision (never display-rounded)
    const rows = XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: "" });
    if (!rows || rows.length < 4) return;
    const scrubbed = rows.map((r) => r.map((c) => (typeof c === "string" ? scrubCell(c) : c)));
    out.push(...tableToSeriesMulti(sheetName, scrubbed, clock));
  };
  // Oct 25: read one worksheet at a time from a bounded subset. SheetJS
  // inflates every zip member up front, so a whole multi-sheet utility
  // workbook can exceed the 512 MiB production container.
  const names = workbookSheetNames(buf);
  if (!names) {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
    for (const sheetName of wb.SheetNames) pushSheet(sheetName, wb.Sheets[sheetName]);
    return out;
  }
  for (const sheetName of names) {
    const wb = XLSX.read(boundedWorkbookInput(buf, { mode: "full", sheetName }), { type: "buffer", cellDates: false, sheets: [sheetName] });
    pushSheet(sheetName, wb.Sheets[sheetName]);
  }
  return out;
}

/**
 * BULK-1: parse ONE worksheet's raw rows with exactly the same scrub +
 * table->series logic parseExcelIntervals applies per sheet. The bulk importer
 * reads one sheet at a time (bounded memory) and calls this per sheet.
 */
export function parseSheetRows(sheetName: string, rows: unknown[][], clock: IntervalClock = DEFAULT_CLOCK): ParsedMeterSeries[] {
  if (!rows || rows.length < 4) return [];
  const scrubbed = (rows as Row[]).map((r) => r.map((c) => (typeof c === "string" ? scrubCell(c) : c)));
  return tableToSeriesMulti(sheetName, scrubbed, clock);
}
/* ---------------- CSV (BUILD-010.3 parseCSV) ---------------- */
export function parseCsvIntervals(text: string, filename: string, clock: IntervalClock = DEFAULT_CLOCK): ParsedMeterSeries[] {
  const rows = parseCSV(text).map((r) => r.map((c) => scrubCell(c)));
  if (rows.length < 4) return [];
  return tableToSeriesMulti(filename.replace(/\.[^.]+$/, ""), rows as Row[], clock);
}

/* ---------------- ESPI Green Button XML ---------------- */
const ESPI_SERVICE_KIND: Record<string, "electric" | "gas" | "water"> = {
  "0": "electric",
  "1": "gas",
  "2": "water",
};

export function parseEspiXml(xmlText: string): ParsedMeterSeries[] {
  const gate = rejectXxe(xmlText);
  if (!gate.ok) throw new Error(gate.reason);
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    processEntities: false, // XXE-safe: no entity expansion
    isArray: (name) => ["entry", "IntervalBlock", "IntervalReading"].includes(name),
  });
  const doc = parser.parse(xmlText);
  const feed = doc.feed ?? doc;
  const entries: unknown[] = feed?.entry ?? [];

  let commodity: "electric" | "gas" | "water" = "electric";
  let powerOfTen = 0;
  let uom = "72"; // Wh default
  let sawReadingType = false; // Batch-30 (pass 1074)
  let scalingResetOccurred = false; // Batch-30 (pass 1074)
  let scalingAssumedAtDefaults = false; // Batch-32 (pass 1204)
  let skippedReadings = 0; // Batch-36 (pass 1374): malformed readings counted + disclosed
  const points: Array<{ ts: number; durationMin: number; usage: number; demand: number | null }> = [];

  for (const e of entries as Array<Record<string, unknown>>) {
    const content = e?.content as Record<string, unknown> | undefined;
    if (!content) continue;
    const up = content.UsagePoint as Record<string, unknown> | undefined;
    if (up) {
      const kind = String(
        (up.ServiceCategory as Record<string, unknown>)?.kind ?? "0",
      );
      commodity = ESPI_SERVICE_KIND[kind] ?? "electric";
    }
    const rt = content.ReadingType as Record<string, unknown> | undefined;
    if (rt) {
      powerOfTen = parseInt(String(rt.powerOfTenMultiplier ?? "0"), 10) || 0;
      uom = String(rt.uom ?? "72");
    }
    const blocks = (content.IntervalBlock as Array<Record<string, unknown>>) ?? [];
    // Batch-30 (pass 1074): in Green Button feeds the ReadingType entry precedes
    // its IntervalBlock entries as SIBLING entries, so carrying the last-seen
    // ReadingType forward is the CORRECT behavior for well-formed single-stream
    // feeds — blanket per-entry resets would break them. The corruption risk is
    // multi-UsagePoint feeds where a later usage point declares NO ReadingType:
    // scaling from the previous stream would silently apply. Detect that case
    // and reset to safe defaults (10^0, Wh) with the reset disclosed.
    if (up && !rt && blocks.length > 0 && sawReadingType) {
      powerOfTen = 0;
      uom = "72";
      scalingResetOccurred = true;
    }
    // Batch-32 (pass 1204): the FIRST usage point can also lack a ReadingType —
    // sawReadingType is false there, so the reset branch above cannot fire and
    // the initial defaults (10^0, Wh) silently apply. That's the same "scaling
    // was assumed, not declared" condition and deserves the same disclosure
    // (values are already at defaults, so no reset is needed — only honesty).
    if (up && !rt && blocks.length > 0 && !sawReadingType) {
      scalingAssumedAtDefaults = true;
    }
    if (rt) sawReadingType = true;
    for (const block of blocks) {
      const readings = (block.IntervalReading as Array<Record<string, unknown>>) ?? [];
      for (const r of readings) {
        const tp = r.timePeriod as Record<string, unknown> | undefined;
        const start = parseInt(String(tp?.start ?? "0"), 10);
        // Batch-37 (passes 1494/1504): `?? "900"` only covers a MISSING duration.
        // A present-but-malformed duration (parseInt → NaN) or a non-positive one
        // (0 / negative) would poison downstream math — uom-38 feeds compute
        // usage = demand × durationSec / 3600 (NaN usage corrupts every sum) and
        // durationMin ≤ 0 rows are excluded from kW derivation. Treat those
        // readings as malformed and skip them THROUGH the disclosed-skip path
        // (counted in rowsSkipped + validation note), never silently defaulted.
        const durationRaw = parseInt(String(tp?.duration ?? "900"), 10);
        const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : NaN;
        const value = parseFloat(String(r.value ?? "0"));
        // Batch-36 (pass 1374): a reading with an unparseable start time or a
        // non-numeric value is still SKIPPED (ingesting garbage would corrupt
        // totals), but the omission is now COUNTED and disclosed in validation
        // notes instead of silently vanishing — an unnoticed gap underestimates
        // usage/demand in every downstream cost analysis.
        if (!start || !Number.isFinite(value) || !Number.isFinite(durationSec)) {
          skippedReadings++;
          continue;
        }
        const mult = Math.pow(10, powerOfTen);
        // uom 72 = Wh → kWh; 38 = W (power → kW demand); 119 = ft3; 128 = US gal
        let usage = value * mult;
        let demand: number | null = null;
        if (uom === "72") usage = usage / 1000;
        // Cycle 3, pass 54: Watts feeds are DEMAND readings — convert W → kW and
        // derive interval energy from demand × duration; never ingest raw Watts
        // into a kWh-typed usage field (1000× error).
        if (uom === "38") {
          demand = (value * mult) / 1000;
          usage = (demand * durationSec) / 3600;
        }
        // Cycle 3, pass 34: ft³ → therms via 100 ft³ per ccf × 1.037 therms/ccf
        // (EIA national-average heat content) — disclosed in series notes below.
        if (uom === "119") usage = (usage / 100) * 1.037;
        points.push({ ts: start * 1000, durationMin: Math.round(durationSec / 60), usage, demand });
      }
    }
  }
  // Batch-54 (pass 2774): when readings EXISTED but every one was skipped as
  // malformed, a bare `return []` silently discarded the skip count — the user
  // saw the generic "No interval data recognized in this file" with no hint
  // that the file DID contain readings. Throw with the diagnosis instead: the
  // ingest route persists parser error messages verbatim on the upload row and
  // surfaces them as `Parse failed: …`. A feed with zero readings altogether
  // still returns [] and keeps the generic no-data message.
  if (points.length === 0) {
    if (skippedReadings > 0) {
      throw new Error(
        `ESPI feed contained ${skippedReadings} interval reading${skippedReadings === 1 ? "" : "s"}, but every one was malformed (unparseable start time, non-numeric value, or invalid duration) — nothing could be ingested. Re-export the Green Button file from your utility portal and try again.`,
      );
    }
    return [];
  }
  points.sort((a, b) => a.ts - b.ts);
  const usageUnit = commodity === "electric" ? "kWh" : commodity === "gas" ? "therms" : "gal";
  const ingestedUsageSum = points.reduce((a, p) => a + p.usage, 0);
  // Cycle 5, pass 154 (same class as Excel path): iterative max, no spread.
  let espiMaxDemand: number | null = null;
  let espiHasDemand = false;
  for (const p of points) {
    if (p.demand != null) {
      espiHasDemand = true;
      if (espiMaxDemand == null || p.demand > espiMaxDemand) espiMaxDemand = p.demand;
    }
  }
  return [
    {
      sourceKey: "espi_usage_point",
      commodity,
      usageUnit,
      demandUnit: espiHasDemand ? "kW" : null,
      points,
      footerTotals: { raw: [] },
      validation: {
        ingestedUsageSum,
        ingestedMaxDemand: espiMaxDemand,
        pass: true,
        notes: [
          `ESPI feed parsed: ${points.length} interval readings`,
          // Batch-36 (pass 1374): the parse is no longer reported as fully clean
          // when malformed readings were dropped — disclose the count.
          ...(skippedReadings > 0
            ? [
                `${skippedReadings} interval reading${skippedReadings === 1 ? " was" : "s were"} skipped (unparseable start time, non-numeric value, or invalid duration) — ingested totals may underestimate actual usage; verify against your utility portal.`,
              ]
            : []),
          ...(uom === "119"
            ? ["Gas volumes converted ft³ → therms using EIA national-average heat content (1.037 therms/ccf); your utility's billing factor may differ slightly."]
            : []),
          ...(uom === "38" ? ["Power (W) readings converted to kW demand; interval energy derived from demand × duration."] : []),
          // Batch-30 (pass 1074): disclose the defensive scaling reset.
          ...(scalingResetOccurred
            ? ["A usage point in this feed declared no ReadingType; its readings were scaled with safe defaults (10^0, Wh) instead of inheriting the previous stream's scaling — verify totals against your utility portal."]
            : []),
          // Batch-32 (pass 1204): first usage point lacked ReadingType too.
          ...(scalingAssumedAtDefaults
            ? ["This feed's first usage point declared no ReadingType; default scaling (10^0, Wh) was assumed for its readings — verify totals against your utility portal."]
            : []),
        ],
      },
      headerRowIndex: 0,
      rowsIngested: points.length,
      rowsSkipped: skippedReadings, // Batch-36 (pass 1374): was hardcoded 0
    },
  ];
}
