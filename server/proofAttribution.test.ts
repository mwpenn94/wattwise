import { describe, expect, it } from "vitest";
import { attributableIds, attributableVerifiedUsd, creditableVerifiedUsd, isAttributable, sanitizeProofRows, type ProofRow } from "./proofAttribution";

const row = (o: Partial<ProofRow> & { id: number; siteId: number }): ProofRow => ({
  status: "verified",
  verifiedSavingsUsd: 150,
  baselineId: 10,
  analysisMeterId: 20,
  ...o,
});

describe("verified-savings attribution gate (R4 #2)", () => {
  it("never credits one whole-site observation to several measures", () => {
    // R4 reproduction: LED and HVAC on the same site each scored $150 from the
    // same $150 site delta — the old sum was $300.
    const rows = [row({ id: 1, siteId: 7 }), row({ id: 2, siteId: 7 })];
    expect(attributableVerifiedUsd(rows)).toBe(0);
    expect(attributableIds(rows).size).toBe(0);
    const shown = sanitizeProofRows(rows);
    expect(shown.every((r) => r.verifiedSavingsUsd === null && r.status === "inconclusive" && !r.attributable)).toBe(true);
  });
  it("withholds implementations without a pinned pre-change baseline or meter", () => {
    expect(attributableVerifiedUsd([row({ id: 1, siteId: 1, baselineId: null })])).toBe(0);
    expect(attributableVerifiedUsd([row({ id: 2, siteId: 2, analysisMeterId: null })])).toBe(0);
  });
  it("credits a sole, pinned implementation and sums across distinct sites", () => {
    const rows = [row({ id: 1, siteId: 1, verifiedSavingsUsd: 120 }), row({ id: 2, siteId: 2, verifiedSavingsUsd: 80 })];
    expect(attributableVerifiedUsd(rows)).toBe(200);
    expect(isAttributable(rows[0]!, rows)).toBe(true);
    expect(sanitizeProofRows(rows).map((r) => r.verifiedSavingsUsd)).toEqual([120, 80]);
  });
  it("keeps awaiting_data status but never reports a withheld row as verified", () => {
    const rows = [row({ id: 1, siteId: 3, status: "awaiting_data" }), row({ id: 2, siteId: 3, status: "verified" })];
    expect(sanitizeProofRows(rows).map((r) => r.status)).toEqual(["awaiting_data", "inconclusive"]);
  });
  it("ignores negative or non-finite amounts", () => {
    expect(attributableVerifiedUsd([row({ id: 1, siteId: 1, verifiedSavingsUsd: -40 })])).toBe(0);
    expect(attributableVerifiedUsd([row({ id: 2, siteId: 2, verifiedSavingsUsd: Number.NaN })])).toBe(0);
  });
  it("never credits early reads: a sole, pinned on_track row contributes $0 to verified totals", () => {
    const early = row({ id: 7, siteId: 7, status: "on_track", verifiedSavingsUsd: 500 });
    expect(attributableVerifiedUsd([early])).toBe(0);
    expect(creditableVerifiedUsd(early)).toBe(0);
    const done = row({ id: 8, siteId: 8, status: "verified", verifiedSavingsUsd: 500 });
    expect(attributableVerifiedUsd([done])).toBe(500);
    expect(attributableVerifiedUsd([row({ id: 9, siteId: 9, status: "underperforming", verifiedSavingsUsd: 90 })])).toBe(0);
  });
});
