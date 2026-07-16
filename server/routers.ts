import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import {
  FREE_TIER_MAX_SITES,
  FREE_TIER_MAX_UPLOADS_PER_MONTH,
  FREE_TIER_SCENARIOS_PER_MONTH,
  MODELED_ESTIMATES_DISCLAIMER,
  LABEL_CP_ESTIMATED,
  LABEL_NORMAL_YEAR,
  LABEL_PROTOTYPE_ARCHETYPE,
  DISAGG_LANGUAGE,
  SOLAR_DISCLOSURE,
  BATTERY_DISCLOSURE,
  type TariffStructure,
} from "@shared/wattwise";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import * as h from "./dbHelpers";
import { ensureSeeded } from "./seed/runSeeders";
import { preParseGate, withParseTimeout } from "./ingest/hardening";
import { parseCsvIntervals, parseEspiXml, parseExcelIntervals, PARSER_VERSION, type ParsedMeterSeries } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { extractBill } from "./ingest/billOcr";
import { getDb } from "./db";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { runScenario, hourlyToPoints, type ScenarioInput } from "./analytics/scenarios";
import { costOnTariff } from "./analytics/tariffEngine";
import { recordMeterEvent, assertFreeTierCostCap, monthToDateLlmSpend } from "./analytics/costModel";
import { storagePut } from "./storage";
import { createHash } from "crypto";
import { intervals as intervalsTable } from "../drizzle/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";

