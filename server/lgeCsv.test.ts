/**
 * LGE-1..4 — LG&E/KU (Louisville Gas & Electric / Kentucky Utilities) MyMeter
 * CSV export support. Layouts verified against the official "My Meter — How to
 * Download Data" guide (lge-ku.com): single datetime column named "Start" or
 * "Read Date" (MM/DD/YYYY h:mm:ss AM/PM), user-selectable columns (Account
 * Number, Name, Meter, Location, Address, Usage Direction), a usage column
 * named after the UNIT itself ("kWh", "CCF", "Gallons"), and a literal "$"
 * cost column. Rows may be sorted by usage (not time) via Row Sort Order.
 */
import { describe, expect, it } from "vitest";
import { parseCsvIntervals, parseExcelIntervals } from "./ingest/parsers";
import * as XLSX from "xlsx";

function elecCsv(rows: string[]): string {
  return "Start,Usage Direction,kWh,$\n" + rows.join("\n") + "\n";
}

const ELEC_ROWS = [
  "03/30/2025 7:00:00 PM,Delivered,1.8564,$0.20",
  "03/30/2025 7:15:00 PM,Delivered,1.8426,$0.20",
  "04/18/2025 9:00:00 PM,Delivered,1.635,$0.18",
  "04/21/2025 8:00:00 AM,Delivered,1.5324,$0.17",
  "03/30/2025 6:45:00 PM,Delivered,1.524,$0.17",
  "04/19/2025 7:15:00 AM,Delivered,1.4814,$0.16",
];

