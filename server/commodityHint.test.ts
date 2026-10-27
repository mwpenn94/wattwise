/**
 * TEL-1 (Oct 26) — the utility chosen on Upload (?commodity from "Add utility")
 * is applied to interval files without ever mislabeling a stated unit.
 */
import { describe, expect, it } from "vitest";
import { applyCommodityHint, parseCsvIntervals } from "./ingest/parsers";

function csv(header: string): string {
  const rows = [header];
  const t0 = Date.UTC(2026, 0, 1, 7);
  for (let i = 0; i < 96; i++) {
    const d = new Date(t0 + i * 3_600_000);
    rows.push(`${d.toISOString().slice(0, 16).replace("T", " ")},${(1 + (i % 5)).toFixed(2)}`);
  }
  return rows.join("\n") + "\n";
}

describe("TEL-1 Upload utility choice", () => {
  it("applies the chosen utility and its standard unit when the file states no unit", () => {
    const [ser] = parseCsvIntervals(csv("Timestamp,Usage"), "generic.csv");
    expect(ser!.commodity).toBe("electric");
    expect(ser!.unitFromFile).toBe(false);
    const gas = applyCommodityHint(ser!, "gas");
    expect(gas).toMatchObject({ commodity: "gas", usageUnit: "therms", demandUnit: null });
    expect(gas.note).toMatch(/Imported as Natural gas as chosen/);
    const water = applyCommodityHint(ser!, "water");
    expect(water).toMatchObject({ commodity: "water", usageUnit: "gal" });
  });

  it("never relabels a unit the file states, and says so", () => {
    const [kwh] = parseCsvIntervals(csv("Timestamp,kWh"), "electric.csv");
    expect(kwh!.unitFromFile).toBe(true);
    const r = applyCommodityHint(kwh!, "gas");
    expect(r).toMatchObject({ commodity: "electric", usageUnit: "kWh" });
    expect(r.note).toMatch(/states its usage in kWh, so it was imported as Electric, not Natural gas/);
    const [ccf] = parseCsvIntervals(csv("Timestamp,CCF"), "gas.csv");
    expect(ccf!.commodity).toBe("gas");
    expect(ccf!.usageUnit).toBe("CCF");
    // UCONV-1 (Oct 26): CCF is a volume gas AND water utilities bill in, so the
    // user's water choice decides the utility; the stated unit is kept.
    const ccfWater = applyCommodityHint(ccf!, "water");
    expect(ccfWater).toMatchObject({ commodity: "water", usageUnit: "CCF", demandUnit: null });
    expect(ccfWater.note).toMatch(/both gas and water utilities use, so it was imported as Water as chosen/);
    // …but a CCF file chosen as Electric stays gas: CCF is never electricity.
    expect(applyCommodityHint(ccf!, "electric")).toMatchObject({ commodity: "gas", usageUnit: "CCF" });
  });

  it("is a no-op with no choice or a matching choice", () => {
    const [ser] = parseCsvIntervals(csv("Timestamp,Therms"), "therms.csv");
    expect(applyCommodityHint(ser!, null)).toMatchObject({ commodity: "gas", usageUnit: "therms", note: null });
    expect(applyCommodityHint(ser!, "gas")).toMatchObject({ commodity: "gas", usageUnit: "therms", note: null });
  });
});
