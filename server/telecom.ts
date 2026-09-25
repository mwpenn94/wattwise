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
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { sites, telecomBenchmarks, telecomServices, type TelecomBenchmark, type TelecomService } from "../drizzle/schema";
import { assertSiteOwner } from "./dbHelpers";
import { detectPriceCreep, listTelecomPriceHistory, recordTelecomPriceObservation } from "./telecomPriceHistory";
import {
  alternateTechnologies,
  marketPriceFactor,
  resolveTelecomMarket,
  type TelecomMarketContext,
} from "./telecomMarket";

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
  /** Optional bill period captured by the unified Add Utility flow. */
  billPeriodStart?: number | null;
  billPeriodEnd?: number | null;
  billedUsd?: number | null;
  billSource?: "entered_bill" | "ocr_confirmed" | "manual";
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
    if (input.billPeriodStart != null && input.billPeriodEnd != null && input.billedUsd != null) {
      await recordTelecomPriceObservation(userId, { serviceId: input.id, periodStart: input.billPeriodStart, periodEnd: input.billPeriodEnd, billedUsd: input.billedUsd, source: input.billSource });
    }
    return input.id;
  }
  const res = await db.insert(telecomServices).values(row);
  const id = Number((res as unknown as [{ insertId: number }])[0]?.insertId ?? 0);
  if (id > 0 && input.billPeriodStart != null && input.billPeriodEnd != null && input.billedUsd != null) {
    await recordTelecomPriceObservation(userId, { serviceId: id, periodStart: input.billPeriodStart, periodEnd: input.billPeriodEnd, billedUsd: input.billedUsd, source: input.billSource });
  }
  return id;
}

