/**
 * Telecom module — internet / mobile / TV / landline services and savings.
 *
 * Telecom is deliberately NOT a commodity: no meters, no intervals, no
 * weather sensitivity, no filed tariffs. It is recurring-subscription spend
 * with plan attributes, so its analytics are plan-vs-market and
 * plan-vs-actual-usage comparisons, not baselines.
 *
 * Honesty contract (same discipline as commodityOpportunities/verticals):
 *  - promo-expiry and contract-window findings compute ONLY from the user's
 *    own entered bill data — high confidence, it is their own price jump;
 *  - market-delta findings compare against a seeded PUBLISHED-RATE catalog
 *    (FCC Urban Rate Survey + published carrier/ISP pricing) and are always
 *    disclosed as "market comparison, not a quote — availability varies";
 *  - right-sizing findings require the user to have entered ACTUAL usage
 *    (data GB used, real speed need); nothing is ever assumed from sqft or
 *    building type — a home's bandwidth need is not inferable from its walls;
 *  - no finding is emitted without a stated basis, and savings are ranges
 *    anchored at published medians, never point promises.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { telecomBenchmarks, telecomServices, type TelecomBenchmark, type TelecomService } from "../drizzle/schema";
import { assertSiteOwner } from "./dbHelpers";

/* ------------------------------------------------------------------ */
/* CRUD helpers                                                        */
/* ------------------------------------------------------------------ */

export async function listTelecomServices(siteId: number, userId: number): Promise<TelecomService[]> {
  await assertSiteOwner(siteId, userId);
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(telecomServices)
    .where(and(eq(telecomServices.siteId, siteId), eq(telecomServices.userId, userId)));
}

export async function listAllTelecomServices(userId: number): Promise<TelecomService[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(telecomServices).where(eq(telecomServices.userId, userId));
}

export interface TelecomServiceInput {
  id?: number;
  siteId: number;
  serviceType: "internet" | "mobile" | "tv_bundle" | "phone_landline";
  provider: string;
  planName?: string | null;
  monthlyCostUsd: number;
  promoEndsAt?: number | null;
  postPromoCostUsd?: number | null;
  contractEndsAt?: number | null;
  downloadMbps?: number | null;
  isBusiness?: boolean;
  lines?: number | null;
  dataAllowanceGb?: number | null;
  unlimitedData?: boolean;
  actualDataUsedGb?: number | null;
  actualDownloadNeedMbps?: number | null;
  notes?: string | null;
}

export async function upsertTelecomService(userId: number, input: TelecomServiceInput): Promise<number> {
  await assertSiteOwner(input.siteId, userId);
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const row = {
    siteId: input.siteId,
    userId,
    serviceType: input.serviceType,
    provider: input.provider.trim(),
    planName: input.planName ?? null,
    monthlyCostUsd: input.monthlyCostUsd,
    promoEndsAt: input.promoEndsAt ?? null,
    postPromoCostUsd: input.postPromoCostUsd ?? null,
    contractEndsAt: input.contractEndsAt ?? null,
    downloadMbps: input.downloadMbps ?? null,
    isBusiness: input.isBusiness ?? false,
    lines: input.lines ?? null,
    dataAllowanceGb: input.dataAllowanceGb ?? null,
    unlimitedData: input.unlimitedData ?? false,
    actualDataUsedGb: input.actualDataUsedGb ?? null,
    actualDownloadNeedMbps: input.actualDownloadNeedMbps ?? null,
    notes: input.notes ?? null,
    source: "manual" as const,
  };
  if (input.id) {
    // ownership: only update rows this user owns
    const existing = await db
      .select({ id: telecomServices.id })
      .from(telecomServices)
      .where(and(eq(telecomServices.id, input.id), eq(telecomServices.userId, userId)))
      .limit(1);
    if (existing.length === 0) throw new Error("Service not found");
    await db.update(telecomServices).set(row).where(eq(telecomServices.id, input.id));
    return input.id;
  }
  const res = await db.insert(telecomServices).values(row);
  return Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
}

