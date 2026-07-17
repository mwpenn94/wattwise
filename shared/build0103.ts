/**
 * AIR Workstation BUILD-010.3 parsing & decimation engine — faithful TypeScript
 * port of the validated JS in AIR_Workstation_BUILD_010_3_PERFORMANCE_FIX.html.
 *
 * Fix lineage preserved (BUILD-010.2 DATA ACCURACY + BUILD-010.3 PERFORMANCE):
 *  D1: header row is NOT always rows[0] — utility workbooks carry 4–6 title/
 *      metadata rows first → scored header detection scanning down to row 25.
 *  D2: trailing "Total = …" / "Max = …" summary rows excluded from data.
 *  D3: import EVERY worksheet — one account/service agreement per sheet.
 *  D4: compact yyyymmdd integer dates (20250301) parsed correctly.
 *  D6: text columns (addresses, "12:00 AM") never classified as numeric Y.
 *  D8: full datetime column preferred over date-only column for X axis.
 *  D11: raw:true float precision preserved (raw:false display-rounds 760.025
 *       → "760.03", silently corrupting kWh totals — Cantex drifted +16.96 kWh).
 *  P4: peak-preserving min/max pixel-bucket decimation — every bucket keeps its
 *      true min AND max, so peaks/troughs are pixel-identical to full render;
 *      metrics/exports always stay full-resolution.
 *
 * This module is shared by server ingestion (server/ingest/*) and the client
 * interval chart. Do not "improve" the algorithms here — they are validated
 * against real utility files (Cantex, Lake Havasu City, American Woodmark);
 * behavior changes require re-validation against those workbooks' own
 * Total=/Max= footers.
 */

export type Cell = string | number | null | undefined;
export type Row = Cell[];

