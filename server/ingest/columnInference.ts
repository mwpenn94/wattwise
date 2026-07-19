/**
 * INFER-1..3 — structural column inference for interval-table parsing.
 *
 * Utility portals name columns inconsistently ("Start" vs "Interval Start
 * Date/Time" vs "USAGE_DATE"; "kWh" vs "Consumption" vs "USAGE (kwh)").
 * Header-regex matching (parsers.ts) is the fast path; when it cannot find a
 * timestamp or usage column, this module classifies columns by what their
 * VALUES look like and proposes the best candidates. Every inference is
 * returned as a human-readable disclosure so the chosen mapping is auditable
 * in validation notes — never a silent guess.
 */
import { Cell, Row } from "../../shared/build0103";

export interface InferredColumns {
  /** header of the combined datetime column, if inferred */
  dtCol: string | null;
  /** header of a date-only column (paired with timeCol), if inferred */
  dateCol: string | null;
  /** header of a time-only column, if inferred */
  timeCol: string | null;
  /** header of the usage (consumption) column, if inferred */
  usageCol: string | null;
  /** header of a demand column, if inferred */
  demandCol: string | null;
  /** headers classified as currency/cost — must never be usage */
  currencyCols: string[];
  /** header of a direction-like enum column (Delivered/Received), if any */
  directionCol: string | null;
  /** header of a meter-id-like column, if any */
  meterCol: string | null;
  /** human-readable notes describing every inference made */
  disclosures: string[];
}

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/** Does a string value look like a datetime (date + time-of-day component)? */
function looksDateTime(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  // ISO 8601: 2025-03-30T19:00 / 2025-03-30 19:00[:ss]
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(t)) return true;
  // US: 3/30/2025 7:00[:00] [AM/PM]
  if (/^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i.test(t)) return true;
  // "Mar 30, 2025 7:00 PM"
  if (MONTHS.test(t) && /\d{1,2}:\d{2}/.test(t)) return true;
  return false;
}

/** Does a string value look like a date only (no time-of-day)? */
function looksDateOnly(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  if (/^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$/.test(t)) return true;
  if (/^\d{8}$/.test(t)) return true; // YYYYMMDD
  if (MONTHS.test(t) && /\d{4}/.test(t) && !/\d{1,2}:\d{2}/.test(t)) return true;
  return false;
}

/** Does a string value look like a time-of-day only? */
function looksTimeOnly(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /^\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i.test(t);
}

/** Does a value look like currency ("$0.20", "USD 1.23", "(1.05)")? */
function looksCurrency(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /^-?\s*[$€£]\s*-?[\d,]+(\.\d+)?$/.test(t) || /^\(\s*[$€£][\d,]+(\.\d+)?\s*\)$/.test(t) || /^(usd|cad)\s/i.test(t);
}

/** Does a value parse as a plain finite number (usage-shaped)? */
function looksNumeric(s: string): boolean {
  const t = s.trim().replace(/,/g, "");
  if (!t) return false;
  return /^-?\d+(\.\d+)?$/.test(t) && Number.isFinite(parseFloat(t));
}

/** Direction-like enum: small value set within known consumption/export words. */
const DIRECTION_WORDS = new Set(["delivered", "received", "consumption", "generation", "import", "export", "net"]);

/** Meter-id-like: repeated short alphanumeric tokens, low cardinality, not numeric-continuous. */
function classifyEnumish(values: string[]): "direction" | "meterish" | null {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (nonEmpty.length < 3) return null;
  const uniq = new Set(nonEmpty.map((v) => v.trim().toLowerCase()));
  if (uniq.size === 0 || uniq.size > Math.max(4, nonEmpty.length * 0.05)) return null;
  const allDirection = Array.from(uniq).every((v) => DIRECTION_WORDS.has(v));
  if (allDirection) return "direction";
  // meter-ish: low-cardinality alphanumeric ids (E100, G123456, 1N4392)
  const allIdish = Array.from(uniq).every((v) => /^[a-z0-9\-_]{2,24}$/i.test(v));
  if (allIdish && uniq.size <= 12) return "meterish";
  return null;
}

/**
 * Classify each column by sampling its values, then propose a column mapping.
 * `headers` and `data` come from rowsToFile (data = array of header-keyed rows).
 */
