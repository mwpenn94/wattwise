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
import { rateSources, rateVerifications, tariffs, type RateSourceRow } from "../drizzle/schema";
import { configNumber } from "./seedLifecycle";

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Source registry seed — one row per governing official document.     */
/* ------------------------------------------------------------------ */

export interface RateSourceSeed {
  sourceKey: string;
  utilityName: string;
  commodity: "electric" | "gas" | "water";
  state: string;
  sourceUrl: string;
  sourceLabel: string;
  governsUrdbIds: string[];
  adjustorCycle: "none" | "quarterly_gsc" | "quarterly_pga" | "monthly_pga" | "annual";
  verifyCadenceDays: number;
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
    governsUrdbIds: ["aps-r-tou-4pm7pm", "aps-r-tou-demand", "aps-r-basic", "aps-gs-xs", "aps-gs-s"],
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
    governsUrdbIds: ["srp-ez3-tou", "srp-basic", "srp-e27-demand", "srp-gs-e36"],
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
    governsUrdbIds: ["tep-tou-basic", "tep-basic", "tep-gs-sgs"],
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
    governsUrdbIds: ["unse-res-basic", "unse-res-tou", "unse-sgs"],
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
    governsUrdbIds: ["swgas-az-res", "swgas-az-comm"],
    adjustorCycle: "monthly_pga",
    verifyCadenceDays: 90,
  },
  {
    sourceKey: "tucsonwater-az-water",
    utilityName: "Tucson Water",
    commodity: "water",
    state: "AZ",
    // tucsonaz.gov blocks datacenter IPs (403) — the weekly fingerprint sweep
    // will report unreachable; the monthly AGENT verifier (real browser) is the
    // effective check for this source. Kept as the canonical official URL.
    sourceUrl: "https://www.tucsonaz.gov/Departments/Water/Rates",
    sourceLabel: "Tucson Water rate ordinance",
    governsUrdbIds: ["tucsonwater-res"],
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
    const existing = await db.select({ id: rateSources.id, sourceUrl: rateSources.sourceUrl }).from(rateSources).where(eq(rateSources.sourceKey, s.sourceKey)).limit(1);
    if (existing.length === 0) {
      await db.insert(rateSources).values({
        sourceKey: s.sourceKey,
        utilityName: s.utilityName,
        commodity: s.commodity,
        state: s.state,
        sourceUrl: s.sourceUrl,
        sourceLabel: s.sourceLabel,
        governsUrdbIds: s.governsUrdbIds,
        adjustorCycle: s.adjustorCycle,
        verifyCadenceDays: s.verifyCadenceDays,
      });
      inserted++;
    } else {
      await db
        .update(rateSources)
        .set({
          utilityName: s.utilityName,
          sourceUrl: s.sourceUrl,
          sourceLabel: s.sourceLabel,
          governsUrdbIds: s.governsUrdbIds,
          adjustorCycle: s.adjustorCycle,
          verifyCadenceDays: s.verifyCadenceDays,
        })
        .where(eq(rateSources.sourceKey, s.sourceKey));
      updated++;
    }
    // Stamp sourceUrl onto the governed tariff rows so UI disclosures can
    // link "verified against <source>" without a join at render time.
    await db
      .update(tariffs)
      .set({ sourceUrl: s.sourceUrl })
      .where(inArray(tariffs.urdbId, s.governsUrdbIds));
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
        await db
          .update(tariffs)
          .set({ verifyStatus: "change_detected" })
          .where(inArray(tariffs.urdbId, s.governsUrdbIds as string[]));
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
      await db
        .update(tariffs)
        .set({ verifyStatus: "due" })
        .where(and(inArray(tariffs.urdbId, s.governsUrdbIds as string[]), eq(tariffs.verifyStatus, "current")));
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
    const rows = await db
      .select({
        urdbId: tariffs.urdbId,
        name: tariffs.name,
        sector: tariffs.sector,
        structure: tariffs.structure,
      })
      .from(tariffs)
      .where(inArray(tariffs.urdbId, s.governsUrdbIds as string[]));
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
  newSourceUrl?: string;
  evidence: string;
}

export interface ApplyResult {
  sourceKey: string;
  action: "verified" | "auto_applied" | "flagged_for_review" | "source_updated" | "failure_recorded";
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
  const govern = src.governsUrdbIds as string[];

  if (f.status === "confirmed") {
    await db
      .update(rateSources)
      .set({ lastVerifiedAt: now, changeDetectedAt: null, consecutiveFailures: 0 })
      .where(eq(rateSources.id, src.id));
    await db
      .update(tariffs)
      .set({ verifyStatus: "current", lastVerifiedAt: now })
      .where(inArray(tariffs.urdbId, govern));
    await db.insert(rateVerifications).values({
      sourceKey: f.sourceKey,
      checkedAt: now,
      status: "confirmed",
      evidence: f.evidence.slice(0, 1024),
      method: "agent_verify",
    });
    return { sourceKey: f.sourceKey, action: "verified", detail: `${govern.length} tariff row(s) re-verified against ${src.sourceLabel}` };
  }

  if (f.status === "source_moved") {
    if (f.newSourceUrl) {
      await db
        .update(rateSources)
        .set({ sourceUrl: f.newSourceUrl, contentFingerprint: null, fingerprintAt: null, consecutiveFailures: 0 })
        .where(eq(rateSources.id, src.id));
      await db.update(tariffs).set({ sourceUrl: f.newSourceUrl }).where(inArray(tariffs.urdbId, govern));
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
  const observed = f.observed ?? [];
  let maxDeltaPct = 0;
  const rows = await db.select().from(tariffs).where(inArray(tariffs.urdbId, govern));
  const byUrdb = new Map(rows.map((r) => [r.urdbId ?? "", r]));
  const pendingUpdates: Array<{ id: number; structure: unknown; urdbId: string; deltaDesc: string }> = [];
  for (const o of observed) {
    const row = byUrdb.get(o.urdbId);
    if (!row) continue;
    const st = structuredClone(row.structure) as {
      fixedMonthly?: number;
      energy?: Array<{ label?: string; ratePerUnit?: number }>;
    };
    const deltas: string[] = [];
    if (o.fixedMonthly != null && st.fixedMonthly != null && st.fixedMonthly > 0) {
      const d = Math.abs(o.fixedMonthly - st.fixedMonthly) / st.fixedMonthly;
      if (d > 0) {
        maxDeltaPct = Math.max(maxDeltaPct, d * 100);
        deltas.push(`fixed ${st.fixedMonthly} → ${o.fixedMonthly}`);
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
            match.ratePerUnit = or.ratePerUnit;
          }
        }
      }
    }
    if (deltas.length > 0) pendingUpdates.push({ id: row.id, structure: st, urdbId: o.urdbId, deltaDesc: deltas.join("; ") });
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
    return {
      sourceKey: f.sourceKey,
      action: "auto_applied",
      detail: `adjustor-band update applied (max delta ${maxDeltaPct.toFixed(1)}% ≤ ${capPct}% cap): ${pendingUpdates.map((u) => u.deltaDesc).join(" | ")}`,
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
  return {
    sourceKey: f.sourceKey,
    action: "flagged_for_review",
    detail: `rate change beyond ${capPct}% auto-apply cap (max delta ${maxDeltaPct.toFixed(1)}%) — observed values recorded, rows flagged change_detected`,
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
    };
  });
}
