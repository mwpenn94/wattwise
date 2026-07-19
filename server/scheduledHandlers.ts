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
 * Project-level cron (no per-user rows): re-ingests the service-territory
 * registry under the current source vintage (superseding older vintages) and
 * re-verifies the incentive catalog (stamping lastVerifiedAt, re-asserting
 * seed-managed terms, flagging soon-to-expire programs). Owner is notified
 * when anything material surfaces — expiring programs or superseded rows —
 * so silent staleness is impossible.
 * Idempotent by construction: both passes upsert + stamp, never duplicate.
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
    const freshness = await territoryFreshness();
    const material = incentives.expiringSoon.length > 0 || territories.superseded > 0;
    if (material) {
      const parts: string[] = [];
      if (incentives.expiringSoon.length > 0) parts.push(`Incentive programs expiring within 90 days: ${incentives.expiringSoon.join(", ")} — verify renewal terms and update the catalog.`);
      if (territories.superseded > 0) parts.push(`${territories.superseded} service-territory rows superseded by vintage ${freshness?.sourceVersion ?? "current"}.`);
      await notifyOwner({
        title: "WattWise reference-data refresh: attention needed",
        content: parts.join(" "),
      }).catch(() => undefined); // notification failure must not fail the cron
    }
    res.json({ ok: true, territories, incentives: { verified: incentives.verified, expiringSoon: incentives.expiringSoon, expired: incentives.expired }, freshness });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}
