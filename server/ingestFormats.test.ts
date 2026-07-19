/**
 * ING-1..4 (owner report Jul 19): upload ingestion format coverage.
 *
 * The owner's utility ships Green Button exports as .zip bundles containing an
 * EXTENSIONLESS ESPI Atom XML ("HourlyIntervalData") plus a companion
 * GreenButtonDataStyleSheet.xslt. Users also upload raw CSVs and CSV data
 * re-saved as .xlsx. These tests pin:
 *  - magic-byte detection distinguishes real OOXML workbooks from generic zips
 *  - preParseGate accepts the new "zip" and "auto" format labels
 *  - archive extraction skips stylesheets/metadata and routes extensionless
 *    members by CONTENT
 *  - each format parses end-to-end through the real parsers
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import * as XLSX from "xlsx";
import { detectMagicBytes, preParseGate } from "./ingest/hardening";
import { extractZipMembers, MAX_ZIP_MEMBERS } from "./ingest/archive";
import { parseCsvIntervals, parseEspiXml, parseExcelIntervals } from "./ingest/parsers";

/* ---------------- fixture builders (mirror the user's real exports) ---------------- */

const START = Date.UTC(2026, 5, 1, 7) / 1000;
const HOURS = 24 * 3;

function buildEspiXml(): string {
  let readings = "";
  for (let i = 0; i < HOURS; i++) {
    const t = START + i * 3600;
    readings += `<IntervalReading><timePeriod><duration>3600</duration><start>${t}</start></timePeriod><value>${900 + i}</value></IntervalReading>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="GreenButtonDataStyleSheet.xslt"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:espi="http://naesb.org/espi">
  <id>urn:uuid:test-feed</id>
  <entry><content><espi:UsagePoint xmlns="http://naesb.org/espi"><ServiceCategory><kind>0</kind></ServiceCategory></espi:UsagePoint></content></entry>
  <entry><content><espi:ReadingType xmlns="http://naesb.org/espi"><powerOfTenMultiplier>0</powerOfTenMultiplier><uom>72</uom></espi:ReadingType></content></entry>
  <entry><content><espi:IntervalBlock xmlns="http://naesb.org/espi">${readings}</espi:IntervalBlock></content></entry>
</feed>`;
}

const XSLT = `<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><html/></xsl:template></xsl:stylesheet>`;

function buildCsv(): string {
  let csv = "Date,Time,kWh\n";
  for (let i = 0; i < HOURS; i++) {
    const d = new Date((START + i * 3600) * 1000);
    csv += `${d.toISOString().slice(0, 10)},${d.toISOString().slice(11, 16)},${(0.9 + i / 1000).toFixed(3)}\n`;
  }
  return csv;
}

function buildCsvAsXlsx(): Buffer {
  const rows = buildCsv().trim().split("\n").map((l) => l.split(","));
  const ws = XLSX.utils.aoa_to_sheet([rows[0], ...rows.slice(1).map((r) => [r[0], r[1], Number(r[2])])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "HourlyIntervalData");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

/** The user's exact bundle layout: extensionless XML + stylesheet. */
function buildGreenButtonZip(includeXslt = true): Buffer {
  const members: Record<string, Uint8Array> = { HourlyIntervalData: strToU8(buildEspiXml()) };
  if (includeXslt) members["GreenButtonDataStyleSheet.xslt"] = strToU8(XSLT);
  return Buffer.from(zipSync(members));
}

/* ---------------- magic-byte detection ---------------- */

describe("detectMagicBytes — zip vs OOXML workbook (ING-2)", () => {
  it("classifies a real xlsx workbook as xlsx", () => {
    expect(detectMagicBytes(buildCsvAsXlsx())).toBe("xlsx");
  });
  it("classifies a Green Button bundle zip as zip, NOT xlsx", () => {
    expect(detectMagicBytes(buildGreenButtonZip())).toBe("zip");
  });
  it("classifies ESPI XML with stylesheet PI as xml", () => {
    expect(detectMagicBytes(Buffer.from(buildEspiXml()))).toBe("xml");
  });
  it("classifies plain CSV as csv_text", () => {
    expect(detectMagicBytes(Buffer.from(buildCsv()))).toBe("csv_text");
  });
});

describe("preParseGate — new format labels (ING-2/ING-3)", () => {
  it("accepts a zip-labeled archive", () => {
    expect(preParseGate(buildGreenButtonZip(), "zip").ok).toBe(true);
  });
  it("accepts every interval content type under auto (extensionless uploads)", () => {
    expect(preParseGate(Buffer.from(buildEspiXml()), "auto").ok).toBe(true);
    expect(preParseGate(Buffer.from(buildCsv()), "auto").ok).toBe(true);
    expect(preParseGate(buildCsvAsXlsx(), "auto").ok).toBe(true);
    expect(preParseGate(buildGreenButtonZip(), "auto").ok).toBe(true);
  });
  it("still rejects images under auto", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(preParseGate(png, "auto").ok).toBe(false);
  });
});

/* ---------------- archive extraction ---------------- */

describe("extractZipMembers — Green Button bundles (ING-3)", () => {
  it("routes the extensionless XML member to espi_xml and skips the XSLT", () => {
    const zx = extractZipMembers(buildGreenButtonZip());
    expect(zx.ok).toBe(true);
    const data = zx.members.find((m) => m.name === "HourlyIntervalData");
    const style = zx.members.find((m) => m.name === "GreenButtonDataStyleSheet.xslt");
    expect(data?.route).toBe("espi_xml");
    expect(style?.route).toBeNull();
    expect(style?.skipReason).toMatch(/stylesheet/i);
  });
  it("handles a zip with only the XML member", () => {
    const zx = extractZipMembers(buildGreenButtonZip(false));
    expect(zx.ok).toBe(true);
    expect(zx.members.filter((m) => m.route !== null)).toHaveLength(1);
  });
  it("routes csv and xlsx members by content", () => {
    const zx = extractZipMembers(
      Buffer.from(zipSync({ "usage.csv": strToU8(buildCsv()), "workbook.xlsx": new Uint8Array(buildCsvAsXlsx()) })),
    );
    expect(zx.ok).toBe(true);
    expect(zx.members.find((m) => m.name === "usage.csv")?.route).toBe("csv");
    expect(zx.members.find((m) => m.name === "workbook.xlsx")?.route).toBe("xlsx");
  });
  it("skips OS metadata and hidden members", () => {
    const zx = extractZipMembers(
      Buffer.from(zipSync({ "__MACOSX/._junk": strToU8("junk"), ".DS_Store": strToU8("junk"), data: strToU8(buildEspiXml()) })),
    );
    expect(zx.ok).toBe(true);
    expect(zx.members.filter((m) => m.route !== null).map((m) => m.name)).toEqual(["data"]);
  });
  it("rejects nested archives with a clear reason instead of recursing", () => {
    const inner = zipSync({ data: strToU8(buildCsv()) });
    const zx = extractZipMembers(Buffer.from(zipSync({ "inner.zip": inner })));
    expect(zx.ok).toBe(true);
    const m = zx.members.find((x) => x.name === "inner.zip");
    expect(m?.route).toBeNull();
    expect(m?.skipReason).toMatch(/nested archive/i);
  });
  it("enforces the member-count cap", () => {
    const members: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_MEMBERS; i++) members[`f${i}.csv`] = strToU8("a,b\n1,2\n");
    const zx = extractZipMembers(Buffer.from(zipSync(members)));
    expect(zx.ok).toBe(false);
    expect(zx.reason).toMatch(/too many members/i);
  });
  it("fails structurally-broken archives without throwing", () => {
    const zx = extractZipMembers(Buffer.from("PK\x03\x04not-actually-a-zip"));
    expect(zx.ok).toBe(false);
  });
});

/* ---------------- end-to-end parses per user-reported format ---------------- */

describe("parser round-trips for every reported failing format (ING-4)", () => {
  it("Green Button XML (with stylesheet PI) parses hourly electric intervals", () => {
    const series = parseEspiXml(buildEspiXml());
    expect(series).toHaveLength(1);
    expect(series[0].commodity).toBe("electric");
    expect(series[0].points).toHaveLength(HOURS);
    // uom 72 = Wh with multiplier 0 → converted to kWh
    expect(series[0].usageUnit).toBe("kWh");
  });
  it("zip bundle member parses identically to the raw XML", () => {
    const zx = extractZipMembers(buildGreenButtonZip());
    const member = zx.members.find((m) => m.route === "espi_xml")!;
    const series = parseEspiXml(member.bytes.toString("utf8"));
    expect(series[0].points).toHaveLength(HOURS);
  });
  it("hourly CSV parses", () => {
    const series = parseCsvIntervals(buildCsv(), "hourly.csv");
    expect(series).toHaveLength(1);
    expect(series[0].points).toHaveLength(HOURS);
  });
  it("CSV data saved as .xlsx parses", () => {
    const series = parseExcelIntervals(buildCsvAsXlsx());
    expect(series).toHaveLength(1);
    expect(series[0].points).toHaveLength(HOURS);
    expect(series[0].sourceKey).toBe("HourlyIntervalData");
  });
});
