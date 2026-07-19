/**
 * Interval file parsers — Excel (multi-sheet, BUILD-010.3 semantics),
 * CSV (BUILD-010.3 parseCSV), ESPI Green Button XML.
 * Every parser emits ParsedMeterSeries[] in canonical form; validation
 * compares ingested sums against the workbook's own Total=/Max= footers.
 */
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";
import {
  Row,
  airIsSummaryRow,
  airIsBlankRow,
  dateFromValue,
  findHeader,
  numberValue,
  parseCSV,
  rowsToFile,
} from "../../shared/build0103";
import { rejectXxe, scrubCell } from "./hardening";
import { inferColumns } from "./columnInference";

export const PARSER_VERSION = "BUILD-010.3-ww1";

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
/** Combine a date cell and a time cell ("00:15", "12:00 AM", excel fraction). */
function combineDateTime(dateCell: unknown, timeCell: unknown): number | null {
  const d = dateFromValue(dateCell as never);
  if (!d) return null;
  let minutes = 0;
  if (timeCell != null && timeCell !== "") {
    if (typeof timeCell === "number" && timeCell >= 0 && timeCell < 1.0001) {
      minutes = Math.round(timeCell * 24 * 60);
    } else {
      const s = String(timeCell).trim();
      const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i);
      if (m) {
        let hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const ap = m[4]?.toLowerCase();
        if (ap === "pm" && hh < 12) hh += 12;
        if (ap === "am" && hh === 12) hh = 0;
        minutes = hh * 60 + mm;
      } else {
        const t = dateFromValue(s);
        if (t) minutes = t.getHours() * 60 + t.getMinutes();
      }
    }
  } else if (d.getHours() !== 0 || d.getMinutes() !== 0) {
    return d.getTime();
  }
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return base + minutes * 60_000;
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
function tableToSeriesMulti(name: string, rows: Row[]): ParsedMeterSeries[] {
  const probe = rowsToFile(name, rows);
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
      for (const mv of Array.from(meterValues)) {
        const subset = [
          ...headerRows,
          ...rows.slice(probe.headerRowIndex + 1).filter((r) => String(r?.[meterIdx] ?? "").trim() === mv),
        ];
        const s = tableToSeries(`${name} · meter ${mv}`, subset);
        if (s) out.push(s);
      }
      if (out.length > 0) return out;
    }
  }
  const single = tableToSeries(name, rows);
  return single ? [single] : [];
}

function tableToSeries(name: string, rows: Row[]): ParsedMeterSeries | null {
  const table = rowsToFile(name, rows);
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
  for (const r of table.data) {
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
    const ts = dtColFinal
      ? (dateFromValue(r[dtColFinal] as never)?.getTime() ?? null)
      : combineDateTime(r[dateColFinal!], timeColFinal ? r[timeColFinal] : null);
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
  for (const p of points) p.durationMin = dur;

  const footerTotals = extractFooterTotals(table.summaryRows);
  const ingestedUsageSum = points.reduce((a, p) => a + p.usage, 0);
  // Cycle 5, pass 154: iterative max — spreading a large array into Math.max
  // risks the engine's argument-count limit on very large files, and the old
  // slice(0, 1M) silently ignored demand rows past the first million.
  let ingestedMaxDemand: number | null = null;
  for (const p of points) {
    if (p.demand != null && (ingestedMaxDemand == null || p.demand > ingestedMaxDemand)) ingestedMaxDemand = p.demand;
  }

  const notes: string[] = [...inferenceNotes];
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
  };
}

/* ---------------- Excel (D3: every sheet; D11: raw floats) ---------------- */
export function parseExcelIntervals(buf: Buffer): ParsedMeterSeries[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const out: ParsedMeterSeries[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    // D11: raw:true preserves full float precision (never display-rounded)
    const rows = XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: "" });
    if (!rows || rows.length < 4) continue;
    const scrubbed = rows.map((r) => r.map((c) => (typeof c === "string" ? scrubCell(c) : c)));
    out.push(...tableToSeriesMulti(sheetName, scrubbed));
  }
  return out;
}

/* ---------------- CSV (BUILD-010.3 parseCSV) ---------------- */
export function parseCsvIntervals(text: string, filename: string): ParsedMeterSeries[] {
  const rows = parseCSV(text).map((r) => r.map((c) => scrubCell(c)));
  if (rows.length < 4) return [];
  return tableToSeriesMulti(filename.replace(/\.[^.]+$/, ""), rows as Row[]);
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