/* ---------- tier helpers ---------- */
type Tier = "free" | "plus" | "pro";
function tierOf(user: { tier?: string | null; role?: string }): Tier {
  if (user.role === "admin") return "pro"; // owner/admin gets full access
  return (user.tier as Tier) ?? "free";
}
function requireTier(current: Tier, needed: Tier, feature: string) {
  const order: Tier[] = ["free", "plus", "pro"];
  if (order.indexOf(current) < order.indexOf(needed)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${feature} requires the ${needed} tier. You are on ${current}.`,
    });
  }
}

const seeded = () => ensureSeeded().catch((e) => console.error("[Seed] failed:", e));

/* ---------- input schemas ---------- */
const siteInput = z.object({
  name: z.string().min(1).max(255),
  address: z.string().max(1000).optional(),
  city: z.string().max(128).optional(),
  state: z.string().max(8).optional(),
  zip: z.string().max(16).optional(),
  buildingType: z.string().max(64).optional(),
  sqft: z.number().positive().max(50_000_000).optional(),
  vintage: z.number().int().min(1850).max(2030).optional(),
  climateZone: z.string().max(16).optional(),
  occupancyHours: z.record(z.string(), z.unknown()).optional(),
  utilityName: z.string().max(128).optional(),
  isHypothetical: z.boolean().optional(),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  /* ================= sites ================= */
  sites: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      await seeded();
      return h.listSites(ctx.user.id);
    }),
    get: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.getSite(input.siteId, ctx.user.id);
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      const tier = tierOf(ctx.user);
      if (tier === "free") {
        const n = await h.countSites(ctx.user.id);
        if (n >= FREE_TIER_MAX_SITES) {
          throw new TRPCError({ code: "FORBIDDEN", message: `Free tier is limited to ${FREE_TIER_MAX_SITES} sites. Upgrade to add more.` });
        }
      }
      const id = await h.createSite({
        ...input,
        userId: ctx.user.id,
        climateZone: input.climateZone ?? inferClimateZone(input.zip, input.state),
        attrSource: "user_entered",
      });
      await h.audit(ctx.user.id, "site_created", "site", String(id), { name: input.name, hypothetical: input.isHypothetical });
      return { id };
    }),
    meters: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.listMeters(input.siteId, ctx.user.id);
    }),
    setMeterTariff: protectedProcedure
      .input(z.object({ meterId: z.number(), tariffId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await h.setMeterTariff(input.meterId, input.tariffId, ctx.user.id);
        return { ok: true };
      }),
  }),

  /* ================= uploads / ingestion ================= */
  uploads: router({
    list: protectedProcedure.query(async ({ ctx }) => h.listUploads(ctx.user.id)),
    /** Interval file ingestion: xlsx | csv | espi_xml (base64 payload). */
    ingest: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          filename: z.string().max(512),
          format: z.enum(["xlsx", "csv", "espi_xml"]),
          contentBase64: z.string().max(70_000_000),
          commodityHint: z.enum(["electric", "gas", "water"]).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        if (tier === "free") {
          const n = await h.countUploadsThisMonth(ctx.user.id);
          if (n >= FREE_TIER_MAX_UPLOADS_PER_MONTH) {
            throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_MAX_UPLOADS_PER_MONTH} uploads/month.` });
          }
        }
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });

        const buf = Buffer.from(input.contentBase64, "base64");
        const gate = preParseGate(buf, input.format);
        if (!gate.ok) throw new TRPCError({ code: "BAD_REQUEST", message: gate.reason ?? "File rejected" });

        const sha256 = createHash("sha256").update(buf).digest("hex");
        const dup = await h.findUploadByHash(ctx.user.id, sha256);
        if (dup && dup.status === "parsed") {
          return { uploadId: dup.id, duplicate: true as const, meters: [], totalPoints: 0, validations: [] };
        }

        const t0 = Date.now();
        const uploadId = await h.createUpload({
          userId: ctx.user.id,
          siteId: input.siteId,
          filename: input.filename,
          sha256,
          format: input.format,
          parser: input.format === "xlsx" ? "excel_build0103" : input.format === "csv" ? "csv_build0103" : "espi_xml",
          parserVersion: PARSER_VERSION,
          status: "pending",
        });

        // Store raw file in S3 (source of truth for re-parse)
        try {
          const put = await storagePut(`uploads/${ctx.user.id}/${uploadId}-${input.filename}`, buf, "application/octet-stream");
          await h.updateUpload(uploadId, { fileKey: put.key, fileUrl: put.url });
        } catch {
          /* storage failure is non-fatal for ingestion */
        }

        let series: ParsedMeterSeries[] = [];
        try {
          series = await withParseTimeout(() => {
            if (input.format === "xlsx") return parseExcelIntervals(buf);
            if (input.format === "csv") return parseCsvIntervals(buf.toString("utf8"), input.filename);
            return parseEspiXml(buf.toString("utf8"));
          }, `parse_${input.format}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await h.updateUpload(uploadId, { status: "failed", error: msg });
          throw new TRPCError({ code: "BAD_REQUEST", message: `Parse failed: ${msg}` });
        }

        if (series.length === 0 || series.every((s) => s.points.length === 0)) {
          await h.updateUpload(uploadId, { status: "failed", error: "No interval data found in file" });
          throw new TRPCError({ code: "BAD_REQUEST", message: "No interval data recognized in this file." });
        }

        // one meter per parsed series (sheet/UsagePoint)
        const existing = await h.listMeters(input.siteId, ctx.user.id);
        const out: Array<{ meterId: number; label: string; points: number; validationPass: boolean }> = [];
        let totalIn = 0;
        let totalSkip = 0;
        for (const s of series.filter((x) => x.points.length > 0)) {
          const commodity = input.commodityHint ?? s.commodity;
          const label = s.sourceKey;
          let meter = existing.find((m) => m.label === label && m.commodity === commodity);
          if (!meter) {
            const meterId = await h.createMeter(
              {
                siteId: input.siteId,
                userId: ctx.user.id,
                commodity,
                label,
                usageUnit: s.usageUnit,
                demandUnit: s.demandUnit,
                timezone: "America/Phoenix",
              },
              ctx.user.id,
            );
            meter = (await h.listMeters(input.siteId, ctx.user.id)).find((m) => m.id === meterId)!;
          }
          const db = (await getDb())!;
          const w = await writeIntervals(db, meter.id, s, uploadId, 2);
          totalIn += s.rowsIngested;
          totalSkip += s.rowsSkipped;
          out.push({ meterId: meter.id, label, points: w.inserted + w.replaced, validationPass: s.validation.pass });
        }

        await h.updateUpload(uploadId, {
          status: "parsed",
          rowsIngested: totalIn,
          rowsSkipped: totalSkip,
          sheetsFound: series.length,
          parseConfidence: series.every((s) => s.validation.pass) ? 1 : 0.8,
          footerTotals: series.map((s) => s.footerTotals),
          validation: series.map((s) => s.validation),
        });
        await recordMeterEvent({ userId: ctx.user.id, kind: `parse_${input.format}`, computeMs: Date.now() - t0, tier });
        await h.audit(ctx.user.id, "upload_ingested", "upload", String(uploadId), {
          filename: input.filename,
          meters: out.length,
          rows: totalIn,
        });
        return {
          uploadId,
          duplicate: false as const,
          meters: out,
          totalPoints: out.reduce((a, m) => a + m.points, 0),
          validations: series.map((s) => ({ sheet: s.sourceKey, ...s.validation, footer: s.footerTotals })),
        };
      }),

    /** Bill image/PDF OCR (LLM vision; kill-switch degrades to manual entry). */
    billOcr: protectedProcedure
      .input(z.object({ siteId: z.number(), filename: z.string(), contentBase64: z.string().max(30_000_000), mime: z.enum(["image/png", "image/jpeg", "application/pdf"]) }))
      .mutation(async ({ ctx, input }) => {
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
        const buf = Buffer.from(input.contentBase64, "base64");
        const gate = preParseGate(buf, input.mime === "application/pdf" ? "bill_pdf" : "bill_image");
        if (!gate.ok) throw new TRPCError({ code: "BAD_REQUEST", message: gate.reason ?? "File rejected" });
        if (input.mime === "application/pdf") {
          // Deployed runtime has no PDF rasterizer — honest degradation path.
          return {
            status: "manual_entry_required" as const,
            reason: "PDF bills can't be auto-parsed yet — please upload a photo/screenshot of the bill, or enter the fields manually.",
          };
        }
        const dataUrl = `data:${input.mime};base64,${input.contentBase64}`;
        const outcome = await extractBill(dataUrl, ctx.user.id, tierOf(ctx.user));
        await h.audit(ctx.user.id, "bill_ocr", "site", String(input.siteId), { outcome: outcome.status });
        return outcome;
      }),
  }),

  /* ================= bills (manual entry + revisions) ================= */
  bills: router({
    list: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => h.listBills(input.siteId, ctx.user.id)),
    create: protectedProcedure
      .input(
        z.object({
          meterId: z.number(),
          periodStart: z.string(),
          periodEnd: z.string(),
          totalUsage: z.number(),
          usageUnit: z.string().max(16),
          billedDemandKw: z.number().nullable().optional(),
          demandBilledSource: z.enum(["parsed_bill", "ratchet_computed"]).optional(),
          totalCostUsd: z.number(),
          rateScheduleName: z.string().max(255).optional(),
          source: z.enum(["manual", "parsed_pdf", "parsed_image"]).default("manual"),
          supersedesBillId: z.number().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const id = await h.createBill(
          {
            meterId: input.meterId,
            periodStart: new Date(input.periodStart),
            periodEnd: new Date(input.periodEnd),
            usage: input.totalUsage,
            demandBilled: input.billedDemandKw ?? null,
            demandBilledSource: input.demandBilledSource ?? (input.billedDemandKw != null ? "parsed_bill" : null),
            totalCost: input.totalCostUsd,
            source: input.source,
            supersedesBillId: input.supersedesBillId,
          },
          ctx.user.id,
        );
        return { id };
      }),
  }),

  /* ================= analysis pipeline ================= */
  analysis: router({
    run: protectedProcedure.input(z.object({ siteId: z.number(), meterId: z.number().optional() })).mutation(async ({ ctx, input }) => {
      await seeded();
      const site = await h.getSite(input.siteId, ctx.user.id);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
      const meters = await h.listMeters(input.siteId, ctx.user.id);
      const meter = input.meterId ? meters.find((m) => m.id === input.meterId) ?? null : meters[0] ?? null;
      const tier = tierOf(ctx.user);
      const result = await runAnalysisPipeline(site, meter, ctx.user.id, tier);
      // AC5: instrumented free-tier cost cap
      const cap = await assertFreeTierCostCap(result.analysisId);
      if (tier === "free" && !cap.ok) {
        await h.audit(ctx.user.id, "cost_cap_exceeded", "analysis", String(result.analysisId), cap);
      }
      return { ...result, costCap: cap };
    }),
    latest: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.getLatestAnalysis(input.siteId, ctx.user.id);
    }),
    baseline: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.getLatestBaseline(input.siteId, ctx.user.id);
    }),
  }),

  /* ================= interval chart data ================= */
  intervalsApi: router({
    stats: protectedProcedure.input(z.object({ meterId: z.number() })).query(async ({ ctx, input }) => {
      return h.intervalStats(input.meterId, ctx.user.id);
    }),
    /** Raw points in a window (client applies BUILD-010.3 peak-preserving decimation). */
    window: protectedProcedure
      .input(z.object({ meterId: z.number(), fromTs: z.number(), toTs: z.number() }))
      .query(async ({ ctx, input }) => {
        await h.assertMeterOwner(input.meterId, ctx.user.id);
        const db = (await getDb())!;
        const span = input.toTs - input.fromTs;
        if (span > 400 * 86_400_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Window too large (max 400 days)" });
        const rows = await db
          .select({ ts: intervalsTable.ts, usage: intervalsTable.usage, demand: intervalsTable.demand, durationMin: intervalsTable.durationMin })
          .from(intervalsTable)
          .where(and(eq(intervalsTable.meterId, input.meterId), gte(intervalsTable.ts, input.fromTs), lte(intervalsTable.ts, input.toTs)))
          .orderBy(asc(intervalsTable.ts))
          .limit(120_000);
        return rows;
      }),
  }),

  /* ================= tariffs ================= */
  tariffs: router({
    list: protectedProcedure.input(z.object({ state: z.string().optional() }).optional()).query(async ({ input }) => {
      await seeded();
      const rows = await h.listTariffs("electric", input?.state);
      return rows.map((t) => ({
        ...t,
        structure: undefined,
        hasRatchet: !!(t.structure as TariffStructure).ratchet,
        hasCp: !!(t.structure as TariffStructure).cp,
        eligibilityNote:
          "Eligibility checked on sector and peak-demand size bounds only; voltage class and customer-class minimums are not in the seeded tariff snapshot — confirm final eligibility with your utility.",
      }));
    }),
    detail: protectedProcedure.input(z.object({ tariffId: z.number() })).query(async ({ input }) => {
      const t = await h.getTariff(input.tariffId);
      if (!t) throw new TRPCError({ code: "NOT_FOUND" });
      return t;
    }),
  }),

  /* ================= insights & opportunities ================= */
  insights: router({
    list: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => h.listInsights(input.siteId, ctx.user.id)),
    opportunities: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => h.listOpportunities(input.siteId, ctx.user.id)),
  }),

  /* ================= scenarios ================= */
  scenariosApi: router({
    list: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => h.listScenarios(input.siteId, ctx.user.id)),
    run: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          name: z.string().max(255),
          kind: z.enum(["solar", "battery", "solar_battery", "efficiency", "ev_load"]),
          solarKwDc: z.number().positive().max(100_000).optional(),
          batteryKwh: z.number().positive().max(1_000_000).optional(),
          batteryKw: z.number().positive().max(500_000).optional(),
          efficiencyReductions: z.record(z.string(), z.number().min(0).max(0.9)).optional(),
          evAnnualKwh: z.number().positive().max(10_000_000).optional(),
          capexUsd: z.number().positive().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        // Tier gates: solar/battery modeling = Plus features (free teaser insight only)
        if (["solar", "battery", "solar_battery"].includes(input.kind)) requireTier(tier, "plus", "Solar/battery scenario modeling");
        if (tier === "free") {
          const n = await h.countScenariosThisMonth(ctx.user.id);
          if (n >= FREE_TIER_SCENARIOS_PER_MONTH) {
            throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_SCENARIOS_PER_MONTH} scenario runs/month.` });
          }
        }
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });

        // Build baseline hourly profile: measured intervals if available, else archetype
        const { hourly, loadBasis, confidence, extrapolated, structure, co2eLbPerMwh, climateZone } = await buildScenarioBasis(site, ctx.user.id);
        const t0 = Date.now();
        const scenarioInput: ScenarioInput = {
          kind: input.kind,
          solarKwDc: input.solarKwDc,
          batteryKwh: input.batteryKwh,
          batteryKw: input.batteryKw,
          efficiencyReductions: input.efficiencyReductions,
          endUseFractions: (await endUseForSite(site))?.fractions,
          evAnnualKwh: input.evAnnualKwh,
          capexUsd: input.capexUsd,
        };
        const results = runScenario(hourly, scenarioInput, structure, climateZone, co2eLbPerMwh, confidence, extrapolated);
        const id = await h.saveScenario({
          siteId: site.id,
          userId: ctx.user.id,
          name: input.name,
          transform: input.kind === "solar" ? "solar" : input.kind === "battery" || input.kind === "solar_battery" ? "battery_peak_shave" : input.kind === "efficiency" ? "led_equipment" : "ev_charging",
          params: scenarioInput as unknown as Record<string, unknown>,
          loadBasis,
          results: results as unknown as Record<string, unknown>,
          status: "complete",
          confidenceLabel: results.confidenceLabel,
          extrapolated: results.extrapolated,
        });
        await recordMeterEvent({ userId: ctx.user.id, kind: "scenario_run", computeMs: Date.now() - t0, tier });
        await h.audit(ctx.user.id, "scenario_run", "scenario", String(id), { kind: input.kind, siteId: site.id });
        return { id, results };
      }),
  }),

  /* ================= reference / transparency ================= */
  reference: router({
    convergenceLog: publicProcedure.query(async () => {
      await seeded();
      return h.listConvergenceLog();
    }),
    seederRuns: publicProcedure.query(async () => {
      await seeded();
      return h.listSeederRuns();
    }),
    labels: publicProcedure.query(() => ({
      cpEstimated: LABEL_CP_ESTIMATED,
      prototypeArchetype: LABEL_PROTOTYPE_ARCHETYPE,
      normalYear: LABEL_NORMAL_YEAR,
      modeledEstimates: MODELED_ESTIMATES_DISCLAIMER,
      disaggregation: DISAGG_LANGUAGE,
      solar: SOLAR_DISCLOSURE,
      battery: BATTERY_DISCLOSURE,
    })),
  }),

  /* ================= account: usage metering + data export ================= */
  account: router({
    usage: protectedProcedure.query(async ({ ctx }) => {
      const llmSpend = await monthToDateLlmSpend(ctx.user.id);
      return { tier: tierOf(ctx.user), monthToDateLlmUsd: llmSpend };
    }),
    exportData: protectedProcedure.mutation(async ({ ctx }) => {
      const data = await h.exportUserData(ctx.user.id);
      await h.audit(ctx.user.id, "data_export", "user", String(ctx.user.id), { tables: Object.keys(data) });
      return data;
    }),
  }),
});