describe("LG&E/KU MyMeter electric CSV (Start / Usage Direction / kWh / $)", () => {
  it("parses the exact layout from the official guide", () => {
    const s = parseCsvIntervals(elecCsv(ELEC_ROWS), "Usage (1).csv");
    expect(s).toHaveLength(1);
    expect(s[0].commodity).toBe("electric");
    expect(s[0].usageUnit).toBe("kWh");
    expect(s[0].points).toHaveLength(6);
    // $ column must never be picked as usage: first point (chronological) is 6:45 PM @ 1.524
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(1.8564 + 1.8426 + 1.635 + 1.5324 + 1.524 + 1.4814, 6);
  });

  it("re-sorts rows chronologically (MyMeter Row Sort Order can sort by kWh desc)", () => {
    const s = parseCsvIntervals(elecCsv(ELEC_ROWS), "Usage (1).csv");
    const tss = s[0].points.map((p) => p.ts);
    const sorted = [...tss].sort((a, b) => a - b);
    expect(tss).toEqual(sorted);
    // Earliest point is 03/30/2025 6:45 PM local
    const first = new Date(s[0].points[0].ts);
    expect(first.getMonth()).toBe(2);
    expect(first.getDate()).toBe(30);
    expect(first.getHours()).toBe(18);
    expect(first.getMinutes()).toBe(45);
  });

  it("excludes Received (net-metering export) rows from consumption with disclosure", () => {
    const rows = [...ELEC_ROWS, "04/21/2025 12:00:00 PM,Received,2.5,$0.00", "04/21/2025 12:15:00 PM,Received,2.1,$0.00"];
    const s = parseCsvIntervals(elecCsv(rows), "Usage (1).csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(6);
    expect(s[0].rowsSkipped).toBe(2);
    expect(s[0].validation.notes.join(" ")).toMatch(/Received.*excluded/i);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(9.8718, 4);
  });
});

describe("LG&E/KU MyMeter gas CSV (Read Date / CCF)", () => {
  const gas =
    "Read Date,Account Number,Meter,Usage Direction,CCF,$\n" +
    [
      "03/30/2025 8:00:00 AM,3000555555,G123456,Delivered,0.42,$0.55",
      "03/30/2025 9:00:00 AM,3000555555,G123456,Delivered,0.38,$0.50",
      "03/30/2025 10:00:00 AM,3000555555,G123456,Delivered,0.35,$0.46",
      "03/30/2025 11:00:00 AM,3000555555,G123456,Delivered,0.31,$0.41",
    ].join("\n") +
    "\n";

  it("parses gas with commodity=gas and the file's ACTUAL unit (CCF, not therms)", () => {
    const s = parseCsvIntervals(gas, "Usage (2).csv");
    expect(s).toHaveLength(1);
    expect(s[0].commodity).toBe("gas");
    expect(s[0].usageUnit).toBe("CCF");
    expect(s[0].points).toHaveLength(4);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(1.46, 6);
    // hourly cadence inferred
    expect(s[0].points[0].durationMin).toBe(60);
  });
});

describe("MyMeter-style water CSV (Gallons)", () => {
  const water =
    "Start,Usage Direction,Gallons,$\n" +
    ["03/30/2025 8:00:00 AM,Delivered,12.5,$0.08", "03/30/2025 9:00:00 AM,Delivered,10.2,$0.07", "03/30/2025 10:00:00 AM,Delivered,9.8,$0.06"].join("\n") +
    "\n";

  it("parses water with gal unit", () => {
    const s = parseCsvIntervals(water, "water.csv");
    expect(s).toHaveLength(1);
    expect(s[0].commodity).toBe("water");
    expect(s[0].usageUnit).toBe("gal");
    expect(s[0].points).toHaveLength(3);
  });
});

describe("multi-meter MyMeter downloads (Meter column interleaved)", () => {
  const multi =
    "Start,Meter,Usage Direction,kWh,$\n" +
    [
      "03/30/2025 7:00:00 PM,E100,Delivered,1.1,$0.12",
      "03/30/2025 7:00:00 PM,E200,Delivered,0.9,$0.10",
      "03/30/2025 7:15:00 PM,E100,Delivered,1.2,$0.13",
      "03/30/2025 7:15:00 PM,E200,Delivered,0.8,$0.09",
      "03/30/2025 7:30:00 PM,E100,Delivered,1.3,$0.14",
      "03/30/2025 7:30:00 PM,E200,Delivered,0.7,$0.08",
    ].join("\n") +
    "\n";

  it("splits into one series per meter", () => {
    const s = parseCsvIntervals(multi, "Usage (3).csv");
    expect(s).toHaveLength(2);
    const keys = s.map((x) => x.sourceKey).sort();
    expect(keys[0]).toMatch(/meter E100/);
    expect(keys[1]).toMatch(/meter E200/);
    const e100 = s.find((x) => x.sourceKey.includes("E100"))!;
    const e200 = s.find((x) => x.sourceKey.includes("E200"))!;
    expect(e100.points).toHaveLength(3);
    expect(e200.points).toHaveLength(3);
    expect(e100.validation.ingestedUsageSum).toBeCloseTo(3.6, 6);
    expect(e200.validation.ingestedUsageSum).toBeCloseTo(2.4, 6);
  });
});

describe("date-only Read Date (monthly export) still parses", () => {
  const monthly =
    "Read Date,kWh\n" +
    ["01/31/2025,850.2", "02/28/2025,791.4", "03/31/2025,702.9", "04/30/2025,655.1"].join("\n") +
    "\n";

  it("parses month-granularity rows via the datetime column path", () => {
    const s = parseCsvIntervals(monthly, "monthly.csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(4);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(2999.6, 4);
  });
});

describe("MyMeter CSV opened and re-saved as real .xlsx", () => {
  it("parses via the Excel path with identical semantics", () => {
    const rows = [
      ["Start", "Usage Direction", "kWh", "$"],
      ...ELEC_ROWS.map((r) => r.split(",")),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Usage");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const s = parseExcelIntervals(buf);
    expect(s).toHaveLength(1);
    expect(s[0].commodity).toBe("electric");
    expect(s[0].points).toHaveLength(6);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(9.8718, 4);
  });
});

describe("regressions: prior formats keep working", () => {
  it("classic Date + Time + kWh layout is unaffected", () => {
    const classic =
      "Date,Time,kWh\n" +
      ["01/05/2025,00:15,0.42", "01/05/2025,00:30,0.40", "01/05/2025,00:45,0.44", "01/05/2025,01:00,0.41"].join("\n") +
      "\n";
    const s = parseCsvIntervals(classic, "classic.csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(4);
    expect(s[0].points[0].durationMin).toBe(15);
  });

  it("a '$'-only numeric column with no usage column still returns no series (never cost-as-usage)", () => {
    const costOnly = "Start,$\n" + ["03/30/2025 7:00:00 PM,$0.20", "03/30/2025 7:15:00 PM,$0.21", "03/30/2025 7:30:00 PM,$0.22"].join("\n") + "\n";
    const s = parseCsvIntervals(costOnly, "cost.csv");
    expect(s).toHaveLength(0);
  });
});
