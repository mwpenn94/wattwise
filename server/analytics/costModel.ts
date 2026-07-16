/**
 * Unit-economics instrumentation (Cycle 5/6 — AC5 made verifiable).
 *
 * Cost model definition:
 * - "Marginal cost" = variable out-of-pocket cost only (LLM tokens at list
 *   price + compute at serverless $/CPU-second). Fixed hosting excluded.
 * - Attribution boundary: one "analysis" = the synchronous job graph triggered
 *   by a single upload-and-analyze or wizard-run action (parse + baseline +
 *   demand + tariff sweep + scenarios + insights), excluding later async
 *   refinements which meter separately.
 *
 * Cost-bearing events (unit costs, sources):
 * - LLM fallback (bill OCR):   gpt-4.1-mini class @ $0.40/M in, $1.60/M out
 * - Compute:                    $0.000024/CPU-second (Cloud Run 1 vCPU tier)
 * - Storage write:              $0.000005/MB-month marginal — negligible, tracked as 0
 * - Seeded-data reads:          $0 (bundled)
 *
 * Enforcement:
 * - Free tier: per-analysis marginal cost must stay ≤ FREE_TIER_MAX_COST_USD
 *   ($0.20). Pre-flight LLM budget check downgrades to template-only parsing
 *   (kill-switch) when the account's month-to-date LLM spend would exceed
 *   FREE_TIER_MONTHLY_LLM_BUDGET_USD.
 * - Per-analysis compute timeout: ANALYSIS_TIMEOUT_MS.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { metering } from "../../drizzle/schema";
import {
  FREE_TIER_MAX_COST_USD,
  FREE_TIER_MONTHLY_LLM_BUDGET_USD,
} from "../../shared/wattwise";

export const UNIT_COSTS = {
  llmInPerMTok: 0.4,
  llmOutPerMTok: 1.6,
  computePerCpuSecond: 0.000024,
} as const;

export function llmCostUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * UNIT_COSTS.llmInPerMTok + (tokensOut / 1_000_000) * UNIT_COSTS.llmOutPerMTok;
}

export function computeCostUsd(ms: number): number {
  return (ms / 1000) * UNIT_COSTS.computePerCpuSecond;
}

export interface MeterEvent {
  userId: number;
  analysisId?: number;
  kind: string; // parse_excel | parse_csv | parse_espi | bill_ocr_llm | analysis_pipeline | scenario_run
  llmTokensIn?: number;
  llmTokensOut?: number;
  computeMs?: number;
  tier: string;
}

/** Record a metering row; returns totalCostUsd for the event. */
export async function recordMeterEvent(e: MeterEvent): Promise<number> {
  const db = await getDb();
  const llm = llmCostUsd(e.llmTokensIn ?? 0, e.llmTokensOut ?? 0);
  const comp = computeCostUsd(e.computeMs ?? 0);
  const total = llm + comp;
  if (db) {
    await db.insert(metering).values({
      userId: e.userId,
      analysisId: e.analysisId ?? null,
      kind: e.kind,
      llmTokensIn: e.llmTokensIn ?? 0,
      llmTokensOut: e.llmTokensOut ?? 0,
      llmCostUsd: llm,
      computeMs: e.computeMs ?? 0,
      computeCostUsd: comp,
      totalCostUsd: total,
      tierAtTime: e.tier,
    });
  }
  return total;
}

/** Month-to-date LLM spend for the account. */
export async function monthToDateLlmSpend(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${metering.llmCostUsd}), 0)` })
    .from(metering)
    .where(and(eq(metering.userId, userId), gte(metering.createdAt, monthStart)));
  return Number(rows[0]?.total ?? 0);
}

/**
 * LLM kill-switch (free tier): returns true when LLM fallback is allowed.
 * When false, callers MUST degrade to template-only parsing and surface the
 * manual-entry prompt.
 */
export async function llmBudgetAllows(userId: number, tier: string, estimatedCallCostUsd = 0.02): Promise<boolean> {
  if (tier !== "free") return true;
  const mtd = await monthToDateLlmSpend(userId);
  return mtd + estimatedCallCostUsd <= FREE_TIER_MONTHLY_LLM_BUDGET_USD;
}

/** Per-analysis total; used by AC5 test and the dashboard unit-economics card. */
export async function analysisTotalCost(analysisId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${metering.totalCostUsd}), 0)` })
    .from(metering)
    .where(eq(metering.analysisId, analysisId));
  return Number(rows[0]?.total ?? 0);
}

/** Free-tier cost-cap assertion — logs breach and returns compliance. */
export async function assertFreeTierCostCap(analysisId: number): Promise<{ ok: boolean; totalUsd: number; capUsd: number }> {
  const totalUsd = await analysisTotalCost(analysisId);
  return { ok: totalUsd <= FREE_TIER_MAX_COST_USD, totalUsd, capUsd: FREE_TIER_MAX_COST_USD };
}
