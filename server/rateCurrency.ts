/**
 * CURR (Jul 22) — autonomous rate-currency engine.
 *
 * Owner directive: "dynamically keep rates current without me having to
 * prompt per utility and per period." Three cooperating mechanisms:
 *
 *  1. WEEKLY fingerprint sweep (Heartbeat, inline, cheap): each registered
 *     official source URL is fetched and sha256-hashed. A changed hash means
 *     the utility republished its tariff document — the source is marked
 *     change_detected, its governed tariff rows flip to verifyStatus
 *     'change_detected', and the owner is notified. False positives are
 *     harmless (the monthly agent resolves them); false negatives are
 *     impossible for document-hosted rates (a rate change requires a
 *     document change).
 *
 *  2. DUE-HORIZON scan (same weekly cron): sources past their verify cadence
 *     — shortened ahead of known adjustor cycles (PGA/GSC file quarterly) —
 *     flip governed rows to 'due'. Staleness is disclosed, never silent.
 *
 *  3. MONTHLY agent verification (AGENT cron): a fresh Manus agent GETs the
 *     prioritized target list from /api/scheduled/rateVerify, opens each
 *     official source (PDF/page), extracts current rate values, and POSTs
 *     structured findings back. Findings are applied conservatively:
 *     confirmations stamp lastVerifiedAt; small adjustor-band deltas
 *     (≤ rate.auto_apply_max_pct, default 15%) auto-apply with a full audit
 *     row and owner notification; larger changes flag + notify but never
 *     silently mutate a filed rate.
 *
 * All thresholds are config-not-constant (platform_config).
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { rateSources, rateVerifications, tariffs, telecomBenchmarks, type RateSourceRow } from "../drizzle/schema";
import { configNumber } from "./seedLifecycle";

/* TEL1C-2: benchmark sources govern telecom_benchmarks tiers instead of
 * tariff rows. Tier keys share the governsUrdbIds JSON column with a stable
 * prefix so no second column is needed and every existing consumer that
 * treats the list as opaque keys keeps working. */
const TIER_PREFIX = "tier:";
export const tierIdsOf = (govern: string[]): string[] =>
  govern.filter((g) => g.startsWith(TIER_PREFIX)).map((g) => g.slice(TIER_PREFIX.length));
export const urdbIdsOf = (govern: string[]): string[] => govern.filter((g) => !g.startsWith(TIER_PREFIX));

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Source registry seed — one row per governing official document.     */
/* ------------------------------------------------------------------ */

export interface RateSourceSeed {
  sourceKey: string;
  utilityName: string;
  commodity: "electric" | "gas" | "water" | "telecom";
  state: string;
  sourceUrl: string;
  sourceLabel: string;
  governsUrdbIds: string[];
  adjustorCycle: "none" | "quarterly_gsc" | "quarterly_pga" | "monthly_pga" | "annual";
  verifyCadenceDays: number;
  /** NAT-7: 'tariff' sources govern seeded rate rows; 'docket' sources track
   * pending rate cases at the commission — a fingerprint change means the
   * regulatory docket moved (new filing/order), giving ADVANCE notice of
   * rate changes before they take effect. Dockets govern no tariff rows.
   * TEL1C-2: 'benchmark' sources govern telecom_benchmarks tiers (via
   * governsTierKeys) instead of tariff rows — same sweep, same escalation. */
  sourceKind?: "tariff" | "docket" | "benchmark";
  /** TEL1C-2: telecom benchmark tierKeys this source underpins. A fingerprint
   * change or staleness flips these rows' verifyStatus, which surfaces as a
   * disclosure on every finding that cites them. */
  governsTierKeys?: string[];
}

/** Registry of official sources for every hand-modeled (filed) tariff row.
 * Imputed state-average rows are NOT here — they are governed by the EIA
 * drift detector (eiaRefresh.ts) whose source is the EIA API itself. */