/* ---------------- scenario basis builder ---------------- */
async function buildScenarioBasis(site: NonNullable<Awaited<ReturnType<typeof h.getSite>>>, userId: number) {
  const climateZone = site.climateZone ?? "2B";
  const meters = await h.listMeters(site.id, userId);
  const meter = meters.find((m) => m.commodity === "electric") ?? meters[0] ?? null;

  let hourly: number[] | null = null;
  let loadBasis = "archetype_scaled";
  let confidence: "low" | "medium" | "high" = "low";
  let extrapolated = false;

  if (meter) {
    const pts = await h.getIntervalPoints(meter.id, userId);
    if (pts.length >= 24 * 30) {
      // aggregate to hour-of-year profile (8760) from measured data
      hourly = measuredTo8760(pts);
      loadBasis = "measured_intervals";
      const spanDays = (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000;
      confidence = spanDays >= 270 ? "high" : spanDays >= 120 ? "medium" : "low";
      extrapolated = spanDays < 270;
    }
  }
  if (!hourly) {
    const arch = site.buildingType ? await h.getArchetype(site.buildingType, climateZone, vintageBandLocal(site.vintage)) : null;
    if (!arch || !site.sqft) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Scenario needs either uploaded interval data or building type + size for an archetype baseline.",
      });
    }
    const annual = arch.annualUsePerSqft * site.sqft;
    hourly = (arch.shape8760 as number[]).map((f) => f * annual);
    confidence = "low";
    extrapolated = (arch.calibMinSqft != null && site.sqft < arch.calibMinSqft) || (arch.calibMaxSqft != null && site.sqft > arch.calibMaxSqft);
  }

  const tariffRows = await h.listTariffs("electric", site.state ?? undefined);
  const current = meter?.currentTariffId ? tariffRows.find((t) => t.id === meter.currentTariffId) : undefined;
  const chosen =
    current ??
    tariffRows.find((t) => site.utilityName && t.utilityName.toLowerCase().includes(site.utilityName.toLowerCase().split(" ")[0])) ??
    tariffRows[0];
  if (!chosen) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No tariff data available for scenario costing" });

  const zip3 = (site.zip ?? "850").slice(0, 3);
  const ef = await h.getEmissionsFactor(zip3);
  return {
    hourly,
    loadBasis,
    confidence,
    extrapolated,
    structure: chosen.structure as TariffStructure,
    co2eLbPerMwh: ef.factor?.co2eLbPerMwh ?? 727.9,
    climateZone,
  };
}

