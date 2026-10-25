/**
 * Verified-savings attribution gate (R4 #2, Oct 2026 — INTERIM).
 *
 * Measured savings are a whole-site observation: actual usage versus a
 * weather-normalized counterfactual for ONE analysis meter. Crediting that same
 * observation to several measures, or scoring it against a baseline that was
 * refit after the change, overstates proof. Until a unique
 * site/commodity/month savings ledger with per-measure allocation exists, a
 * verified dollar amount is attributable ONLY when:
 *   1. the implementation pinned an immutable pre-change baseline and analysis
 *      meter at creation (baselineId + analysisMeterId), and
 *   2. it is the only implementation on its site (no shared whole-site credit).
 * Everything else keeps its progress record but its dollars are withheld — never
 * summed — and its status reads "inconclusive" rather than "verified".
 */
export type ProofStatus = "awaiting_data" | "on_track" | "verified" | "underperforming" | "inconclusive";

export interface ProofRow {
  id: number;
  siteId: number;
  status: ProofStatus;
  verifiedSavingsUsd: number | null;
  baselineId?: number | null;
  analysisMeterId?: number | null;
}

export const ATTRIBUTION_WITHHELD_DISCLOSURE =
  "Savings attribution withheld: this measure has no pinned pre-change baseline, or it shares one whole-site observation with other measures. Progress is kept; dollars are not credited until per-measure allocation is available.";

/** Ids of implementations whose verified dollars may be credited. */
export function attributableIds(rows: ProofRow[]): Set<number> {
  const perSite = new Map<number, number>();
  for (const r of rows) perSite.set(r.siteId, (perSite.get(r.siteId) ?? 0) + 1);
  const ok = new Set<number>();
  for (const r of rows) {
    if (r.baselineId != null && r.analysisMeterId != null && (perSite.get(r.siteId) ?? 0) === 1) ok.add(r.id);
  }
  return ok;
}

/** Whether a single implementation is attributable given its site's full implementation list. */
export function isAttributable(row: ProofRow, siteRows: ProofRow[]): boolean {
  return attributableIds(siteRows.filter((r) => r.siteId === row.siteId)).has(row.id);
}

/**
 * Display-safe copy of each row: attributable rows keep their amount; others
 * get verifiedSavingsUsd=null and a non-verified status.
 */
export function sanitizeProofRows<T extends ProofRow>(rows: T[]): Array<T & { attributable: boolean }> {
  const ok = attributableIds(rows);
  return rows.map((r) => {
    if (ok.has(r.id)) return { ...r, attributable: true };
    const status: ProofStatus = r.status === "awaiting_data" ? "awaiting_data" : "inconclusive";
    return { ...r, status, verifiedSavingsUsd: null, attributable: false };
  });
}

/**
 * Dollars that may be summed or labeled "verified": attributable AND the
 * evaluator's status is "verified" (>= 3 evaluable months). Early reads
 * (on_track / underperforming) keep their row amount for display as an early
 * read, but are never added into a verified total.
 */
export function creditableVerifiedUsd(row: ProofRow): number {
  const v = Number(row.verifiedSavingsUsd ?? 0);
  return row.status === "verified" && Number.isFinite(v) && v > 0 ? v : 0;
}
/** Sum of attributable, status-verified dollars only. */
export function attributableVerifiedUsd(rows: ProofRow[]): number {
  const ok = attributableIds(rows);
  return rows.reduce((sum, r) => (ok.has(r.id) ? sum + creditableVerifiedUsd(r) : sum), 0);
}