export async function removeTelecomService(id: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(telecomServices).where(and(eq(telecomServices.id, id), eq(telecomServices.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* Benchmark matching                                                  */
/* ------------------------------------------------------------------ */

export async function loadBenchmarks(): Promise<TelecomBenchmark[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(telecomBenchmarks);
}

/** Match a service to its benchmark tier. Internet matches on speed window +
 * business flag; mobile on plan kind; TV/landline on the single tier. */
export function matchBenchmark(svc: TelecomService, catalog: TelecomBenchmark[]): TelecomBenchmark | null {
  if (svc.serviceType === "internet") {
    const mbps = svc.downloadMbps;
    if (mbps == null || mbps <= 0) return null; // cannot tier without a speed
    const prefix = svc.isBusiness ? "internet_biz_" : "internet_res_";
    const candidates = catalog.filter(
      (b) => b.serviceType === "internet" && b.tierKey.startsWith(prefix),
    );
    return (
      candidates.find(
        (b) => (b.minMbps == null || mbps >= b.minMbps) && (b.maxMbps == null || mbps < b.maxMbps),
      ) ?? null
    );
  }
  if (svc.serviceType === "mobile") {
    // Prepaid/MVNO detection is not inferable from a bill total alone; the
    // conservative comparison for an unlimited plan is the POSTPAID tier
    // (never compare a big-3 bill against Mint's annual-prepay price as if
    // it were an apples-to-apples market rate). Capped plans use the
    // limited-data tier.
    const key = svc.unlimitedData ? "mobile_unlimited_postpaid" : "mobile_limited_data";
    return catalog.find((b) => b.tierKey === key) ?? null;
  }
  if (svc.serviceType === "tv_bundle") return catalog.find((b) => b.tierKey === "tv_bundle_standard") ?? null;
  return catalog.find((b) => b.tierKey === "phone_landline_standard") ?? null;
}

/** The cheaper-plan-kind alternative for savings framing (unlimited postpaid →
 * prepaid/MVNO tier), used only as a disclosed switch option. */
function mvnoTier(catalog: TelecomBenchmark[]): TelecomBenchmark | null {
  return catalog.find((b) => b.tierKey === "mobile_unlimited_prepaid_mvno") ?? null;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export interface TelecomFinding {
  serviceId: number;
  serviceLabel: string;
  kind: "promo_expiry" | "market_delta" | "right_size_speed" | "right_size_data" | "contract_window";
  title: string;
  body: string;
  /** annual $ savings range; null for pure action-window alerts */
  estAnnualSavingsLo: number | null;
  estAnnualSavingsHi: number | null;
  confidence: "high" | "medium" | "low";
  disclosures: string[];
}

export interface TelecomAnalysis {
  services: TelecomService[];
  monthlyTotalUsd: number;
  annualTotalUsd: number;
  findings: TelecomFinding[];
  totalAnnualSavingsLo: number;
  totalAnnualSavingsHi: number;
}

const DAY_MS = 86_400_000;
const round = (n: number) => Math.round(n);

function svcLabel(s: TelecomService): string {
  const type =
    s.serviceType === "internet"
      ? "Internet"
      : s.serviceType === "mobile"
        ? "Mobile"
        : s.serviceType === "tv_bundle"
          ? "TV bundle"
          : "Landline";
  return `${type} — ${s.provider}${s.planName ? ` ${s.planName}` : ""}`;
}

/** Analyze one user's services for a site (or all sites when siteId omitted). */
export async function analyzeTelecomServices(
  userId: number,
  siteId?: number,
  now: number = Date.now(),
): Promise<TelecomAnalysis> {
  const services = siteId != null ? await listTelecomServices(siteId, userId) : await listAllTelecomServices(userId);
  const catalog = await loadBenchmarks();
  const findings: TelecomFinding[] = [];

  for (const svc of services) {
    const label = svcLabel(svc);
    const lines = svc.serviceType === "mobile" ? Math.max(1, svc.lines ?? 1) : 1;
    const perLineCost = svc.monthlyCostUsd / lines;

    /* 1. Promo expiry — the user's own bill data, high confidence. */
    if (svc.promoEndsAt != null && svc.postPromoCostUsd != null && svc.postPromoCostUsd > svc.monthlyCostUsd) {
      const daysLeft = Math.floor((svc.promoEndsAt - now) / DAY_MS);
      const jumpMo = svc.postPromoCostUsd - svc.monthlyCostUsd;
      if (daysLeft <= 60) {
        const when =
          daysLeft < 0
            ? `expired ${Math.abs(daysLeft)} days ago — you may already be paying the higher rate`
            : `ends in ${daysLeft} days`;
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "promo_expiry",
          title: `Promo pricing ${daysLeft < 0 ? "has expired" : "expiring"} on ${svc.provider}`,
          body: `Your promotional rate of $${svc.monthlyCostUsd.toFixed(0)}/mo ${when}. The plan's regular rate is $${svc.postPromoCostUsd.toFixed(0)}/mo — a jump of $${jumpMo.toFixed(0)}/mo ($${round(jumpMo * 12)}/yr). Calling to renegotiate before the jump, or switching providers, typically avoids most of it.`,
          estAnnualSavingsLo: round(jumpMo * 12 * 0.5),
          estAnnualSavingsHi: round(jumpMo * 12),
          confidence: "high",
          disclosures: [
            "Computed from the promo end date and post-promo price you entered — verify against your latest bill.",
            "Savings range assumes renegotiation recovers 50–100% of the jump; outcomes vary by provider and market.",
          ],
        });
      }
    }

    /* 2. Market delta — published-rate comparison, low confidence. */
    const bench = matchBenchmark(svc, catalog);
    if (bench != null) {
      const compareCost = bench.perLine ? perLineCost : svc.monthlyCostUsd;
      if (compareCost > bench.typicalHighUsd) {
        const deltaMedianMo = compareCost - bench.medianUsd;
        const deltaHighMo = compareCost - bench.typicalHighUsd;
        const scale = bench.perLine ? lines : 1;
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "market_delta",
          title: `${svc.provider} is above the typical published range`,
          body: `You pay $${compareCost.toFixed(0)}/mo${bench.perLine ? " per line" : ""} for ${bench.tierLabel.toLowerCase()}; published national pricing typically runs $${bench.typicalLowUsd.toFixed(0)}–$${bench.typicalHighUsd.toFixed(0)}/mo (median $${bench.medianUsd.toFixed(0)}). Matching the median would save about $${round(deltaMedianMo * 12 * scale)}/yr.`,
          estAnnualSavingsLo: round(deltaHighMo * 12 * scale),
          estAnnualSavingsHi: round(deltaMedianMo * 12 * scale),
          confidence: "low",
          disclosures: [bench.basis, "Actual available pricing depends on providers serving your address and current offers."],
        });
      }
      /* Mobile: unlimited postpaid users also see the MVNO option (disclosed switch). */
      if (svc.serviceType === "mobile" && svc.unlimitedData && bench.tierKey === "mobile_unlimited_postpaid") {
        const mvno = mvnoTier(catalog);
        if (mvno && perLineCost > mvno.typicalHighUsd) {
          const saveMedianMo = (perLineCost - mvno.medianUsd) * lines;
          const saveHighMo = (perLineCost - mvno.typicalHighUsd) * lines;
          findings.push({
            serviceId: svc.id,
            serviceLabel: label,
            kind: "market_delta",
            title: `Prepaid/MVNO plans run far below your per-line rate`,
            body: `Your ${lines}-line unlimited plan works out to $${perLineCost.toFixed(0)}/line. Unlimited prepaid/MVNO plans on the same major networks publish at $${mvno.typicalLowUsd.toFixed(0)}–$${mvno.typicalHighUsd.toFixed(0)}/line (median $${mvno.medianUsd.toFixed(0)}). Switching all lines at the median would save about $${round(saveMedianMo * 12)}/yr — with tradeoffs (deprioritization at congestion, fewer perks, no device subsidies).`,
            estAnnualSavingsLo: round(saveHighMo * 12),
            estAnnualSavingsHi: round(saveMedianMo * 12),
            confidence: "low",
            disclosures: [
              mvno.basis,
              "MVNO tradeoffs are real: data deprioritization during congestion, limited international/hotspot features, and device-financing differences. This is a switch option, not a like-for-like repricing.",
            ],
          });
        }
      }
    }

    /* 3. Right-size speed — only from user-entered actual need. */
    if (
      svc.serviceType === "internet" &&
      svc.downloadMbps != null &&
      svc.actualDownloadNeedMbps != null &&
      svc.actualDownloadNeedMbps > 0 &&
      svc.downloadMbps >= svc.actualDownloadNeedMbps * 2
    ) {
      const currentTier = matchBenchmark(svc, catalog);
      const neededSvc = { ...svc, downloadMbps: svc.actualDownloadNeedMbps } as TelecomService;
      const neededTier = matchBenchmark(neededSvc, catalog);
      if (currentTier && neededTier && neededTier.tierKey !== currentTier.tierKey && neededTier.medianUsd < currentTier.medianUsd) {
        const saveMo = currentTier.medianUsd - neededTier.medianUsd;
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "right_size_speed",
          title: `Your plan is ${Math.round(svc.downloadMbps / svc.actualDownloadNeedMbps)}× faster than what you say you need`,
          body: `You subscribe to ${svc.downloadMbps.toFixed(0)} Mbps but reported needing about ${svc.actualDownloadNeedMbps.toFixed(0)} Mbps. Stepping down to a ${neededTier.tierLabel.toLowerCase()} plan typically saves $${saveMo.toFixed(0)}/mo ($${round(saveMo * 12)}/yr) at published median pricing.`,
          estAnnualSavingsLo: round(saveMo * 12 * 0.5),
          estAnnualSavingsHi: round(saveMo * 12),
          confidence: "medium",
          disclosures: [
            "Based on the actual speed need you entered — if your household adds heavy simultaneous use (4K streams, large uploads, many devices), revisit before downgrading.",
            neededTier.basis,
          ],
        });
      }
    }

    /* 4. Right-size mobile data — only from user-entered actual usage. */
    if (svc.serviceType === "mobile" && svc.actualDataUsedGb != null && svc.actualDataUsedGb >= 0) {
      const perLineUsedGb = svc.actualDataUsedGb / lines;
      const limited = catalog.find((b) => b.tierKey === "mobile_limited_data");
      // unlimited plan but light per-line usage → capped plan comparison
      if (svc.unlimitedData && limited && perLineUsedGb < 10 && perLineCost > limited.medianUsd) {
        const saveMo = (perLineCost - limited.medianUsd) * lines;
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "right_size_data",
          title: `Unlimited data, but you use ~${perLineUsedGb.toFixed(0)} GB/line`,
          body: `You reported using about ${svc.actualDataUsedGb.toFixed(0)} GB/mo across ${lines} line${lines > 1 ? "s" : ""} (~${perLineUsedGb.toFixed(0)} GB/line) on an unlimited plan at $${perLineCost.toFixed(0)}/line. Capped plans covering that usage publish at a median of $${limited.medianUsd.toFixed(0)}/line — about $${round(saveMo * 12)}/yr less.`,
          estAnnualSavingsLo: round(saveMo * 12 * 0.5),
          estAnnualSavingsHi: round(saveMo * 12),
          confidence: "medium",
          disclosures: [
            "Based on the actual data usage you entered — check a few months of bills for seasonality (travel months can spike).",
            limited.basis,
          ],
        });
      }
      // capped plan with allowance >= 2x usage → smaller cap
      if (!svc.unlimitedData && svc.dataAllowanceGb != null && svc.dataAllowanceGb >= svc.actualDataUsedGb * 2 && svc.actualDataUsedGb > 0) {
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "right_size_data",
          title: `Data allowance is ${Math.round(svc.dataAllowanceGb / svc.actualDataUsedGb)}× your actual usage`,
          body: `Your plan includes ${svc.dataAllowanceGb.toFixed(0)} GB but you use about ${svc.actualDataUsedGb.toFixed(0)} GB/mo. Most carriers price smaller buckets $5–$15/mo lower — ask for the next tier down.`,
          estAnnualSavingsLo: 60,
          estAnnualSavingsHi: 180,
          confidence: "medium",
          disclosures: [
            "Based on the actual data usage you entered.",
            "Savings range reflects typical $5–$15/mo step-downs between published bucket sizes; exact tiers vary by carrier.",
          ],
        });
      }
    }

    /* 5. Contract window — action alert, no $ claim by itself. */
    if (svc.contractEndsAt != null) {
      const daysLeft = Math.floor((svc.contractEndsAt - now) / DAY_MS);
      if (daysLeft >= 0 && daysLeft <= 60) {
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "contract_window",
          title: `Contract on ${svc.provider} ends in ${daysLeft} days`,
          body: `Your contract ends ${new Date(svc.contractEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. The weeks around contract end are the strongest renegotiation window — retention offers and competitor switch credits are both on the table with no early-termination fee.`,
          estAnnualSavingsLo: null,
          estAnnualSavingsHi: null,
          confidence: "high",
          disclosures: ["Computed from the contract end date you entered."],
        });
      }
    }
  }

  const monthlyTotalUsd = services.reduce((s, x) => s + x.monthlyCostUsd, 0);
  const withSavings = findings.filter((f) => f.estAnnualSavingsLo != null);
  // Per-service cap: overlapping findings (market delta + MVNO + right-size)
  // are alternative paths to the same dollars, not additive. Total = per
  // service, the single largest hi/lo pair.
  const byService = new Map<number, TelecomFinding[]>();
  for (const f of withSavings) {
    const arr = byService.get(f.serviceId) ?? [];
    arr.push(f);
    byService.set(f.serviceId, arr);
  }
  let totalLo = 0;
  let totalHi = 0;
  for (const arr of Array.from(byService.values())) {
    const best = arr.reduce((a, b) => ((b.estAnnualSavingsHi ?? 0) > (a.estAnnualSavingsHi ?? 0) ? b : a));
    totalLo += Math.max(0, best.estAnnualSavingsLo ?? 0);
    totalHi += Math.max(0, best.estAnnualSavingsHi ?? 0);
  }

  return {
    services,
    monthlyTotalUsd,
    annualTotalUsd: monthlyTotalUsd * 12,
    findings,
    totalAnnualSavingsLo: totalLo,
    totalAnnualSavingsHi: totalHi,
  };
}

