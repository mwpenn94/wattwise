import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import {
  FREE_TIER_MAX_SITES,
  FREE_TIER_MAX_UPLOADS_PER_MONTH,
  FREE_TIER_SCENARIOS_PER_MONTH,
  MODELED_ESTIMATES_DISCLAIMER,
  // (§3l reports engine imported separately below)
  LABEL_CP_ESTIMATED,
  LABEL_NORMAL_YEAR,
  LABEL_PROTOTYPE_ARCHETYPE,
  DISAGG_LANGUAGE,
  SOLAR_DISCLOSURE,
  BATTERY_DISCLOSURE,
  ENGINE_VERSION,
  inferClimateZone,
  inferClimateZoneWithSource,
  TZ_BY_STATE,
  parseQuickAddress,
  quickStartAssumptions,
  QUICK_START_DEFAULTS,
  type TariffStructure,
} from "@shared/wattwise";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import * as h from "./dbHelpers";
import * as geo from "./geometry";
import { emitDeadEndPersona } from "./personaFingerprint";
import { ensureSeeded } from "./seed/runSeeders";
import { STATE_PROFILES } from "./seed/nationalData";
import { preParseGate, rejectXxe, withParseTimeout } from "./ingest/hardening";
import { extractZipMembers } from "./ingest/archive";
import { parseCsvIntervals, parseEspiXml, parseExcelIntervals, PARSER_VERSION, type ParsedMeterSeries } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { extractBill } from "./ingest/billOcr";
import { runBulkScreen } from "./bulkScreen";
import { getDb } from "./db";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { archetypeBaseline, type BaselineFit } from "./analytics/baseline";
import { assembleReportData, newReportToken, practitionerCsv, portfolioManagerCsv, assemblePortfolioVerified, type PortfolioExportRow } from "./reports";
import { assembleWrapped } from "./wrapped";

/** §3l report kinds → human feature names for tier-gate error copy. */
const REPORT_FEATURE_NAME: Record<"energy_plan" | "verified_savings" | "practitioner" | "site_insights", string> = {
  energy_plan: "My Energy Plan report",
  verified_savings: "Verified Savings Statement",
  practitioner: "Practitioner export",
  site_insights: "Site Insights report",
};
/** PRINT (Jul 19) — tier floor per report kind. site_insights is free: it is a
 * print-grade rendering of the user's own Explore analysis, not a gated artifact. */
const REPORT_TIER: Record<"energy_plan" | "verified_savings" | "practitioner" | "site_insights", "free" | "plus" | "pro"> = {
  energy_plan: "plus",
  verified_savings: "pro",
  practitioner: "pro",
  site_insights: "free",
};
import { evaluateImplementation, buildMonthlyActuals } from "./analytics/proveIt";
import { routeQuestion, ASK_ROUTE_EST_COST_USD, buildAskCard } from "./askWattwise";
import { runScenario, hourlyToPoints, type ScenarioInput } from "./analytics/scenarios";
import { composeMeasures, presetBaskets, type PlanMeasure } from "./analytics/composer";
import { costOnTariff } from "./analytics/tariffEngine";
import { recordMeterEvent, assertFreeTierCostCap, monthToDateLlmSpend, llmBudgetAllows } from "./analytics/costModel";
import { parse as parseCookieHeader } from "cookie";
import { createHeartbeatJob, deleteHeartbeatJob } from "./_core/heartbeat";
import { buildDigest } from "./digest";
import { storagePut } from "./storage";
import { deriveFromAddress, cascadeProvenance, deriveUtilityTriple } from "./cascade";
import { placeAutocomplete, resolvePlace, reverseGeocode } from "./places";
import { computeAddressEstimate, estimateRateAllows } from "./estimate";
import { reconcileBill } from "./billReconciliation";
import { deriveBillVerifiedRate } from "./billCalibration";
import { registerGeometryCacheDb } from "./geometryCacheDb";
import { assessSeedFreshness, recordParseOutcome, recordUnknownTariff, sweepUnverifiedTariffs } from "./seedLifecycle";
import { incentiveEconomics } from "./incentives";
import { runCommodityEfficiency } from "./commodityScenario";
import { resolveAllCommodityServices } from "./commodityService";
import { assessMv } from "./mv";
import { VERTICAL_PACKS, addProductionPeriod, listProduction, deleteProductionPeriod } from "./verticals";

/** GAP-D / AC16a: self-calibration on every real bill — fail-open so bill
 * ingest never breaks because the calibration couldn't run. */
