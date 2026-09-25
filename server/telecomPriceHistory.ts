import { and, asc, eq } from "drizzle-orm";
import { telecomPriceHistory, telecomServices, type TelecomPriceHistory } from "../drizzle/schema";
import { assertSiteOwner } from "./dbHelpers";
import { getDb } from "./db";

const DAY_MS = 86_400_000;
const AVG_MONTH_DAYS = 365.2425 / 12;

export interface PriceObservationInput {
  serviceId: number;
  periodStart: number;
  periodEnd: number;
  billedUsd: number;
  source?: "entered_bill" | "ocr_confirmed" | "manual";
}

export interface PriceCreepResult {
  serviceId: number;
  previousMonthlyUsd: number;
  latestMonthlyUsd: number;
  deltaMonthlyUsd: number;
  deltaPct: number;
  periodsCompared: number;
  sustained: boolean;
  basis: string;
}

export function normalizeMonthlyPrice(billedUsd: number, periodStart: number, periodEnd: number): number {
  const days = Math.max(1, (periodEnd - periodStart) / DAY_MS);
  return billedUsd / (days / AVG_MONTH_DAYS);
}

/** Two observations are enough to flag a material jump; three consecutive
 * rising observations earn the sustained label. One observation never does. */
export function detectPriceCreep(observations: Array<Pick<TelecomPriceHistory, "periodStart" | "periodEnd" | "normalizedMonthlyUsd">>, serviceId: number): PriceCreepResult | null {
  const sorted = [...observations].sort((a, b) => a.periodStart - b.periodStart);
  if (sorted.length < 2) return null;
  const previous = sorted[sorted.length - 2];
  const latest = sorted[sorted.length - 1];
  const delta = latest.normalizedMonthlyUsd - previous.normalizedMonthlyUsd;
  const pct = previous.normalizedMonthlyUsd > 0 ? delta / previous.normalizedMonthlyUsd : 0;
  if (delta < 5 || pct < 0.1) return null;
  const tail = sorted.slice(-3);
  const sustained = tail.length === 3 && tail[2].normalizedMonthlyUsd > tail[1].normalizedMonthlyUsd && tail[1].normalizedMonthlyUsd > tail[0].normalizedMonthlyUsd;
  return {
    serviceId,
    previousMonthlyUsd: previous.normalizedMonthlyUsd,
    latestMonthlyUsd: latest.normalizedMonthlyUsd,
    deltaMonthlyUsd: delta,
    deltaPct: pct,
    periodsCompared: sorted.length,
    sustained,
    basis: `Compared ${sorted.length} entered bill period${sorted.length === 1 ? "" : "s"}; latest normalized monthly cost is $${latest.normalizedMonthlyUsd.toFixed(2)} versus $${previous.normalizedMonthlyUsd.toFixed(2)} in the prior period.`,
  };
}

export async function recordTelecomPriceObservation(userId: number, input: PriceObservationInput): Promise<number> {
  if (!Number.isFinite(input.billedUsd) || input.billedUsd < 0 || input.periodEnd <= input.periodStart) throw new Error("Invalid telecom bill period or amount");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const service = await db.select({ id: telecomServices.id, siteId: telecomServices.siteId }).from(telecomServices).where(and(eq(telecomServices.id, input.serviceId), eq(telecomServices.userId, userId))).limit(1);
  if (!service[0]) throw new Error("Service not found");
  await assertSiteOwner(service[0].siteId, userId);
  const normalizedMonthlyUsd = normalizeMonthlyPrice(input.billedUsd, input.periodStart, input.periodEnd);
  await db.insert(telecomPriceHistory).values({ serviceId: input.serviceId, siteId: service[0].siteId, userId, periodStart: input.periodStart, periodEnd: input.periodEnd, billedUsd: input.billedUsd, normalizedMonthlyUsd, source: input.source ?? "manual" }).onDuplicateKeyUpdate({ set: { billedUsd: input.billedUsd, normalizedMonthlyUsd, source: input.source ?? "manual" } });
  const row = await db.select({ id: telecomPriceHistory.id }).from(telecomPriceHistory).where(and(eq(telecomPriceHistory.serviceId, input.serviceId), eq(telecomPriceHistory.periodStart, input.periodStart), eq(telecomPriceHistory.periodEnd, input.periodEnd))).limit(1);
  return row[0]?.id ?? 0;
}

export async function listTelecomPriceHistory(serviceId: number, userId: number): Promise<TelecomPriceHistory[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(telecomPriceHistory).where(and(eq(telecomPriceHistory.serviceId, serviceId), eq(telecomPriceHistory.userId, userId))).orderBy(asc(telecomPriceHistory.periodStart));
}
