import { describe, expect, it } from "vitest";
import { euiPlausibility } from "./pipeline";
// CBECS 2018 Table C22, K–12 education: p25 6.2 kWh/sqft/yr.
const P25 = 6.2;
describe("benchmark plausibility guard", () => {
  it("flags an EUI under half the peer 25th percentile and names the likely input problems", () => {
    const r = euiPlausibility(2.0, P25, "public_record_estimate");
    expect(r?.flag).toBe("implausibly_low");
    expect(r?.note).toMatch(/2\.0 kWh\/sqft\/yr is under half the low end of typical peers \(6\.2\)/);
    expect(r?.note).toMatch(/public-record estimate/);
    expect(r?.note).toMatch(/every meter/);
  });
  it("does not flag efficient-but-plausible sites", () => {
    expect(euiPlausibility(3.2, P25, "public_record_estimate")).toBeNull(); // > 3.1 = ½·p25
    expect(euiPlausibility(5.0, P25, "as_entered")).toBeNull();
    expect(euiPlausibility(12, P25, "as_entered")).toBeNull();
  });
  it("words the floor-area cause by basis and fails open without a peer p25", () => {
    expect(euiPlausibility(1, P25, "placeholder")?.note).toMatch(/typical-size placeholder/);
    expect(euiPlausibility(1, P25, "as_entered")?.note).not.toMatch(/public-record|placeholder/);
    expect(euiPlausibility(1, null, "as_entered")).toBeNull();
    expect(euiPlausibility(1, 0, "as_entered")).toBeNull();
  });
});
