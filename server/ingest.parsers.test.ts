/**
 * Parser tests against REAL utility interval files (fixtures copied from the
 * owner's data set) + synthetic edge cases. Validates the BUILD-010.3 reuse
 * constraints: header scoring down to row 25, yyyymmdd compact dates, raw
 * float precision, footer-row exclusion, multi-sheet support.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCsvIntervals, parseExcelIntervals, parseEspiXml } from "./ingest/parsers";
import { airDecimate, airDetectHeaderRow, airIsSummaryRow, dateFromValue, numberValue, type Row } from "../shared/build0103";

const FIX = path.resolve(__dirname, "../tests/fixtures");
const cantex = path.join(FIX, "cantex.xlsx");
const lhc = path.join(FIX, "lhc.xlsx");
const aww = path.join(FIX, "aww.xlsx");
const csvFile = path.join(FIX, "hourly.csv");

describe("BUILD-010.3 primitives (verbatim reuse)", () => {
  it("parses yyyymmdd compact integer dates", () => {
    const d = dateFromValue(20250301);
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
    expect(d!.getMonth()).toBe(2); // March
    expect(d!.getDate()).toBe(1);
  });

  it("excludes footer/summary rows (Total =, Max =)", () => {
    expect(airIsSummaryRow(["Total = 61471.87", null, null])).toBe(true);
    expect(airIsSummaryRow(["Max = 123.4", null, null])).toBe(true);
    expect(airIsSummaryRow([20250301, "00:15", 12.5])).toBe(false);
  });

  it("preserves raw float precision through numberValue", () => {
    expect(numberValue(61471.8712345)).toBeCloseTo(61471.8712345, 7);
    expect(numberValue("1,234.5678")).toBeCloseTo(1234.5678, 4);
  });

  it("peak-preserving decimation never drops the max point (BUILD-010.3 airDecimate)", () => {
    const pts = Array.from({ length: 50_000 }, (_, i) => ({
      i,
      v: Math.sin(i / 40) * 20 + 40,
      t: i * 900_000,
    }));
    pts[31_337] = { i: 31_337, v: 999, t: 31_337 * 900_000 };
    const out = airDecimate(pts, 1500);
    expect(out.length).toBeLessThanOrEqual(3200);
    let mx = -Infinity;
    for (const p of out) if (p.v > mx) mx = p.v;
    expect(mx).toBe(999); // bucket max always retained
    // troughs preserved too: global min must survive decimation
    let mn = Infinity;
    for (const p of out) if (p.v < mn) mn = p.v;
    expect(mn).toBeCloseTo(20, 1);
  });

  it("scores headers down to row 25", () => {
    const rows: Row[] = [];
    for (let i = 0; i < 24; i++) rows.push([`junk ${i}`, null, null, null]);
    rows.push(["DATE", "TIME", "KWH_DEL", "KW_DEL"]);
    rows.push([20250301, "00:15", 1.25, 5.0]);
    const idx = airDetectHeaderRow(rows);
    expect(idx).toBe(24);
  });
});

describe("Excel parser — real utility workbooks", () => {
  it.skipIf(!existsSync(cantex))("parses the Cantex workbook: yyyymmdd dates, footer exclusion, ±0.5% total validation", () => {
    const buf = readFileSync(cantex);
    const series = parseExcelIntervals(buf);
    expect(series.length).toBeGreaterThanOrEqual(1);
    const s = series[0]!;
    expect(s.points.length).toBeGreaterThan(30_000); // ~1 yr of 15-min data
    expect(s.points.every((p) => Number.isFinite(p.ts) && Number.isFinite(p.usage))).toBe(true);
    expect(s.points[0]!.durationMin).toBe(15);
    // Footer "Total =" present and ingested sum matches within ±0.5%
    if (s.footerTotals.totalUsage != null) {
      expect(s.validation.footerUsageDeltaPct).toBeDefined();
      expect(Math.abs(s.validation.footerUsageDeltaPct!)).toBeLessThan(0.5);
      expect(s.validation.pass).toBe(true);
    }
  });

  it.skipIf(!existsSync(lhc))("parses Lake Havasu City workbook (multi-sheet service agreements)", () => {
    const buf = readFileSync(lhc);
    const series = parseExcelIntervals(buf);
    expect(series.length).toBeGreaterThanOrEqual(1);
    const total = series.reduce((n, s) => n + s.points.length, 0);
    expect(total).toBeGreaterThan(1000);
  });

  it.skipIf(!existsSync(aww))("parses American Woodmark multi-account workbook", () => {
    const buf = readFileSync(aww);
    const series = parseExcelIntervals(buf);
    expect(series.length).toBeGreaterThanOrEqual(1);
    for (const s of series) {
      expect(s.points.every((p) => Number.isFinite(p.usage))).toBe(true);
    }
  });
});

describe("CSV parser — BUILD-010.3 logic", () => {
  it.skipIf(!existsSync(csvFile))("parses the real hourly CSV export", () => {
    const text = readFileSync(csvFile, "utf-8");
    const series = parseCsvIntervals(text, "hourly.csv");
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series[0]!.points.length).toBeGreaterThan(100);
    expect(series[0]!.points[0]!.durationMin).toBe(60);
  });

  it("parses a synthetic 15-min CSV and skips summary footer", () => {
    const rows = ["Date,Time,kWh,kW"];
    for (let i = 0; i < 96; i++) {
      const hh = String(Math.floor(i / 4)).padStart(2, "0");
      const mm = String((i % 4) * 15).padStart(2, "0");
      rows.push(`2025-06-01,${hh}:${mm},1.5,6.0`);
    }
    rows.push("Total = 144,,,");
    const series = parseCsvIntervals(rows.join("\n"), "synthetic.csv");
    expect(series.length).toBe(1);
    const s = series[0]!;
    expect(s.points.length).toBe(96);
    expect(s.points.reduce((sum, p) => sum + p.usage, 0)).toBeCloseTo(144, 3);
  });
});

describe("ESPI Green Button XML parser", () => {
  it("parses IntervalBlock readings", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content>
    <espi:IntervalBlock>
      <espi:interval><espi:duration>86400</espi:duration><espi:start>1717200000</espi:start></espi:interval>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717200000</espi:start></espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717203600</espi:start></espi:timePeriod>
        <espi:value>2500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </content></entry>
</feed>`;
    const series = parseEspiXml(xml);
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series[0]!.points.length).toBe(2);
    expect(series[0]!.points[0]!.durationMin).toBe(60);
    expect(series[0]!.points[0]!.ts).toBe(1717200000 * 1000);
  });

  it("rejects XML with DOCTYPE (XXE guard)", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><feed>&xxe;</feed>`;
    expect(() => parseEspiXml(evil)).toThrow();
  });

  // Batch-36 (pass 1374): malformed readings are skipped but never silently —
  // the count lands in rowsSkipped and a disclosure note is emitted.
  it("counts and discloses skipped malformed readings (no silent data loss)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content>
    <espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717200000</espi:start></espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>not-a-number</espi:start></espi:timePeriod>
        <espi:value>2500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717207200</espi:start></espi:timePeriod>
        <espi:value>garbage</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </content></entry>
</feed>`;
    const series = parseEspiXml(xml);
    expect(series.length).toBe(1);
    expect(series[0]!.points.length).toBe(1);
    expect(series[0]!.rowsSkipped).toBe(2);
    expect(series[0]!.validation.notes.some((n) => n.includes("2 interval readings were skipped"))).toBe(true);
  });

  // Batch-37 (passes 1494/1504): present-but-malformed or non-positive
  // durations are skipped through the disclosed path — a uom-38 (Watts) feed
  // with duration garbage must never produce NaN usage.
  it("skips readings with malformed or zero durations (no NaN/inflated energy)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content>
    <espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717200000</espi:start></espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>abc</espi:duration><espi:start>1717203600</espi:start></espi:timePeriod>
        <espi:value>2500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>0</espi:duration><espi:start>1717207200</espi:start></espi:timePeriod>
        <espi:value>2500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </content></entry>
</feed>`;
    const series = parseEspiXml(xml);
    expect(series[0]!.points.length).toBe(1);
    expect(series[0]!.rowsSkipped).toBe(2);
    expect(series[0]!.points.every((p) => Number.isFinite(p.usage) && p.durationMin > 0)).toBe(true);
  });

  // Batch-54 (pass 2774): a feed whose EVERY reading is malformed must not
  // collapse into the generic "no interval data" message — the thrown error
  // names the skip count and cause (persisted verbatim on the upload row).
  it("throws a diagnostic error when every reading is malformed (not a silent empty result)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content>
    <espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>not-a-number</espi:start></espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>abc</espi:duration><espi:start>1717203600</espi:start></espi:timePeriod>
        <espi:value>2500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </content></entry>
</feed>`;
    expect(() => parseEspiXml(xml)).toThrow(/2 interval readings.*malformed/);
  });

  it("returns empty (no throw) for a feed with zero readings altogether", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content><espi:UsagePoint><espi:ServiceCategory><espi:kind>0</espi:kind></espi:ServiceCategory></espi:UsagePoint></content></entry>
</feed>`;
    expect(parseEspiXml(xml)).toEqual([]);
  });

  it("reports rowsSkipped 0 and no skip note for a clean feed", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <entry><content>
    <espi:IntervalBlock>
      <espi:IntervalReading>
        <espi:timePeriod><espi:duration>3600</espi:duration><espi:start>1717200000</espi:start></espi:timePeriod>
        <espi:value>1500</espi:value>
      </espi:IntervalReading>
    </espi:IntervalBlock>
  </content></entry>
</feed>`;
    const series = parseEspiXml(xml);
    expect(series[0]!.rowsSkipped).toBe(0);
    expect(series[0]!.validation.notes.some((n) => n.includes("skipped"))).toBe(false);
  });
});