/* ===== BUILD-010.3 CSV parser (delimiter sniff + quoted fields) ===== */
export function parseCSV(text: string): string[][] {
  const sample = (text || "").slice(0, 4000);
  const counts: Record<string, number> = {
    ",": (sample.match(/,/g) || []).length,
    ";": (sample.match(/;/g) || []).length,
    "\t": (sample.match(/\t/g) || []).length,
  };
  const delim =
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      if (q && n === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === delim && !q) {
      row.push(cur.trim());
      cur = "";
    } else if ((c === "\n" || c === "\r") && !q) {
      if (c === "\r" && n === "\n") i++;
      row.push(cur.trim());
      if (row.some((x) => String(x).trim() !== "")) rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  row.push(cur.trim());
  if (row.some((x) => String(x).trim() !== "")) rows.push(row);
  return rows;
}

/* ===== Row classification (D1/D2) ===== */
export function airIsBlankRow(r: Row | undefined | null): boolean {
  return !r || r.every((c) => String(c ?? "").trim() === "");
}

export function airIsSummaryRow(r: Row | undefined | null): boolean {
  const joined = (r || []).map((c) => String(c ?? "").trim()).join(" ");
  return (
    /^(total|max|sum|average|avg|grand\s*total)\s*=?/i.test(joined) ||
    (r || []).some((c) =>
      /^(total|max|sum|average|avg)\s*=/i.test(String(c ?? "").trim()),
    )
  );
}

const HEADER_WORDS =
  /^(date|time|datetime|date.?time|timestamp|kwh|kw|kwh_del|kw_del|demand|usage|energy|consumption|value|units?|type|notes?|address|account|meter|interval|start|end|read|channel|cost|amount|therms?|ccf|mcf|gallons?|gal|hcf|flow|volume)/i;

export function airHeaderScore(row: Row | undefined, next?: Row): number {
  if (!row) return -1;
  const cells = row.map((c) => String(c ?? "").trim());
  const filled = cells.filter(Boolean);
  if (filled.length < 2) return -1;
  let score = filled.length;
  score += cells.filter((c) => HEADER_WORDS.test(c)).length * 4;
  score -=
    cells.filter(
      (c) =>
        c !== "" &&
        Number.isFinite(parseFloat(c)) &&
        /^[-+]?[\d.,]+$/.test(c),
    ).length * 3;
  if (next) {
    const nextCells = next.map((c) => String(c ?? "").trim());
    score += nextCells.filter(
      (c) => c !== "" && Number.isFinite(parseFloat(c.replace(/,/g, ""))),
    ).length;
  }
  return score;
}

/** D1: scored header detection scanning down to row 25 (0-indexed limit). */
export function airDetectHeaderRow(rows: Row[]): number {
  const limit = Math.min(rows.length - 1, 25);
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i <= limit; i++) {
    if (airIsBlankRow(rows[i])) continue;
    // Batch-49 (pass 2514a): summary rows ("Total = 1234") are data-class rows
    // (D2), never header candidates. Without this skip, a PREAMBLE summary row
    // sitting above the true header could outscore it (numeric-next-row bonus
    // plus few numeric cells of its own) and silently shift parsing off the
    // real columns — the D2 exclusion previously applied only BELOW the header.
    if (airIsSummaryRow(rows[i])) continue;
    const s = airHeaderScore(rows[i], rows[i + 1]);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

/* ===== Date/number handling (D4/D6) ===== */
export function airParseDateLike(raw: Cell): number {
  if (raw == null || raw === "") return NaN;
  const text = String(raw).trim();
  const ymd = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) {
    const y = +ymd[1],
      mo = +ymd[2],
      da = +ymd[3];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31)
      return new Date(y, mo - 1, da).getTime();
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : NaN;
}

export function airLooksNumericValue(v: Cell): boolean {
  const s = String(v ?? "").trim();
  if (s === "") return false;
  if (/[ap]m$/i.test(s)) return false;
  if (/^\d{1,2}:\d{2}/.test(s)) return false;
  return (
    /^[-+$]?[\d.,]+%?$/.test(s) &&
    Number.isFinite(parseFloat(s.replace(/[$,%]/g, "")))
  );
}

/** D6 guard: plain number AND not a compact/slashed date. */
export function airIsPlainNumber(v: Cell): boolean {
  const s = String(v ?? "").trim();
  return (
    airLooksNumericValue(s) &&
    !/^(\d{4})(\d{2})(\d{2})$/.test(s) &&
    !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(s)
  );
}

export const numberValue = (v: Cell): number | null => {
  const n = parseFloat(String(v ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** dateFromValue — Excel serials, compact yyyymmdd, ISO, m/d/y. */
export function dateFromValue(value: Cell | Date): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && value > 25000 && value < 80000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  const ymd = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) {
    const y = Number(ymd[1]),
      mo = Number(ymd[2]),
      da = Number(ymd[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const d0 = new Date(y, mo - 1, da);
      if (!Number.isNaN(d0.getTime())) return d0;
    }
  }
  let d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d;
  const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/* ===== Structured file model (rowsToFile) ===== */
export interface ParsedTable {
  name: string;
  sheetName?: string;
  headers: string[];
  data: Record<string, Cell>[];
  numeric: string[];
  dates: string[];
  x: string;
  y: string;
  preamble: string[];
  summaryRows: string[];
  headerRowIndex: number;
}

export function rowsToFile(name: string, rows: Row[]): ParsedTable {
  const headerIdx = airDetectHeaderRow(rows);
  const headerRow = rows[headerIdx] || [];
  const headers = headerRow.map((h, i) =>
    String(h || "Column " + (i + 1)).trim(),
  );
  const preamble = rows
    .slice(0, headerIdx)
    .map((r) =>
      (r || [])
        .map((c) => String(c ?? "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
  const rawData = rows
    .slice(headerIdx + 1)
    .filter((r) => !airIsBlankRow(r) && !airIsSummaryRow(r));
  const summaryRows = rows
    .slice(headerIdx + 1)
    .filter((r) => airIsSummaryRow(r))
    .map((r) =>
      (r || [])
        .map((c) => String(c ?? "").trim())
        .filter(Boolean)
        .join(" "),
    );
  const data = rawData.map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])),
  );
  const cols = headers.map((h) => ({
    name: h,
    numeric: data.filter((r) => airIsPlainNumber(r[h])).length,
    date: data.filter((r) => Number.isFinite(airParseDateLike(r[h]))).length,
  }));
  const numeric = cols
    .filter((c) => c.numeric > Math.max(3, data.length * 0.35))
    .map((c) => c.name);
  const dates = cols
    .filter((c) => c.date > Math.max(3, data.length * 0.35))
    .map((c) => c.name);
  const y =
    numeric.find((c) => /kwh/i.test(c)) ||
    numeric.find((c) => /(^|[^a-z])kw([^a-z]|$)|demand/i.test(c)) ||
    numeric.find((c) =>
      /usage|energy|consumption|value|cost|amount|therms?|gallons?/i.test(c),
    ) ||
    numeric[0] ||
    headers[0];
  const x =
    dates.find((c) => /date.?time|timestamp/i.test(c)) ||
    dates.find((c) => /date/i.test(c)) ||
    dates[0] ||
    "__row";
  return {
    name,
    headers,
    data,
    numeric,
    dates,
    x,
    y,
    preamble,
    summaryRows,
    headerRowIndex: headerIdx,
  };
}

/* ===== Column finding helpers ===== */
export function findColumnIn(
  row: Record<string, Cell>,
  patterns: RegExp[],
): string | null {
  return (
    Object.keys(row || {}).find((k) => patterns.some((p) => p.test(k))) || null
  );
}

export function findHeader(
  headers: string[],
  patterns: RegExp[],
  exclude: RegExp[] = [],
): string | null {
  return (
    (headers || []).find(
      (h) =>
        patterns.some((p) => p.test(String(h))) &&
        !exclude.some((p) => p.test(String(h))),
    ) || null
  );
}

/* ===== BUILD-010.3 P4: peak-preserving min/max pixel-bucket decimation ===== */
export interface SeriesPoint {
  i: number;
  label?: string;
  v: number;
  t?: number;
}

/** Loop-based min/max — spread over 38k+ elements risks stack overflow. */
export function airMinMax(s: SeriesPoint[]): [number, number] {
  let mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < s.length; i++) {
    const v = s[i].v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

/**
 * Peak-preserving decimation: ≤2 vertices per pixel column; every bucket keeps
 * its true min AND max so peaks/troughs are pixel-identical to full rendering.
 */
export function airDecimate(
  s: SeriesPoint[],
  pxWidth: number,
): SeriesPoint[] {
  const budget = Math.max(300, Math.ceil(pxWidth) * 2);
  if (s.length <= budget) return s;
  const buckets = Math.max(150, Math.ceil(pxWidth));
  const out: SeriesPoint[] = [];
  const step = s.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * step);
    const z = Math.max(a + 1, Math.min(s.length, Math.floor((b + 1) * step)));
    let lo: SeriesPoint | null = null;
    let hi: SeriesPoint | null = null;
    for (let i = a; i < z; i++) {
      const p = s[i];
      if (!lo || p.v < lo.v) lo = p;
      if (!hi || p.v > hi.v) hi = p;
    }
    if (!lo || !hi) continue;
    if (lo === hi) {
      out.push(hi);
    } else {
      const first = lo.i < hi.i ? lo : hi;
      const second = lo.i < hi.i ? hi : lo;
      out.push(first, second);
    }
  }
  return out;
}