export const RATE_SOURCE_SEEDS: RateSourceSeed[] = [
  {
    sourceKey: "aps-az-electric",
    utilityName: "Arizona Public Service Co (APS)",
    commodity: "electric",
    state: "AZ",
    sourceUrl: "https://www.aps.com/en/Utility/Regulatory-and-Legal/Rates-Schedules-and-Adjustors",
    sourceLabel: "APS Rate Schedules (ACC filed)",
    governsUrdbIds: ["aps-r-tou-4pm7pm", "aps-r-tou-demand", "aps-e32-m", "aps-e32-l", "aps-e34"],
    adjustorCycle: "annual",
    verifyCadenceDays: 120,
  },
  {
    sourceKey: "srp-az-electric",
    utilityName: "Salt River Project (SRP)",
    commodity: "electric",
    state: "AZ",
    // srpnet.com bot-blocks non-browser fetches (403) — same note as Tucson
    // Water: the monthly AGENT verifier with a real browser covers this source.
    sourceUrl: "https://www.srpnet.com/price-plans/residential-electric",
    sourceLabel: "SRP Standard Price Plans",
    governsUrdbIds: ["srp-e23", "srp-e26-tou", "srp-e36-genl", "srp-e65-cpp"],
    adjustorCycle: "annual",
    verifyCadenceDays: 120,
  },
  {
    sourceKey: "tep-az-electric",
    utilityName: "Tucson Electric Power (TEP)",
    commodity: "electric",
    state: "AZ",
    sourceUrl: "https://www.tep.com/rates/",
    sourceLabel: "TEP Pricing Plans (ACC filed)",
    governsUrdbIds: ["tep-res-basic", "tep-lgs-14"],
    adjustorCycle: "annual",
    verifyCadenceDays: 120,
  },
  {
    sourceKey: "unse-az-electric",
    utilityName: "UNS Electric (UniSource)",
    commodity: "electric",
    state: "AZ",
    sourceUrl: "https://www.uesaz.com/electric-rates/",
    sourceLabel: "UNS Electric Statement of Rates (ACC Decision)",
    governsUrdbIds: ["uns-erres", "uns-errest", "uns-lgs"],
    adjustorCycle: "annual",
    verifyCadenceDays: 120,
  },
  {
    sourceKey: "swgas-az-gas",
    utilityName: "Southwest Gas (AZ)",
    commodity: "gas",
    state: "AZ",
    sourceUrl: "https://www.swgas.com/en/rates-and-regulation",
    sourceLabel: "Southwest Gas AZ rate schedules (G-5/G-25)",
    // Governs only the modeled G-5 residential row. AZ commercial gas is a
    // state-representative imputed row (rep-az-gas-comm) governed by the EIA
    // drift detector, not this document watch.
    governsUrdbIds: ["swgas-az-res"],
    adjustorCycle: "monthly_pga",
    verifyCadenceDays: 90,
  },
  {
    sourceKey: "phxwater-az-water",
    utilityName: "City of Phoenix Water Services",
    commodity: "water",
    state: "AZ",
    // Official water/sewer rates page (verified reachable Jul 2026).
    sourceUrl: "https://www.phoenix.gov/administration/departments/waterservices/city-services-bill/water-sewer-rates.html",
    sourceLabel: "City of Phoenix water rates (ordinance)",
    governsUrdbIds: ["phxwater-az-comm"],
    adjustorCycle: "annual",
    verifyCadenceDays: 180,
  },
  {
    sourceKey: "lge-ky-electric",
    utilityName: "Louisville Gas and Electric (LG&E)",
    commodity: "electric",
    state: "KY",
    sourceUrl: "https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Electric-Rates-072126.pdf",
    sourceLabel: "LG&E P.S.C. Electric No. 13 (KY PSC filed)",
    governsUrdbIds: ["lge-rs", "lge-rtod-energy", "lge-gs"],
    adjustorCycle: "annual",
    verifyCadenceDays: 120,
  },
  {
    sourceKey: "lge-ky-gas",
    utilityName: "Louisville Gas and Electric (LG&E)",
    commodity: "gas",
    state: "KY",
    sourceUrl: "https://lge-ku.com/sites/default/files/media/files/downloads/LGE-Gas-Rates-062226.pdf",
    sourceLabel: "LG&E P.S.C. Gas No. 14 (KY PSC filed; GSC files quarterly)",
    governsUrdbIds: ["lge-rgs", "lge-cgs"],
    adjustorCycle: "quarterly_gsc",
    verifyCadenceDays: 90,
  },
  {
    sourceKey: "unsg-az-gas",
    utilityName: "UNS Gas (UniSource)",
    commodity: "gas",
    state: "AZ",
    sourceUrl: "https://docs.uesaz.com/wp-content/uploads/UNSG-Tariff-Sheet-1.1.pdf",
    sourceLabel: "UNS Gas Statement of Rates Tariff Sheet 1.1 (PGA-inclusive)",
    governsUrdbIds: ["unsg-grres", "unsg-ggsvs"],
    adjustorCycle: "monthly_pga",
    verifyCadenceDays: 90,
  },
  /* ---- NAT-7 pending-rate-case dockets (advance notice, govern nothing) ---- */
  {
    sourceKey: "docket-aps-rate-case",
    utilityName: "Arizona Public Service Co (APS)",
    commodity: "electric",
    state: "AZ",
    sourceUrl: "https://www.aps.com/en/Utility/Regulatory-and-Legal/Rate-case",
    sourceLabel: "APS pending rate case (ACC Docket E-01345A-25-0105 watch)",
    governsUrdbIds: [],
    adjustorCycle: "none",
    verifyCadenceDays: 45,
    sourceKind: "docket",
  },
  {
    sourceKey: "docket-tep-rates-pricing",
    utilityName: "Tucson Electric Power (TEP)",
    commodity: "electric",
    state: "AZ",
    sourceUrl: "https://www.tep.com/2026-rates/",
    sourceLabel: "TEP pending rate review (ACC Docket 25-0103 watch)",
    governsUrdbIds: [],
    adjustorCycle: "none",
    verifyCadenceDays: 45,
    sourceKind: "docket",
  },
  /* ---- TEL1C-2 telecom benchmark sources (govern telecom_benchmarks tiers,
   * not tariff rows). Reachability verified Jul 2026:
   *  - fcc.gov 000s and most carrier pages 403 server-side fetches — those are
   *    AGENT-ONLY sources (monthly browser-based verification, like SRP);
   *  - verizon.com, att.com, visible.com, starlink.com serve 200 to browser-
   *    header fetches — they join the weekly fingerprint sweep. */
  {
    sourceKey: "telecom-fcc-urs",
    utilityName: "FCC Urban Rate Survey",
    commodity: "telecom",
    state: "US",
    // fcc.gov blocks datacenter fetches (connection reset) — monthly AGENT
    // verification with a real browser covers this source; weekly sweep
    // failures are expected and tolerated (consecutiveFailures grows,
    // agent priority rises).
    sourceUrl: "https://www.fcc.gov/economics-analytics/industry-analysis-division/urban-rate-survey-data-resources",
    sourceLabel: "FCC Urban Rate Survey (fixed broadband + voice, annual)",
    governsUrdbIds: [],
    governsTierKeys: [
      "internet_res_under_100",
      "internet_res_100_300",
      "internet_res_300_600",
      "internet_res_600_1000",
      "internet_res_gigabit_plus",
      "phone_landline_standard",
    ],
    adjustorCycle: "annual",
    verifyCadenceDays: 180,
    sourceKind: "benchmark",
  },
  {
    sourceKey: "telecom-verizon-home",
    utilityName: "Verizon (home internet)",
    commodity: "telecom",
    state: "US",
    sourceUrl: "https://www.verizon.com/home/internet/",
    sourceLabel: "Verizon home internet published pricing (Fios + 5G Home)",
    governsUrdbIds: [],
    governsTierKeys: ["internet_res_100_300", "internet_res_300_600", "internet_res_gigabit_plus"],
    adjustorCycle: "none",
    verifyCadenceDays: 90,
    sourceKind: "benchmark",
  },
  {
    sourceKey: "telecom-att-fiber",
    utilityName: "AT&T (fiber internet)",
    commodity: "telecom",
    state: "US",
    sourceUrl: "https://www.att.com/internet/fiber/",
    sourceLabel: "AT&T Fiber published pricing",
    governsUrdbIds: [],
    governsTierKeys: ["internet_res_300_600", "internet_res_600_1000", "internet_res_gigabit_plus", "internet_biz_under_500", "internet_biz_500_plus"],
    adjustorCycle: "none",
    verifyCadenceDays: 90,
    sourceKind: "benchmark",
  },
  {
    sourceKey: "telecom-visible-mobile",
    utilityName: "Visible by Verizon (MVNO)",
    commodity: "telecom",
    state: "US",
    sourceUrl: "https://www.visible.com/plans",
    sourceLabel: "Visible published MVNO plan pricing",
    governsUrdbIds: [],
    governsTierKeys: ["mobile_unlimited_prepaid_mvno"],
    adjustorCycle: "none",
    verifyCadenceDays: 90,
    sourceKind: "benchmark",
  },
  {
    sourceKey: "telecom-carrier-postpaid",
    utilityName: "Major-carrier postpaid pricing (T-Mobile/Verizon/AT&T)",
    commodity: "telecom",
    state: "US",
    // Carrier plan pages 403 server-side fetches — AGENT-ONLY source, same
    // treatment as SRP/Tucson Water. The URL is the canonical target the
    // monthly agent opens in a real browser.
    sourceUrl: "https://www.t-mobile.com/cell-phone-plans",
    sourceLabel: "Major-carrier unlimited postpaid published pricing (agent-verified)",
    governsUrdbIds: [],
    governsTierKeys: ["mobile_unlimited_postpaid", "mobile_limited_data"],
    adjustorCycle: "none",
    verifyCadenceDays: 90,
    sourceKind: "benchmark",
  },
  {
    sourceKey: "docket-lge-ky-psc",
    utilityName: "Louisville Gas and Electric (LG&E)",
    commodity: "electric",
    state: "KY",
    sourceUrl: "https://lge-ku.com/raterequest",
    sourceLabel: "LG&E/KU rate request page (pending KY PSC change watch, electric + gas)",
    governsUrdbIds: [],
    adjustorCycle: "none",
    verifyCadenceDays: 45,
    sourceKind: "docket",
  },
];

