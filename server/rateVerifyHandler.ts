/**
 * CURR-5 — /api/scheduled/rateVerify: the wire contract between the monthly
 * rate-verification AGENT cron and this site.
 *
 *  GET  → prioritized verification targets (change_detected first, then due,
 *         then stalest), each with the currently-seeded values so the agent
 *         can compare without DB access.
 *  POST → structured findings; applied conservatively by applyAgentFinding
 *         (see server/rateCurrency.ts) and summarized to the owner in ONE
 *         notification per run — never per-utility spam.
 *
 * Cron-only auth on both verbs (sdk.authenticateRequest → user.isCron).
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { sdk } from "./_core/sdk";
import { applyAgentFinding, getVerifyTargets, type AgentFinding, type ApplyResult } from "./rateCurrency";
import { notifyOwner } from "./_core/notification";

const findingSchema = z.object({
  sourceKey: z.string().min(1).max(96),
  status: z.enum(["confirmed", "changed", "source_moved", "unreachable"]),
  observed: z
    .array(
      z.object({
        urdbId: z.string().min(1).max(64),
        fixedMonthly: z.number().nonnegative().optional(),
        energyRates: z.array(z.object({ label: z.string().max(128), ratePerUnit: z.number().nonnegative() })).optional(),
        effectiveDate: z.string().max(32).optional(),
        notes: z.string().max(512).optional(),
      }),
    )
    .optional(),
  newSourceUrl: z.string().url().max(512).optional(),
  evidence: z.string().min(1).max(1024),
});

const bodySchema = z.object({ results: z.array(findingSchema).max(50) });

export async function rateVerifyHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return;
    }

    if (req.method === "GET") {
      const targets = await getVerifyTargets();
      res.json({
        ok: true,
        targets,
        instructions:
          "For each target: fetch sourceUrl (PDF or page), find the CURRENT filed rates for each tariffRows entry, compare to the seeded fixedMonthly/energyRates values. POST results back to this endpoint: status=confirmed if values match, status=changed with observed values if they differ, status=source_moved with newSourceUrl if the document relocated, status=unreachable if it cannot be fetched. Always include one-line evidence quoting the figure seen.",
      });
      return;
    }

    // POST — agent findings
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", detail: parsed.error.issues.slice(0, 5) });
      return;
    }
    const now = Date.now();
    const applied: ApplyResult[] = [];
    for (const f of parsed.data.results) {
      applied.push(await applyAgentFinding(f as AgentFinding, now));
    }
    // One digest notification per run, only when something needs attention
    // or was materially changed. Pure confirmations stay quiet.
    const material = applied.filter((a) => a.action === "auto_applied" || a.action === "flagged_for_review" || a.action === "source_updated");
    const verifiedCount = applied.filter((a) => a.action === "verified").length;
    if (material.length > 0) {
      await notifyOwner({
        title: "Meterly rate verification: changes detected",
        content:
          material.map((m) => `[${m.action}] ${m.sourceKey}: ${m.detail}`).join(" ") +
          (verifiedCount > 0 ? ` (${verifiedCount} source(s) confirmed unchanged.)` : ""),
      }).catch(() => undefined);
    }
    res.json({ ok: true, applied, verified: verifiedCount, material: material.length });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}
