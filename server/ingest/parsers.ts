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
function tableToSeries(name: string, rows: Row[]): ParsedMeterSeries | null {
  const table = rowsToFile(name, rows);
  if (table.data.length < 3) return null;
  const headers = table.headers;

  const dateCol = findHeader(headers, [/^date$/i, /^date[^a-z]/i, /date/i], [/time/i]) ?? findHeader(headers, [/date.?time|timestamp/i]);
  const dtCol = findHeader(headers, [/date.?time|timestamp/i]);
  const timeCol = findHeader(headers, [/^time$/i, /interval.?time|^end.?time|^start.?time/i], [/date/i]);
  const kwhCol = findHeader(headers, [/kwh/i], [/cost|charge|\$/i]);
  const kwCol = findHeader(headers, [/(^|[^a-z])kw([^a-z]|$)/i, /demand/i], [/kwh/i]);
  const usageCol =
    kwhCol ??
    findHeader(headers, [/usage|consumption|energy|therms?|ccf|mcf|gallons?|gal\b|hcf|volume|flow/i], [/cost|charge|\$/i]);

  if (!usageCol && !kwCol) return null;
  if (!dateCol && !dtCol) return null;

  let commodity: "electric" | "gas" | "water" = "electric";
  const headerBlob = headers.join(" ").toLowerCase();
  if (/therm|ccf|mcf|gas/.test(headerBlob)) commodity = "gas";
  else if (/gallon|gal\b|hcf|water/.test(headerBlob)) commodity = "water";
  const usageUnit = commodity === "electric" ? "kWh" : commodity === "gas" ? "therms" : "gal";

  const points: Array<{ ts: number; durationMin: number; usage: number; demand: number | null }> = [];
  let skipped = 0;
  for (const r of table.data) {
    const ts = dtCol
      ? (dateFromValue(r[dtCol] as never)?.getTime() ?? null)
      : combineDateTime(r[dateCol!], timeCol ? r[timeCol] : null);
    if (ts == null || !Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    const usage = usageCol ? numberValue(r[usageCol]) : null;
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
  const demands = points.filter((p) => p.demand != null).map((p) => p.demand as number);
  const ingestedMaxDemand = demands.length ? Math.max(...demands.slice(0, 1_000_000)) : null;

  const notes: string[] = [];
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
    demandUnit: kwCol ? "kW" : null,
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
    const series = tableToSeries(sheetName, scrubbed);
    if (series) out.push(series);
  }
  return out;
}

/* ---------------- CSV (BUILD-010.3 parseCSV) ---------------- */
export function parseCsvIntervals(text: string, filename: string): ParsedMeterSeries[] {
  const rows = parseCSV(text).map((r) => r.map((c) => scrubCell(c)));
  if (rows.length < 4) return [];
  const series = tableToSeries(filename.replace(/\.[^.]+$/, ""), rows as Row[]);
  return series ? [series] : [];
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
    for (const block of blocks) {
      const readings = (block.IntervalReading as Array<Record<string, unknown>>) ?? [];
      for (const r of readings) {
        const tp = r.timePeriod as Record<string, unknown> | undefined;
        const start = parseInt(String(tp?.start ?? "0"), 10);
        const durationSec = parseInt(String(tp?.duration ?? "900"), 10);
        const value = parseFloat(String(r.value ?? "0"));
        if (!start || !Number.isFinite(value)) continue;
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
  if (points.length === 0) return [];
  points.sort((a, b) => a.ts - b.ts);
  const usageUnit = commodity === "electric" ? "kWh" : commodity === "gas" ? "therms" : "gal";
  const ingestedUsageSum = points.reduce((a, p) => a + p.usage, 0);
  const demandVals = points.filter((p) => p.demand != null).map((p) => p.demand as number);
  return [
    {
      sourceKey: "espi_usage_point",
      commodity,
      usageUnit,
      demandUnit: demandVals.length ? "kW" : null,
      points,
      footerTotals: { raw: [] },
      validation: {
        ingestedUsageSum,
        ingestedMaxDemand: demandVals.length ? Math.max(...demandVals) : null,
        pass: true,
        notes: [
          `ESPI feed parsed: ${points.length} interval readings`,
          ...(uom === "119"
            ? ["Gas volumes converted ft³ → therms using EIA national-average heat content (1.037 therms/ccf); your utility's billing factor may differ slightly."]
            : []),
          ...(uom === "38" ? ["Power (W) readings converted to kW demand; interval energy derived from demand × duration."] : []),
        ],
      },
      headerRowIndex: 0,
      rowsIngested: points.length,
      rowsSkipped: 0,
    },
  ];
}
