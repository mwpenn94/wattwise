import { and, asc, eq, inArray } from "drizzle-orm";
import { telecomPriceHistory, telecomServices, type TelecomPriceHistory } from "../drizzle/schema";
import { assertSiteOwner } from "./dbHelpers";
import { getDb } from "./db";

const DAY_MS = 86_400_000;
const AVG_MONTH_DAYS = 365.2425 / 12;
/** TEL-1: longest statement period accepted (catches a mistyped year). */
export const MAX_BILL_PERIOD_DAYS = 400;
/** Telecom bills are often issued in advance of the service period. */
const MAX_FUTURE_DAYS = 62;

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
  /** Inclusive human labels, e.g. "Sep 5, 2026 – Oct 4, 2026". */
  latestPeriodLabel: string;
  priorPeriodLabel: string;
}

export function normalizeMonthlyPrice(billedUsd: number, periodStart: number, periodEnd: number): number {
  const days = Math.max(1, (periodEnd - periodStart) / DAY_MS);
  return billedUsd / (days / AVG_MONTH_DAYS);
}

/** TEL-1: bills state an INCLUSIVE service period ("Sep 5 – Oct 4"). Stored as
 * UTC midnight of the first day and UTC midnight AFTER the last day, so the
 * day count is exact and identical in every browser time zone. */
export function billPeriodFromDates(startDate: string, endDateInclusive: string): { periodStart: number; periodEnd: number } {
  const parse = (s: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return NaN;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // reject rollovers such as 2026-02-30
    const d = new Date(t);
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : NaN;
  };
  return { periodStart: parse(startDate), periodEnd: parse(endDateInclusive) + DAY_MS };
}

/** Plain-language reason a bill period/amount is unusable, or null when valid. */
export function billObservationProblem(periodStart: number, periodEnd: number, billedUsd: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) return "Enter the bill's service period as two valid dates.";
  if (periodEnd <= periodStart) return "The period's last day must be on or after its first day.";
  const days = (periodEnd - periodStart) / DAY_MS;
  if (days > MAX_BILL_PERIOD_DAYS) return `That period is ${Math.round(days)} days long — check the year. Bills up to ${MAX_BILL_PERIOD_DAYS} days are accepted.`;
  if (periodStart > now + MAX_FUTURE_DAYS * DAY_MS) return "That period starts more than two months from today — check the dates.";
  if (periodStart < now - 10 * 365 * DAY_MS) return "That period is more than 10 years old — check the year.";
  if (!Number.isFinite(billedUsd) || billedUsd <= 0) return "Enter the amount billed for that period (more than $0).";
  if (billedUsd > 100_000) return "That amount is over $100,000 — check the figure.";
  return null;
}

const fmtDay = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** Inclusive human label for a stored period (end is exclusive internally). */
export function billPeriodLabel(periodStart: number, periodEnd: number): string {
  return `${fmtDay(periodStart)} – ${fmtDay(periodEnd - DAY_MS)}`;
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
    latestPeriodLabel: billPeriodLabel(latest.periodStart, latest.periodEnd),
    priorPeriodLabel: billPeriodLabel(previous.periodStart, previous.periodEnd),
    basis: `Compared ${sorted.length} bill${sorted.length === 1 ? "" : "s"} you entered. Latest (${billPeriodLabel(latest.periodStart, latest.periodEnd)}): $${latest.normalizedMonthlyUsd.toFixed(2)} per standard month; prior (${billPeriodLabel(previous.periodStart, previous.periodEnd)}): $${previous.normalizedMonthlyUsd.toFixed(2)}. Each bill is converted to a standard 30.4-day month so different bill lengths compare fairly.`,
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

/** TEL-1: every bill observation for a site's services (owner-scoped). */
export async function listTelecomPriceHistoryForSite(siteId: number, userId: number): Promise<TelecomPriceHistory[]> {
  await assertSiteOwner(siteId, userId);
  const db = await getDb();
  if (!db) return [];
  const svcIds = (await db.select({ id: telecomServices.id }).from(telecomServices).where(and(eq(telecomServices.siteId, siteId), eq(telecomServices.userId, userId)))).map((r) => r.id);
  if (svcIds.length === 0) return [];
  return db
    .select()
    .from(telecomPriceHistory)
    .where(and(inArray(telecomPriceHistory.serviceId, svcIds), eq(telecomPriceHistory.userId, userId)))
    .orderBy(asc(telecomPriceHistory.serviceId), asc(telecomPriceHistory.periodStart));
}

/** Whether an observation already exists for exactly this period (a re-entry replaces it). */
export async function priceObservationExists(serviceId: number, userId: number, periodStart: number, periodEnd: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const r = await db
    .select({ id: telecomPriceHistory.id })
    .from(telecomPriceHistory)
    .where(and(eq(telecomPriceHistory.serviceId, serviceId), eq(telecomPriceHistory.userId, userId), eq(telecomPriceHistory.periodStart, periodStart), eq(telecomPriceHistory.periodEnd, periodEnd)))
    .limit(1);
  return r.length > 0;
}

/** Remove one observation; returns its site id, or null when it is not this user's. */
export async function removeTelecomPriceObservation(id: number, userId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const row = await db.select({ id: telecomPriceHistory.id, siteId: telecomPriceHistory.siteId }).from(telecomPriceHistory).where(and(eq(telecomPriceHistory.id, id), eq(telecomPriceHistory.userId, userId))).limit(1);
  if (!row[0]) return null;
  await db.delete(telecomPriceHistory).where(and(eq(telecomPriceHistory.id, id), eq(telecomPriceHistory.userId, userId)));
  return row[0].siteId;
}