/** Idempotent boot/refresh registration: missing sources are added; existing
 * rows keep their runtime state (fingerprints, failure counts) but URL/label/
 * governs lists are re-asserted so seed edits propagate. */
export async function registerRateSources(): Promise<{ inserted: number; updated: number }> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  let inserted = 0;
  let updated = 0;
  for (const s of RATE_SOURCE_SEEDS) {
    // TEL1C-2: benchmark tier keys ride in the same governs list, prefixed.
    const governs = [...s.governsUrdbIds, ...(s.governsTierKeys ?? []).map((k) => `${TIER_PREFIX}${k}`)];
    const existing = await db.select({ id: rateSources.id, sourceUrl: rateSources.sourceUrl }).from(rateSources).where(eq(rateSources.sourceKey, s.sourceKey)).limit(1);
    if (existing.length === 0) {
      await db.insert(rateSources).values({
        sourceKey: s.sourceKey,
        utilityName: s.utilityName,
        commodity: s.commodity,
        state: s.state,
        sourceUrl: s.sourceUrl,
        sourceLabel: s.sourceLabel,
        governsUrdbIds: governs,
        adjustorCycle: s.adjustorCycle,
        verifyCadenceDays: s.verifyCadenceDays,
        sourceKind: s.sourceKind ?? "tariff",
      });
      inserted++;
    } else {
      await db
        .update(rateSources)
        .set({
          utilityName: s.utilityName,
          sourceUrl: s.sourceUrl,
          sourceLabel: s.sourceLabel,
          governsUrdbIds: governs,
          adjustorCycle: s.adjustorCycle,
          verifyCadenceDays: s.verifyCadenceDays,
          sourceKind: s.sourceKind ?? "tariff",
        })
        .where(eq(rateSources.sourceKey, s.sourceKey));
      updated++;
    }
    // Stamp sourceUrl onto the governed tariff rows so UI disclosures can
    // link "verified against <source>" without a join at render time.
    // Docket sources govern nothing — skip the (empty inArray) stamp.
    if (s.governsUrdbIds.length > 0) {
      await db
        .update(tariffs)
        .set({ sourceUrl: s.sourceUrl })
        .where(inArray(tariffs.urdbId, s.governsUrdbIds));
    }
  }
  return { inserted, updated };
}

/* ------------------------------------------------------------------ */
/* Weekly fingerprint sweep + due-horizon scan                         */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  checked: number;
  changed: string[]; // sourceKeys whose fingerprint changed
  due: string[]; // sourceKeys past verify cadence
  unreachable: string[]; // fetch failures this sweep
}

/** Fetch a source document and hash it. PDFs hash exactly; HTML pages are
 * lightly normalized (scripts/nonces stripped) to avoid per-request noise. */