export async function removeTelecomService(id: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db.delete(telecomServices).where(and(eq(telecomServices.id, id), eq(telecomServices.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* TEL1C-3 — cascading identification                                  */
/* ------------------------------------------------------------------ */

/** Writes the telecom-setup invite insight at site creation — the same
 * cascading-identification pattern meters/commodities use: the site's
 * location resolves a telecom MARKET (technology mix, density class) and the
 * insight invites the user to enter their actual services so plan-vs-market
 * comparisons can run. Idempotent per site (kind-guarded); honest that the
 * mix is a market prior, never a serviceability check for the address. */
export async function addTelecomSetupInvite(
  siteId: number,
  loc: { city?: string | null; state?: string | null; zip?: string | null },
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { insights } = await import("../drizzle/schema");
  // Kind-guard: one invite per site, and never after services exist.
  const [existing, services] = await Promise.all([
    db
      .select({ id: insights.id })
      .from(insights)
      .where(and(eq(insights.siteId, siteId), eq(insights.kind, "telecom_setup_invite")))
      .limit(1),
    db.select({ id: telecomServices.id }).from(telecomServices).where(eq(telecomServices.siteId, siteId)).limit(1),
  ]);
  if (existing.length > 0 || services.length > 0) return;
  const market = resolveTelecomMarket(loc);
  const techList = market.technologies.map((t) => t.label).join(", ");
  const wiredCount = market.technologies.filter((t) => t.technology === "fiber" || t.technology === "cable" || t.technology === "dsl").length;
  await db.insert(insights).values({
    siteId,
    kind: "telecom_setup_invite",
    title: "Connectivity is a utility too — add internet/mobile services to include them",
    body:
      `Based on this site's location (${market.densityClass} market), the plausible access technologies are: ${techList}. ` +
      (wiredCount >= 2
        ? `With ${wiredCount} overlapping wired options, competitive pressure typically supports meaningful negotiation — `
        : `With limited wired overlap, switching leverage is thinner, but promo-expiry and right-sizing checks still apply — `) +
      `add your internet, mobile, TV, or landline services (or snap a bill photo) and their spend joins your site's cost picture with plan-vs-market findings. ` +
      `This technology mix is a market prior from FCC deployment data, not a serviceability check for your exact address.`,
    severity: "info",
    confidence: "medium",
    provenance: {
      method: "telecom_setup_invite_v1",
      densityClass: market.densityClass,
      technologies: market.technologies.map((t) => t.technology),
      disclosures: market.disclosures,
    },
    metrics: null,
  });
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
/** TEL1C-2: benchmark rows now carry verifyStatus from the rate-currency
 * engine (weekly fingerprint sweep of FCC/carrier sources + monthly agent
 * verification). Non-current benchmarks are still USABLE — the market
 * doesn't vanish — but every finding that cites them says so explicitly. */
export function benchmarkCurrencyDisclosure(bench: TelecomBenchmark): string[] {
  const vs = (bench as { verifyStatus?: string }).verifyStatus;
  if (vs === "change_detected") {
    return ["The published pricing behind this benchmark changed recently and is pending re-verification — treat the dollar range as indicative."];
  }
  if (vs === "due" || vs === "stale") {
    return ["This benchmark is past its verification window — published market pricing may have shifted since it was last confirmed."];
  }
  return [];
}

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
  kind: "promo_expiry" | "market_delta" | "right_size_speed" | "right_size_data" | "contract_window" | "price_creep";
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
  /** TEL1C-1: location-driven market context (multi-provider, multi-technology).
   * Set when analyzing a single site; null for cross-site portfolio analysis
   * (each service still gets its own site's market internally). */
  market: TelecomMarketContext | null;
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
  const priceHistories = new Map<number, Awaited<ReturnType<typeof listTelecomPriceHistory>>>();
  for (const svc of services) priceHistories.set(svc.id, await listTelecomPriceHistory(svc.id, userId));

  /* TEL1C-1 (owner Jul 23): resolve the multi-technology market context from
   * each service's site location — same cascade discipline as electric/gas
   * territory resolution, but modeled as a technology MIX (wired fiber/cable/
   * DSL, fixed-wireless, satellite can all overlap in one geography) rather
   * than one provider per territory. Internet benchmark medians are market-
   * adjusted and savings ranges competition-scaled, basis disclosed on every
   * finding. Mobile stays nationally priced (carrier pricing does not vary
   * by address). */
  const siteMarkets = new Map<number, TelecomMarketContext>();
  {
    const db = await getDb();
    if (db) {
      const ids = Array.from(new Set(services.map((s) => s.siteId).concat(siteId != null ? [siteId] : [])));
      if (ids.length > 0) {
        const rows = await db
          .select({ id: sites.id, city: sites.city, state: sites.state, zip: sites.zip })
          .from(sites)
          .where(inArray(sites.id, ids));
        for (const r of rows) siteMarkets.set(r.id, resolveTelecomMarket(r));
      }
    }
  }

  for (const svc of services) {
    const label = svcLabel(svc);
    const lines = svc.serviceType === "mobile" ? Math.max(1, svc.lines ?? 1) : 1;
    const perLineCost = svc.monthlyCostUsd / lines;

    /* Month-over-month creep is based only on the user's own bill history.
     * If the observed jump is the explicitly entered promo expiry, that
     * existing finding owns the same dollars and we do not double-count it. */
    const creep = detectPriceCreep(priceHistories.get(svc.id) ?? [], svc.id);
    const latestObserved = (priceHistories.get(svc.id) ?? []).at(-1);
    const overlapsPromo = svc.postPromoCostUsd != null && latestObserved != null && Math.abs(latestObserved.normalizedMonthlyUsd - svc.postPromoCostUsd) <= 1 && svc.promoEndsAt != null && latestObserved.periodEnd >= svc.promoEndsAt;
    if (creep && !overlapsPromo) {
      findings.push({
        serviceId: svc.id,
        serviceLabel: label,
        kind: "price_creep",
        title: `Month-over-month price creep on ${svc.provider}`,
        body: `Your normalized monthly cost rose from $${creep.previousMonthlyUsd.toFixed(0)} to $${creep.latestMonthlyUsd.toFixed(0)} — an increase of $${creep.deltaMonthlyUsd.toFixed(0)}/mo (${Math.round(creep.deltaPct * 100)}%).${creep.sustained ? " The rise continued across three captured periods." : " Capture another bill to confirm whether the change persists."}`,
        estAnnualSavingsLo: Math.round(creep.deltaMonthlyUsd * 12 * 0.5),
        estAnnualSavingsHi: Math.round(creep.deltaMonthlyUsd * 12),
        confidence: creep.sustained ? "high" : "medium",
        disclosures: [creep.basis, "Based only on bills you entered or confirmed; it is not a carrier quote.", "This finding is suppressed when the same increase matches the explicitly entered promo-expiry price."]
      });
    }

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

    /* 2. Market delta — published-rate comparison, low confidence.
     * TEL1C-1: internet comparisons are market-adjusted by the site's
     * technology-mix price factor; savings scale with local competition. */
    const bench = matchBenchmark(svc, catalog);
    const mkt = siteMarkets.get(svc.siteId) ?? null;
    const adjustable = svc.serviceType === "internet" && mkt != null;
    const priceF = adjustable ? marketPriceFactor(mkt) : 1.0;
    const compF = adjustable ? mkt.competitionFactor : 1.0;
    if (bench != null) {
      const compareCost = bench.perLine ? perLineCost : svc.monthlyCostUsd;
      const adjMedian = round(bench.medianUsd * priceF);
      const adjHigh = round(bench.typicalHighUsd * priceF);
      const adjLow = round(bench.typicalLowUsd * priceF);
      if (compareCost > adjHigh) {
        const deltaMedianMo = compareCost - adjMedian;
        const deltaHighMo = compareCost - adjHigh;
        const scale = bench.perLine ? lines : 1;
        const marketNote =
          adjustable && priceF !== 1.0 ? ` (adjusted for your ${mkt.densityClass} market's technology mix)` : "";
        findings.push({
          serviceId: svc.id,
          serviceLabel: label,
          kind: "market_delta",
          title: `${svc.provider} is above the typical published range`,
          body: `You pay $${compareCost.toFixed(0)}/mo${bench.perLine ? " per line" : ""} for ${bench.tierLabel.toLowerCase()}; published pricing${marketNote} typically runs $${adjLow}–$${adjHigh}/mo (median $${adjMedian}). Matching the median would save about $${round(deltaMedianMo * 12 * scale * Math.min(1, compF))}–$${round(deltaMedianMo * 12 * scale * compF)}/yr.`,
          estAnnualSavingsLo: round(deltaHighMo * 12 * scale * Math.min(1, compF)),
          estAnnualSavingsHi: round(deltaMedianMo * 12 * scale * compF),
          confidence: "low",
          disclosures: [
            bench.basis,
            ...benchmarkCurrencyDisclosure(bench),
            ...(adjustable ? mkt.disclosures : []),
            "Actual available pricing depends on providers serving your address and current offers.",
          ],
        });
      }
      /* TEL1C-1: alternate-technology switch option — when the market
       * plausibly offers a cheaper access technology (e.g., 5G fixed-wireless
       * vs cable), surface it as a disclosed switch, never like-for-like. */
      if (adjustable && compareCost > adjMedian) {
        const alts = alternateTechnologies(svc, mkt).filter((a) => a.priceFactor < priceF);
        if (alts.length > 0) {
          const best = alts[0];
          const altMedian = round(bench.medianUsd * best.priceFactor);
          const saveMo = compareCost - altMedian;
          if (saveMo > 10) {
            findings.push({
              serviceId: svc.id,
              serviceLabel: label,
              kind: "market_delta",
              title: `${best.label} plausibly serves your market at lower typical pricing`,
              body: `About ${Math.round(best.availabilityPrior * 100)}% of ${mkt.densityClass} locations like this site have ${best.label} available. Published ${best.label} pricing for comparable speeds runs around $${altMedian}/mo versus your $${compareCost.toFixed(0)}/mo — roughly $${round(saveMo * 12)}/yr if serviceable at your address.`,
              estAnnualSavingsLo: round(saveMo * 12 * 0.5),
              estAnnualSavingsHi: round(saveMo * 12),
              confidence: "low",
              disclosures: [
                "Technology availability is a market prior, not an address-level serviceability check — confirm with the provider before planning around it.",
                "Switching access technologies (e.g., cable to fixed-wireless) has real tradeoffs in latency, upload speed, and congestion behavior.",
                bench.basis,
                ...benchmarkCurrencyDisclosure(bench),
              ],
            });
          }
        }
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
              ...benchmarkCurrencyDisclosure(mvno),
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
            ...benchmarkCurrencyDisclosure(neededTier),
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
            ...benchmarkCurrencyDisclosure(limited),
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
    market: siteId != null ? (siteMarkets.get(siteId) ?? null) : null,
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
