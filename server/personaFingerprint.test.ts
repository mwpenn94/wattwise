/**
 * v1.20 block E — dead-end persona fingerprints are PII-free by construction.
 */
import { describe, expect, it } from "vitest";
import { sanitizeFingerprint } from "./personaFingerprint";

describe("dead-end persona fingerprints (v1.20 block E)", () => {
  it("strips forbidden identity keys entirely", () => {
    const out = sanitizeFingerprint({
      deadEnd: "parse_failed_csv",
      userId: 42,
      address: "123 Main St",
      email: "a@b.com",
      name: "Riverside Dental",
      zip: "85004",
      tenure: "rent",
    });
    expect(out).toEqual({ deadEnd: "parse_failed_csv", tenure: "rent" });
  });

  it("rejects digit-heavy strings that could be addresses, zips, or account numbers", () => {
    const out = sanitizeFingerprint({
      deadEnd: "no_tariffs_for_region",
      region: "AZ",
      sneaky: "account 4471982210",
    });
    expect(out.region).toBe("AZ");
    expect(out.sneaky).toBeUndefined();
  });

  it("rejects long free-text values — categorical coordinates only", () => {
    const out = sanitizeFingerprint({
      deadEnd: "csv_headers_unknown",
      note: "the user said their utility is Salt River Project and the file came from their portal export page",
    });
    expect(out.note).toBeUndefined();
  });

  it("keeps categorical/boolean/numeric coverage-matrix coordinates", () => {
    const out = sanitizeFingerprint({
      deadEnd: "empty_file_xlsx",
      hasSolar: true,
      buildingClass: "single_family",
      dataState: "bills_only",
      language: "es",
      tier: "free",
    });
    expect(out).toEqual({
      deadEnd: "empty_file_xlsx",
      hasSolar: true,
      buildingClass: "single_family",
      dataState: "bills_only",
      language: "es",
      tier: "free",
    });
  });
});