export async function fingerprintSource(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(url, {
    headers: {
      // Full browser-like headers: several utility sites (CDN bot rules) 403
      // plain bot UAs but serve standard browser requests.
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (contentType.includes("text/html")) {
    // Normalize volatile HTML by hashing VISIBLE TEXT ONLY: drop script/style
    // bodies, comments, then strip every tag (attributes carry per-request
    // tokens — nonces, csrf, cache-busted asset URLs, session ids — that
    // caused false change detections). A rate change necessarily changes the
    // rendered text; markup churn alone no longer flips the hash.
    const text = buf
      .toString("utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      // Volatile infrastructure noise: some sites print the serving node
      // (e.g. aps.com footer "Current server address is 10.20.64.10"). Strip
      // bare IPv4 addresses — tariff text never depends on them.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return createHash("sha256").update(text).digest("hex");
  }
  return createHash("sha256").update(buf).digest("hex");
}

/** Effective cadence: adjustor-cycled sources verify on the cycle, not the
 * base cadence, so quarterly GSC/PGA filings are caught within their window. */
export function effectiveCadenceDays(source: Pick<RateSourceRow, "adjustorCycle" | "verifyCadenceDays">): number {
  switch (source.adjustorCycle) {
    case "monthly_pga":
      return Math.min(source.verifyCadenceDays, 45);
    case "quarterly_pga":
    case "quarterly_gsc":
      return Math.min(source.verifyCadenceDays, 100);
    default:
      return source.verifyCadenceDays;
  }
}

/** Weekly sweep body — called from refreshReferenceHandler. Never throws;
 * per-source failures increment consecutiveFailures and continue. */
export async function sweepRateSources(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<SweepResult> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  await registerRateSources();
  // DKT-2: territory-driven docket auto-registration — every state with sites
  // gets a commission docket watch, so a site added in a new state is covered
  // by the next weekly sweep with zero prompting. Best-effort: a docket
  // registration failure must never block the tariff fingerprint sweep.
  try {
    const { ensureDocketCoverage } = await import("./stateDockets");
    await ensureDocketCoverage();
  } catch {
    /* docket coverage is additive; sweep continues regardless */
  }
  // GWD-2: major gas LDC acquisition floor — idempotent (dedupes by
  // utility+state+commodity), so weekly re-calls only bump demand counts on
  // still-pending entries. Best-effort like docket coverage.
  try {
    const { seedGasDepthQueue } = await import("./gasWaterDepth");
    await seedGasDepthQueue();
  } catch {
    /* gas depth floor is additive; sweep continues regardless */
  }
  const sources = await db.select().from(rateSources);
  const result: SweepResult = { checked: 0, changed: [], due: [], unreachable: [] };
  for (const s of sources) {
    result.checked++;
    // 1. fingerprint check
    try {
      const hash = await fingerprintSource(s.sourceUrl, fetchImpl);
      const changed = s.contentFingerprint != null && s.contentFingerprint !== hash;
      await db
        .update(rateSources)
        .set({
          contentFingerprint: hash,
          fingerprintAt: now,
          consecutiveFailures: 0,
          ...(changed ? { changeDetectedAt: now } : {}),
        })
        .where(eq(rateSources.id, s.id));
      if (changed) {
        result.changed.push(s.sourceKey);
        const govern = s.governsUrdbIds as string[];
        const urdbIds = urdbIdsOf(govern);
        const tierKeys = tierIdsOf(govern);
        if (urdbIds.length > 0) {
          await db
            .update(tariffs)
            .set({ verifyStatus: "change_detected" })
            .where(inArray(tariffs.urdbId, urdbIds));
        }
        // TEL1C-2: benchmark sources escalate their governed telecom tiers.
        if (tierKeys.length > 0) {
          await db
            .update(telecomBenchmarks)
            .set({ verifyStatus: "change_detected" })
            .where(inArray(telecomBenchmarks.tierKey, tierKeys));
        }
        await db.insert(rateVerifications).values({
          sourceKey: s.sourceKey,
          checkedAt: now,
          status: "change_detected",
          evidence: `source document fingerprint changed (${s.sourceLabel})`,
          method: "weekly_fingerprint",
        });
      }
    } catch {
      result.unreachable.push(s.sourceKey);
      await db
        .update(rateSources)
        .set({ consecutiveFailures: s.consecutiveFailures + 1 })
        .where(eq(rateSources.id, s.id));
    }
    // 2. due-horizon: past effective cadence since last verification
    const cadence = effectiveCadenceDays(s);
    const anchor = s.lastVerifiedAt ?? s.createdAt.getTime();
    if (s.changeDetectedAt == null && now - anchor > cadence * DAY_MS) {
      result.due.push(s.sourceKey);
      const gv = s.governsUrdbIds as string[];
      const gvUrdb = urdbIdsOf(gv);
      const gvTiers = tierIdsOf(gv);
      if (gvUrdb.length > 0) {
        await db
          .update(tariffs)
          .set({ verifyStatus: "due" })
          .where(and(inArray(tariffs.urdbId, gvUrdb), eq(tariffs.verifyStatus, "current")));
      }
      // TEL1C-2: stale benchmark sources flip their tiers to 'due' so telecom
      // findings carry a currency disclosure until the agent re-verifies.
      if (gvTiers.length > 0) {
        await db
          .update(telecomBenchmarks)
          .set({ verifyStatus: "due" })
          .where(and(inArray(telecomBenchmarks.tierKey, gvTiers), eq(telecomBenchmarks.verifyStatus, "current")));
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Monthly agent verification: targets out, findings in                */
/* ------------------------------------------------------------------ */

export interface VerifyTarget {
  sourceKey: string;
  utilityName: string;
  commodity: string;
  state: string;
  sourceUrl: string;
  sourceLabel: string;
  priority: number; // higher = verify first
  lastVerifiedAt: number | null;
  tariffRows: Array<{
    urdbId: string;
    name: string;
    sector: string;
    fixedMonthly: number | null;
    energyRates: Array<{ label: string; ratePerUnit: number }>;
  }>;
  /** TEL1C-2: telecom benchmark tiers this source governs — the agent
   * verifies the published low/median/high against the live source and
   * reports observedTiers. Empty for tariff/docket sources. */
  benchmarkTiers?: Array<{
    tierKey: string;
    tierLabel: string;
    typicalLowUsd: number;
    medianUsd: number;
    typicalHighUsd: number;
  }>;
}

/** Prioritized verification targets for the monthly agent run.
 * change_detected sources first, then due, then stalest. Cap bounds the
 * agent's work per run (config rate.verify_targets_per_run, default 10). */
export async function getVerifyTargets(now = Date.now()): Promise<VerifyTarget[]> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  await registerRateSources();
  const cap = await configNumber("rate.verify_targets_per_run", 10);
  const sources = await db.select().from(rateSources);
  const scored = sources
    .map((s) => {
      const ageDays = (now - (s.lastVerifiedAt ?? s.createdAt.getTime())) / DAY_MS;
      const cadence = effectiveCadenceDays(s);
      let priority = ageDays / Math.max(cadence, 1); // 1.0 = exactly due
      if (s.changeDetectedAt != null) priority += 10; // change trumps everything
      return { s, priority };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(1, Math.floor(cap)));
  const targets: VerifyTarget[] = [];
  for (const { s, priority } of scored) {
    const gvUrdb = urdbIdsOf(s.governsUrdbIds as string[]);
    const gvTiers = tierIdsOf(s.governsUrdbIds as string[]);
    const rows = gvUrdb.length
      ? await db
          .select({
            urdbId: tariffs.urdbId,
            name: tariffs.name,
            sector: tariffs.sector,
            structure: tariffs.structure,
          })
          .from(tariffs)
          .where(inArray(tariffs.urdbId, gvUrdb))
      : [];
    const tierRows = gvTiers.length
      ? await db
          .select({
            tierKey: telecomBenchmarks.tierKey,
            tierLabel: telecomBenchmarks.tierLabel,
            typicalLowUsd: telecomBenchmarks.typicalLowUsd,
            medianUsd: telecomBenchmarks.medianUsd,
            typicalHighUsd: telecomBenchmarks.typicalHighUsd,
          })
          .from(telecomBenchmarks)
          .where(inArray(telecomBenchmarks.tierKey, gvTiers))
      : [];
    targets.push({
      sourceKey: s.sourceKey,
      utilityName: s.utilityName,
      commodity: s.commodity,
      state: s.state,
      sourceUrl: s.sourceUrl,
      sourceLabel: s.sourceLabel,
      priority: Math.round(priority * 100) / 100,
      lastVerifiedAt: s.lastVerifiedAt,
      tariffRows: rows.map((r) => {
        const st = r.structure as { fixedMonthly?: number; energy?: Array<{ label?: string; ratePerUnit?: number }> };
        return {
          urdbId: r.urdbId ?? "",
          name: r.name,
          sector: r.sector,
          fixedMonthly: st.fixedMonthly ?? null,
          energyRates: (st.energy ?? []).map((e) => ({ label: e.label ?? "", ratePerUnit: e.ratePerUnit ?? 0 })),
        };
      }),
      ...(tierRows.length > 0 ? { benchmarkTiers: tierRows } : {}),
    });
  }
  return targets;
}

export interface AgentFinding {
  sourceKey: string;
  status: "confirmed" | "changed" | "source_moved" | "unreachable";
  /** for status=changed: per-tariff observed values */
  observed?: Array<{
    urdbId: string;
    fixedMonthly?: number;
    energyRates?: Array<{ label: string; ratePerUnit: number }>;
    effectiveDate?: string;
    notes?: string;
  }>;
  /** TEL1C-2: for benchmark sources with status=changed — observed published
   * price bands per governed tier. Applied with the same auto-apply band
   * discipline as tariff adjustor deltas. */
  observedTiers?: Array<{
    tierKey: string;
    typicalLowUsd?: number;
    medianUsd?: number;
    typicalHighUsd?: number;
    notes?: string;
  }>;
  newSourceUrl?: string;
  evidence: string;
}

export interface ApplyResult {
  sourceKey: string;
  action: "verified" | "auto_applied" | "flagged_for_review" | "source_updated" | "failure_recorded" | "acquired";
  detail: string;
}

/** Apply one agent finding. Conservative by design:
 *  - confirmed → stamp lastVerifiedAt, rows back to 'current'
 *  - changed, all deltas ≤ auto-apply cap → apply in place (adjustor band),
 *    audit row applied=true, rows 'current' with fresh verify stamp
 *  - changed, any delta > cap → rows stay 'change_detected', owner must act
 *  - source_moved → adopt newSourceUrl, reset fingerprint
 *  - unreachable → failure count only
 * Returns a human-readable action record for the notification digest. */
export async function applyAgentFinding(f: AgentFinding, now = Date.now()): Promise<ApplyResult> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  const src = (await db.select().from(rateSources).where(eq(rateSources.sourceKey, f.sourceKey)).limit(1))[0];
  if (!src) return { sourceKey: f.sourceKey, action: "failure_recorded", detail: "unknown sourceKey" };
  const governAll = src.governsUrdbIds as string[];
  const govern = urdbIdsOf(governAll);
  const governTiers = tierIdsOf(governAll);

  if (f.status === "confirmed") {
    await db
      .update(rateSources)
      .set({ lastVerifiedAt: now, changeDetectedAt: null, consecutiveFailures: 0 })
      .where(eq(rateSources.id, src.id));
    if (govern.length > 0) {
      await db
        .update(tariffs)
        .set({ verifyStatus: "current", lastVerifiedAt: now })
        .where(inArray(tariffs.urdbId, govern));
    }
    // TEL1C-2: benchmark confirmation re-stamps governed telecom tiers.
    if (governTiers.length > 0) {
      await db
        .update(telecomBenchmarks)
        .set({ verifyStatus: "current", lastVerifiedAt: now })
        .where(inArray(telecomBenchmarks.tierKey, governTiers));
    }
    await db.insert(rateVerifications).values({
      sourceKey: f.sourceKey,
      checkedAt: now,
      status: "confirmed",
      evidence: f.evidence.slice(0, 1024),
      method: "agent_verify",
    });
    return {
      sourceKey: f.sourceKey,
      action: "verified",
      detail: `${govern.length + governTiers.length} governed row(s) re-verified against ${src.sourceLabel}`,
    };
  }

  if (f.status === "source_moved") {
    if (f.newSourceUrl) {
      await db
        .update(rateSources)
        .set({ sourceUrl: f.newSourceUrl, contentFingerprint: null, fingerprintAt: null, consecutiveFailures: 0 })
        .where(eq(rateSources.id, src.id));
      if (govern.length > 0) {
        await db.update(tariffs).set({ sourceUrl: f.newSourceUrl }).where(inArray(tariffs.urdbId, govern));
      }
    }
    await db.insert(rateVerifications).values({
      sourceKey: f.sourceKey,
      checkedAt: now,
      status: "source_moved",
      evidence: f.evidence.slice(0, 1024),
      method: "agent_verify",
    });
    return { sourceKey: f.sourceKey, action: "source_updated", detail: `source URL updated to ${f.newSourceUrl ?? "(none provided)"} — verification still pending` };
  }

  if (f.status === "unreachable") {
    await db
      .update(rateSources)
      .set({ consecutiveFailures: src.consecutiveFailures + 1 })
      .where(eq(rateSources.id, src.id));
    await db.insert(rateVerifications).values({
      sourceKey: f.sourceKey,
      checkedAt: now,
      status: "unreachable",
      evidence: f.evidence.slice(0, 1024),
      method: "agent_verify",
    });
    return { sourceKey: f.sourceKey, action: "failure_recorded", detail: `source unreachable (${src.consecutiveFailures + 1} consecutive)` };
  }

  // status === "changed"
  const capPct = await configNumber("rate.auto_apply_max_pct", 15);

  /* TEL1C-2: benchmark-source changes update telecom_benchmarks tiers under
   * the same auto-apply band. Benchmarks are market context (not filed
   * rates), so within-band updates apply and re-stamp; out-of-band changes
   * flag change_detected for owner review, same conservatism as tariffs. */
  if (governTiers.length > 0 && (f.observedTiers?.length ?? 0) > 0) {
    const tierRows = await db.select().from(telecomBenchmarks).where(inArray(telecomBenchmarks.tierKey, governTiers));
    const byTier = new Map(tierRows.map((r) => [r.tierKey, r]));
    let maxTierDeltaPct = 0;
    const tierUpdates: Array<{ id: number; tierKey: string; set: Record<string, number>; desc: string }> = [];
    for (const ot of f.observedTiers ?? []) {
      const row = byTier.get(ot.tierKey);
      if (!row) continue;
      const set: Record<string, number> = {};
      const descs: string[] = [];
      const fields: Array<[keyof typeof ot & string, "typicalLowUsd" | "medianUsd" | "typicalHighUsd", number]> = [
        ["typicalLowUsd", "typicalLowUsd", row.typicalLowUsd],
        ["medianUsd", "medianUsd", row.medianUsd],
        ["typicalHighUsd", "typicalHighUsd", row.typicalHighUsd],
      ];
      for (const [obsKey, col, cur] of fields) {
        const obs = ot[obsKey] as number | undefined;
        if (obs != null && obs > 0 && cur > 0 && obs !== cur) {
          maxTierDeltaPct = Math.max(maxTierDeltaPct, (Math.abs(obs - cur) / cur) * 100);
          set[col] = obs;
          descs.push(`${col} ${cur} → ${obs}`);
        }
      }
      if (descs.length > 0) tierUpdates.push({ id: row.id, tierKey: ot.tierKey, set, desc: descs.join(", ") });
    }
    if (tierUpdates.length > 0) {
      const tierWithinBand = maxTierDeltaPct <= capPct;
      for (const u of tierUpdates) {
        if (tierWithinBand) {
          await db
            .update(telecomBenchmarks)
            .set({ ...u.set, verifyStatus: "current", lastVerifiedAt: now })
            .where(eq(telecomBenchmarks.id, u.id));
        } else {
          await db.update(telecomBenchmarks).set({ verifyStatus: "change_detected" }).where(eq(telecomBenchmarks.id, u.id));
        }
        await db.insert(rateVerifications).values({
          sourceKey: f.sourceKey,
          urdbId: `tier:${u.tierKey}`,
          checkedAt: now,
          status: "changed",
          observed: f.observedTiers?.find((o) => o.tierKey === u.tierKey) ?? null,
          applied: tierWithinBand,
          evidence: `${u.desc} — ${f.evidence}`.slice(0, 1024),
          method: "agent_verify",
        });
      }
      // untouched governed tiers verified-current by the same check
      if (tierWithinBand) {
        await db
          .update(telecomBenchmarks)
          .set({ verifyStatus: "current", lastVerifiedAt: now })
          .where(inArray(telecomBenchmarks.tierKey, governTiers));
        await db
          .update(rateSources)
          .set({ lastVerifiedAt: now, changeDetectedAt: null, consecutiveFailures: 0 })
          .where(eq(rateSources.id, src.id));
        return {
          sourceKey: f.sourceKey,
          action: "auto_applied",
          detail: `benchmark band update applied (max delta ${maxTierDeltaPct.toFixed(1)}% ≤ ${capPct}% cap): ${tierUpdates.map((u) => `${u.tierKey}: ${u.desc}`).join(" | ")}`,
        };
      }
      await db
        .update(rateSources)
        .set({ changeDetectedAt: now, consecutiveFailures: 0 })
        .where(eq(rateSources.id, src.id));
      return {
        sourceKey: f.sourceKey,
        action: "flagged_for_review",
        detail: `benchmark change beyond ${capPct}% cap (max delta ${maxTierDeltaPct.toFixed(1)}%) — observed bands recorded, tiers flagged change_detected`,
      };
    }
  }

  const observed = f.observed ?? [];
  let maxDeltaPct = 0;
  const rows = govern.length > 0 ? await db.select().from(tariffs).where(inArray(tariffs.urdbId, govern)) : [];
  const byUrdb = new Map(rows.map((r) => [r.urdbId ?? "", r]));
  const pendingUpdates: Array<{ id: number; structure: unknown; urdbId: string; deltaDesc: string }> = [];
  /** IMP-1: signed deltas captured for per-site impact projection */
  const signedDeltas: Array<{ urdbId: string; volumetricDeltas: number[]; fixedMonthlyDelta: number }> = [];
  for (const o of observed) {
    const row = byUrdb.get(o.urdbId);
    if (!row) continue;
    const st = structuredClone(row.structure) as {
      fixedMonthly?: number;
      energy?: Array<{ label?: string; ratePerUnit?: number }>;
    };
    const deltas: string[] = [];
    const volDeltas: number[] = [];
    let fixedDelta = 0;
    if (o.fixedMonthly != null && st.fixedMonthly != null && st.fixedMonthly > 0) {
      const d = Math.abs(o.fixedMonthly - st.fixedMonthly) / st.fixedMonthly;
      if (d > 0) {
        maxDeltaPct = Math.max(maxDeltaPct, d * 100);
        deltas.push(`fixed ${st.fixedMonthly} → ${o.fixedMonthly}`);
        fixedDelta = o.fixedMonthly - st.fixedMonthly;
        st.fixedMonthly = o.fixedMonthly;
      }
    }
    if (o.energyRates && st.energy) {
      for (const or of o.energyRates) {
        // match by label prefix (case-insensitive) — agent echoes our labels
        const match = st.energy.find((e) => (e.label ?? "").toLowerCase().startsWith(or.label.toLowerCase().slice(0, 12)));
        if (match && match.ratePerUnit != null && match.ratePerUnit > 0 && or.ratePerUnit > 0) {
          const d = Math.abs(or.ratePerUnit - match.ratePerUnit) / match.ratePerUnit;
          if (d > 0) {
            maxDeltaPct = Math.max(maxDeltaPct, d * 100);
            deltas.push(`${match.label}: ${match.ratePerUnit} → ${or.ratePerUnit}`);
            volDeltas.push(or.ratePerUnit - match.ratePerUnit);
            match.ratePerUnit = or.ratePerUnit;
          }
        }
      }
    }
    if (deltas.length > 0) {
      pendingUpdates.push({ id: row.id, structure: st, urdbId: o.urdbId, deltaDesc: deltas.join("; ") });
      signedDeltas.push({ urdbId: o.urdbId, volumetricDeltas: volDeltas, fixedMonthlyDelta: fixedDelta });
    }
  }

  const withinBand = maxDeltaPct > 0 && maxDeltaPct <= capPct;
  if (withinBand) {
    for (const u of pendingUpdates) {
      await db
        .update(tariffs)
        .set({ structure: u.structure as object, verifyStatus: "current", lastVerifiedAt: now })
        .where(eq(tariffs.id, u.id));
      await db.insert(rateVerifications).values({
        sourceKey: f.sourceKey,
        urdbId: u.urdbId,
        checkedAt: now,
        status: "changed",
        observed: observed.find((o) => o.urdbId === u.urdbId) ?? null,
        applied: true,
        evidence: `${u.deltaDesc} — ${f.evidence}`.slice(0, 1024),
        method: "agent_verify",
      });
    }
    // untouched governed rows are still verified-current by this same check
    await db
      .update(tariffs)
      .set({ verifyStatus: "current", lastVerifiedAt: now })
      .where(inArray(tariffs.urdbId, govern));
    await db
      .update(rateSources)
      .set({ lastVerifiedAt: now, changeDetectedAt: null, consecutiveFailures: 0 })
      .where(eq(rateSources.id, src.id));
    // IMP-1: project per-site $/yr impact and attach to the audit rows.
    // Failure here must never fail the apply itself.
    let impactNote = "";
    try {
      const { computeRateChangeImpact, attachImpactToVerifications } = await import("./rateImpact");
      const impact = await computeRateChangeImpact(signedDeltas);
      if (impact && impact.perSite.length > 0) {
        await attachImpactToVerifications(f.sourceKey, now, impact);
        impactNote = ` — projected impact: ${impact.affectedSites} site(s), ${impact.totalUsdYrDelta >= 0 ? "+" : ""}$${impact.totalUsdYrDelta.toFixed(0)}/yr`;
      }
    } catch {
      /* impact projection is best-effort */
    }
    return {
      sourceKey: f.sourceKey,
      action: "auto_applied",
      detail: `adjustor-band update applied (max delta ${maxDeltaPct.toFixed(1)}% ≤ ${capPct}% cap): ${pendingUpdates.map((u) => u.deltaDesc).join(" | ")}${impactNote}`,
    };
  }

  // Large change (or unmatched structure): flag, never silently mutate.
  await db
    .update(tariffs)
    .set({ verifyStatus: "change_detected" })
    .where(inArray(tariffs.urdbId, govern));
  await db
    .update(rateSources)
    .set({ changeDetectedAt: now, consecutiveFailures: 0 })
    .where(eq(rateSources.id, src.id));
  for (const o of observed) {
    await db.insert(rateVerifications).values({
      sourceKey: f.sourceKey,
      urdbId: o.urdbId,
      checkedAt: now,
      status: "changed",
      observed: o,
      applied: false,
      evidence: f.evidence.slice(0, 1024),
      method: "agent_verify",
    });
  }
  // IMP-1: even for flagged (not-applied) changes, project the WOULD-BE impact
  // so the owner sees dollar stakes when deciding. Best-effort.
  let flaggedImpactNote = "";
  try {
    const { computeRateChangeImpact, attachImpactToVerifications } = await import("./rateImpact");
    const impact = await computeRateChangeImpact(signedDeltas);
    if (impact && impact.perSite.length > 0) {
      await attachImpactToVerifications(f.sourceKey, now, impact);
      flaggedImpactNote = ` — projected impact if adopted: ${impact.affectedSites} site(s), ${impact.totalUsdYrDelta >= 0 ? "+" : ""}$${impact.totalUsdYrDelta.toFixed(0)}/yr`;
    }
  } catch {
    /* impact projection is best-effort */
  }
  return {
    sourceKey: f.sourceKey,
    action: "flagged_for_review",
    detail: `rate change beyond ${capPct}% auto-apply cap (max delta ${maxDeltaPct.toFixed(1)}%) — observed values recorded, rows flagged change_detected${flaggedImpactNote}`,
  };
}

/* ------------------------------------------------------------------ */
/* NAT-5 acquire-mode — the agent fills catalog gaps end to end.       */
/* ------------------------------------------------------------------ */

export interface AcquisitionFinding {
  queueId: number;
  status: "acquired" | "failed";
  rates?: Array<{
    sector: "Residential" | "Commercial";
    rateName: string;
    fixedMonthly: number;
    energyRatePerUnit: number;
    unit?: string;
    effectiveDate?: string;
    notes?: string;
  }>;
  sourceUrl?: string;
  evidence: string;
}

/** Apply one acquisition finding: insert agent_acquired tariff rows for a
 * utility the catalog lacked, mark the queue entry, and record the audit
 * trail. Sanity bounds keep a hallucinated rate out of the catalog: energy
 * rate must be $0.01–$1.50/unit and fixed charge ≤ $500/mo. */
export async function applyAcquisition(a: AcquisitionFinding, now = Date.now()): Promise<ApplyResult> {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  const { rateAcquisitionQueue } = await import("../drizzle/schema");
  const q = (await db.select().from(rateAcquisitionQueue).where(eq(rateAcquisitionQueue.id, a.queueId)).limit(1))[0];
  const key = `acq-${a.queueId}`;
  if (!q) return { sourceKey: key, action: "failure_recorded", detail: "unknown queueId" };

  if (a.status === "failed" || !a.rates || a.rates.length === 0) {
    await db
      .update(rateAcquisitionQueue)
      .set({ status: "failed", lastError: a.evidence.slice(0, 512) })
      .where(eq(rateAcquisitionQueue.id, a.queueId));
    await db.insert(rateVerifications).values({
      sourceKey: key,
      checkedAt: now,
      status: "unreachable",
      evidence: a.evidence.slice(0, 1024),
      method: "agent_acquire",
    });
    return { sourceKey: key, action: "failure_recorded", detail: `acquisition failed for ${q.utilityName} (${q.state} ${q.commodity})` };
  }

  const unitDefault = q.commodity === "electric" ? "kWh" : q.commodity === "gas" ? "therm" : "kgal";
  let inserted = 0;
  const rejected: string[] = [];
  for (const r of a.rates.slice(0, 6)) {
    if (r.energyRatePerUnit < 0.01 || r.energyRatePerUnit > 1.5 || r.fixedMonthly > 500) {
      rejected.push(`${r.rateName} (out of sanity bounds)`);
      continue;
    }
    const sectorLc = r.sector.toLowerCase() as "residential" | "commercial";
    const urdbId = `acq-${a.queueId}-${sectorLc}-${inserted}`;
    const unit = r.unit ?? unitDefault;
    await db.insert(tariffs).values({
      urdbId,
      utilityName: q.utilityName,
      name: `${r.rateName} — agent-acquired from official source, ${r.effectiveDate ?? "effective date unverified"}`,
      sector: sectorLc,
      state: q.state,
      commodity: q.commodity,
      source: "agent_acquired",
      sourceUrl: a.sourceUrl ?? null,
      verifyStatus: "current",
      lastVerifiedAt: now,
      structure: {
        fixedMonthly: r.fixedMonthly,
        energy: [
          {
            label: `${r.rateName}${r.notes ? ` — ${r.notes.slice(0, 160)}` : ""} (agent-acquired; verify against your bill)`,
            ratePerUnit: r.energyRatePerUnit,
            unit,
          },
        ],
      },
    });
    inserted++;
  }

  await db
    .update(rateAcquisitionQueue)
    .set(
      inserted > 0
        ? { status: "acquired", lastError: null }
        : { status: "failed", lastError: `all ${a.rates.length} rate(s) rejected: ${rejected.join("; ")}`.slice(0, 512) },
    )
    .where(eq(rateAcquisitionQueue.id, a.queueId));
  await db.insert(rateVerifications).values({
    sourceKey: key,
    checkedAt: now,
    status: inserted > 0 ? "changed" : "unreachable",
    observed: a.rates as unknown as Record<string, unknown>[],
    applied: inserted > 0,
    evidence: a.evidence.slice(0, 1024),
    method: "agent_acquire",
  });
  return {
    sourceKey: key,
    action: inserted > 0 ? "acquired" : "failure_recorded",
    detail:
      inserted > 0
        ? `${inserted} filed rate(s) acquired for ${q.utilityName} (${q.state} ${q.commodity})${rejected.length > 0 ? `; ${rejected.length} rejected by sanity bounds` : ""}`
        : `all rates rejected by sanity bounds for ${q.utilityName}`,
  };
}

/** Recent verification history for the UI panel. */
export async function recentVerifications(limit = 50) {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  return db.select().from(rateVerifications).orderBy(desc(rateVerifications.checkedAt)).limit(limit);
}

/** Currency rollup for the UI: per-source status + governed row counts. */
export async function rateCurrencyStatus(now = Date.now()) {
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  const sources = await db.select().from(rateSources);
  return sources.map((s) => {
    const cadence = effectiveCadenceDays(s);
    const anchor = s.lastVerifiedAt ?? s.createdAt.getTime();
    const ageDays = Math.floor((now - anchor) / DAY_MS);
    return {
      sourceKey: s.sourceKey,
      utilityName: s.utilityName,
      commodity: s.commodity,
      state: s.state,
      sourceLabel: s.sourceLabel,
      sourceUrl: s.sourceUrl,
      lastVerifiedAt: s.lastVerifiedAt,
      ageDays,
      cadenceDays: cadence,
      status: s.changeDetectedAt != null ? ("change_detected" as const) : ageDays > cadence ? ("due" as const) : ("current" as const),
      consecutiveFailures: s.consecutiveFailures,
      governs: (s.governsUrdbIds as string[]).length,
      sourceKind: s.sourceKind,
    };
  });
}
