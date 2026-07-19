/**
 * INFER-1..4 — structural column inference: layouts whose HEADER NAMES match
 * none of the known regexes must still parse when the VALUES are unambiguous,
 * and the inferred mapping must be disclosed in validation notes.
 */
import { describe, expect, it } from "vitest";
import { parseCsvIntervals } from "./ingest/parsers";

describe("structural inference: unfamiliar header names", () => {
  it("uppercase/underscore headers (USAGE_DATE / INTERVAL_VALUE style, ISO timestamps)", () => {
    const csv =
      "READING_DTTM,REG_VALUE,BILLED_AMT\n" +
      [
        "2025-03-30T19:00:00,1.8564,$0.20",
        "2025-03-30T19:15:00,1.8426,$0.20",
        "2025-03-30T19:30:00,1.7100,$0.19",
        "2025-03-30T19:45:00,1.6500,$0.18",
      ].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "export.csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(4);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(7.059, 4);
    // disclosure of inferred mapping (INFER-2)
    const blob = s[0].validation.notes.join(" | ");
    expect(blob).toMatch(/inferred as interval timestamp/i);
    expect(blob).toMatch(/inferred as usage/i);
    expect(blob).toMatch(/cost\/currency/i);
  });

  it("cryptic headers with separate date and time columns", () => {
    const csv =
      "COL_A,COL_B,COL_C\n" +
      [
        "03/30/2025,7:00 PM,1.85",
        "03/30/2025,7:15 PM,1.84",
        "03/30/2025,7:30 PM,1.71",
        "03/30/2025,7:45 PM,1.65",
      ].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "cryptic.csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(4);
    // 15-minute cadence inferred from values
    expect(s[0].points[0].durationMin).toBe(15);
    const first = new Date(s[0].points[0].ts);
    expect(first.getHours()).toBe(19);
    expect(first.getMinutes()).toBe(0);
  });

  it("direction flag under a nonstandard name is honored (export rows excluded)", () => {
    const csv =
      "TS,FLOW,VAL\n" +
      [
        "2025-03-30 19:00,Delivered,1.5",
        "2025-03-30 19:15,Delivered,1.4",
        "2025-03-30 19:30,Received,2.9",
        "2025-03-30 19:45,Delivered,1.3",
      ].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "flow.csv");
    expect(s).toHaveLength(1);
    expect(s[0].points).toHaveLength(3);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(4.2, 6);
    expect(s[0].validation.notes.join(" ")).toMatch(/Received.*excluded/i);
  });

  it("INFER-3: header literally named 'Usage' with currency values is rejected, not summed", () => {
    const csv =
      "Start,Usage\n" +
      ["03/30/2025 7:00:00 PM,$0.20", "03/30/2025 7:15:00 PM,$0.21", "03/30/2025 7:30:00 PM,$0.22"].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "trap.csv");
    // no legitimate usage column exists → no series (never cost-as-usage)
    expect(s).toHaveLength(0);
  });

  it("account-number-like huge integer column is not chosen as usage", () => {
    const csv =
      "When,Account,Reading\n" +
      [
        "2025-03-30 19:00,3000555555,1.51",
        "2025-03-30 19:15,3000555555,1.42",
        "2025-03-30 19:30,3000555555,1.38",
        "2025-03-30 19:45,3000555555,1.29",
      ].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "acct.csv");
    expect(s).toHaveLength(1);
    expect(s[0].validation.ingestedUsageSum).toBeCloseTo(5.6, 4);
  });

  it("unit-in-parentheses header still routes through name matching (no inference needed)", () => {
    const csv =
      "Interval Start,Usage (kWh)\n" +
      ["03/30/2025 7:00:00 PM,1.5", "03/30/2025 7:15:00 PM,1.4", "03/30/2025 7:30:00 PM,1.3"].join("\n") +
      "\n";
    const s = parseCsvIntervals(csv, "paren.csv");
    expect(s).toHaveLength(1);
    expect(s[0].usageUnit).toBe("kWh");
    expect(s[0].points).toHaveLength(3);
  });
});