async function endUseForSite(site: { buildingType: string | null; climateZone: string | null; vintage: number | null }) {
  if (!site.buildingType) return null;
  const arch = await h.getArchetype(site.buildingType, site.climateZone ?? "2B", vintageBandLocal(site.vintage));
  return arch ? { fractions: arch.endUseFractions as Record<string, number> } : null;
}

function vintageBandLocal(v: number | null): string {
  if (v == null) return "all";
  if (v < 1980) return "pre1980";
  if (v < 2004) return "1980-2003";
  return "2004+";
}

/** Fold measured interval points into an 8760 hour-of-year average profile. */
function measuredTo8760(pts: Array<{ ts: number; durationMin: number; usage: number }>): number[] {
  const sums = new Array(8760).fill(0);
  const counts = new Array(8760).fill(0);
  for (const p of pts) {
    const d = new Date(p.ts);
    const start = new Date(d.getFullYear(), 0, 1).getTime();
    let hoy = Math.floor((p.ts - start) / 3600_000);
    if (hoy >= 8760) hoy = 8759;
    if (hoy < 0) hoy = 0;
    const hours = p.durationMin / 60;
    sums[hoy] += p.usage;
    counts[hoy] += hours;
  }
  const out = new Array(8760).fill(0);
  let lastNonZero = 0.1;
  for (let i = 0; i < 8760; i++) {
    if (counts[i] > 0) {
      out[i] = sums[i] / counts[i]; // kWh per hour
      lastNonZero = out[i];
    } else {
      out[i] = lastNonZero; // gap-fill with persistence (disclosed via confidence)
    }
  }
  return out;
}

function inferClimateZone(zip?: string, state?: string): string {
  const z3 = zip?.slice(0, 3);
  if (z3) {
    if (["850", "851", "852", "853", "855", "859", "860", "863", "864", "865"].includes(z3)) return "2B"; // Phoenix/Havasu/Kingman
    if (["856", "857"].includes(z3)) return "2B"; // Tucson
    if (["859", "860"].includes(z3)) return "5B"; // Flagstaff-ish
  }
  if (state === "AZ") return "2B";
  if (state === "NV") return "3B";
  if (state === "CA") return "3B";
  if (state === "TX") return "2A";
  return "2B";
}

export type AppRouter = typeof appRouter;
