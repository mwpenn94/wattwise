/**
 * Heartbeat cron callback handlers — mounted at /api/scheduled/* in
 * server/_core/index.ts (the path prefix is required by the platform).
 *
 * Security rules (periodic-updates skill):
 *  - authenticate via sdk.authenticateRequest; require user.isCron + taskUid
 *  - look up the business row by taskUid ONLY, never by request-body fields
 *  - idempotent: upsertAlert batches per (site, kind); re-running a trigger
 *    refreshes rather than duplicates
 *  - orphaned crons (user deleted / opted out) return 2xx so the platform
 *    stops retrying
 */
import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { getUserByDigestTaskUid } from "./dbHelpers";
import { runDigestCycle } from "./digest";
import { refreshServiceTerritories, territoryFreshness } from "./serviceTerritories";
import { verifyIncentiveCatalog } from "./incentives";
import { notifyOwner } from "./_core/notification";
import { reassertNationalRates } from "./seed/runSeeders";
import { SEED_VERSION } from "./seed/seedData";
import { assessSeedFreshness } from "./seedLifecycle";
import { checkEiaRateDrift } from "./eiaRefresh";

export async function digestHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) {
      res.status(403).json({ error: "cron-only endpoint" });
      return;
    }
    const owner = await getUserByDigestTaskUid(user.taskUid);
    if (!owner) {
      // orphan cron — 2xx so the platform stops retrying
      res.json({ ok: true, skipped: "orphan (no user bound to this taskUid)" });
      return;
    }
    const result = await runDigestCycle(owner.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * CUR (Jul 19) — weekly reference-data currency refresh.
 * Project-level cron (no per-user rows), four passes, all idempotent:
 *  1. service-territory registry re-ingest (supersedes older vintages)
 *  2. incentive catalog re-verification (lastVerifiedAt, expiry flags)
 *  3. RATE-4: national representative-rate re-assert — every electric/gas/
 *     water state-average row (EIA-861/EIA-176/AWWA derived) is re-emitted
 *     under the current SEED_VERSION, healing drift/manual damage and
 *     advancing the vintage stamp; assigned tariff ids are preserved because
 *     rows update in place on their (utilityName, name) identity
 *  4. seed-freshness assessment across ALL reference datasets (tariffs,
 *     benchmarks, weather normals, eGRID, archetypes) — overdue sources are
 *     surfaced in the owner notification so silent staleness is impossible.
 */
export async function refreshReferenceHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return;
    }
    const now = Date.now();
    const territories = await refreshServiceTerritories(now);
    const incentives = await verifyIncentiveCatalog(now);
    // RATE-4: re-assert the national representative-rate catalog (electric +
    // gas + water) under the current seed version — heals drifted/damaged
    // rows and advances every row's vintage stamp in one idempotent pass.
    const rates = await reassertNationalRates(SEED_VERSION).catch((e) => {
      console.warn("[refreshReference] rate re-assert failed", e);
      return { inserted: 0, updated: 0 };
    });
    // Freshness sweep across ALL reference datasets — sources past their
    // registered cadence get named in the owner notification.
    const staleness = await assessSeedFreshness(now).catch(() => []);
    const overdue = staleness.filter((s) => s.stale);
    const freshness = await territoryFreshness();
    // NEXT-4: live EIA drift check — gated on EIA_API_KEY (free). Detects when
    // the seeded state-average catalog has drifted >10% from current EIA data
    // and reports it for a deliberate seed update; never mutates rate rows
    // (the weekly re-assert would clobber runtime mutations anyway).
    const eia = await checkEiaRateDrift(now).catch((e) => ({ ran: false as const, reason: e instanceof Error ? e.message : String(e) }));
    const eiaDrifted = eia.ran && eia.drifted ? eia.drifted : [];
    const material = incentives.expiringSoon.length > 0 || territories.superseded > 0 || rates.inserted > 0 || overdue.length > 0 || eiaDrifted.length > 0;
    if (material) {
      const parts: string[] = [];
      if (incentives.expiringSoon.length > 0) parts.push(`Incentive programs expiring within 90 days: ${incentives.expiringSoon.join(", ")} — verify renewal terms and update the catalog.`);
      if (territories.superseded > 0) parts.push(`${territories.superseded} service-territory rows superseded by vintage ${freshness?.sourceVersion ?? "current"}.`);
      if (rates.inserted > 0) parts.push(`${rates.inserted} missing national rate rows re-created during the weekly re-assert (${rates.updated} refreshed in place) — someone or something had removed them.`);
      if (overdue.length > 0) parts.push(`Reference datasets past their refresh cadence: ${overdue.map((s) => `${s.source} (${s.ageDays}d old, cadence ${s.cadenceDays}d)`).join(", ")} — schedule a source-data update.`);
      if (eiaDrifted.length > 0)
        parts.push(
          `EIA live check (period ${eia.ran ? (eia.electricPeriod ?? eia.gasPeriod ?? "latest") : ""}): ${eiaDrifted.length} state-average rate(s) drifted >10% from the seeded catalog — ${eiaDrifted
            .slice(0, 8)
            .map((d) => `${d.state} ${d.metric.replaceAll("_", " ")} seeded ${d.seeded} vs live ${d.live}`)
            .join("; ")}${eiaDrifted.length > 8 ? ` (+${eiaDrifted.length - 8} more)` : ""}. Update STATE_PROFILES in server/seed/nationalData.ts.`,
        );
      await notifyOwner({
        title: "Meterly reference-data refresh: attention needed",
        content: parts.join(" "),
      }).catch(() => undefined); // notification failure must not fail the cron
    }
    res.json({
      ok: true,
      territories,
      incentives: { verified: incentives.verified, expiringSoon: incentives.expiringSoon, expired: incentives.expired },
      rates,
      staleSeeds: overdue.map((s) => s.source),
      freshness,
      eia,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}
