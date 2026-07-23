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
import { applyAgentFinding, getVerifyTargets, applyAcquisition, type AgentFinding, type ApplyResult, type AcquisitionFinding } from "./rateCurrency";
import { pendingAcquisitions } from "./urdbImport";
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
  /** TEL1C-2: benchmark sources report observed published price bands per tier */
  observedTiers: z
    .array(
      z.object({
        tierKey: z.string().min(1).max(64),
        typicalLowUsd: z.number().nonnegative().optional(),
        medianUsd: z.number().nonnegative().optional(),
        typicalHighUsd: z.number().nonnegative().optional(),
        notes: z.string().max(512).optional(),
      }),
    )
    .max(20)
    .optional(),
  newSourceUrl: z.string().url().max(512).optional(),
  evidence: z.string().min(1).max(1024),
});

/** NAT-5 acquire-mode: the agent found a utility's filed rates that the
 * catalog lacks entirely (queued via rate_acquisition_queue). */
const acquisitionSchema = z.object({
  queueId: z.number().int().positive(),
  status: z.enum(["acquired", "failed"]),
  rates: z
    .array(
      z.object({
        sector: z.enum(["Residential", "Commercial"]),
        rateName: z.string().min(1).max(255),
        fixedMonthly: z.number().nonnegative(),
        energyRatePerUnit: z.number().nonnegative(),
        unit: z.string().max(16).optional(),
        effectiveDate: z.string().max(32).optional(),
        notes: z.string().max(512).optional(),
      }),
    )
    .max(6)
    .optional(),
  sourceUrl: z.string().url().max(512).optional(),
  evidence: z.string().min(1).max(1024),
});

const bodySchema = z.object({
  results: z.array(findingSchema).max(50).optional().default([]),
  acquisitions: z.array(acquisitionSchema).max(10).optional().default([]),
});

export async function rateVerifyHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return;
    }

    if (req.method === "GET") {
      const targets = await getVerifyTargets();
      const acquisitions = await pendingAcquisitions(5);
      res.json({
        ok: true,
        targets,
        acquisitions: acquisitions.map((a) => ({
          queueId: a.id,
          utilityName: a.utilityName,
          state: a.state,
          commodity: a.commodity,
          demandCount: a.demandCount,
        })),
        instructions:
          "VERIFY targets: fetch sourceUrl (PDF or page), find the CURRENT filed rates for each tariffRows entry, compare to the seeded fixedMonthly/energyRates values. POST results: status=confirmed if values match, status=changed with observed values if they differ, status=source_moved with newSourceUrl if the document relocated, status=unreachable if it cannot be fetched. Always include one-line evidence quoting the figure seen. " +
          "BENCHMARK targets (commodity=telecom, benchmarkTiers present): open sourceUrl in a browser (many carrier/FCC pages block plain fetches), read current published pricing, and compare against each benchmarkTiers entry's typicalLowUsd/medianUsd/typicalHighUsd. POST status=confirmed if bands still bracket published prices, or status=changed with observedTiers=[{tierKey, typicalLowUsd?, medianUsd?, typicalHighUsd?}] when the market has shifted. " +
          "ACQUISITIONS: for each queued utility, locate its OFFICIAL current tariff (utility website or state commission filing), extract the default residential and small-commercial rates (fixed monthly charge + all-in volumetric energy rate including riders/adjustors where published), and POST under acquisitions[] with queueId, status=acquired, rates[], sourceUrl, evidence. Use status=failed with evidence if no official source can be found.",
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
    for (const a of parsed.data.acquisitions) {
      applied.push(await applyAcquisition(a as AcquisitionFinding, now));
    }
    // One digest notification per run, only when something needs attention
    // or was materially changed. Pure confirmations stay quiet.
    const material = applied.filter(
      (a) => a.action === "auto_applied" || a.action === "flagged_for_review" || a.action === "source_updated" || a.action === "acquired",
    );
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
