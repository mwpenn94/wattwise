/**
 * GAP-D / AC16a — bill-reconciliation self-calibration.
 *
 * Every time a real bill lands for a meter that has a recorded tariff, we
 * re-price the bill period on that tariff structure and compare against what
 * the utility actually charged. The result is persisted (bill_reconciliations)
 * and rolled up onto the tariff row as a trust status:
 *
 * - match (within tolerance)   → hit; enough hits ⇒ trustStatus 'verified_against_bill'
 * - mismatch (outside tolerance) → miss; enough misses ⇒ 'mismatch_review' and
 *   every downstream rate figure carries a WIDENED confidence disclosure rather
 *   than silently keeping the seeded number.
 *
 * Tolerance: 8% or $10, whichever is larger — seeded snapshots omit riders,
 * franchise fees, and taxes that legitimately move a bill a few percent.
 * A mismatch here means the STRUCTURE is probably wrong (wrong schedule,
 * changed rates), not just missing riders.
 */
import * as h from "./dbHelpers";
import { touchBillVerification } from "./seedLifecycle";
import { costOnTariff } from "./analytics/tariffEngine";
import type { TariffStructure } from "../shared/wattwise";

export const RECONCILE_TOLERANCE_PCT = 0.08;
export const RECONCILE_TOLERANCE_USD = 10;
/** hits needed (with zero misses outstanding) to mark verified */
export const VERIFY_HITS = 2;
/** misses needed to flip into mismatch_review */
export const REVIEW_MISSES = 2;

export interface ReconcileOutcome {
  reconciled: boolean;
  reason?: string;
  billId?: number;
  predictedUsd?: number;
  actualUsd?: number;
  deltaPct?: number;
  verdict?: "match" | "mismatch";
  trustStatus?: string;
}

/**
 * Reconcile one bill against the meter's recorded tariff. Fail-open: any
 * missing precondition (no tariff, unpriceable structure, zero usage) returns
 * {reconciled:false, reason} without throwing — bill ingest must never fail
 * because calibration couldn't run.
 */
export async function reconcileBill(billId: number, meterId: number, userId: number): Promise<ReconcileOutcome> {
  const bill = await h.getBill(billId, userId);
  if (!bill) return { reconciled: false, reason: "bill not found" };
  if ((bill.readType ?? "actual") === "estimated") {
    return { reconciled: false, reason: "estimated read — utilities true these up later; we don't calibrate on them" };
  }
  const meter = await h.getMeter(meterId, userId);
  if (!meter?.currentTariffId) return { reconciled: false, reason: "no tariff recorded on this meter" };
  const tariff = await h.getTariff(meter.currentTariffId);
  if (!tariff) return { reconciled: false, reason: "recorded tariff not found" };
  const usage = Number(bill.usage ?? 0);
  const actualUsd = Number(bill.totalCost ?? 0);
  if (!(usage > 0) || !(actualUsd > 0)) return { reconciled: false, reason: "bill lacks positive usage/cost" };

  // Price the single bill period. costOnTariff consumes interval points; a
  // bill only gives us a period total, so we spread it flat across the period
  // hours. Disclosure: a flat shape under-prices steep TOU spreads slightly —
  // acceptable inside the 8% tolerance, and demand charges use the BILLED kW
  // from the bill itself, not a synthetic peak.
  const startTs = new Date(bill.periodStart).getTime();
  const endTs = new Date(bill.periodEnd).getTime();
  const hours = Math.max(1, Math.round((endTs - startTs) / 3_600_000));
  if (hours > 24 * 45) return { reconciled: false, reason: "bill period longer than 45 days — not a monthly bill" };
  const perHour = usage / hours;
  const billedKw = bill.demandBilled != null ? Number(bill.demandBilled) : null;
  const points = Array.from({ length: hours }, (_, i) => ({
    ts: startTs + i * 3_600_000,
    durationMin: 60,
    usage: perHour,
    demand: billedKw,
  }));
  let predictedUsd: number;
  try {
    const cost = costOnTariff(points, tariff.structure as TariffStructure);
    predictedUsd = cost.breakdown.total;
  } catch (e) {
    return { reconciled: false, reason: `structure unpriceable: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!(predictedUsd > 0)) return { reconciled: false, reason: "predicted cost non-positive" };

  const deltaUsd = Math.abs(predictedUsd - actualUsd);
  const deltaPct = deltaUsd / actualUsd;
  const withinTolerance = deltaPct <= RECONCILE_TOLERANCE_PCT || deltaUsd <= RECONCILE_TOLERANCE_USD;
  const verdict = withinTolerance ? ("match" as const) : ("mismatch" as const);

  await h.createBillReconciliation({
    siteId: meter.siteId,
    userId,
    billId,
    tariffId: tariff.id,
    predictedUsd: Math.round(predictedUsd * 100) / 100,
    actualUsd: Math.round(actualUsd * 100) / 100,
    deltaPct: Math.round(deltaPct * 1000) / 1000,
    verdict,
    createdAt: Date.now(),
  });

  // Roll up onto the tariff's trust status.
  const hits = (tariff.reconcileHits ?? 0) + (verdict === "match" ? 1 : 0);
  const misses = (tariff.reconcileMisses ?? 0) + (verdict === "mismatch" ? 1 : 0);
  let trustStatus: "seeded" | "verified_against_bill" | "mismatch_flagged" = tariff.trustStatus ?? "seeded";
  if (misses >= REVIEW_MISSES && misses > hits) trustStatus = "mismatch_flagged";
  else if (hits >= VERIFY_HITS && hits > misses) trustStatus = "verified_against_bill";
  else if (verdict === "mismatch" && trustStatus === "verified_against_bill") trustStatus = "mismatch_flagged";
  await h.updateTariffTrust(tariff.id, { trustStatus, reconcileHits: hits, reconcileMisses: misses, trustUpdatedAt: Date.now() });
  // v1.22 non-URDB tariff freshness: currency is earned from bills — any
  // within-tolerance match resets this tariff's bill-verification clock.
  if (verdict === "match") {
    await touchBillVerification(tariff.id).catch(() => undefined);
  }

  return {
    reconciled: true,
    billId,
    predictedUsd: Math.round(predictedUsd * 100) / 100,
    actualUsd: Math.round(actualUsd * 100) / 100,
    deltaPct: Math.round(deltaPct * 1000) / 1000,
    verdict,
    trustStatus,
  };
}

/** Human chip label + disclosure for a tariff's trust status — used by every
 * surface that quotes a rate-derived dollar figure. */
export function tariffTrustDisclosure(trustStatus: string | null | undefined): { label: string; disclosure: string | null } {
  switch (trustStatus ?? "seeded") {
    case "verified_against_bill":
      return {
        label: "Verified against your bills",
        disclosure: null,
      };
    case "mismatch_flagged":
      return {
        label: "Rate under review",
        disclosure:
          "Recent bills didn't match what this rate schedule predicts — the seeded rate may be outdated or the wrong schedule. Dollar figures based on this rate carry wider uncertainty until it's resolved; check the rate name on your latest bill.",
      };
    default:
      return {
        label: "Seeded rate",
        disclosure: "This rate comes from our seeded snapshot and hasn't been verified against your actual bills yet.",
      };
  }
}