async function maybeReconcileBill(billId: number, meterId: number, userId: number) {
  try {
    await reconcileBill(billId, meterId, userId);
  } catch (e) {
    console.warn(`[reconcile] skipped for bill ${billId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
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
  /** v1.18 tenure modes — gates opportunity generation to what the occupant can execute */
  tenure: z.enum(["own", "rent", "condo_hoa"]).optional(),
  /** v1.18 technology-conditioned tariff applicability — solar sites see only lawful plans */
  hasSolar: z.boolean().optional(),
});

/* §5c-2: module cache for the homepage live sample card — recomputed at most
 * every 6h; the landing page hydrates one real-pipeline card without per-visitor cost. */
let sampleCardCache: {
  at: number;
  value: {
    estimatedAnnualCostUsd: number;
    topOpportunity: { title: string; estimatedSavingsUsd: number; basis: string } | null;
    percentileBand: string | null;
    rung: string;
    label: string;
  };
} | null = null;

/* NEXT-3: wire the persistent footprint-resolve cache once at startup —
 * geometry.ts stays DB-free; the adapter injects the drizzle-backed layer. */
registerGeometryCacheDb();

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

  /* ================= public estimate (UX v1.9 estimate-first onboarding) =================
   * Zero-signup: the landing page delivers a grounded dollar estimate from an
   * address + confirmed building type. IP rate-limited; no LLM cost. */
  estimate: router({
    autocomplete: publicProcedure
      .input(z.object({ query: z.string().min(3).max(200) }))
      .query(({ ctx, input }) => {
        if (!estimateRateAllows(ctx.req.ip ?? "unknown")) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many lookups — try again in a few minutes, or sign in for unlimited access." });
        }
        return placeAutocomplete(input.query);
      }),
    fromAddress: publicProcedure
      .input(
        z.object({
          placeId: z.string().min(1).max(512),
          buildingType: z.string().min(1).max(64),
          sqft: z.number().positive().max(10_000_000).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!estimateRateAllows(ctx.req.ip ?? "unknown")) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many estimates from this connection — try again in a few minutes, or sign in to continue." });
        }
        const place = await resolvePlace(input.placeId);
        const est = await computeAddressEstimate({
          formattedAddress: place.formattedAddress,
          city: place.city,
          state: place.state,
          zip: place.zip,
          placeVerified: true,
          buildingType: input.buildingType,
          sqft: input.sqft ?? null,
        });
        return { estimate: est, place: { formattedAddress: place.formattedAddress, lat: place.lat, lng: place.lng, placeId: place.placeId } };
      }),
    /* §1 demo building — a zero-commitment sample estimate (no address, no
     * sign-up). Location-neutral by design (owner request Jul 19): a "typical
     * U.S. office" — no state → priced on the national blended commercial rate
     * and the mixed-climate 4A archetype — so visitors anywhere see a number
     * that reads as "buildings like yours", not "someone else's city". No
     * fabricated address, no map pin: the demo never pretends to be a place. */
    sample: publicProcedure.mutation(async ({ ctx }) => {
      if (!estimateRateAllows(ctx.req.ip ?? "unknown")) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many estimates from this connection — try again in a few minutes." });
      }
      const est = await computeAddressEstimate({
        formattedAddress: null,
        city: null,
        state: null,
        zip: null,
        placeVerified: false,
        buildingType: "office",
        sqft: 12_000,
      });
      return {
        estimate: est,
        place: { formattedAddress: "Typical U.S. office · 12,000 sqft (demo building — national averages)", lat: null, lng: null, placeId: "sample-national-office" },
        isSample: true as const,
      };
    }),
    /* §5c-2 live sample insight card — the homepage embeds ONE real card
     * ("show one, don't describe six"). Same real pipeline as `sample`, but a
     * query (renders on page load) with a server-side cache so the landing
     * page never pays recompute per visitor and never counts against the
     * per-IP estimate budget. Clearly labeled a demo building downstream. */
    sampleCard: publicProcedure.query(async () => {
      const now = Date.now();
      if (sampleCardCache && now - sampleCardCache.at < 6 * 60 * 60 * 1000) return sampleCardCache.value;
      const est = await computeAddressEstimate({
        formattedAddress: null,
        city: null,
        state: null,
        zip: null,
        placeVerified: false,
        buildingType: "office",
        sqft: 12_000,
      });
      const value = {
        estimatedAnnualCostUsd: est.estimatedAnnualCostUsd,
        topOpportunity: est.topOpportunity,
        percentileBand: est.percentileBand,
        rung: est.accuracy.rung,
        label: "Typical U.S. office · 12,000 sqft (demo building — national averages)",
      };
      sampleCardCache = { at: now, value };
      return value;
    }),
    /* §1b use-my-location — tap-triggered reverse geocode. The coordinate is
     * used once for the lookup and never stored (GPS-never-stored rule). */
    fromLocation: publicProcedure
      .input(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
      .mutation(async ({ ctx, input }) => {
        if (!estimateRateAllows(ctx.req.ip ?? "unknown")) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many lookups — try again in a few minutes." });
        }
        return await reverseGeocode(input.lat, input.lng);
      }),
  }),

  /* ================= places (grounded address intake, Jul 17) ================= */
  places: router({
    /** Debounced address autocomplete — US-biased, address-scoped, top 5. */
    autocomplete: protectedProcedure
      .input(z.object({ query: z.string().min(3).max(200) }))
      .query(({ input }) => placeAutocomplete(input.query)),
    /** Resolve a selected suggestion to verified components so the intake UI
     *  can preview state/ZIP (and the suggested utility) BEFORE creating. */
    resolve: protectedProcedure
      .input(z.object({ placeId: z.string().min(1).max(512) }))
      .query(async ({ input }) => {
        const place = await resolvePlace(input.placeId);
        // Editable suggestion only — never silently persisted without display.
        const cascade = deriveFromAddress(place.formattedAddress, {
          state: place.state,
          zip: place.zip,
          city: place.city,
          placeVerified: place.state != null,
        });
        return {
          place,
          suggestedUtility: cascade.utilityName.value,
          utilityNote: cascade.utilityName.note,
          climateZone: cascade.climateZone.value,
        };
      }),
  }),
  /* ================= sites ================= */
  sites: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      await seeded();
      return h.listSites(ctx.user.id);
    }),
    get: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      // GAP-L: owners get their row as before; shared-site members (facility
      // manager / read-only) can view it too — the effective role rides along
      // so the UI can gate its edit affordances honestly.
      const { site, role } = await h.getSiteAsViewer(input.siteId, ctx.user.id);
      return { ...site, myRole: role };
    }),
    /** SVC (owner reports Jul 19) — per-commodity service applicability with
     * provenance. Resolution ladder: user override → meter/equipment evidence →
     * territory imputation → commodity default (gas never assumed). */
    services: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      const { site } = await h.getSiteAsViewer(input.siteId, ctx.user.id);
      return resolveAllCommodityServices(site, ctx.user.id);
    }),
    setServices: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          electric: z.enum(["active", "none", "unknown"]).optional(),
          gas: z.enum(["active", "none", "unknown"]).optional(),
          water: z.enum(["active", "none", "unknown"]).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Owner or facility_manager may set; merge over the existing profile so
        // a single-commodity toggle never clobbers the others. "unknown" clears
        // the override and returns that commodity to evidence/territory tiers.
        const { site } = await h.getSiteAsViewer(input.siteId, ctx.user.id);
        const prior = (site.servicesProfile ?? {}) as Record<string, string>;
        const merged: Record<string, string> = { ...prior };
        for (const c of ["electric", "gas", "water"] as const) {
          if (input[c]) merged[c] = input[c]!;
        }
        await h.updateSite(input.siteId, ctx.user.id, { servicesProfile: merged });
        return resolveAllCommodityServices({ ...site, servicesProfile: merged }, ctx.user.id);
      }),
    /** GAP-L — sites shared WITH me, with my role on each. */
    sharedWithMe: protectedProcedure.query(async ({ ctx }) => {
      const rows = await h.listSharedSites(ctx.user.id);
      return rows.map((r) => ({ ...r.site, myRole: r.role as "facility_manager" | "read_only" }));
    }),
    /** GAP-L — membership management (owner only). Roles:
     * facility_manager = can act (refine, mark measures); read_only = can look.
     * The invitee must already have a Meterly account (invite-by-email lookup);
     * we say so honestly instead of pretending an email invitation was sent. */
    members: router({
      list: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
        return h.listSiteMembers(input.siteId, ctx.user.id);
      }),
      add: protectedProcedure
        .input(z.object({ siteId: z.number(), email: z.string().email().max(320), role: z.enum(["facility_manager", "read_only"]) }))
        .mutation(async ({ ctx, input }) => {
          const target = await h.findUserByEmail(input.email.trim().toLowerCase()) ?? await h.findUserByEmail(input.email.trim());
          if (!target) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "No Meterly account exists for that email yet. Ask them to sign in once first — no email invitation is sent from here (we don't pretend otherwise).",
            });
          }
          const id = await h.upsertSiteMember(input.siteId, ctx.user.id, target.id, input.role);
          await h.audit(ctx.user.id, "site_member_add", "site", String(input.siteId), { memberUserId: target.id, role: input.role });
          return { ok: true as const, memberId: id, name: target.name };
        }),
      remove: protectedProcedure
        .input(z.object({ siteId: z.number(), memberId: z.number() }))
        .mutation(async ({ ctx, input }) => {
          await h.removeSiteMember(input.siteId, ctx.user.id, input.memberId);
          await h.audit(ctx.user.id, "site_member_remove", "site", String(input.siteId), { memberId: input.memberId });
          return { ok: true as const };
        }),
    }),
    create: protectedProcedure.input(siteInput).mutation(async ({ ctx, input }) => {
      const tier = tierOf(ctx.user);
      // Batch-13 (passes 56/76/86/95): count-then-create runs under a per-user
      // named lock so concurrent requests cannot all pass the free-tier check.
      // Gap-8 cascade (Jul 2026): the direct-create path now derives every
      // omitted location-downstream field the same way quick-start does —
      // explicit user values always win (tagged user_entered inside the
      // cascade); only genuinely absent fields get derived suggestions.
      const createCascade = deriveFromAddress(input.address ?? null, {
        state: input.state ?? null,
        zip: input.zip ?? null,
        city: input.city ?? null,
        climateZone: input.climateZone ?? null,
        utilityName: input.utilityName ?? null,
        buildingType: input.buildingType ?? null,
        sqft: input.sqft ?? null,
        vintage: input.vintage ?? null,
      });
      const id = await h.withUserQuotaLock(ctx.user.id, async () => {
        if (tier === "free") {
          const n = await h.countSites(ctx.user.id);
          if (n >= FREE_TIER_MAX_SITES) {
            throw new TRPCError({ code: "FORBIDDEN", message: `Free tier is limited to ${FREE_TIER_MAX_SITES} sites. Upgrade to add more.` });
          }
        }
        return h.createSite({
          ...input,
          userId: ctx.user.id,
          // Batch-48 (pass 2155): location fields parsed out of a free-text
          // address are persisted AND disclosed below — previously state/zip/
          // city derived by the cascade were used for zone/utility derivation
          // but silently dropped from the row, leaving downstream paths
          // (upload timezone, tariff sweep, refine cascade) to re-fallback.
          state: input.state ?? createCascade.state.value ?? undefined,
          zip: input.zip ?? createCascade.zip.value ?? undefined,
          city: input.city ?? createCascade.city.value ?? undefined,
          climateZone: input.climateZone ?? createCascade.climateZone.value,
          utilityName: input.utilityName ?? createCascade.utilityName.value ?? undefined,
          attrSource: "user_entered",
        });
      });
      // Disclose any derived (non-user-entered) suggestions so the cascade is
      // never silent on this path either.
      // Batch-48 (pass 2155): city/state/zip parsed from the address are part
      // of the disclosure — the cascade can derive them from free text, and
      // silently consuming them violated the never-silent cascade contract.
      const derivedOnCreate = Object.entries(cascadeProvenance(createCascade)).filter(
        ([k, v]) =>
          ["climateZone", "utilityName", "state", "zip", "city"].includes(k) &&
          v.value != null &&
          v.source !== "user_entered" &&
          v.source !== "unknown",
      );
      if (derivedOnCreate.length > 0) {
        await h.addInsight({
          siteId: id,
          kind: "intake_assumptions",
          title: "Some fields were derived from your address — override anytime",
          body:
            derivedOnCreate
              .map(([k]) => (createCascade as unknown as Record<string, { note: string }>)[k].note)
              .join(" ") +
            " Derived values are starting points, not verified facts — edit the site to correct any of them.",
          severity: "info",
          confidence: "medium",
          provenance: { method: "site_create_cascade_v1", derivedFields: derivedOnCreate.map(([k]) => k) },
          metrics: { cascade: cascadeProvenance(createCascade) },
        });
      }
      // Batch-39 (passes 1586/1626): the quick-start, file-upload, and bill-entry
      // paths all disclose timezone assignment risk; the direct create path was the
      // one silent exception. Two cases matter: (a) a split-timezone state where the
      // dominant zone may be wrong for this site, and (b) NO state at all, where
      // tzForState falls back to America/Phoenix and inferClimateZone falls back to
      // the US-median zone — both affect TOU periods, demand windows, and CP seasons.
      // Batch-42 (pass 1826): check !input.state FIRST — tzAmbiguityNote now
      // also returns a (generic) note for empty states, but this path has the
      // richer combined timezone + climate-zone disclosure below.
      const createTzNote = input.state ? tzAmbiguityNote(input.state) : null;
      if (createTzNote) {
        // Batch-46 (pass 2036): an UNRECOGNIZED non-empty state (typo, territory
        // like PR) doesn't just break the timezone — the climate zone falls to
        // the US-median too, and the no-state branch below (which discloses that)
        // never fires because input.state is non-empty. Append the same
        // zone-context clause here so both consequences of the bad state are
        // disclosed together, sharing one inference source with the stored zone.
        const createZoneUsed = input.climateZone
          ? { zone: input.climateZone, source: "user_entered" as const }
          : inferClimateZoneWithSource(input.zip, input.state);
        // "Unrecognized state" is precisely the tz-warning case where the zone
        // inference could NOT resolve via the state table — the inference
        // source is the single source of truth (state_inferred means the state
        // WAS recognized, so no extra zone context is needed).
        const stateUnrecognized = createTzNote.severity === "warning" && createZoneUsed.source !== "state_inferred";
        const createZoneClause = stateUnrecognized
          ? createZoneUsed.source === "user_entered"
            ? ` The climate zone uses your entered value (${createZoneUsed.zone}) and is unaffected.`
            : createZoneUsed.source === "zip_inferred"
              ? ` The climate zone was still inferred from your ZIP (${createZoneUsed.zone}).`
              : ` The climate zone also could not be derived and defaults to the US-median (${createZoneUsed.zone}) — archetype load shapes may not match your climate.`
          : "";
        await h.addInsight({
          siteId: id,
          kind: "intake_assumptions",
          title: "Meter timezone assumption — verify if incorrect for this site",
          body: createTzNote.body + createZoneClause,
          severity: createTzNote.severity,
          confidence: createTzNote.confidence,
          provenance: {
            method: "site_create_tz_disclosure_v1",
            state: input.state,
            tzAmbiguous: true,
            ...(stateUnrecognized ? { climateZoneUsed: createZoneUsed.zone, climateZoneSource: createZoneUsed.source } : {}),
          },
          metrics: null,
        });
      } else if (!input.state) {
        // Batch-41 (pass 1776): the disclosure must describe the values ACTUALLY
        // used. If the user supplied a climate zone, it is NOT a fallback — only
        // the timezone is; if a ZIP inferred a specific zone, name that; only
        // when neither exists is the US-median 4A wording true.
        // Batch-45 (pass 1926a): the zone SOURCE now comes from
        // inferClimateZoneWithSource, not from "was a ZIP present" — a ZIP
        // whose prefix is unmapped falls through to the US-median, and the old
        // presence-based branching would have mislabeled that fallback as
        // "inferred from your ZIP". Provenance and body text share one source.
        const zoneUsed = input.climateZone
          ? { zone: input.climateZone, source: "user_entered" as const }
          : inferClimateZoneWithSource(input.zip, input.state);
        const usedZone = zoneUsed.zone;
        const zoneClause =
          zoneUsed.source === "user_entered"
            ? `the climate zone uses your entered value (${usedZone})`
            : zoneUsed.source === "zip_inferred"
              ? `the climate zone was inferred from your ZIP (${usedZone})`
              : `the climate zone defaults to the US-median (${usedZone})`;
        await h.addInsight({
          siteId: id,
          kind: "intake_assumptions",
          title: "No state provided — timezone is a fallback assumption",
          body: `No state was provided for this site, so the meter timezone defaults to America/Phoenix, and ${zoneClause}. Time-of-use periods, demand windows, and coincident-peak seasons may be wrong for your actual location — add a state to correct the timezone.`,
          severity: "warning",
          confidence: "low",
          provenance: { method: "site_create_tz_disclosure_v2", state: null, tzFallback: "America/Phoenix", climateZoneUsed: usedZone, climateZoneSource: zoneUsed.source },
          metrics: null,
        });
      }
      await h.audit(ctx.user.id, "site_created", "site", String(id), { name: input.name, hypothetical: input.isHypothetical });
      return { id };
    }),
    /** Progressive participation (Jul 2026): start with NOTHING but a free-text
     *  address. State/ZIP/city are parsed from the text; every other attribute
     *  is a DISCLOSED placeholder (attrSource=quick_start_defaults) so the
     *  archetype pipeline can produce an immediate quick-win analysis. An
     *  intake-assumptions insight is written at creation time enumerating each
     *  assumption and what refining it unlocks — forms are optional refinements,
     *  never a gate. */
    quickCreate: protectedProcedure
      .input(
        z.object({
          address: z.string().min(3).max(1000),
          name: z.string().max(255).optional(),
          // Grounded intake (Jul 17): a Google Places selection grounds the
          // location in a VERIFIED address instead of free-text regex parsing.
          placeId: z.string().max(512).optional(),
          // Building type CONFIRMED by the user in the intake flow (one-tap
          // chips) — no more silent 15k-sqft office assumption for a house.
          buildingType: z.enum(["single_family", "multifamily", "office", "retail", "warehouse", "restaurant", "school", "hospital", "hotel", "grocery", "manufacturing", "municipal"]).optional(),
          // Utility confirmed/overridden by the user (the state-largest is
          // only ever shown as an editable suggestion).
          utilityName: z.string().max(128).optional(),
          // GAP-O pin-drop mode: coordinates from a map pin the user dropped
          // (NOT device GPS). Only honored together with prospective intent or
          // when no verified place was selected — a verified place geocode
          // always wins for address-grounded sites.
          pinLat: z.number().min(-90).max(90).optional(),
          pinLng: z.number().min(-180).max(180).optional(),
          // Prospective site: user is only CONSIDERING this location (pre-purchase
          // / pre-lease / pin-drop). Insights render modeled-only, never occupancy.
          prospective: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        // Grounded location: resolve the verified Place server-side when one
        // was selected; degrade to free-text parsing (disclosed) otherwise —
        // a Places outage must never block intake.
        let verified: Awaited<ReturnType<typeof resolvePlace>> | null = null;
        if (input.placeId) {
          try {
            verified = await resolvePlace(input.placeId);
          } catch (e) {
            console.error("[quickCreate] place resolution failed — falling back to text parse:", e);
          }
        }
        const effectiveAddress = verified?.formattedAddress || input.address;
        const parse = verified?.state
          ? { state: verified.state, zip: verified.zip, city: verified.city, raw: effectiveAddress }
          : parseQuickAddress(input.address);
        // Gap-8 cascade (Jul 2026): everything derivable from the address is
        // derived — candidate utility, ZIP3-aware climate zone, timezone,
        // eGRID subregion, and building-stock priors — each with provenance.
        // Grounded intake feeds VERIFIED location facts and the user-confirmed
        // building type in as explicit values.
        const cascade = deriveFromAddress(effectiveAddress, {
          state: verified?.state ?? undefined,
          zip: verified?.zip ?? undefined,
          city: verified?.city ?? undefined,
          buildingType: input.buildingType ?? undefined,
          utilityName: input.utilityName?.trim() || undefined,
          placeVerified: verified?.state != null,
        });
        const assumptions = quickStartAssumptions(parse, {
          buildingType: cascade.buildingType.value,
          sqft: cascade.sqft.value,
          vintage: cascade.vintage.value,
        });
        const id = await h.withUserQuotaLock(ctx.user.id, async () => {
          if (tier === "free") {
            const n = await h.countSites(ctx.user.id);
            if (n >= FREE_TIER_MAX_SITES) {
              throw new TRPCError({ code: "FORBIDDEN", message: `Free tier is limited to ${FREE_TIER_MAX_SITES} sites. Upgrade to add more.` });
            }
          }
          return h.createSite({
            userId: ctx.user.id,
            name:
              input.name?.trim() ||
              // Owner request Jul 19: when the user searched by PLACE NAME
              // ("Emmanuel Baptist Church"), the site should be called that —
              // not a generic "Tucson building".
              verified?.placeName ||
              (parse.city
                ? `${parse.city} ${input.buildingType === "single_family" ? "home" : input.buildingType === "multifamily" ? "apartment" : "building"}`
                : parse.raw.slice(0, 60) || "My building"),
            address: parse.raw,
            city: parse.city,
            state: parse.state,
            zip: parse.zip,
            buildingType: cascade.buildingType.value,
            sqft: cascade.sqft.value,
            vintage: cascade.vintage.value,
            climateZone: cascade.climateZone.value,
            utilityName: cascade.utilityName.value ?? undefined,
            isHypothetical: false,
            // §1b portfolio map: coordinates come from the VERIFIED place
            // geocode (user picked the address), or — GAP-O — from a map pin
            // the user explicitly dropped. Never from raw device GPS.
            lat: verified?.lat ?? input.pinLat ?? undefined,
            lng: verified?.lng ?? input.pinLng ?? undefined,
            // GAP-O: prospective flag — a considered location, not an occupied one.
            prospective: input.prospective ? 1 : 0,
            attrSource: input.buildingType ? "user_entered" : "quick_start_defaults",
            // Batch-45 (pass 1959): per-field refinement record — grounded
            // intake counts a user-confirmed building type as refined from
            // the start; sqft/vintage remain priors until provided.
            refinedFields: input.buildingType ? ["buildingType"] : [],
          });
        });
        // Disclosure exists from the moment the site does — before any analysis.
        // Batch-24 (passes 846/856): quick-start meters inherit tzForState(state),
        // which is single-valued per state — split-timezone states get the
        // ambiguity warning appended so TOU/demand-window shifts are never silent.
        const tzNote = tzAmbiguityNote(parse.state);
        await h.addInsight({
          siteId: id,
          kind: "intake_assumptions",
          title: verified
            ? "Quick-start analysis — verified address, remaining assumptions disclosed"
            : "Quick-start analysis — placeholder assumptions in effect",
          body:
            (verified
              ? `This site was created from a verified address (${verified.formattedAddress}). Everything derivable from it was derived automatically — `
              : `This site was created from just an address. Everything derivable from the address was derived automatically — `) +
            [
              `climate zone ${cascade.climateZone.value} (${cascade.climateZone.source.replace(/_/g, " ")})`,
              `timezone ${cascade.timezone.value} (${cascade.timezone.source.replace(/_/g, " ")})`,
              // Batch-46 (pass 2026): when no utility was derived, cite the
              // cascade's own note (which names the actual reason) instead of
              // asserting "no state parsed" — the derivation can fail for
              // reasons other than a missing state, and the note is the source
              // of truth for why.
              cascade.utilityName.value
                ? `likely utility ${cascade.utilityName.value} (${cascade.utilityName.source.replace(/_/g, " ")})`
                : `utility unknown — ${cascade.utilityName.note}`,
              input.buildingType
                ? `building type ${cascade.buildingType.value} (confirmed by you) with ${cascade.sqft.value.toLocaleString()} sqft / vintage ${cascade.vintage.value} type-median priors`
                : `building prior: ${cascade.buildingType.value}, ${cascade.sqft.value.toLocaleString()} sqft, vintage ${cascade.vintage.value} (${cascade.sqft.source.replace(/_/g, " ")}) — UNCONFIRMED: tap the building-type chip to correct it`,
            ].join("; ") +
            `. These are starting points, not facts — every field is overridable, and each "add detail" chip on the dashboard shows exactly what refining a field unlocks.` +
            (input.prospective
              ? ` PROSPECTIVE SITE: you marked this as a location you're considering — every figure here is a modeled what-if for the archetype at this location, not a reading of anyone's actual usage.`
              : "") +
            (tzNote ? ` ${tzNote.body}` : "") +
            ` ${MODELED_ESTIMATES_DISCLAIMER}`,
          // Batch-44 (pass 1915): the combined note inherits the tz note's
          // severity when it is graver than the default info.
          severity: tzNote?.severity === "warning" ? "warning" : "info",
          confidence: "low",
          provenance: {
            method: verified ? "quick_start_intake_v3_grounded" : "quick_start_intake_v2",
            parsedState: parse.state,
            parsedZip: parse.zip,
            tzAmbiguous: tzNote != null,
            placeId: verified?.placeId,
            buildingTypeConfirmed: input.buildingType != null,
            prospective: input.prospective === true,
            pinDropped: input.pinLat != null && input.pinLng != null,
          },
          metrics: { assumptions, cascade: cascadeProvenance(cascade) },
        });
        await h.audit(ctx.user.id, "site_created", "site", String(id), { name: input.name ?? parse.raw.slice(0, 60), quickStart: true });
        // GAP-Q reveal moment: one address → candidate providers for all three
        // commodities. Candidates only — each carries its own honesty note.
        const utilityTriple = deriveUtilityTriple(cascade.state.value, cascade.city.value);
        return { id, parse, assumptions, utilityTriple };
      }),
    /** GAP-Q — the three-utilities reveal for an EXISTING site (viewer-scoped):
     * candidate electric/gas/water providers derived from its location. */
    utilityReveal: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      const { site } = await h.getSiteAsViewer(input.siteId, ctx.user.id);
      return {
        triple: deriveUtilityTriple(site.state, site.city),
        knownElectric: site.utilityName ?? null,
        note: "Candidates derived from the site's location — confirm against actual bills. The electric provider on file (if any) always wins over the candidate.",
      };
    }),
    /** Optional refinement path for quick-start sites — each supplied field
     *  replaces its placeholder; attrSource flips to user_entered once any core
     *  attribute (buildingType/sqft/vintage) is provided by the user. */
    refine: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          buildingType: z.string().max(64).optional(),
          sqft: z.number().positive().max(50_000_000).optional(),
          vintage: z.number().int().min(1850).max(2030).optional(),
          occupancyHours: z.record(z.string(), z.unknown()).optional(),
          utilityName: z.string().max(128).optional(),
          state: z.string().max(8).optional(),
          zip: z.string().max(16).optional(),
          name: z.string().min(1).max(255).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // GAP-L: refine is an ACT — owner or facility_manager may do it;
        // read_only members are blocked with a role-naming error.
        await h.assertSiteActor(input.siteId, ctx.user.id);
        const { site } = await h.getSiteAsViewer(input.siteId, ctx.user.id);
        const { siteId, ...patch } = input;
        const provided = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(provided).length === 0) return { ok: true as const, updated: [] as string[] };
        // Batch-21 (passes 565/566): (a) explicitly-entered location (state/zip)
        // counts as user-entered data too — leaving attrSource at
        // quick_start_defaults kept re-emitting the intake-assumptions insight
        // against data the user actually typed; (b) climateZone is DERIVED from
        // location, so a location update always re-infers it (the old
        // attrSource guard silently pinned the zone — and every downstream
        // archetype/EUI/savings figure — to the pre-move location once any
        // earlier refinement had flipped attrSource).
        // Batch-46 (pass 2109): the attrSource flip keys off the BUILDING
        // attributes only (was [buildingType, sqft, vintage, state, zip] since
        // Batch-21 — that batch's concern, re-emitting the intake insight
        // against user-typed location, is now handled by the pipeline's
        // per-line location gating). A location-only refine on a LEGACY row
        // (refinedFields null, no per-field record) must not flip attrSource
        // and silently retire the buildingType/sqft/vintage placeholder lines
        // that are still quick-start defaults.
        const buildingAttrProvided = ["buildingType", "sqft", "vintage"].some((k) => k in provided);
        // Batch-45 (pass 1959): track WHICH core placeholders the user replaced.
        // Site-level attrSource flips on the FIRST core refinement, which alone
        // cannot say which of buildingType/sqft/vintage remain placeholders —
        // the per-field list can. Only maintained for quick-start-origin sites
        // (refinedFields non-null); regular sites stay null.
        const priorRefined = Array.isArray(site.refinedFields) ? (site.refinedFields as string[]) : null;
        // Batch-46 (pass 2035): utilityName is tracked per-field too — site-level
        // attrSource flips on ANY core refinement, so it alone cannot distinguish
        // "user typed this utility" from "cascade suggested it before the user
        // refined an unrelated field". Only an explicitly-provided utilityName
        // earns ownership for quick-start-origin sites.
        const newlyRefined = ["buildingType", "sqft", "vintage", "utilityName"].filter((k) => k in provided && !priorRefined?.includes(k));
        const nextRefined = priorRefined != null && newlyRefined.length > 0 ? [...priorRefined, ...newlyRefined] : undefined;
        const nextState = (provided.state as string | undefined) ?? site.state ?? undefined;
        const nextZip = (provided.zip as string | undefined) ?? site.zip ?? undefined;
        // Gap-8 cascade (Jul 2026): a location change re-runs the full cascade,
        // not just the climate zone — the candidate utility follows the move
        // too, UNLESS the user has ever set a utility themselves (a provided
        // utilityName in this call, or one already stored on a site whose
        // attrSource is user_entered, is treated as user intent and never
        // overwritten by a state-level suggestion).
        const locationChanged = Boolean(provided.state || provided.zip);
        const refineCascade = locationChanged
          ? deriveFromAddress(site.address ?? null, { state: nextState ?? null, zip: nextZip ?? null })
          : null;
        // Batch-46 (pass 2035): for quick-start sites (refinedFields non-null),
        // ownership requires the utility to have been EXPLICITLY provided — now
        // or in a past refine (tracked per-field). The site-level attrSource
        // check would otherwise pin a cascade-suggested utility as "user-owned"
        // the moment the user refined an unrelated field like buildingType,
        // blocking legitimate re-derivation on a later location change. Regular
        // sites keep the attrSource heuristic (their utility, when present, was
        // typed in sites.create or refine directly).
        const userOwnsUtility =
          "utilityName" in provided ||
          (priorRefined != null
            ? priorRefined.includes("utilityName")
            : site.utilityName != null && site.attrSource === "user_entered");
        await h.updateSite(siteId, ctx.user.id, {
          ...provided,
          // climateZone derives from location: always re-infer on location change
          // (cascade path uses the ZIP3 table for sub-state precision).
          ...(refineCascade ? { climateZone: refineCascade.climateZone.value } : {}),
          ...(refineCascade && !userOwnsUtility && refineCascade.utilityName.value
            ? { utilityName: refineCascade.utilityName.value }
            : {}),
          ...(buildingAttrProvided && site.attrSource === "quick_start_defaults" ? { attrSource: "user_entered" } : {}),
          ...(nextRefined !== undefined ? { refinedFields: nextRefined } : {}),
        });
        // Disclose the re-derivation so the location-driven update is never silent.
        if (refineCascade && !userOwnsUtility && refineCascade.utilityName.value && refineCascade.utilityName.value !== site.utilityName) {
          await h.addInsight({
            siteId,
            kind: "intake_assumptions",
            title: "Location change re-derived your candidate utility — override anytime",
            body: `${refineCascade.utilityName.note} The climate zone was also re-inferred (${refineCascade.climateZone.value}, ${refineCascade.climateZone.source.replace(/_/g, " ")}).`,
            severity: "info",
            confidence: "medium",
            provenance: { method: "site_refine_cascade_v1", state: nextState ?? null, zip: nextZip ?? null },
            metrics: { cascade: cascadeProvenance(refineCascade) },
          });
        }
        // Batch-39 (pass 1626): a refine that sets/changes the state must carry the
        // same split-timezone disclosure as every creation path — the new state
        // silently re-derives the meter timezone for all downstream TOU math.
        if (provided.state) {
          const refineTzNote = tzAmbiguityNote(provided.state as string);
          if (refineTzNote) {
            // Batch-57 (pass 2906): parity with sites.create (Batch-46 pass 2036) —
            // an unrecognized state (warning severity) also re-runs climate-zone
            // inference on this path (refineCascade above), so the provenance
            // must name the zone actually applied, not just the tz ambiguity.
            const refineStateUnrecognized =
              refineTzNote.severity === "warning" &&
              !((provided.state as string).toUpperCase().trim() in TZ_BY_STATE);
            await h.addInsight({
              siteId,
              kind: "intake_assumptions",
              title: "Meter timezone assumption — verify if incorrect for this site",
              body: refineTzNote.body,
              severity: refineTzNote.severity,
              confidence: refineTzNote.confidence,
              provenance: {
                method: "site_refine_tz_disclosure_v1",
                state: provided.state,
                tzAmbiguous: true,
                ...(refineStateUnrecognized && refineCascade
                  ? { climateZoneUsed: refineCascade.climateZone.value, climateZoneSource: refineCascade.climateZone.source }
                  : {}),
              },
              metrics: null,
            });
          }
        }
        await h.audit(ctx.user.id, "site_refined", "site", String(siteId), { fields: Object.keys(provided) });
        // v1.17 §5.0(c) recompute disclosure: a confirmation/correction states
        // WHICH dependent insights it recomputes — "pool confirmed → summer
        // end-use split updated", never a silent number change. The mapping is
        // deterministic (attribute → dependent insight classes in this build);
        // the next analysis run applies it, and the UI announces it now.
        const RECOMPUTE_DEPENDENTS: Record<string, string[]> = {
          buildingType: ["peer archetype load shape", "end-use breakdown prior", "peer-building benchmark"],
          sqft: ["synthetic baseline scale", "peer-building benchmark percentile"],
          vintage: ["archetype efficiency band", "end-use breakdown prior"],
          state: ["climate zone", "tariffs swept in the rate check", "emissions factors", "meter timezone"],
          zip: ["climate zone precision", "emissions subregion"],
          utilityName: ["tariffs swept in the rate check"],
          occupancyHours: ["operating-hours assumptions in scenarios"],
        };
        const recomputes = Object.keys(provided)
          .filter((k) => k in RECOMPUTE_DEPENDENTS)
          .map((k) => ({ field: k, updates: RECOMPUTE_DEPENDENTS[k] }));
        return { ok: true as const, updated: Object.keys(provided), recomputes };
      }),
    /** Direct site edit: rename + core attributes. Distinct from `refine` (which
     * runs the derivation cascade); this is a plain CRUD update for user control. */
    update: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          name: z.string().min(1).max(255).optional(),
          address: z.string().max(512).nullable().optional(),
          city: z.string().max(128).nullable().optional(),
          occupancyHours: z.string().max(64).nullable().optional(),
          utilityName: z.string().max(255).nullable().optional(),
          /** v1.18: tenure + solar status are first-class, editable site facts */
          tenure: z.enum(["own", "rent", "condo_hoa"]).optional(),
          hasSolar: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { siteId, ...patch } = input;
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(clean).length === 0) return { ok: true as const };
        await h.updateSite(siteId, ctx.user.id, clean);
        await h.audit(ctx.user.id, "site_update", "site", String(siteId), { fields: Object.keys(clean) });
        return { ok: true as const };
      }),
    /** v2.11 identity-confirm moment — one-tap "yes, that's it": the derived
     * profile was a QUESTION; answering yes upgrades attrSource so the
     * imputed/estimate chips resolve to confirmed, and downstream inference
     * (archetype match, hours, benchmark peers) runs on a confirmed identity.
     * No attribute values change — only their provenance does. */
    confirmIdentity: protectedProcedure
      .input(z.object({ siteId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await h.updateSite(input.siteId, ctx.user.id, { attrSource: "user_confirmed" });
        await h.audit(ctx.user.id, "site_identity_confirm", "site", String(input.siteId), {});
        return { ok: true as const };
      }),
    /** GAP-J — dimensional receipts: every dimension the model uses, WITH its
     * source, side by side with what building geometry implies. When the profile
     * sqft diverges >20% from geometry-derived GFA (footprint × stories), the
     * client surfaces a QUESTION (never a silent override) — the user's answer
     * flows through sites.refine like any other refinement. */
    dimensionReceipts: protectedProcedure
      .input(z.object({ siteId: z.number() }))
      .query(async ({ ctx, input }) => {
        const site = await h.getSite(input.siteId, ctx.user.id);
        const geom = await h.getSiteGeometry(input.siteId, ctx.user.id);
        const profileSqft = site.sqft ?? null;
        const profileSource =
          site.attrSource === "user_entered" || site.attrSource === "user_confirmed"
            ? "you provided / confirmed it"
            : site.attrSource === "assessor"
              ? "county assessor record"
              : "building-stock prior for the type (placeholder)";
        const footprintSqft = geom?.footprintSqft ?? null;
        const stories = geom?.stories ?? null;
        const geometryGfaSqft = footprintSqft != null && stories != null && stories > 0 ? footprintSqft * stories : null;
        const geometrySource = geom?.footprintSource
          ? `${geom.footprintSource.replace(/_/g, " ")} footprint × ${stories} ${stories === 1 ? "story" : "stories"}`
          : null;
        let divergencePct: number | null = null;
        if (profileSqft != null && profileSqft > 0 && geometryGfaSqft != null && geometryGfaSqft > 0) {
          divergencePct = Math.abs(geometryGfaSqft - profileSqft) / profileSqft;
        }
        const DIVERGENCE_QUESTION_THRESHOLD = 0.2;
        return {
          receipts: [
            {
              dimension: "floor_area_sqft",
              valueInUse: profileSqft,
              source: profileSource,
              usedBy: "baseline scaling, EUI benchmark percentile, per-sqft opportunity sizing",
            },
            ...(geometryGfaSqft != null
              ? [
                  {
                    dimension: "geometry_derived_gfa_sqft",
                    valueInUse: Math.round(geometryGfaSqft),
                    source: geometrySource ?? "building geometry",
                    usedBy: "cross-check only — never silently replaces your floor area",
                  },
                ]
              : []),
          ],
          divergence:
            divergencePct != null && divergencePct > DIVERGENCE_QUESTION_THRESHOLD
              ? {
                  pct: Math.round(divergencePct * 100),
                  profileSqft,
                  geometryGfaSqft: Math.round(geometryGfaSqft!),
                  question: `Your profile says ${profileSqft!.toLocaleString()} sqft, but the building footprint × stories works out to about ${Math.round(geometryGfaSqft!).toLocaleString()} sqft (${geometrySource}). Which is closer to right?`,
                  disclosure:
                    "Geometry-derived floor area is an estimate too (footprint × story count) — basements, mezzanines, and unconditioned space all blur it. We ask instead of overriding.",
                }
              : null,
          thresholdPct: DIVERGENCE_QUESTION_THRESHOLD * 100,
        };
      }),
    /** GEO — stage 2b geometry & exposure (handoff v1.22, cycles 4/8/10).
     * Resolve footprint candidates for a site: OSM Overpass first (free, ODbL
     * flagged), prism fallback synthesized from GFA + stories. Candidates are
     * returned for tap-to-confirm — nothing is silently asserted. */
    geometryResolve: protectedProcedure
      .input(z.object({ siteId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
        if (site.lat == null || site.lng == null) {
          return {
            candidates: [] as ReturnType<typeof geo.deriveGeometry>[],
            raw: [] as import("./geometry").FootprintCandidate[],
            fallback: null,
            note: "This site has no coordinates yet — confirm the address (or drop a pin) first, then geometry can be resolved.",
          };
        }
        const point = { lat: site.lat, lng: site.lng };
        // Raced two-family resolve: OSM Overpass mirrors and the Esri layers
        // (FEMA USA Structures → MSBFP2) are queried IN PARALLEL with a short
        // per-source budget, first family with candidates wins (OSM preferred
        // for tags/ODbL handling). Results are cached ~6h per point so retries
        // and re-opens never depend on upstream throttling. Prism last.
        const resolved = await geo.resolveFootprints(point);
        const found = resolved.candidates;
        let sourceNote = "";
        if (resolved.provider === "osm") {
          sourceNote = "OpenStreetMap building footprints near your point (ODbL).";
        } else if (resolved.provider === "esri") {
          const heightBearing = found[0]?.source === "usa_structures";
          const dsName = heightBearing
            ? `the FEMA USA Structures dataset${found.some((c) => c.heightM != null) ? " (includes measured building heights)" : " (no height measured for this building — stories come from your profile)"}`
            : "the Microsoft US Building Footprints dataset (no height data — stories come from your profile)";
          sourceNote = resolved.osmFailed
            ? `OpenStreetMap was unreachable, so these footprints come from ${dsName}.`
            : `No OSM building here — these footprints come from ${dsName}.`;
        } else if (resolved.osmFailed && resolved.esriFailed) {
          sourceNote =
            "Both footprint sources are unreachable right now — showing a prism estimate from your floor area instead. You can also trace the building yourself below.";
        } else {
          sourceNote =
            "No mapped building found within ~60 m in OpenStreetMap or the federal footprint datasets — you can trace it yourself below.";
        }
        if (resolved.cached && found.length > 0) sourceNote += " (cached result)";
        const prism = geo.prismFallback(point, site.sqft ?? null, null);
        await h.audit(ctx.user.id, "geometry_resolved", "site", String(input.siteId), {
          candidates: found.length,
          source: found[0]?.source ?? "none",
          provider: resolved.provider,
          cached: resolved.cached,
          osmFailed: resolved.osmFailed,
          esriFailed: resolved.esriFailed,
        });
        return {
          candidates: found.map((c) => ({ ...geo.deriveGeometry(c), ring: c.ring, osmId: c.osmId, distanceM: c.distanceM, areaSqft: c.areaSqft, source: c.source })),
          fallback: { ...geo.deriveGeometry(prism), ring: prism.ring, areaSqft: prism.areaSqft, prism: true as const },
          note: sourceNote,
        };
      }),
    /** GEO — tap-to-confirm: persist the chosen footprint (an OSM candidate,
     * the prism estimate, or a user-drawn ring). user_drawn wins precedence and
     * is never overwritten by re-resolves; every field carries provenance. */
    geometryConfirm: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          ring: z.array(z.tuple([z.number(), z.number()])).min(3).max(120),
          source: z.enum(["osm", "microsoft", "usa_structures", "user_drawn", "prism"]),
          osmId: z.string().optional(),
          heightM: z.number().positive().max(500).nullable().optional(),
          stories: z.number().int().positive().max(120).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const cand: import("./geometry").FootprintCandidate = {
          ring: input.ring as [number, number][],
          areaSqft: Math.round(geo.ringAreaSqm(input.ring as [number, number][]) * 10.7639),
          heightM: input.heightM ?? null,
          stories: input.stories ?? null,
          source: input.source,
          osmId: input.osmId,
          distanceM: 0,
        };
        const d = geo.deriveGeometry(cand);
        // usa_structures footprints are LiDAR/imagery-derived federal data —
        // between OSM (human-verified) and MSBFP (ML-only) in confidence.
        const confidence =
          input.source === "user_drawn" ? 0.95 : input.source === "osm" ? 0.8 : input.source === "usa_structures" ? 0.7 : 0.45;
        await h.upsertSiteGeometry(input.siteId, ctx.user.id, {
          footprint: { type: "Polygon", coordinates: [cand.ring] },
          footprintSource: input.source === "prism" ? undefined : input.source,
          footprintSqft: d.footprintSqft,
          heightM: d.heightM,
          heightSource: d.heightSource,
          stories: d.stories ?? undefined,
          orientationDeg: d.orientationDeg,
          exposedWallAreaByOrientation: d.exposedWallAreaByOrientation,
          exposureScore: d.exposureScore,
          neighborShadingFactor: 1,
          geometryConfidence: {
            footprint: { source: input.source, confidence },
            height: { source: d.heightSource, confidence: input.heightM != null ? 0.8 : 0.5 },
            orientation: { source: "derived_longest_edge", confidence: 0.7 },
            exposure: { source: "heuristic", confidence: 0.5 },
          },
          odblDerived: d.odblDerived,
        });
        await h.audit(ctx.user.id, "geometry_confirmed", "site", String(input.siteId), { source: input.source, sqft: d.footprintSqft });
        return { ok: true as const, derived: d };
      }),
    /** GEO — read the stored geometry row (viewer-scoped like sites.get). */
    geometryGet: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.getSiteGeometry(input.siteId, ctx.user.id);
    }),
    /** v1.19 §5 stage 4 — away mode as a promise: one toggle (with optional
     * dates) flips the product's voice. The watchdog itself runs inside the
     * analysis pipeline; this mutation just records the window and audits it. */
    setAway: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          awayMode: z.boolean(),
          awayStart: z.number().nullable().optional(),
          awayEnd: z.number().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.awayStart != null && input.awayEnd != null && input.awayEnd <= input.awayStart) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Away end date must be after the start date." });
        }
        await h.updateSite(input.siteId, ctx.user.id, {
          awayMode: input.awayMode,
          awayStart: input.awayMode ? (input.awayStart ?? null) : null,
          awayEnd: input.awayMode ? (input.awayEnd ?? null) : null,
        });
        await h.audit(ctx.user.id, "site_away_mode", "site", String(input.siteId), { awayMode: input.awayMode });
        return { ok: true as const };
      }),
    /** GAP-A / AC11 — resolve the solar net/gross gate. One answer releases the
     * paused insights on the next analysis run:
     * - net: meter records consumption minus solar (most net-metered homes)
     * - gross: meter records total consumption (separate generation meter)
     * - no_solar: user says there is no PV here — gate dismissed, disclosed. */
    resolvePv: protectedProcedure
      .input(z.object({ siteId: z.number(), answer: z.enum(["net", "gross", "no_solar"]) }))
      .mutation(async ({ ctx, input }) => {
        const patch =
          input.answer === "net"
            ? { pvDetectionStatus: "confirmed_net" as const, netMeteringBasis: "net" as const, hasSolar: true }
            : input.answer === "gross"
              ? { pvDetectionStatus: "confirmed_gross" as const, netMeteringBasis: "gross" as const, hasSolar: true }
              : { pvDetectionStatus: "dismissed" as const };
        await h.updateSite(input.siteId, ctx.user.id, patch);
        await h.audit(ctx.user.id, "pv_gate_resolved", "site", String(input.siteId), { answer: input.answer });
        return {
          ok: true as const,
          released: true,
          note:
            input.answer === "no_solar"
              ? "Noted — no solar here. If the midday-dip pattern persists we may ask again, because the insights depend on reading your shape correctly."
              : "Thanks — re-run the analysis and the paused insights will come back, now interpreted on the right basis.",
        };
      }),
    /** AC12 — occupancy change re-base: records WHEN the building's occupancy
     * changed (move-in/out, new shift, tenant turnover). Verdicts issued before
     * the change keep their period; baselines fitted after it are disclosed. */
    markOccupancyChange: protectedProcedure
      .input(z.object({ siteId: z.number(), changedAt: z.number().optional() }))
      .mutation(async ({ ctx, input }) => {
        const changedAt = input.changedAt ?? Date.now();
        await h.updateSite(input.siteId, ctx.user.id, { occupancyChangedAt: changedAt });
        await h.audit(ctx.user.id, "occupancy_change_marked", "site", String(input.siteId), { changedAt });
        return { ok: true as const, changedAt };
      }),
    /** AC13 — equipment inventory: list rows (inferred until confirmed). */
    equipment: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.listEquipment(input.siteId, ctx.user.id);
    }),
    /** AC13 — confirm/edit an inventory row: providing an install year or a
     * label flips source to user_confirmed so re-analysis never clobbers it. */
    updateEquipment: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          label: z.string().max(120).optional(),
          installYear: z.number().int().min(1900).max(2100).nullable().optional(),
          serviceLifeYears: z.number().int().min(1).max(60).optional(),
          notes: z.string().max(500).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...rest } = input;
        await h.updateEquipment(id, ctx.user.id, { ...rest, source: "user_confirmed" });
        await h.audit(ctx.user.id, "equipment_confirmed", "equipment", String(id), rest);
        return { ok: true as const };
      }),
    /** AC14 — log a production period (water pumped, units produced…). Any site
     * can log any pack metric; the KPI only renders from real logged periods. */
    addProduction: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          metricKey: z.string().max(48),
          periodStart: z.number(),
          periodEnd: z.number(),
          quantity: z.number().positive(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.periodEnd <= input.periodStart) throw new TRPCError({ code: "BAD_REQUEST", message: "Period end must be after period start." });
        await h.getSite(input.siteId, ctx.user.id); // tenancy
        const pack = VERTICAL_PACKS.find((p) => p.metricKey === input.metricKey);
        if (!pack) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown production metric." });
        const id = await addProductionPeriod({
          siteId: input.siteId,
          userId: ctx.user.id,
          metricKey: pack.metricKey,
          metricLabel: pack.metricLabel,
          unit: pack.unit,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          quantity: input.quantity,
        });
        await h.audit(ctx.user.id, "production_logged", "site", String(input.siteId), { metricKey: pack.metricKey, quantity: input.quantity });
        return { id };
      }),
    listProduction: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      await h.getSite(input.siteId, ctx.user.id);
      return listProduction(input.siteId, ctx.user.id);
    }),
    deleteProduction: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await deleteProductionPeriod(input.id, ctx.user.id);
      return { ok: true as const };
    }),
    /** Full site removal (cascade: meters, intervals, bills, analytics, geometry,
     * group memberships). Uploads are detached, not deleted — file provenance survives. */
    delete: protectedProcedure.input(z.object({ siteId: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteSite(input.siteId, ctx.user.id);
      await h.audit(ctx.user.id, "site_delete", "site", String(input.siteId), {});
      return { ok: true as const };
    }),
    meters: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      return h.listMeters(input.siteId, ctx.user.id);
    }),
    /** Manual meter creation — uploads auto-create meters, but users can also
     * add one explicitly (e.g. to stage a submeter or gas meter before data). */
    createMeter: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          label: z.string().max(255).optional(),
          commodity: z.enum(["electric", "gas", "water"]).default("electric"),
          timezone: z.string().max(64).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const usageUnit = input.commodity === "electric" ? "kWh" : input.commodity === "gas" ? "therms" : "gallons";
        const id = await h.createMeter(
          {
            siteId: input.siteId,
            userId: ctx.user.id,
            commodity: input.commodity,
            label: input.label ?? null,
            usageUnit,
            demandUnit: input.commodity === "electric" ? "kW" : null,
            ...(input.timezone ? { timezone: input.timezone } : {}),
          },
          ctx.user.id,
        );
        return { id };
      }),
    updateMeter: protectedProcedure
      .input(
        z.object({
          meterId: z.number(),
          label: z.string().max(255).nullable().optional(),
          timezone: z.string().max(64).optional(),
          accountNumber: z.string().max(64).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { meterId, ...patch } = input;
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(clean).length === 0) return { ok: true as const };
        await h.updateMeter(meterId, ctx.user.id, clean);
        return { ok: true as const };
      }),
    /** Meter removal (cascade: its intervals + bills; child submeters detach). */
    deleteMeter: protectedProcedure.input(z.object({ meterId: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteMeter(input.meterId, ctx.user.id);
      await h.audit(ctx.user.id, "meter_delete", "meter", String(input.meterId), {});
      return { ok: true as const };
    }),
    setMeterTariff: protectedProcedure
      .input(z.object({ meterId: z.number(), tariffId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await h.setMeterTariff(input.meterId, input.tariffId, ctx.user.id);
        return { ok: true };
      }),
    /** v1.7 §2.4: assign meter role + optional parent (submeter nesting). Aggregation
     * physics depend on this: site totals sum main meters only; submeters roll under parents. */
    setMeterRole: protectedProcedure
      .input(
        z.object({
          meterId: z.number(),
          role: z.enum(["main", "submeter", "generation", "ev", "virtual_total"]),
          parentMeterId: z.number().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.role === "submeter" && input.parentMeterId == null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A submeter must name its parent meter — its load is inside the parent's and would otherwise double-count site totals." });
        }
        if (input.parentMeterId != null && input.parentMeterId === input.meterId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A meter cannot be its own parent." });
        }
        await h.setMeterRole(input.meterId, input.role, input.parentMeterId ?? null, ctx.user.id);
        return { ok: true as const };
      }),
    /* --------- site groups (v1.7 §2.2a portfolio rollups) --------- */
    groups: protectedProcedure.query(async ({ ctx }) => h.listSiteGroups(ctx.user.id)),
    createGroup: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          kind: z.enum(["region", "manager", "brand", "custom"]).default("custom"),
          entityId: z.number().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const id = await h.createSiteGroup(ctx.user.id, input.name, input.kind, input.entityId ?? null);
        return { id };
      }),
    setGroupMembership: protectedProcedure
      .input(z.object({ groupId: z.number(), siteId: z.number(), member: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await h.setGroupMembership(input.groupId, input.siteId, input.member, ctx.user.id);
        return { ok: true as const };
      }),
    deleteGroup: protectedProcedure.input(z.object({ groupId: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteSiteGroup(input.groupId, ctx.user.id);
      return { ok: true as const };
    }),
  }),

  /* ================= entities (Gap-9 organizational layer) =================
   * One household/owner/company → many sites → many meters. Entirely optional:
   * sites with entityId NULL belong directly to the account and nothing forces
   * a user to create entities (progressive-participation principle applies to
   * the org layer too). Deleting an entity NEVER deletes sites — they are
   * detached (entityId nulled) so analytic data survives org re-shuffles. */
  entities: router({
    list: protectedProcedure.query(async ({ ctx }) => h.listEntities(ctx.user.id)),
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(255),
          kind: z.enum(["household", "company", "property_owner", "other"]).default("other"),
          notes: z.string().max(2000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const id = await h.createEntity({ userId: ctx.user.id, name: input.name, kind: input.kind, notes: input.notes ?? null });
        return { id };
      }),
    update: protectedProcedure
      .input(
        z.object({
          entityId: z.number(),
          name: z.string().min(1).max(255).optional(),
          kind: z.enum(["household", "company", "property_owner", "other"]).optional(),
          notes: z.string().max(2000).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { entityId, ...patch } = input;
        await h.updateEntity(entityId, ctx.user.id, patch);
        return { ok: true };
      }),
    delete: protectedProcedure.input(z.object({ entityId: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteEntity(input.entityId, ctx.user.id);
      return { ok: true, note: "Sites formerly under this entity were detached, not deleted." };
    }),
    /** Attach/detach a site to an entity (entityId null = detach). */
    assignSite: protectedProcedure
      .input(z.object({ siteId: z.number(), entityId: z.number().nullable() }))
      .mutation(async ({ ctx, input }) => {
        await h.assignSiteEntity(input.siteId, input.entityId, ctx.user.id);
        return { ok: true };
      }),
    /** Portfolio rollup — per-site latest-analysis KPIs + entity totals.
     * Reads each site's persisted machine-readable summary insight; sites
     * never analyzed roll up with null KPIs (disclosed via analyzed flag)
     * rather than fabricated zeros. */
    portfolio: protectedProcedure
      .input(z.object({ entityId: z.number().nullable().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const [allSites, allEntities] = await Promise.all([h.listSites(ctx.user.id), h.listEntities(ctx.user.id)]);
        const filterEntity = input?.entityId;
        const rows = filterEntity === undefined ? allSites : allSites.filter((s) => (s.entityId ?? null) === filterEntity);
        const siteRollups = await Promise.all(
          rows.map(async (s) => {
            const ins = await h.listInsights(s.id, ctx.user.id);
            const summary = ins.find((i) => i.kind === "summary");
            const m = (summary?.metrics ?? null) as {
              demand?: { peakKw?: number; loadFactor?: number } | null;
              currentCost?: { breakdown?: { total?: number; demand?: number; cp?: number | null } } | null;
              emissions?: { annualCo2eLb?: number } | null;
              baseline?: { normalizedAnnualUsage?: number | null; confidenceLabel?: string } | null;
              ratePricing?: { tier?: string; basis?: string; isFallback?: boolean } | null;
            } | null;
            const meterRows = await h.listMeters(s.id, ctx.user.id);
            // §3i-2 exception-first inputs: biggest open $ opportunity (not yet
            // marked implemented) and anomaly severity from the insight rows.
            const [opps, impls] = await Promise.all([
              h.listOpportunities(s.id, ctx.user.id),
              h.listMeasureImplementations(s.id, ctx.user.id),
            ]);
            const implementedMeasures = new Set(impls.map((i) => i.measure));
            const openOpps = opps.filter((o) => !implementedMeasures.has(o.measure));
            const topOpp = openOpps.reduce<{ title: string; savings: number } | null>((acc, o) => {
              const s$ = o.estCostSavingsPerYr ?? 0;
              return acc == null || s$ > acc.savings ? { title: o.title, savings: s$ } : acc;
            }, null);
            const anomaly = ins.find((i) => i.kind === "anomaly");
            const annualUsageKwh = m?.baseline?.normalizedAnnualUsage ?? null;
            return {
              siteId: s.id,
              name: s.name,
              entityId: s.entityId ?? null,
              state: s.state,
              buildingType: s.buildingType,
              // §1b portfolio map: pin coordinates (null when the site was
              // created without a verified address — the map shows only what
              // it actually knows).
              lat: s.lat ?? null,
              lng: s.lng ?? null,
              // §5c-1 returning-user hero: watchdog status in the "since your
              // last visit" line without an extra query.
              awayMode: s.awayMode ?? false,
              climateZone: s.climateZone ?? null,
              // §3i-2 utility-exposure rollup input: which provider serves this site
              utilityName: s.utilityName ?? null,
              sqft: s.sqft ?? null,
              meterCount: meterRows.length,
              analyzed: m != null,
              annualCostUsd: m?.currentCost?.breakdown?.total ?? null,
              demandCostUsd: m?.currentCost?.breakdown ? (m.currentCost.breakdown.demand ?? 0) + (m.currentCost.breakdown.cp ?? 0) : null,
              peakKw: m?.demand?.peakKw ?? null,
              loadFactor: m?.demand?.loadFactor ?? null,
              annualUsageKwh,
              annualCo2eLb: m?.emissions?.annualCo2eLb ?? null,
              // League-table basis: kWh/sqft/yr — only when BOTH inputs exist.
              // Weather normalization: usage is already normal-year normalized
              // by the baseline where a fit exists; chip carries the basis.
              euiKwhPerSqft: annualUsageKwh != null && s.sqft ? annualUsageKwh / s.sqft : null,
              euiBasis: m?.baseline?.confidenceLabel ?? null,
              topOpportunityTitle: topOpp?.title ?? null,
              topOpportunityUsd: topOpp?.savings ?? null,
              hasAnomaly: anomaly != null,
              anomalyTitle: anomaly?.title ?? null,
              // CONF-1 (Jul 21): rate provenance for the confidence rollup —
              // which pricing tier the site's dollar figures stand on. null
              // when the site has no analyzed summary yet.
              rateTier: m?.ratePricing?.tier ?? null,
              rateBasis: m?.ratePricing?.basis ?? null,
            };
          }),
        );
        const sum = (k: "annualCostUsd" | "peakKw" | "annualUsageKwh" | "annualCo2eLb" | "demandCostUsd") => {
          const vals = siteRollups.map((r) => r[k]).filter((v): v is number => v != null);
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
        };
        // §3i-2 roll-up KPI header: cumulative verified savings across ALL the
        // user's implementations; portfolio load factor = usage-weighted mean
        // of site load factors (disclosed as weighted mean, not a coincident
        // portfolio-meter figure — we have no combined meter).
        const verifiedSavingsUsd = await h.totalVerifiedSavings(ctx.user.id);
        const lfRows = siteRollups.filter((r) => r.loadFactor != null && r.annualUsageKwh != null);
        const lfWeight = lfRows.reduce((a, r) => a + (r.annualUsageKwh ?? 0), 0);
        const portfolioLoadFactor =
          lfWeight > 0 ? lfRows.reduce((a, r) => a + (r.loadFactor ?? 0) * ((r.annualUsageKwh ?? 0) / lfWeight), 0) : null;
        // GAP-M — utility-exposure rollup: per-provider share of annual spend
        // across the portfolio. Sites without a known provider or analyzed cost
        // are grouped honestly under "Unknown" rather than dropped.
        const exposureMap = new Map<string, { annualCostUsd: number; siteCount: number }>();
        for (const r of siteRollups) {
          const key = r.utilityName?.trim() || "Unknown provider";
          const cur = exposureMap.get(key) ?? { annualCostUsd: 0, siteCount: 0 };
          cur.annualCostUsd += r.annualCostUsd ?? 0;
          cur.siteCount += 1;
          exposureMap.set(key, cur);
        }
        const exposureTotal = Array.from(exposureMap.values()).reduce((a, v) => a + v.annualCostUsd, 0);
        // CONF-1 — rate-confidence rollup: how many analyzed sites price their
        // dollars on actual/verified data vs an imputed average. Sites without
        // an analysis are counted separately (unknown), never lumped as imputed.
        const analyzedTiers = siteRollups.filter((r) => r.analyzed);
        const rateConfidence = {
          actualCount: analyzedTiers.filter((r) => r.rateTier === "tariff_priced_actual").length,
          billVerifiedCount: analyzedTiers.filter((r) => r.rateTier === "bill_verified").length,
          imputedCount: analyzedTiers.filter((r) => r.rateTier === "state_average_imputed" || r.rateTier === "national_assumption").length,
          unknownCount: analyzedTiers.filter((r) => r.rateTier == null).length,
        };
        const utilityExposure = Array.from(exposureMap.entries())
          .map(([utility, v]) => ({
            utility,
            siteCount: v.siteCount,
            annualCostUsd: Math.round(v.annualCostUsd),
            sharePct: exposureTotal > 0 ? Math.round((v.annualCostUsd / exposureTotal) * 100) : null,
          }))
          .sort((a, b) => b.annualCostUsd - a.annualCostUsd);
        return {
          entities: allEntities,
          sites: siteRollups,
          utilityExposure,
          rateConfidence,
          totals: {
            siteCount: siteRollups.length,
            analyzedCount: siteRollups.filter((r) => r.analyzed).length,
            annualCostUsd: sum("annualCostUsd"),
            demandCostUsd: sum("demandCostUsd"),
            annualUsageKwh: sum("annualUsageKwh"),
            annualCo2eLb: sum("annualCo2eLb"),
            // NOTE: site peaks are non-coincident — summing them overstates any
            // true coincident portfolio peak; label is explicit about this.
            sumOfSitePeaksKw: sum("peakKw"),
            verifiedSavingsUsd,
            portfolioLoadFactor,
                        openOpportunityUsd: siteRollups.reduce((a, r) => a + (r.topOpportunityUsd ?? 0), 0),
          },
        };
      }),
    /** §3i-2 Bulk site screening (Pro): paste a list of addresses → ranked
     *  archetype-estimate screen. Deterministic (no LLM), hard 50-row cap,
     *  failures named per row. Estimates only — never presented as measured. */
    bulkScreen: protectedProcedure
      .input(
        z.object({
          text: z.string().min(3).max(20_000),
          defaultBuildingType: z.string().min(1).max(64).default("office"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        requireTier(tierOf(ctx.user), "pro", "Bulk site screening");
        const res = await runBulkScreen(input.text, input.defaultBuildingType);
        await h.audit(ctx.user.id, "bulk_screen", "portfolio", "batch", { requested: res.requested, estimated: res.estimated, failed: res.failed });
        return res;
      }),
  }),
  /* ================= uploads / ingestion ================= */
  uploads: router({
    list: protectedProcedure.query(async ({ ctx }) => h.listUploads(ctx.user.id)),
    /** Back out a bad file: removes the upload row, every interval it ingested,
     * and any bills parsed from it. Returns how many intervals were removed so
     * the UI can say exactly what happened. */
    delete: protectedProcedure.input(z.object({ uploadId: z.number() })).mutation(async ({ ctx, input }) => {
      const removedIntervals = await h.deleteUpload(input.uploadId, ctx.user.id);
      await h.audit(ctx.user.id, "upload_delete", "upload", String(input.uploadId), { removedIntervals });
      return { ok: true as const, removedIntervals };
    }),
    /** Interval file ingestion: xlsx | csv | espi_xml (base64 payload). */
    ingest: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          filename: z.string().max(512),
          // "zip" = archive of interval files (Green Button bundles etc.);
          // "auto" = unknown/missing extension — route by content detection.
          format: z.enum(["xlsx", "csv", "espi_xml", "zip", "auto"]),
          // Batch-14 (pass 126): layered size caps — Express json body limit (50mb)
          // rejects oversized payloads BEFORE zod/base64 decode; this zod max
          // (≈50MB decoded: 50MiB × 4/3 base64 expansion ≈ 69.9M chars) matches
          // MAX_UPLOAD_BYTES, and preParseGate re-checks the decoded byte length.
          // A payload that exhausts memory can't reach Buffer.from: Express has
          // already 413'd anything over 50mb on the wire.
          contentBase64: z.string().max(70_000_000),
          commodityHint: z.enum(["electric", "gas", "water"]).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });

        const buf = Buffer.from(input.contentBase64, "base64");
        const gate = preParseGate(buf, input.format);
        if (!gate.ok) throw new TRPCError({ code: "BAD_REQUEST", message: gate.reason ?? "File rejected" });
        // Parser routing is based on the gate-verified DETECTED content type, not
        // the user-supplied format label — a mislabeled upload cannot steer content
        // into a parser that never inspected it (defense-in-depth on top of the gate).
        // ING-2 (owner report Jul 19): "zip" routes through archive extraction —
        // each data-bearing member is content-detected and parsed individually.
        const verifiedFormat: "xlsx" | "csv" | "espi_xml" | "zip" =
          gate.detected === "zip" ? "zip"
          : gate.detected === "xlsx" || gate.detected === "xls" ? "xlsx"
          : gate.detected === "csv_text" ? "csv"
          : "espi_xml";

        const sha256 = createHash("sha256").update(buf).digest("hex");
        const dup = await h.findUploadByHash(ctx.user.id, sha256);
        if (dup && dup.status === "parsed") {
          return { uploadId: dup.id, duplicate: true as const, meters: [], totalPoints: 0, validations: [] };
        }

        const t0 = Date.now();
        // Batch-13 (passes 56/76/86/95): the monthly-quota count and the upload-row
        // insert run under a per-user named lock so concurrent requests cannot all
        // pass the count check before any row exists.
        const uploadId = await h.withUserQuotaLock(ctx.user.id, async () => {
          if (tier === "free") {
            const n = await h.countUploadsThisMonth(ctx.user.id);
            if (n >= FREE_TIER_MAX_UPLOADS_PER_MONTH) {
              throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_MAX_UPLOADS_PER_MONTH} uploads/month.` });
            }
          }
          return h.createUpload({
            userId: ctx.user.id,
            siteId: input.siteId,
            filename: input.filename,
            sha256,
            format: input.format,
            parser: verifiedFormat === "xlsx" ? "excel_build0103" : verifiedFormat === "csv" ? "csv_build0103" : verifiedFormat === "zip" ? "zip_multi" : "espi_xml",
            parserVersion: PARSER_VERSION,
            status: "pending",
          });
        });

        // Store raw file in S3 (source of truth for re-parse). Cycle 3, pass 55:
        // a storage failure is disclosed on the upload record (re-parse will not
        // be possible) and logged loudly — never silently swallowed.
        let storageWarning: string | null = null;
        try {
          const put = await storagePut(`uploads/${ctx.user.id}/${uploadId}-${input.filename}`, buf, "application/octet-stream");
          await h.updateUpload(uploadId, { fileKey: put.key, fileUrl: put.url });
        } catch (e) {
          storageWarning = `Raw file could not be durably stored (${e instanceof Error ? e.message : "storage error"}); parsing proceeded but re-parse from source will not be possible.`;
          console.error("[uploads.ingest] storagePut failed for upload", uploadId, e);
        }

        // Cycle 5, pass 195: XXE gate runs BEFORE any parse work is scheduled —
        // hostile DOCTYPE/ENTITY payloads are rejected up front rather than
        // relying on the gate inside the timeout-wrapped parser.
        if (verifiedFormat === "espi_xml") {
          const xxe = rejectXxe(buf.toString("utf8"));
          if (!xxe.ok) {
            await h.updateUpload(uploadId, { status: "failed", error: xxe.reason });
            throw new TRPCError({ code: "BAD_REQUEST", message: xxe.reason ?? "XML rejected (XXE protection)" });
          }
        }
        // Zip path: extract members, then parse each data-bearing member through
        // the SAME parser family the single-file path uses. Skipped members
        // (stylesheets, OS metadata) are disclosed in the validation notes.
        const memberNotes: string[] = [];
        let series: ParsedMeterSeries[] = [];
        try {
          series = await withParseTimeout(() => {
            if (verifiedFormat === "zip") {
              const zx = extractZipMembers(buf);
              if (!zx.ok) throw new Error(zx.reason ?? "Could not read the zip archive");
              const all: ParsedMeterSeries[] = [];
              for (const m of zx.members) {
                const base = m.name.split("/").pop() ?? m.name;
                if (m.route === null) {
                  memberNotes.push(`Skipped "${base}": ${m.skipReason}`);
                  continue;
                }
                if (m.route === "espi_xml") {
                  const xxe = rejectXxe(m.bytes.toString("utf8"));
                  if (!xxe.ok) throw new Error(`"${base}": ${xxe.reason}`);
                }
                const parsed =
                  m.route === "xlsx" ? parseExcelIntervals(m.bytes)
                  : m.route === "csv" ? parseCsvIntervals(m.bytes.toString("utf8"), base)
                  : parseEspiXml(m.bytes.toString("utf8"));
                if (parsed.length === 0 || parsed.every((s) => s.points.length === 0)) {
                  memberNotes.push(`"${base}": no interval data recognized`);
                  continue;
                }
                // Prefix series keys with the member name so multi-file archives
                // produce distinguishable meter labels (single-member bundles keep
                // the parser's own label — usually the sheet/usage-point name).
                for (const s of parsed) {
                  all.push(zx.members.filter((x: { route: unknown }) => x.route !== null).length > 1 ? { ...s, sourceKey: `${base}: ${s.sourceKey}` } : s);
                }
                memberNotes.push(`Parsed "${base}" (${m.route === "espi_xml" ? "Green Button XML" : m.route})`);
              }
              return all;
            }
            if (verifiedFormat === "xlsx") return parseExcelIntervals(buf);
            if (verifiedFormat === "csv") return parseCsvIntervals(buf.toString("utf8"), input.filename);
            return parseEspiXml(buf.toString("utf8"));
          }, `parse_${verifiedFormat}`);
                } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await h.updateUpload(uploadId, { status: "failed", error: msg });
          // v1.20 block E: the user this failed for becomes a coverage-matrix
          // candidate — situation fingerprint only, no PII, userId not stored.
          await emitDeadEndPersona({ deadEnd: `parse_failed_${verifiedFormat}` });
          throw new TRPCError({ code: "BAD_REQUEST", message: `Parse failed: ${msg}` });
        }
        if (series.length === 0 || series.every((s) => s.points.length === 0)) {
          // LGE-4: disclose the header row we saw so unrecognized layouts are
          // self-diagnosing (user + owner can see exactly which columns failed
          // to match instead of a bare "no data" verdict).
          let headerHint = "";
          if (verifiedFormat === "csv") {
            const firstLines = buf.toString("utf8", 0, Math.min(buf.length, 4096)).split(/\r?\n/).filter((l) => l.trim()).slice(0, 2);
            if (firstLines.length > 0) headerHint = ` First row seen: "${firstLines[0].slice(0, 200)}".`;
          }
          const detail = (memberNotes.length > 0 ? ` (${memberNotes.join("; ")})` : "") + headerHint;
          await h.updateUpload(uploadId, { status: "failed", error: `No interval data found in file${detail}`.slice(0, 1024) });
          await emitDeadEndPersona({ deadEnd: `empty_file_${verifiedFormat}` });
          throw new TRPCError({ code: "BAD_REQUEST", message: `No interval data recognized in this file.${detail}`.slice(0, 1024) });
        }
        // Surface member-level dispositions on every parsed series' notes.
        if (memberNotes.length > 0) {
          for (const s of series) s.validation.notes.push(...memberNotes);
        }

        // one meter per parsed series (sheet/UsagePoint)
        const existing = await h.listMeters(input.siteId, ctx.user.id);
        const out: Array<{ meterId: number; label: string; points: number; validationPass: boolean }> = [];
        let totalIn = 0;
        let totalSkip = 0;
        // Cycle 1 pass 16: a mid-loop write failure must not leave the upload
        // marked 'parsed' — catch, record the partial-write state, and fail.
        try {
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
                  // Cycle 3, passes 36/66: timezone derived from the site's
                  // state, never hardcoded.
                  timezone: tzForState(site.state),
                },
                ctx.user.id,
              );
              meter = (await h.listMeters(input.siteId, ctx.user.id)).find((m) => m.id === meterId)!;
              // Batch-37 (pass 1505): file-upload meters in split-timezone
              // states get the SAME ambiguity disclosure as quick-start and
              // bill-entry meters (Batch-24) — a FL-panhandle upload must not
              // be silently pinned to America/New_York when TOU/demand windows
              // could shift by an hour.
              const uploadTzNote = tzAmbiguityNote(site.state);
              if (uploadTzNote) {
                await h.addInsight({
                  siteId: input.siteId,
                  kind: "data_coverage",
                  title: "Meter timezone assumption — verify if incorrect for this site",
                  body: uploadTzNote.body,
                  severity: uploadTzNote.severity,
                  confidence: uploadTzNote.confidence,
                  provenance: { method: "tz_state_inference_v1", state: site.state, meterId: meter.id, source: "file_upload" },
                  metrics: null,
                });
              }
            }
            const db = (await getDb())!;
            const w = await writeIntervals(db, meter.id, s, uploadId, 2);
            totalIn += s.rowsIngested;
            totalSkip += s.rowsSkipped;
            out.push({ meterId: meter.id, label, points: w.inserted + w.replaced, validationPass: s.validation.pass });
          }
        } catch (writeErr) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          await h.updateUpload(uploadId, {
            status: "failed",
            error: `Interval write failed after ${out.length} of ${series.length} series were written: ${msg}`,
            rowsIngested: totalIn,
            rowsSkipped: totalSkip,
          });
          await recordMeterEvent({ userId: ctx.user.id, kind: `parse_${input.format}`, computeMs: Date.now() - t0, tier });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "File parsed but interval storage failed partway — no analysis will use partial data until re-upload succeeds." });
        }

        await h.updateUpload(uploadId, {
          status: "parsed",
          rowsIngested: totalIn,
          rowsSkipped: totalSkip,
          sheetsFound: series.length,
          parseConfidence: series.every((s) => s.validation.pass) ? 1 : 0.8,
          footerTotals: series.map((s) => s.footerTotals),
          validation: storageWarning
            ? [...series.map((s) => ({ ...s.validation, notes: [...s.validation.notes, storageWarning] }))]
            : series.map((s) => s.validation),
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
        // v1.22 parser-drift monitor: per-template (LLM extractor) success
        // tracking — sustained drops raise a template-update task before users
        // feel it. Fail-open: telemetry must never break ingest.
        await recordParseOutcome("llm_bill_extractor_v1", outcome.status === "extracted").catch(() => undefined);
        // v1.22 unknown-tariff crowd discovery: a parsed rate-schedule name that
        // matches no record we carry aggregates across users; N≥3 occurrences
        // at one utility raises a create-template task.
        if (outcome.status === "extracted") {
          const rawName = outcome.bill.rateScheduleName?.value?.trim();
          const rawUtility = outcome.bill.utilityName?.value?.trim();
          if (rawName && rawUtility) {
            const known = await h.findTariffByName(rawUtility, rawName).catch(() => null);
            if (!known) await recordUnknownTariff(rawUtility, rawName).catch(() => undefined);
          }
        }
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
          /** GAP-G §2.6 — estimated meter reads: utilities sometimes bill on an
           * estimated read and true-up later; usage shifts between months. */
          readType: z.enum(["actual", "estimated"]).default("actual"),
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
            readType: input.readType,
          },
          ctx.user.id,
        );
        await maybeReconcileBill(id.id, input.meterId, ctx.user.id);
        // BILL (Jul 19): a saved bill is conclusive service evidence — stamp
        // the site's services profile via the meter's commodity (never
        // downgrades a user override; contradictions surface as insights).
        try {
          const meter = await h.getMeter(input.meterId, ctx.user.id);
          if (meter) {
            const { noteBillEvidence } = await import("./commodityService");
            await noteBillEvidence(meter.siteId, ctx.user.id, meter.commodity as "electric" | "gas" | "water");
          }
        } catch {
          /* evidence stamping never fails a bill save */
        }
        return { id };
      }),
    /** Progressive participation (Jul 2026): persist a bill against a SITE that
     *  may not have a meter yet (quick-start bill-first entry). Lazily creates
     *  a bill-entry meter so OCR output is never discarded. */
    createForSite: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          periodStart: z.string(),
          periodEnd: z.string(),
          totalUsage: z.number(),
          usageUnit: z.string().max(16).default("kWh"),
          billedDemandKw: z.number().nullable().optional(),
          totalCostUsd: z.number(),
          source: z.enum(["manual", "parsed_pdf", "parsed_image"]).default("parsed_image"),
          readType: z.enum(["actual", "estimated"]).default("actual"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const site = await h.getSite(input.siteId, ctx.user.id);
        const meters = await h.listMeters(input.siteId, ctx.user.id);
        let meter = meters.find((m) => m.commodity === "electric") ?? meters[0] ?? null;
        if (!meter) {
          const meterId = await h.createMeter(
            {
              siteId: input.siteId,
              userId: ctx.user.id,
              commodity: "electric",
              label: "Bill entry",
              usageUnit: input.usageUnit,
              demandUnit: "kW",
              timezone: tzForState(site.state),
            },
            ctx.user.id,
          );
          meter = (await h.listMeters(input.siteId, ctx.user.id)).find((m) => m.id === meterId)!;
          // Batch-24 (passes 846/856): lazily created bill-entry meters in
          // split-timezone states carry the same ambiguity disclosure as
          // quick-start sites — never a silent dominant-zone assignment.
          const billTzNote = tzAmbiguityNote(site.state);
          if (billTzNote) {
            await h.addInsight({
              siteId: input.siteId,
              kind: "data_coverage",
              title: "Meter timezone assumption — verify if incorrect for this site",
              body: billTzNote.body,
              severity: billTzNote.severity,
              confidence: billTzNote.confidence,
              provenance: { method: "tz_state_inference_v1", state: site.state, meterId: meter.id },
              metrics: null,
            });
          }
        }
        const id = await h.createBill(
          {
            meterId: meter.id,
            periodStart: new Date(input.periodStart),
            periodEnd: new Date(input.periodEnd),
            usage: input.totalUsage,
            demandBilled: input.billedDemandKw ?? null,
            demandBilledSource: input.billedDemandKw != null ? "parsed_bill" : null,
            totalCost: input.totalCostUsd,
            source: input.source,
            readType: input.readType,
          },
          ctx.user.id,
        );
        await h.audit(ctx.user.id, "bill_created", "bill", String(id), { siteId: input.siteId, quickStart: true });
        await maybeReconcileBill(id.id, meter.id, ctx.user.id);
        // BILL (Jul 19): a saved bill is conclusive service evidence. The
        // quick-start path may lack a typed meter, so the bill's own usage
        // unit decides the commodity (therms/ccf → gas, gal/kgal → water).
        try {
          const u = input.usageUnit.toLowerCase();
          const commodity = /therm|ccf|mcf|dth/.test(u)
            ? ("gas" as const)
            : /gal|ccf_water|hcf/.test(u)
              ? ("water" as const)
              : ((meter.commodity as "electric" | "gas" | "water") ?? ("electric" as const));
          const { noteBillEvidence } = await import("./commodityService");
          await noteBillEvidence(input.siteId, ctx.user.id, commodity);
        } catch {
          /* evidence stamping never fails a bill save */
        }
        return { id, meterId: meter.id };
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
    /* §3h processing as proof-of-work — poll the running analysis and surface
       the pipeline's real narration lines (written incrementally by narrate()).
       No theatrical stages: this returns exactly what the engine has done. */
    progress: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      const a = await h.getLatestAnalysis(input.siteId, ctx.user.id);
      if (!a) return null;
      return {
        analysisId: a.id,
        status: a.status,
        narration: Array.isArray(a.stagesCompleted) ? (a.stagesCompleted as string[]) : [],
        error: a.error ?? null,
      };
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
    /* §3i-2 "one address, three utilities" — per-commodity provider registry
       derived from the seeded tariff snapshot for a state. Honesty: this lists
       providers WE HAVE RATES FOR, not a claim of who actually serves the
       address — the copy must say "rates loaded", not "your utility is". */
    utilitiesForState: protectedProcedure.input(z.object({ state: z.string() })).query(async ({ input }) => {
      await seeded();
      const rows = await h.listTariffs(undefined, input.state.toUpperCase());
      const byCommodity: Record<"electric" | "gas" | "water", string[]> = { electric: [], gas: [], water: [] };
      for (const t of rows) {
        const c = t.commodity as "electric" | "gas" | "water";
        if (!byCommodity[c].includes(t.utilityName)) byCommodity[c].push(t.utilityName);
      }
      return {
        state: input.state.toUpperCase(),
        electric: byCommodity.electric,
        gas: byCommodity.gas,
        water: byCommodity.water,
        rateCount: rows.length,
      };
    }),
    list: protectedProcedure
      .input(z.object({ state: z.string().optional(), commodity: z.enum(["electric", "gas", "water"]).optional() }).optional())
      .query(async ({ input }) => {
        await seeded();
        const rows = await h.listTariffs(input?.commodity, input?.state);
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

  /* ================= §3e prove-it loop ================= */
  proveIt: router({
    /** Mark a measure as implemented — the "I did this" action. */
    mark: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          opportunityId: z.number().optional(),
          measure: z.string().min(1).max(128),
          title: z.string().min(1).max(512),
          implementedAt: z.number(), // ms epoch, user-declared
          expectedSavingsUsd: z.number().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.implementedAt > Date.now() + 86_400_000) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Implementation date cannot be in the future" });
        }
        const id = await h.createMeasureImplementation({
          userId: ctx.user.id,
          siteId: input.siteId,
          opportunityId: input.opportunityId ?? null,
          measure: input.measure,
          title: input.title,
          implementedAt: input.implementedAt,
          expectedSavingsUsd: input.expectedSavingsUsd ?? null,
          status: "awaiting_data",
        });
        await h.audit(ctx.user.id, "measure_marked_implemented", "measure_implementation", String(id), {
          siteId: input.siteId,
          measure: input.measure,
          implementedAt: input.implementedAt,
        });
        return { id };
      }),

    list: protectedProcedure
      .input(z.object({ siteId: z.number() }))
      .query(async ({ ctx, input }) => h.listMeasureImplementations(input.siteId, ctx.user.id)),

    /** Total verified savings across all the user's implementations (greeting counter). */
    verifiedTotal: protectedProcedure.query(async ({ ctx }) => ({
      totalUsd: await h.totalVerifiedSavings(ctx.user.id),
    })),

    remove: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteMeasureImplementation(input.id, ctx.user.id);
      return { ok: true };
    }),

    /** Re-evaluate one implementation against post-date actuals vs counterfactual baseline. */
    evaluate: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const impl = await h.getMeasureImplementation(input.id, ctx.user.id);
      const site = await h.getSite(impl.siteId, ctx.user.id);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });

      // main electric meter (aggregation physics — submeters would double-count)
      const siteMeters = await h.listMeters(impl.siteId, ctx.user.id);
      const meter = siteMeters.find((m) => m.commodity === "electric" && m.meterRole === "main") ?? siteMeters.find((m) => m.commodity === "electric") ?? null;

      const evaluatedAt = Date.now();
      // AC12 occupancy re-base: verdicts are attributed to the occupancy period
      // in effect at implementation time. If the site's occupancy changed AFTER
      // this measure went in, the verdicts issued before the change keep their
      // period label — they are never silently re-based to the new occupancy.
      const occChanged = site.occupancyChangedAt ?? null;
      const occupancyPeriod =
        occChanged == null
          ? "baseline"
          : impl.implementedAt < occChanged
            ? `pre-${new Date(occChanged).toISOString().slice(0, 7)}`
            : `post-${new Date(occChanged).toISOString().slice(0, 7)}`;
      const persistAndReturn = async (result: ReturnType<typeof evaluateImplementation>) => {
        // AC12 model pinning: verdicts already issued under an older engine are
        // not silently re-scored — a version change is disclosed on the result.
        if (impl.engineVersion && impl.engineVersion !== ENGINE_VERSION) {
          result.disclosures.push(
            `Analytics engine updated since these verdicts were first issued (${impl.engineVersion} → ${ENGINE_VERSION}). Past monthly verdicts keep their original scoring; only new months use the current engine.`,
          );
        }
        if (occChanged != null && impl.implementedAt < occChanged) {
          result.disclosures.push(
            `Occupancy changed on ${new Date(occChanged).toLocaleDateString()} — months after that date are compared against a shifted usage pattern and are scored conservatively rather than re-based.`,
          );
        }
        await h.updateMeasureVerdicts(input.id, ctx.user.id, {
          status: result.status,
          verdicts: result.monthVerdicts,
          verifiedSavingsUsd: result.verifiedSavingsUsd,
          lastEvaluatedAt: evaluatedAt,
          engineVersion: impl.engineVersion ?? ENGINE_VERSION,
          occupancyPeriod,
        });
        return { ...result, lastEvaluatedAt: evaluatedAt };
      };

      if (!meter) {
        // Owner directive (Jul 19): actual as able, imputed where required,
        // notated accordingly — no meter means no actual rate, so impute the
        // site's state-average commercial rate (EIA-861 2024) and say so;
        // only fall to the $0.12 national assumption when the state is unknown.
        const sp = site.state ? STATE_PROFILES.find((p) => p.state === site.state) : null;
        const imputedRate = sp ? sp.commRateCents / 100 : 0.12;
        const empty = evaluateImplementation([], null, imputedRate, impl.expectedSavingsUsd ?? null);
        empty.disclosures.push("No electric meter with interval data exists on this site yet — add data to start the verification clock.");
        empty.disclosures.push(
          sp
            ? `Dollar figures use the ${sp.state} state-average commercial rate ($${(sp.commRateCents / 100).toFixed(3)}/kWh, EIA-861 2024 — state-average imputed) until your meter provides an actual rate.`
            : "Dollar figures use a $0.12/kWh national-average assumption — no state on file to impute a closer rate.",
        );
        return persistAndReturn(empty);
      }

      // post-implementation actuals
      const points = await h.getIntervalPoints(meter.id, ctx.user.id, impl.implementedAt - 40 * 86_400_000);
      // counterfactual: latest fitted baseline coefficients + climate-zone normals
      const baselineRow = await h.getLatestBaseline(impl.siteId, ctx.user.id);
      const coeffs = (baselineRow?.params ?? null) as {
        baseloadPerDay: number;
        coolingSlope: number;
        heatingSlope: number;
        coolingBalanceF: number;
        heatingBalanceF: number;
      } | null;
      const climateZone = site.climateZone ?? "4A";
      const station = await h.getWeatherStation(climateZone);
      const normals = (station?.monthlyNormals ?? []) as Array<{ month: number; hddBase65: number; cddBase65: number; avgTempF: number }>;
      const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

      const expectedKwhByMonth = (monthKey: string): number | null => {
        if (!coeffs || normals.length === 0) return null;
        const mi = parseInt(monthKey.split("-")[1], 10) - 1;
        const nrm = normals[mi];
        if (!nrm) return null;
        const days = daysInMonth[mi];
        const cddPerDay = Math.max(0, nrm.avgTempF - coeffs.coolingBalanceF);
        const hddPerDay = Math.max(0, coeffs.heatingBalanceF - nrm.avgTempF);
        const perDay = coeffs.baseloadPerDay + coeffs.coolingSlope * cddPerDay + coeffs.heatingSlope * hddPerDay;
        return Math.max(0, perDay * days);
      };

      const fit = baselineRow
        ? ({
            method: "caltrack_monthly",
            coefficients: coeffs!,
            rSquared: baselineRow.rSquared,
            cvrmse: baselineRow.cvrmse,
            monthsCoverage: 0,
            confidence: "medium",
            confidenceLabel: "",
            weatherBasis: "",
            normalizedAnnualUsage: 0,
            disclosures: [],
          } as BaselineFit)
        : null;

      // blended rate from the latest analysis summary insight (all-in $/kWh).
      // Actual-first ladder: real blended rate (below) → state-average imputed
      // (EIA-861 2024 via STATE_PROFILES) → national assumption as true last resort.
      const mvProf = site.state ? STATE_PROFILES.find((p) => p.state === site.state) : null;
      const mvSector = site.buildingType && ["single_family", "multifamily"].includes(site.buildingType) ? "residential" : "commercial";
      const mvStateCents = mvProf ? (mvSector === "residential" ? mvProf.resRateCents : mvProf.commRateCents) : null;
      let blendedRate = mvStateCents && mvStateCents > 0 ? mvStateCents / 100 : 0.12;
      let rateDisclosure =
        mvStateCents && mvStateCents > 0
          ? `Priced at the ${site.state} state-average ${mvSector} rate ($${(mvStateCents / 100).toFixed(3)}/kWh, EIA-861 2024 — state-average imputed) — run an analysis with a tariff to use your real blended rate.`
          : "Priced at a $0.12/kWh national-average assumption — no state on file to impute a closer rate; run an analysis with a tariff to use your real blended rate.";
      // NEXT-1 (calibrate to my bill): real bills on file beat any imputation —
      // upgrade the tier before the analysis-summary rate (which itself wins below).
      const mvBillVerified = await deriveBillVerifiedRate(impl.siteId, ctx.user.id, "electric");
      if (mvBillVerified) {
        blendedRate = mvBillVerified.rate;
        rateDisclosure = `Priced at ${mvBillVerified.basis} — verified savings scale with the rate actually paid.`;
      }
      const siteInsights = await h.listInsights(impl.siteId, ctx.user.id);
      const summary = [...siteInsights].reverse().find((i) => i.kind === "summary");
      const summaryMetrics = (summary?.metrics ?? null) as { currentCost?: { breakdown?: { total?: number; energyKwh?: number } } } | null;
      const cc = summaryMetrics?.currentCost as { breakdown?: { total?: number }; monthlyCosts?: Array<{ total: number }> } | undefined;
      const intervalKwh = points.filter((p) => p.usage > 0).reduce((s, p) => s + p.usage, 0);
      if (cc?.breakdown?.total && intervalKwh > 0) {
        // window totals: use total cost over the full-history import kWh where available
        const allPoints = await h.getIntervalPoints(meter.id, ctx.user.id);
        const allImportKwh = allPoints.filter((p) => p.usage > 0).reduce((s, p) => s + p.usage, 0);
        if (allImportKwh > 0) {
          const r = cc.breakdown.total / allImportKwh;
          if (Number.isFinite(r) && r > 0) {
            blendedRate = r;
            rateDisclosure = `Priced at your blended all-in rate ($${r.toFixed(3)}/kWh) from the latest analysis — not a bill-exact re-price.`;
          }
        }
      }

      const tz = meter.timezone ?? "America/Phoenix";
      const months = buildMonthlyActuals(
        points.map((p) => ({ ts: p.ts, usage: p.usage })),
        impl.implementedAt,
        expectedKwhByMonth,
        tz,
        evaluatedAt,
      );
      const result = evaluateImplementation(months, fit, blendedRate, impl.expectedSavingsUsd ?? null);
      result.disclosures.push(rateDisclosure);
      // §2.6 estimated reads: if any bill overlapping the evaluation window was
      // billed on an ESTIMATED meter read, the months it touches are disclosed —
      // an estimated read can shift usage between adjacent months and produce a
      // phantom saving/regression that reverses when the true-up bill lands.
      const siteBills = await h.listBills(impl.siteId, ctx.user.id);
      const estimatedBills = siteBills.filter(
        (b) => b.readType === "estimated" && new Date(b.periodEnd).getTime() >= impl.implementedAt,
      );
      if (estimatedBills.length > 0) {
        const monthsTouched = Array.from(new Set(estimatedBills.map((b) => String(b.periodEnd).slice(0, 7)))).join(", ");
        result.disclosures.push(
          `${estimatedBills.length} bill${estimatedBills.length === 1 ? " was" : "s were"} issued on an estimated meter read (${monthsTouched}). Estimated reads can shift usage between months — verdicts for those months may move when the utility trues up.`,
        );
      }
      if (!coeffs || normals.length === 0) {
        result.disclosures.push(
          "No fitted counterfactual baseline exists for this site — months cannot be evaluated until an analysis with ≥4 months of usage history has run.",
        );
      }
      await h.audit(ctx.user.id, "measure_evaluated", "measure_implementation", String(input.id), {
        status: result.status,
        months: result.monthVerdicts.length,
        verifiedSavingsUsd: result.verifiedSavingsUsd,
      });
      return persistAndReturn(result);
    }),
  }),
  /* ================= scenarios ================= */
  scenariosApi: router({
    list: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => h.listScenarios(input.siteId, ctx.user.id)),
    rename: protectedProcedure
      .input(z.object({ scenarioId: z.number(), name: z.string().min(1).max(255) }))
      .mutation(async ({ ctx, input }) => {
        await h.renameScenario(input.scenarioId, ctx.user.id, input.name);
        return { ok: true as const };
      }),
    delete: protectedProcedure.input(z.object({ scenarioId: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deleteScenario(input.scenarioId, ctx.user.id);
      return { ok: true as const };
    }),
    run: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          name: z.string().max(255),
          kind: z.enum(["solar", "battery", "solar_battery", "efficiency", "ev_load", "gas_efficiency", "water_efficiency"]),
          solarKwDc: z.number().positive().max(100_000).optional(),
          batteryKwh: z.number().positive().max(1_000_000).optional(),
          batteryKw: z.number().positive().max(500_000).optional(),
          efficiencyReductions: z.record(z.string(), z.number().min(0).max(0.9)).optional(),
          evAnnualKwh: z.number().positive().max(10_000_000).optional(),
          // Batch-25 (pass 865): min(0), not positive() — capexUsd=0 is a valid
          // no-capex scenario (Batch-18 gives it paybackYears=0, "immediate — no
          // upfront cost"); positive() silently rejected it at the API boundary.
          capexUsd: z.number().min(0).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        // Tier gates: solar/battery modeling = Plus features (free teaser insight only)
        if (["solar", "battery", "solar_battery"].includes(input.kind)) requireTier(tier, "plus", "Solar/battery scenario modeling");
        // Batch-13: fast-fail pre-check only; the authoritative quota check runs
        // under the per-user lock at save time (see below) so concurrent runs
        // cannot all pass a count taken before any row exists.
        if (tier === "free") {
          const n = await h.countScenariosThisMonth(ctx.user.id);
          if (n >= FREE_TIER_SCENARIOS_PER_MONTH) {
            throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_SCENARIOS_PER_MONTH} scenario runs/month.` });
          }
        }
                const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
        /* ---- Gas/water efficiency: commodity-native path (no electric 8760 machinery) ---- */
        if (input.kind === "gas_efficiency" || input.kind === "water_efficiency") {
          const commodity = input.kind === "gas_efficiency" ? ("gas" as const) : ("water" as const);
          const reduction = input.efficiencyReductions?.overall ?? 0.1;
          const t0gw = Date.now();
          const gw = await runCommodityEfficiency({
            site,
            userId: ctx.user.id,
            commodity,
            reduction,
            capexUsd: input.capexUsd,
          });
          const idGw = await h.withUserQuotaLock(ctx.user.id, async () => {
            if (tier === "free") {
              const n = await h.countScenariosThisMonth(ctx.user.id);
              if (n >= FREE_TIER_SCENARIOS_PER_MONTH) {
                throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_SCENARIOS_PER_MONTH} scenario runs/month.` });
              }
            }
            return h.saveScenario({
              siteId: site.id,
              userId: ctx.user.id,
              name: input.name,
              transform: input.kind as "gas_efficiency" | "water_efficiency",
              params: { kind: input.kind, reduction, capexUsd: input.capexUsd } as unknown as Record<string, unknown>,
              loadBasis: gw.loadBasis,
              results: gw.results as unknown as Record<string, unknown>,
              status: "complete",
              confidenceLabel: gw.results.confidenceLabel,
              extrapolated: gw.results.extrapolated,
            });
          });
          await recordMeterEvent({ userId: ctx.user.id, kind: "scenario_run", computeMs: Date.now() - t0gw, tier });
          await h.audit(ctx.user.id, "scenario_run", "scenario", String(idGw), { kind: input.kind, siteId: site.id });
          return { id: idGw, results: gw.results };
        }
        // Build baseline hourly profile: measured intervals if available, else archetype
        const { hourly, loadBasis, confidence, extrapolated, structure, co2eLbPerMwh, climateZone, tariffBasisDisclosure, archetypeZoneDisclosure, nem } = await buildScenarioBasis(site, ctx.user.id);
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
        const results = runScenario(hourly, scenarioInput, structure, climateZone, co2eLbPerMwh, confidence, extrapolated, nem);
        // AC15 — incentives layer: attach live (never-expired) incentive matches
        // with pre- AND post-incentive paybacks, named sources, and who-pays/
        // who-benefits. Tenure-honest: renters never see owner-only credits.
        try {
          const measureKey = input.kind === "solar_battery" ? "solar" : input.kind === "efficiency" ? "led_retrofit" : input.kind;
          const annualSavings = Math.max(0, -((results as unknown as { siteTotalDeltaCost?: number }).siteTotalDeltaCost ?? 0));
          // Implementer economics: first-year unit savings per commodity feed
          // usd_per_unit_saved custom-program rebates ($/kWh, $/therm). Only
          // genuine reductions count — added load (EV) never nets a rebate.
          const unitsSavedAnnual: Partial<Record<"electric" | "gas" | "water", number>> = {};
          for (const [cmd, pc] of Object.entries(results.perCommodity ?? {})) {
            const saved = Math.max(0, -((pc as { deltaUsage?: number }).deltaUsage ?? 0));
            if (saved > 0) unitsSavedAnnual[cmd as "electric" | "gas" | "water"] = Math.round(saved);
          }
          const incEcon = await incentiveEconomics({
            measureKey,
            state: site.state ?? null,
            utilityName: site.utilityName ?? null,
            sectorClass:
              site.buildingType && ["single_family", "multifamily"].includes(site.buildingType) ? ("residential" as const) : ("commercial" as const),
            capexUsd: input.capexUsd ?? 0,
            annualSavingsUsd: annualSavings,
            unitsSavedAnnual,
            tenure: site.tenure ?? null,
          });
          (results as unknown as Record<string, unknown>).implementerSavings = {
            unitsSavedAnnual,
            note: "First-year modeled unit savings by commodity — the figures custom rebate programs ($/kWh, $/therm) pay on. Verify with M&V before filing.",
          };
          if (incEcon.matches.length) {
            (results as unknown as Record<string, unknown>).incentives = incEcon;
            results.disclosures.push(
              `Incentives: ${incEcon.matches.map((m) => m.name).join("; ")} — payback shown both before (${incEcon.paybackPreYears ?? "n/a"} yr) and after (${incEcon.paybackPostYears ?? "n/a"} yr) incentives. ${incEcon.matches[0].disclosure}`,
            );
          }
        } catch (e) {
          console.warn("[incentives] skipped:", e instanceof Error ? e.message : String(e));
        }
        if (tariffBasisDisclosure) results.disclosures.push(tariffBasisDisclosure);
        if (archetypeZoneDisclosure) results.disclosures.push(archetypeZoneDisclosure);
        if (loadBasis === "archetype_scaled") {
          // v1.6 convergence (pass 41): demand-charge and ratchet exposure on a
          // typical archetype shape is only as accurate as its peak fidelity.
          results.disclosures.push(
            "Demand charges and ratchet exposure are estimated from a typical archetype load shape (ratchet basis: archetype-derived, not measured) — actual exposure may differ materially.",
          );
          (results.assumptions as Record<string, unknown>).ratchetConfidence = "archetype_derived";
        } else {
          (results.assumptions as Record<string, unknown>).ratchetConfidence = "measured";
        }
        const id = await h.withUserQuotaLock(ctx.user.id, async () => {
          if (tier === "free") {
            const n = await h.countScenariosThisMonth(ctx.user.id);
            if (n >= FREE_TIER_SCENARIOS_PER_MONTH) {
              throw new TRPCError({ code: "FORBIDDEN", message: `Free tier allows ${FREE_TIER_SCENARIOS_PER_MONTH} scenario runs/month.` });
            }
          }
          return h.saveScenario({
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
        });
        // Batch-33 (pass 1225): metering stays AFTER the quota-locked save — a
        // failed save must never consume quota. (Verified ordering; the LLM/
        // compute meter events inside the pipeline are cost-metering, not
        // scenario-quota events.)
                await recordMeterEvent({ userId: ctx.user.id, kind: "scenario_run", computeMs: Date.now() - t0, tier });
        await h.audit(ctx.user.id, "scenario_run", "scenario", String(id), { kind: input.kind, siteId: site.id });
        return { id, results };
      }),
    /* ---- Bill Builder (UX addendum §3c): composed what-if across measures ---- */
    presets: protectedProcedure.input(z.object({ siteId: z.number() })).query(async ({ ctx, input }) => {
      await seeded();
      const site = await h.getSite(input.siteId, ctx.user.id);
      if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
      const endUse = await endUseForSite(site);
      return presetBaskets(site.sqft, endUse?.fractions);
    }),
    compose: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          measures: z
            .array(
              z.object({
                key: z.string().max(64),
                label: z.string().max(255),
                kind: z.enum(["efficiency", "solar", "battery"]),
                solarKwDc: z.number().positive().max(100_000).optional(),
                batteryKwh: z.number().positive().max(1_000_000).optional(),
                batteryKw: z.number().positive().max(500_000).optional(),
                efficiencyReductions: z.record(z.string(), z.number().min(0).max(0.9)).optional(),
                capexUsd: z.number().min(0).optional(),
              }),
            )
            .min(1)
            .max(12),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        // §3c conversion rule: free tier composes up to 3 measures; the full
        // basket is the Plus unlock at the moment of demonstrated value.
        if (tier === "free" && input.measures.length > 3) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Free tier composes up to 3 measures — upgrade to Plus for the full basket." });
        }
        // Solar/battery measures are Plus features, consistent with scenariosApi.run.
        if (input.measures.some((m) => m.kind === "solar" || m.kind === "battery")) {
          requireTier(tier, "plus", "Solar/battery plan composition");
        }
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
        const basis = await buildScenarioBasis(site, ctx.user.id);
        const endUse = await endUseForSite(site);
        const sectorClass = site.buildingType && ["single_family", "multifamily"].includes(site.buildingType) ? "residential" : "commercial";
        const t0 = Date.now();
        const result = composeMeasures(
          basis.hourly,
          input.measures as PlanMeasure[],
          basis.structure,
          basis.climateZone,
          basis.co2eLbPerMwh,
          basis.confidence,
          basis.extrapolated,
          endUse?.fractions,
          basis.tariffRows.map((t) => ({
            id: t.id,
            name: t.name,
            utilityName: t.utilityName,
            sector: t.sector,
            commodity: t.commodity,
            peakKwMin: t.peakKwMin,
            peakKwMax: t.peakKwMax,
            closedToNew: t.closedToNew,
            techCondition: t.techCondition,
            structure: t.structure as TariffStructure,
            isCurrentBasis: t.id === basis.chosenTariffId,
          })),
          sectorClass,
          site.hasSolar ?? false,
          basis.nem,
        );
        if (basis.tariffBasisDisclosure) result.disclosures.push(basis.tariffBasisDisclosure);
        if (basis.archetypeZoneDisclosure) result.disclosures.push(basis.archetypeZoneDisclosure);
        if (basis.loadBasis === "archetype_scaled") {
          result.disclosures.push(
            "Composed-plan savings are modeled on a typical archetype load shape, not measured data — upload interval data to tighten these figures.",
          );
        }
        // Composition is a modeling call like a scenario run — meter compute,
        // but do NOT consume the monthly scenario quota (nothing is saved; the
        // plan bar re-prices on every toggle and quota-charging each toggle
        // would make the feature unusable).
        await recordMeterEvent({ userId: ctx.user.id, kind: "scenario_run", computeMs: Date.now() - t0, tier });
        return { result, loadBasis: basis.loadBasis };
      }),
    /* ---- §3i-2 portfolio basket: one measure applied across selected sites,
       composed per site through the SAME composeMeasures path, rolled up with
       weakest-chip inheritance. Pro-gated (portfolio surface). ---- */
    portfolioCompose: protectedProcedure
      .input(
        z.object({
          siteIds: z.array(z.number()).min(2).max(25),
          measure: z.object({
            key: z.string().max(64),
            label: z.string().max(255),
            kind: z.enum(["efficiency", "solar", "battery"]),
            solarKwDc: z.number().positive().max(100_000).optional(),
            batteryKwh: z.number().positive().max(1_000_000).optional(),
            batteryKw: z.number().positive().max(500_000).optional(),
            efficiencyReductions: z.record(z.string(), z.number().min(0).max(0.9)).optional(),
            capexUsd: z.number().min(0).optional(),
          }),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        requireTier(tier, "pro", "Portfolio basket (apply a measure across sites)");
        const t0 = Date.now();
        const CONF_RANK = { low: 0, medium: 1, high: 2 } as const;
        const perSite: Array<{
          siteId: number;
          siteName: string;
          ok: boolean;
          reason?: string;
          annualSavingsUsd?: number;
          co2eDeltaLb?: number;
          confidence?: "low" | "medium" | "high";
          loadBasis?: string;
        }> = [];
        for (const siteId of input.siteIds) {
          const site = await h.getSite(siteId, ctx.user.id);
          if (!site) {
            perSite.push({ siteId, siteName: `Site ${siteId}`, ok: false, reason: "Site not found" });
            continue;
          }
          try {
            const basis = await buildScenarioBasis(site, ctx.user.id);
            const endUse = await endUseForSite(site);
            const sectorClass =
              site.buildingType && ["single_family", "multifamily"].includes(site.buildingType)
                ? "residential"
                : "commercial";
            const result = composeMeasures(
              basis.hourly,
              [input.measure as PlanMeasure],
              basis.structure,
              basis.climateZone,
              basis.co2eLbPerMwh,
              basis.confidence,
              basis.extrapolated,
              endUse?.fractions,
              basis.tariffRows.map((t) => ({
                id: t.id,
                name: t.name,
                utilityName: t.utilityName,
                sector: t.sector,
                commodity: t.commodity,
                peakKwMin: t.peakKwMin,
                peakKwMax: t.peakKwMax,
                closedToNew: t.closedToNew,
                techCondition: t.techCondition,
                structure: t.structure as TariffStructure,
                isCurrentBasis: t.id === basis.chosenTariffId,
              })),
              sectorClass,
              site.hasSolar ?? false,
              basis.nem,
            );
            perSite.push({
              siteId,
              siteName: site.name,
              ok: true,
              annualSavingsUsd: result.composedSavings,
              co2eDeltaLb: result.deltaCo2eLb,
              confidence: result.confidence,
              loadBasis: basis.loadBasis,
            });
          } catch (e) {
            // Honesty rule: a site that cannot compose is NAMED with its reason,
            // never silently dropped or zero-filled into the rollup.
            perSite.push({
              siteId,
              siteName: site.name,
              ok: false,
              reason: e instanceof Error ? e.message : "Composition failed",
            });
          }
        }
        const okRows = perSite.filter((r) => r.ok);
        // Weakest-chip inheritance across the whole basket (§3i-2): the rollup
        // is never more confident than its least-confident site.
        const rollupConfidence = okRows.length
          ? okRows.reduce<"low" | "medium" | "high">(
              (acc, r) => (CONF_RANK[r.confidence ?? "low"] < CONF_RANK[acc] ? (r.confidence ?? "low") : acc),
              "high",
            )
          : ("low" as const);
        await recordMeterEvent({ userId: ctx.user.id, kind: "scenario_run", computeMs: Date.now() - t0, tier });
        return {
          perSite,
          rollup: {
            sitesComposed: okRows.length,
            sitesFailed: perSite.length - okRows.length,
            annualSavingsUsd: okRows.reduce((s, r) => s + (r.annualSavingsUsd ?? 0), 0),
            co2eDeltaLb: okRows.reduce((s, r) => s + (r.co2eDeltaLb ?? 0), 0),
            confidence: rollupConfidence,
          },
          disclosure:
            "Portfolio rollup sums per-site composed savings; sites are composed independently (no cross-site interaction modeled). Rollup confidence inherits the weakest site chip." +
            (input.measure.capexUsd != null && input.measure.capexUsd > 0
              ? " Capex shown is a typical-project placeholder applied to EVERY site — real installed costs vary by site size and condition; get quotes before relying on payback."
              : ""),
        };
      }),

    /* ---- §3m plan_baskets: persist a composed plan across sessions ---- */
    saveBasket: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          name: z.string().min(1).max(255),
          measures: z.array(z.object({}).passthrough()).min(1).max(12),
          composedResults: z.object({}).passthrough().nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Persisted plans are a Plus feature, matching the full-basket unlock;
        // free users can still compose transiently up to 3 measures.
        requireTier(tierOf(ctx.user), "plus", "Saving a plan");
        const id = await h.savePlanBasket({
          siteId: input.siteId,
          userId: ctx.user.id,
          name: input.name,
          measures: input.measures,
          composedResults: input.composedResults ?? null,
        });
        return { id };
      }),
    listBaskets: protectedProcedure
      .input(z.object({ siteId: z.number().optional() }))
      .query(async ({ ctx, input }) => h.listPlanBaskets(ctx.user.id, input.siteId)),
    getBasket: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      const row = await h.getPlanBasket(input.id, ctx.user.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
      return row;
    }),
    deleteBasket: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await h.deletePlanBasket(input.id, ctx.user.id);
      return { ok: true };
    }),
  }),
  /* ================= M&V — verified savings (IPMVP Option C) ================= */
  mv: router({
    /** Whole-facility verified savings: CalTRACK baseline on pre-install
     * months, projected over the reporting period. The output rows are the
     * evidence custom rebate programs ($/kWh, $/therm saved) pay on. */
    assess: protectedProcedure
      .input(
        z.object({
          siteId: z.number(),
          meterId: z.number(),
          /** measure in-service date (epoch ms) */
          installedAt: z.number(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const result = await assessMv({ siteId: input.siteId, userId: ctx.user.id, meterId: input.meterId, installedAt: input.installedAt });
        await h.audit(ctx.user.id, "mv_assess", "site", String(input.siteId), { meterId: input.meterId, installedAt: input.installedAt });
        return result;
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
    /** v1.22 S-LIFECYCLE: the freshness ledger — every seeded source with its
     * age vs cadence, plus never-bill-verified tariff findings and open
     * template tasks. Public: staleness is a disclosure, not a secret. */
    dataFreshness: publicProcedure.query(async () => {
      await seeded();
      const [seeds, tariffFindings, templateTasks] = await Promise.all([
        assessSeedFreshness(),
        sweepUnverifiedTariffs(),
        h.listOpenTemplateTasks(),
      ]);
      return { seeds, tariffFindings, templateTasks };
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
  /* ================= §3k Ask Meterly — NL entrance to existing engines ================= */
  ask: router({
    question: protectedProcedure
      .input(z.object({ siteId: z.number(), question: z.string().min(3).max(500) }))
      .mutation(async ({ ctx, input }) => {
        requireTier(tierOf(ctx.user), "plus", "Ask Meterly");
        const site = await h.getSite(input.siteId, ctx.user.id);
        if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });

        // Budget pre-check: routing uses a tiny LLM call; over-budget or
        // unavailable → deterministic keyword router (disclosed in provenance).
        const allowLlm = await llmBudgetAllows(ctx.user.id, tierOf(ctx.user), ASK_ROUTE_EST_COST_USD);
        const route = await routeQuestion(input.question, allowLlm);
        if (route.routedBy === "llm") {
          await recordMeterEvent({ userId: ctx.user.id, kind: "ask_wattwise_route", llmTokensIn: 200, llmTokensOut: 20, tier: tierOf(ctx.user) });
        }
        const routedNote =
          route.routedBy === "llm"
            ? "Question routed by LLM — all figures below come from your stored analysis, never generated text."
            : "Question routed by keyword matching (LLM unavailable or over budget) — all figures come from your stored analysis.";

        // Dispatch: every card's numbers come from stored engine rows.
        const insights = await h.listInsights(input.siteId, ctx.user.id);
        const summaryRow = insights.find((i) => i.kind === "summary");
        const opps = await h.listOpportunities(input.siteId, ctx.user.id);
        const card = await buildAskCard(route.intent, {
          siteId: input.siteId,
          siteName: site.name,
          insights,
          summaryMetrics: (summaryRow?.metrics ?? null) as Record<string, unknown> | null,
          opportunities: opps,
          verifiedTotalUsd: await h.totalVerifiedSavings(ctx.user.id),
        });
        await h.audit(ctx.user.id, "ask_wattwise", "site", String(input.siteId), { question: input.question.slice(0, 200), intent: route.intent, routedBy: route.routedBy });
        return { intent: route.intent, routedBy: route.routedBy, card: { ...card, provenance: [routedNote, ...card.provenance] } };
      }),
  }),
  account: router({
    usage: protectedProcedure.query(async ({ ctx }) => {
      const llmSpend = await monthToDateLlmSpend(ctx.user.id);
      return { tier: tierOf(ctx.user), monthToDateLlmUsd: llmSpend };
    }),
    /** Gap-6 (Jul 2026): self-serve tier switching during the beta — the
     *  pricing page previously showed dead "Coming soon" buttons for tiers
     *  that were already fully enforced server-side (requireTier gates).
     *  During the beta there is NO billing integration, so switching is free
     *  and honestly labeled as such in the UI; the audit trail records every
     *  change. When billing lands, this becomes the checkout entry point. */
    setTier: protectedProcedure
      .input(z.object({ tier: z.enum(["free", "plus", "pro"]) }))
      .mutation(async ({ ctx, input }) => {
        const prev = tierOf(ctx.user);
        await h.setUserTier(ctx.user.id, input.tier);
        // §5b rule 7: beta tier selections are willingness-to-pay signal —
        // capture persona (building types owned) and analysis state alongside
        // the switch so the market-research read is possible later.
        const userSites = await h.listSites(ctx.user.id);
        const buildingTypes = Array.from(new Set(userSites.map((s) => s.buildingType).filter(Boolean)));
        const persona = buildingTypes.length === 0 ? "no_sites_yet" : buildingTypes.every((b) => ["single_family", "multifamily"].includes(b as string)) ? "residential" : "commercial";
        await h.audit(ctx.user.id, "tier_change", "user", String(ctx.user.id), {
          from: prev,
          to: input.tier,
          billing: "none — beta period, no payment collected",
          wtpSignal: {
            persona,
            siteCount: userSites.length,
            buildingTypes,
            hasAnalyzedSite: (await Promise.all(userSites.slice(0, 5).map((s) => h.getLatestAnalysis(s.id, ctx.user.id)))).some(Boolean),
          },
        });
        return { tier: input.tier, previous: prev };
      }),
    exportData: protectedProcedure.mutation(async ({ ctx }) => {
      const data = await h.exportUserData(ctx.user.id);
      await h.audit(ctx.user.id, "data_export", "user", String(ctx.user.id), { tables: Object.keys(data) });
      return data;
    }),
    /** GAP-K (guardrail §8.2) — delete everything. The confirm phrase is
     * enforced server-side (not just a UI nicety); the response states exactly
     * what was removed and what remains (the auth identity row, plus one
     * tombstone audit entry evidencing the deletion). Irreversible. */
    deleteAllData: protectedProcedure
      .input(z.object({ confirmPhrase: z.literal("delete my account") }))
      .mutation(async ({ ctx }) => {
        const result = await h.deleteAllUserData(ctx.user.id);
        return {
          ok: true as const,
          sitesDeleted: result.sitesDeleted,
          note:
            "All your data — sites, meters, readings, bills, analyses, insights, scenarios, uploads, reports, equipment, memberships, and audit history — has been deleted. What remains: your sign-in identity (so you can log in again to an empty account) and a single audit entry recording this deletion. This cannot be undone.",
        };
      }),
    /** §3f lifecycle: digest settings — quiet by default (opt-in), anchored to
     * the user's bill-cycle day. The digest itself (send infra) is future work;
     * the setting is real and persisted so the contract is honest. */
    digestPrefs: protectedProcedure.query(async ({ ctx }) => h.getDigestPrefs(ctx.user.id)),
    setDigestPrefs: protectedProcedure
      .input(z.object({ optIn: z.boolean(), anchorDay: z.number().int().min(1).max(28) }))
      .mutation(async ({ ctx, input }) => {
        await h.setDigestPrefs(ctx.user.id, input.optIn, input.anchorDay);
        await h.audit(ctx.user.id, "digest_prefs", "user", String(ctx.user.id), input);
        // §3f: back the setting with a real Heartbeat cron — monthly on the
        // user's bill-cycle anchor day, 15:00 UTC (morning US time). Cron
        // create/delete failures must not corrupt the saved preference: the
        // pref persists; cron state is reported back for honest UI copy.
        const sessionToken = parseCookieHeader(ctx.req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
        const current = await h.getDigestPrefs(ctx.user.id);
        let cronState: "scheduled" | "removed" | "unchanged" | "error" = "unchanged";
        try {
          if (input.optIn) {
            if (current?.digestCronTaskUid) {
              // re-anchor: drop the old cron, create the new one
              await deleteHeartbeatJob(current.digestCronTaskUid, sessionToken).catch(() => undefined);
            }
            const job = await createHeartbeatJob(
              {
                name: `digest-u${ctx.user.id}`,
                cron: `0 0 15 ${input.anchorDay} * *`,
                path: "/api/scheduled/digest",
                description: `Monthly Meterly digest (bill-cycle day ${input.anchorDay}) — sends only when a material dollar figure exists`,
              },
              sessionToken,
            );
            await h.setDigestCronTaskUid(ctx.user.id, job.taskUid);
            cronState = "scheduled";
          } else if (current?.digestCronTaskUid) {
            await deleteHeartbeatJob(current.digestCronTaskUid, sessionToken).catch(() => undefined);
            await h.setDigestCronTaskUid(ctx.user.id, null);
            cronState = "removed";
          }
        } catch {
          cronState = "error";
        }
        return { ...(await h.getDigestPrefs(ctx.user.id)), cronState };
      }),
    /** Preview what this month's digest WOULD contain — or the honest reason
     * nothing would send (the dollar-figure-or-silence rule, testable). */
    digestPreview: protectedProcedure.query(async ({ ctx }) => {
      const content = await buildDigest(ctx.user.id);
      return content ?? { headlineUsd: 0, headline: "", lines: [], wouldSend: false as const };
    }),
  }),

  /* §3i alerts — dollar-first, quiet-by-default, batched per (site, kind).
   * Generated at analysis time + by the digest cron; in-app only today
   * (external delivery honestly labeled post-beta in the UI). */
  alerts: router({
    list: protectedProcedure
      .input(z.object({ status: z.enum(["open", "read", "dismissed"]).optional() }).optional())
      .query(async ({ ctx, input }) => h.listAlerts(ctx.user.id, input?.status)),
    setStatus: protectedProcedure
      .input(z.object({ id: z.number().int(), status: z.enum(["read", "dismissed"]) }))
      .mutation(async ({ ctx, input }) => {
        const ok = await h.setAlertStatus(input.id, ctx.user.id, input.status);
        if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found" });
        return { ok };
      }),
  }),

  /* §3l reports — three artifacts, one engine, verify tokens */
  reports: router({
    /** §3 Hero 5 — Energy Wrapped: shareable year-in-review card, assembled
     * from persisted rows only. Free-tier accessible (it's a delight/share
     * surface, not a gated report). Null when no analysis exists yet. */
    wrapped: protectedProcedure
      .input(z.object({ siteId: z.number().int() }))
      .query(async ({ ctx, input }) => assembleWrapped(input.siteId, ctx.user.id)),
    /** Assemble report data for preview/print. energy_plan = Plus+; the other two = Pro. */
    data: protectedProcedure
      .input(z.object({ siteId: z.number().int(), kind: z.enum(["energy_plan", "verified_savings", "practitioner"]) }))
      .query(async ({ ctx, input }) => {
        requireTier(tierOf(ctx.user), input.kind === "energy_plan" ? "plus" : "pro", REPORT_FEATURE_NAME[input.kind]);
        return assembleReportData(input.siteId, ctx.user.id);
      }),
    /** Create a report artifact: persists the printed snapshot + verify token.
     * Returns the token — the client renders the print view with the footer
     * verification link (/verify/<token>). */
    generate: protectedProcedure
      .input(z.object({ siteId: z.number().int(), kind: z.enum(["energy_plan", "verified_savings", "practitioner", "site_insights"]) }))
      .mutation(async ({ ctx, input }) => {
        const tierFloor = REPORT_TIER[input.kind];
        if (tierFloor !== "free") requireTier(tierOf(ctx.user), tierFloor, REPORT_FEATURE_NAME[input.kind]);
        const data = await assembleReportData(input.siteId, ctx.user.id);
        const token = newReportToken();
        await h.createReportArtifact({
          userId: ctx.user.id,
          siteId: input.siteId,
          token,
          kind: input.kind,
          snapshot: {
            annualCostUsd: data.annualCostUsd,
            plannedTotalUsd: data.plannedTotalUsd,
            verifiedTotalUsd: data.verifiedTotalUsd,
            measureCount: data.measures.length,
            siteName: data.site.name,
            generatedAt: data.generatedAt,
          },
        });
        await h.audit(ctx.user.id, "report_generate", "site", String(input.siteId), { kind: input.kind, token });
        const csv = input.kind === "practitioner" ? practitionerCsv(data) : null;
        return { token, data, csv };
      }),
    /** GAP-N — ENERGY STAR Portfolio Manager–compatible CSV across every site
     * (Pro). Rows come from persisted summary insights + baselines only; sites
     * without an analysis export with blank figures, never fabricated ones. */
    portfolioExport: protectedProcedure.mutation(async ({ ctx }) => {
      requireTier(tierOf(ctx.user), "pro", "Portfolio Manager export");
      const userSites = await h.listSites(ctx.user.id);
      const rows: PortfolioExportRow[] = [];
      for (const s of userSites) {
        const insightRows = await h.listInsights(s.id, ctx.user.id);
        const summary = insightRows.find((i) => i.kind === "summary");
        const metrics = (summary?.metrics ?? {}) as {
          currentCost?: { total?: number };
          annualUsageKwh?: number;
          usage?: { annualKwh?: number };
        };
        const annualUsageKwh = metrics.annualUsageKwh ?? metrics.usage?.annualKwh ?? null;
        const baselineRow = await h.getLatestBaseline(s.id, ctx.user.id).catch(() => null);
        const params = (baselineRow?.params ?? null) as { confidenceLabel?: string; confidence?: string } | null;
        const impls = await h.listMeasureImplementations(s.id, ctx.user.id);
        rows.push({
          siteId: s.id,
          siteName: s.name,
          buildingType: s.buildingType,
          state: s.state,
          zip: s.zip,
          sqft: s.sqft,
          annualUsageKwh,
          annualCostUsd: metrics.currentCost?.total ?? null,
          euiKwhPerSqft: annualUsageKwh != null && s.sqft ? annualUsageKwh / s.sqft : null,
          euiBasis: params?.confidenceLabel ?? params?.confidence ?? null,
          verifiedSavingsUsd: impls.reduce((a, i) => a + (i.verifiedSavingsUsd ?? 0), 0),
          analyzed: summary != null,
        });
      }
      await h.audit(ctx.user.id, "report_generate", "portfolio", "all", { kind: "portfolio_manager_csv", siteCount: rows.length });
      return { csv: portfolioManagerCsv(rows), siteCount: rows.length };
    }),
    /** GAP-N — portfolio verified-savings edition (Pro): cumulative verified
     * headline across all sites + per-site verdict ledgers. Only persisted
     * implementation verdicts count toward the verified total. */
    portfolioVerified: protectedProcedure.query(async ({ ctx }) => {
      requireTier(tierOf(ctx.user), "pro", "Portfolio Verified Savings Statement");
      return assemblePortfolioVerified(ctx.user.id);
    }),
    /** Public verify endpoint — the token is the capability. Shows the printed
     * snapshot next to the CURRENT figures so a forwarded PDF is never silently
     * stale. Only headline numbers, never account details. */
    verify: publicProcedure.input(z.object({ token: z.string().min(8).max(64) })).query(async ({ input }) => {
      const artifact = await h.getReportArtifactByToken(input.token);
      if (!artifact) return { found: false as const };
      const current = await assembleReportData(artifact.siteId, artifact.userId).catch(() => null);
      return {
        found: true as const,
        kind: artifact.kind,
        printedAt: artifact.createdAt.getTime(),
        snapshot: artifact.snapshot as Record<string, unknown> | null,
        current: current
          ? {
              annualCostUsd: current.annualCostUsd,
              plannedTotalUsd: current.plannedTotalUsd,
              verifiedTotalUsd: current.verifiedTotalUsd,
              measureCount: current.measures.length,
              siteName: current.site.name,
            }
          : null,
        disclaimer: MODELED_ESTIMATES_DISCLAIMER,
      };
    }),
  }),
});

/* ---------------- scenario basis builder ---------------- */
/** Cycle 3, passes 36/66: meter timezone derived from the site's state. */
// Batch-24 (passes 846/856): states that span two clock zones — the map's single
// value covers the dominant-population zone, and any meter created from bare
// state inference in one of these states gets an explicit timezone-ambiguity
// disclosure (TOU/demand-window/CP alignment may be shifted 1h in the minority
// region; user should verify/override). ZIP-level tz mapping stays out of MVP
// scope — the fix is disclosure, not silence.
const SPLIT_TZ_STATES: Record<string, string> = {
  FL: "panhandle (Central)", ID: "northern panhandle (Pacific)", IN: "northwest/southwest counties (Central)",
  KY: "western half (Central)", MI: "western Upper Peninsula (Central)", TN: "western third incl. Memphis/Jackson (Central)",
  SD: "western half (Mountain)", ND: "southwest corner (Mountain)", TX: "far-west El Paso region (Mountain)",
  KS: "far-west counties (Mountain)", NE: "western panhandle (Mountain)", OR: "eastern Malheur County (Mountain)",
  NV: "West Wendover area (Mountain)", AK: "Aleutians west of 169.5°W (Hawaii–Aleutian)",
};

// Batch-44 (pass 1915): the note now carries its own severity/confidence — the
// three cases are NOT equally risky and lumping them all under info/low
// understated the unrecognized-state case. A split-zone state is a known
// ±1-hour ambiguity (info/low: the dominant zone is probably right); an
// unrecognized or missing state means the system KNOWS it could not infer a
// timezone and applied a default that may be off by many hours (warning, and
// medium confidence that the concern itself is well-founded).
type TzNote = { body: string; severity: "info" | "warning"; confidence: "low" | "medium" | "high" };

function tzAmbiguityNote(state: string | null | undefined): TzNote | null {
  const st = (state ?? "").toUpperCase().trim();
  const region = SPLIT_TZ_STATES[st];
  if (region) {
    return {
      body: `Timezone assumed ${tzForState(st)} (dominant zone for ${st}); the ${region} region uses a different clock zone. If this site is in that region, time-of-use periods, demand windows, and coincident-peak seasons may be shifted by one hour — verify the meter timezone.`,
      severity: "info",
      confidence: "low",
    };
  }
  // Batch-41 (pass 1776): a NON-EMPTY state that tzForState doesn't recognize
  // (typo, territory like PR/GU/VI, or free-text junk) silently fell back to
  // America/Phoenix with NO disclosure — unlike the no-state path, which warns.
  // Batch-44 (pass 1915): elevated to warning — a wholesale state mismatch can
  // shift clock math by many hours, not the ±1 hour of a split-zone state.
  if (st && !(st in TZ_BY_STATE)) {
    return {
      body: `State "${st}" was not recognized, so the meter timezone defaulted to America/Phoenix. Time-of-use periods, demand windows, and coincident-peak seasons may be SIGNIFICANTLY shifted (potentially many hours) if that is wrong — correct the state (2-letter USPS code) or verify the meter timezone before relying on time-of-use cost figures.`,
      severity: "warning",
      confidence: "medium",
    };
  }
  // Batch-42 (pass 1826): an EMPTY/missing state silently returned null here
  // even though tzForState defaults the meter to America/Phoenix — so the
  // quick-start, refine, upload, and bill paths (which call this helper with
  // site.state) produced NO timezone disclosure for state-less sites, while
  // sites.create warned via its own dedicated branch. Parity: the helper now
  // covers the empty case itself. sites.create checks !input.state FIRST and
  // keeps its richer combined tz+climate-zone wording.
  if (!st) {
    return {
      body: `No state is recorded for this site, so the meter timezone defaults to America/Phoenix. Time-of-use periods, demand windows, and coincident-peak seasons may be SIGNIFICANTLY shifted (potentially many hours) if that is wrong — add a state (2-letter USPS code) to correct the timezone.`,
      severity: "warning",
      confidence: "medium",
    };
  }
  return null;
}

// Batch-41 (pass 1776): hoisted to module scope so tzAmbiguityNote can check
// membership — an unrecognized state must produce a disclosure, not silence.
// Gap-8 cascade (Jul 2026): map moved to shared/wattwise.ts (TZ_BY_STATE) so
// the address-cascade module and routers derive timezones from ONE table.

function tzForState(state: string | null | undefined): string {
  return TZ_BY_STATE[(state ?? "").toUpperCase().trim()] ?? "America/Phoenix";
}

async function buildScenarioBasis(site: NonNullable<Awaited<ReturnType<typeof h.getSite>>>, userId: number) {
  // Cycle 9 (pass 505): never hardcode the hot-arid AZ zone as a universal
  // fallback — infer from ZIP/state so a Seattle site without an explicit
  // climateZone doesn't get a Phoenix archetype.
  const zoneInference = inferClimateZoneWithSource(site.zip ?? undefined, site.state ?? undefined);
  const climateZone = site.climateZone ?? zoneInference.zone;
  // Batch-36 (pass 1385): when the site carries NO location signal at all
  // (no explicit zone, no zip, no state), inferClimateZone bottoms out at the
  // US-median '4A' fallback. Quick-start sites disclose this via the
  // intake-assumptions insight, but a user_entered site (core attributes
  // provided, location omitted) or a stored zone that itself came from the
  // location-less create path would anchor archetype-based projections to a
  // zone the user never chose — with NO disclosure in the scenario results.
  // Batch-43 (pass 1845): use the inference SOURCE, not a location-field
  // heuristic — a ZIP can be present yet unresolvable (unmapped prefix with
  // no recognizable state), which previously fell to 4A silently because the
  // old check required BOTH zip and state to be absent.
  // Batch-46 (pass 2026): the STORED-zone branch also keys off the inference
  // SOURCE now — a stored 4A that came from a create-path with an unresolvable
  // ZIP (zip present but unmapped) previously escaped the disclosure because
  // the old heuristic required BOTH zip and state to be absent. Re-inferring
  // from the stored location fields tells us whether 4A is genuinely derivable
  // or just the US-median bottom-out.
  const zoneIsUsMedianFallback =
    site.climateZone == null
      ? zoneInference.source === "us_median_fallback"
      : site.climateZone === "4A" && zoneInference.source === "us_median_fallback";
  const meters = await h.listMeters(site.id, userId);
  // v1.7 §2.4a aggregation physics: site-level analysis reads MAIN-role meters only.
  // A submeter's load is inside its parent's — naive inclusion double-counts; generation
  // meters carry production, not consumption. virtual_total (when materialized) wins outright
  // so site analytics reuse the single-meter path on the summed main series.
  const virtualTotal = meters.find((m) => m.meterRole === "virtual_total" && m.commodity === "electric");
  const mainElectric = meters.filter((m) => m.meterRole === "main" && m.commodity === "electric");
  const meter =
    virtualTotal ??
    mainElectric[0] ??
    meters.find((m) => m.commodity === "electric" && m.meterRole !== "submeter" && m.meterRole !== "generation") ??
    meters.find((m) => m.meterRole !== "submeter" && m.meterRole !== "generation") ??
    null;

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
  let archetypeZoneDisclosure: string | null = null;
  if (!hourly) {
    const arch = site.buildingType ? await h.getArchetype(site.buildingType, climateZone, vintageBandLocal(site.vintage)) : null;
    if (!arch || !site.sqft) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Scenario needs either uploaded interval data or building type + size for an archetype baseline.",
      });
    }
    // Batch-43 (pass 1842): the scenario path previously scaled the shape
    // linearly and set only a bare `extrapolated` flag when sqft fell outside
    // the archetype's calibration bounds — no customer-facing disclosure named
    // the cause, and the peak-derating the pipeline applies (sqrt-of-size load
    // diversity) was silently absent here, so scenario baselines disagreed
    // with analysis baselines for the same site. Route through
    // archetypeBaseline for parity: same derating, same calibration semantics.
    const outOfCalib =
      (arch.calibMinSqft != null && site.sqft < arch.calibMinSqft) || (arch.calibMaxSqft != null && site.sqft > arch.calibMaxSqft);
    const calibMid =
      arch.calibMinSqft != null && arch.calibMaxSqft != null ? (arch.calibMinSqft + arch.calibMaxSqft) / 2 : (arch.calibMaxSqft ?? arch.calibMinSqft ?? null);
    const ab = archetypeBaseline(arch.shape8760 as number[], arch.annualUsePerSqft, site.sqft, {
      outOfCalibrationRange: outOfCalib,
      calibMidSqft: calibMid,
    });
    hourly = ab.hourly;
    confidence = "low";
    extrapolated = outOfCalib;
    if (outOfCalib) {
      const range = [
        arch.calibMinSqft != null ? `${arch.calibMinSqft.toLocaleString()} sqft` : null,
        arch.calibMaxSqft != null ? `${arch.calibMaxSqft.toLocaleString()} sqft` : null,
      ]
        .filter(Boolean)
        .join(" – ");
      archetypeZoneDisclosure = `Your building size (${site.sqft.toLocaleString()} sqft) is outside the ${site.buildingType} archetype's calibration range (${range}) — energy and peak-demand intensities are extrapolated beyond the model's valid domain, and confidence is reduced to low.`;
    }
    // Cycle 10 (pass 546): an any-zone archetype fallback silently substitutes a
    // different climate's load shape — disclose the mismatch explicitly.
    if (arch.zoneMatched === false) {
      const zoneNote = `Baseline uses a ${site.buildingType} archetype from a different climate zone (no ${climateZone} profile is seeded) — heating/cooling shape may differ materially from your climate.`;
      archetypeZoneDisclosure = archetypeZoneDisclosure ? `${archetypeZoneDisclosure} ${zoneNote}` : zoneNote;
    }
  }
  // Batch-36 (pass 1385) + Batch-47 (pass 2116): the US-median-zone disclosure
  // applies on EVERY load basis, not just the archetype branch — solar yields
  // (SOLAR_YIELD_BY_ZONE) key off climateZone even when the baseline is built
  // from measured intervals, so a fallback 4A silently prices a Phoenix
  // rooftop at mixed-humid yields. Say so regardless of how the load was built.
  if (zoneIsUsMedianFallback) {
    const fallbackNote = `Climate zone ${climateZone} is the US-median assumption (it could not be resolved from this site's location fields) — ${
      hourly && loadBasis === "measured_intervals"
        ? "solar yield estimates use this generic zone and"
        : "the archetype load shape and yields"
    } may not match your actual climate; add or correct the state/ZIP to fix this.`;
    archetypeZoneDisclosure = archetypeZoneDisclosure ? `${archetypeZoneDisclosure} ${fallbackNote}` : fallbackNote;
  }

  const tariffRows = await h.listTariffs("electric", site.state ?? undefined);
  // Batch-33 (pass 1225): the explicitly assigned tariff must be fetched
  // DIRECTLY, not looked up inside the state-filtered list — otherwise an
  // assigned rate whose eligibility list mismatches site.state silently
  // vanished and the basis fell back to an arbitrary eligible tariff with no
  // disclosure that the user's own assignment was ignored.
  const assigned = meter?.currentTariffId ? await h.getTariff(meter.currentTariffId) : undefined;
  const current = assigned && assigned.commodity === "electric" ? assigned : undefined;
  const currentStateMismatch = current ? !tariffRows.some((t) => t.id === current.id) : false;
  const utilityMatch = tariffRows.find((t) => site.utilityName && t.utilityName.toLowerCase().includes(site.utilityName.toLowerCase().split(" ")[0]));
  const chosen = current ?? utilityMatch ?? tariffRows[0];
  if (!chosen) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No tariff data available for scenario costing" });
  // Cycle 3, pass 56: disclose when the cost basis was not the user's actual
  // assigned rate — an arbitrary seeded tariff can materially shift projections.
  const tariffBasisDisclosure = current
    ? currentStateMismatch
      ? // Batch-36 (pass 1376) + Batch-42 (pass 1796): POLICY — the assigned rate
        // is priced even when its eligibility list mismatches the site's state,
        // because the assignment is the user's own declaration of what they are
        // BILLED on; silently substituting a different "eligible" rate would
        // produce projections against a tariff the customer never sees on a
        // bill (the pre-Batch-33 behavior, which was itself flagged). The
        // disclosure must therefore carry the full consequence: the figures
        // are only as valid as the assignment, and the user has exactly two
        // resolution paths (fix the assignment, or fix the site's state).
        `Cost basis: your assigned rate ${chosen.utilityName} ${chosen.name} is used for these figures even though its eligibility list does not include this site's state (${site.state ?? "unknown"}) — no substitute rate was applied. These projections are only as valid as that assignment: if the rate is wrong, correct it on the meter; if the site's state is wrong, correct it on the site. Until then, treat all cost figures here as unverified.`
      : null
    : utilityMatch
      ? `Cost basis: ${chosen.utilityName} ${chosen.name} matched by utility name — assign your actual rate on the meter for firmer numbers.`
      : `Cost basis: no rate is assigned to this meter and no seeded rate matched your utility, so the first available ${chosen.utilityName} ${chosen.name} rate was used. Projections may shift materially on your actual tariff.`;

  const zip3 = (site.zip ?? "").slice(0, 3);
  const ef = await h.getEmissionsFactor(zip3, site.state);
  return {
    hourly,
    loadBasis,
    confidence,
    extrapolated,
    structure: chosen.structure as TariffStructure,
    co2eLbPerMwh: ef.factor?.co2eLbPerMwh ?? 727.9,
    climateZone,
    tariffBasisDisclosure,
    archetypeZoneDisclosure,
    // Bill Builder (§3c): the composed-plan rate re-sweep needs the full
    // candidate list and which row is the current cost basis.
    chosenTariffId: chosen.id,
    tariffRows,
    // GAP-T §2.3: NEM banking rules from the chosen tariff row — solar
    // scenarios must disclose which export-credit regime the economics assume.
    nem: {
      banking: (chosen as { nemBanking?: string | null }).nemBanking ?? null,
      creditExpiry: (chosen as { nemCreditExpiry?: string | null }).nemCreditExpiry ?? null,
    },
  };
}

async function endUseForSite(site: { buildingType: string | null; climateZone: string | null; vintage: number | null; zip?: string | null; state?: string | null }) {
  if (!site.buildingType) return null;
  // Cycle 9 (pass 505): infer zone from ZIP/state rather than assuming 2B.
  const zone = site.climateZone ?? inferClimateZone(site.zip ?? undefined, site.state ?? undefined);
  const arch = await h.getArchetype(site.buildingType, zone, vintageBandLocal(site.vintage));
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

export type AppRouter = typeof appRouter;