export function inferColumns(headers: string[], data: Record<string, Cell>[]): InferredColumns {
  const sample = data.slice(0, 200);
  const out: InferredColumns = {
    dtCol: null,
    dateCol: null,
    timeCol: null,
    usageCol: null,
    demandCol: null,
    currencyCols: [],
    directionCol: null,
    meterCol: null,
    disclosures: [],
  };
  if (sample.length < 3) return out;

  interface ColStat {
    header: string;
    idx: number;
    n: number;
    dt: number;
    dateOnly: number;
    timeOnly: number;
    currency: number;
    numeric: number;
    enumish: "direction" | "meterish" | null;
    numericValues: number[];
  }
  const stats: ColStat[] = headers.map((h, idx) => {
    const values = sample.map((r) => String(r[h] ?? ""));
    const nonEmpty = values.filter((v) => v.trim() !== "");
    const s: ColStat = {
      header: h,
      idx,
      n: nonEmpty.length,
      dt: nonEmpty.filter(looksDateTime).length,
      dateOnly: nonEmpty.filter(looksDateOnly).length,
      timeOnly: nonEmpty.filter(looksTimeOnly).length,
      currency: nonEmpty.filter(looksCurrency).length,
      numeric: nonEmpty.filter(looksNumeric).length,
      enumish: classifyEnumish(values),
      numericValues: nonEmpty.filter(looksNumeric).map((v) => parseFloat(v.replace(/,/g, ""))),
    };
    return s;
  });

  const threshold = (s: ColStat) => Math.max(3, s.n * 0.8);

  // Currency columns first — they are excluded from every other role (INFER-3).
  for (const s of stats) {
    if (s.n >= 3 && s.currency >= threshold(s)) {
      out.currencyCols.push(s.header);
      out.disclosures.push(`Column "${s.header}" classified as cost/currency by value shape — excluded from usage`);
    }
  }
  const isCurrency = (h: string) => out.currencyCols.includes(h);

  // Datetime: highest datetime-share column wins.
  const dtCands = stats.filter((s) => !isCurrency(s.header) && s.dt >= threshold(s)).sort((a, b) => b.dt - a.dt);
  if (dtCands.length > 0) {
    out.dtCol = dtCands[0].header;
    out.disclosures.push(`Column "${out.dtCol}" inferred as interval timestamp by value shape (e.g. datetime-formatted values)`);
  } else {
    // Separate date + time pair.
    const dCands = stats.filter((s) => !isCurrency(s.header) && s.dateOnly >= threshold(s)).sort((a, b) => b.dateOnly - a.dateOnly);
    const tCands = stats.filter((s) => !isCurrency(s.header) && s.timeOnly >= threshold(s)).sort((a, b) => b.timeOnly - a.timeOnly);
    if (dCands.length > 0) {
      out.dateCol = dCands[0].header;
      out.disclosures.push(`Column "${out.dateCol}" inferred as date by value shape`);
      if (tCands.length > 0 && tCands[0].header !== out.dateCol) {
        out.timeCol = tCands[0].header;
        out.disclosures.push(`Column "${out.timeCol}" inferred as time-of-day by value shape`);
      }
    }
  }

  // Direction / meter enums.
  for (const s of stats) {
    if (s.enumish === "direction" && !out.directionCol) {
      out.directionCol = s.header;
      out.disclosures.push(`Column "${s.header}" inferred as usage-direction flag (values like Delivered/Received)`);
    } else if (s.enumish === "meterish" && !out.meterCol) {
      out.meterCol = s.header;
      out.disclosures.push(`Column "${s.header}" inferred as meter identifier (repeated low-cardinality ids)`);
    }
  }

  // Usage: numeric-dominant columns not already claimed; prefer fractional,
  // non-monotonic values (interval usage varies; ids/account numbers don't).
  const claimed = new Set([out.dtCol, out.dateCol, out.timeCol, out.directionCol, out.meterCol].filter(Boolean) as string[]);
  const usageCands = stats
    .filter((s) => !isCurrency(s.header) && !claimed.has(s.header) && s.n >= 3 && s.numeric >= threshold(s))
    .map((s) => {
      const vals = s.numericValues;
      const uniq = new Set(vals).size;
      const fractional = vals.filter((v) => !Number.isInteger(v)).length / Math.max(1, vals.length);
      const allHugeInts = vals.length > 0 && vals.every((v) => Number.isInteger(v) && Math.abs(v) > 10000);
      // ids/account numbers: near-constant or huge integers
      const idPenalty = (uniq <= 2 ? 1 : 0) + (allHugeInts ? 1 : 0);
      return { s, score: fractional * 2 + uniq / Math.max(1, vals.length) - idPenalty * 3 };
    })
    .sort((a, b) => b.score - a.score);
  if (usageCands.length > 0 && usageCands[0].score > -1) {
    out.usageCol = usageCands[0].s.header;
    out.disclosures.push(`Column "${out.usageCol}" inferred as usage by value shape (numeric interval-like values)`);
  }

  return out;
}