/* ------------------------------------------------------------------ */
/* TELX-2: cron-facing expiry sweep                                    */
/* ------------------------------------------------------------------ */

/** One entry per service whose promo price lapses OR whose contract
 *  early-termination window ends within the next `windowDays` (default 30).
 *  Read-only — the weekly cron folds these into the owner notification so
 *  action windows are never discovered late on a page visit. */
export interface TelecomExpiry {
  serviceId: number;
  siteId: number;
  userId: number;
  kind: "promo_expiry" | "contract_window";
  /** human-readable one-liner for the notification body */
  summary: string;
}

export async function checkTelecomExpiries(now: number, windowDays = 30): Promise<TelecomExpiry[]> {
  const db = await getDb();
  if (!db) return [];
  const all = await db.select().from(telecomServices);
  const horizon = now + windowDays * DAY_MS;
  const out: TelecomExpiry[] = [];
  for (const s of all) {
    if (s.promoEndsAt != null && s.promoEndsAt > now && s.promoEndsAt <= horizon) {
      const days = Math.ceil((s.promoEndsAt - now) / DAY_MS);
      const jump =
        s.postPromoCostUsd != null && s.postPromoCostUsd > s.monthlyCostUsd
          ? ` (price rises $${round(s.monthlyCostUsd)}→$${round(s.postPromoCostUsd)}/mo)`
          : "";
      out.push({
        serviceId: s.id,
        siteId: s.siteId,
        userId: s.userId,
        kind: "promo_expiry",
        summary: `${svcLabel(s)} promo ends in ${days}d${jump}`,
      });
    }
    if (s.contractEndsAt != null && s.contractEndsAt > now && s.contractEndsAt <= horizon) {
      const days = Math.ceil((s.contractEndsAt - now) / DAY_MS);
      out.push({
        serviceId: s.id,
        siteId: s.siteId,
        userId: s.userId,
        kind: "contract_window",
        summary: `${svcLabel(s)} contract ends in ${days}d — switch/renegotiate without early-termination fees`,
      });
    }
  }
  return out;
}
