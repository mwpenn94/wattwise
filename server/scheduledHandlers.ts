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
