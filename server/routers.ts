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
import { ensureSeeded } from "./seed/runSeeders";
import { preParseGate, rejectXxe, withParseTimeout } from "./ingest/hardening";
import { parseCsvIntervals, parseEspiXml, parseExcelIntervals, PARSER_VERSION, type ParsedMeterSeries } from "./ingest/parsers";
import { writeIntervals } from "./ingest/writer";
import { extractBill } from "./ingest/billOcr";
import { getDb } from "./db";
import { runAnalysisPipeline } from "./analytics/pipeline";
import { archetypeBaseline } from "./analytics/baseline";
import { runScenario, hourlyToPoints, type ScenarioInput } from "./analytics/scenarios";
import { costOnTariff } from "./analytics/tariffEngine";
import { recordMeterEvent, assertFreeTierCostCap, monthToDateLlmSpend } from "./analytics/costModel";
import { storagePut } from "./storage";
import { deriveFromAddress, cascadeProvenance } from "./cascade";
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
          climateZone: input.climateZone ?? createCascade.climateZone.value,
          utilityName: input.utilityName ?? createCascade.utilityName.value ?? undefined,
          attrSource: "user_entered",
        });
      });
      // Disclose any derived (non-user-entered) suggestions so the cascade is
      // never silent on this path either.
      const derivedOnCreate = Object.entries(cascadeProvenance(createCascade)).filter(
        ([k, v]) =>
          ["climateZone", "utilityName"].includes(k) &&
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
      .input(z.object({ address: z.string().min(3).max(1000), name: z.string().max(255).optional() }))
      .mutation(async ({ ctx, input }) => {
        await seeded();
        const tier = tierOf(ctx.user);
        const parse = parseQuickAddress(input.address);
        // Gap-8 cascade (Jul 2026): everything derivable from the address is
        // derived — candidate utility, ZIP3-aware climate zone, timezone,
        // eGRID subregion, and building-stock priors — each with provenance,
        // instead of one flat 10k-sqft office default.
        const cascade = deriveFromAddress(input.address);
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
            name: input.name?.trim() || (parse.city ? `${parse.city} building` : parse.raw.slice(0, 60) || "My building"),
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
            attrSource: "quick_start_defaults",
            // Batch-45 (pass 1959): per-field refinement record — starts empty;
            // sites.refine appends each core field the user actually provides.
            refinedFields: [],
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
          title: "Quick-start analysis — placeholder assumptions in effect",
          body:
            `This site was created from just an address. Everything derivable from the address was derived automatically — ` +
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
              `building prior: ${cascade.buildingType.value}, ${cascade.sqft.value.toLocaleString()} sqft, vintage ${cascade.vintage.value} (${cascade.sqft.source.replace(/_/g, " ")})`,
            ].join("; ") +
            `. These are starting points, not facts — every field is overridable, and each "add detail" chip on the dashboard shows exactly what refining a field unlocks.` +
            (tzNote ? ` ${tzNote.body}` : "") +
            ` ${MODELED_ESTIMATES_DISCLAIMER}`,
          // Batch-44 (pass 1915): the combined note inherits the tz note's
          // severity when it is graver than the default info.
          severity: tzNote?.severity === "warning" ? "warning" : "info",
          confidence: "low",
          provenance: { method: "quick_start_intake_v2", parsedState: parse.state, parsedZip: parse.zip, tzAmbiguous: tzNote != null },
          metrics: { assumptions, cascade: cascadeProvenance(cascade) },
        });
        await h.audit(ctx.user.id, "site_created", "site", String(id), { name: input.name ?? parse.raw.slice(0, 60), quickStart: true });
        return { id, parse, assumptions };
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
        const site = await h.getSite(input.siteId, ctx.user.id);
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
            await h.addInsight({
              siteId,
              kind: "intake_assumptions",
              title: "Meter timezone assumption — verify if incorrect for this site",
              body: refineTzNote.body,
              severity: refineTzNote.severity,
              confidence: refineTzNote.confidence,
              provenance: { method: "site_refine_tz_disclosure_v1", state: provided.state, tzAmbiguous: true },
              metrics: null,
            });
          }
        }
        await h.audit(ctx.user.id, "site_refined", "site", String(siteId), { fields: Object.keys(provided) });
        return { ok: true as const, updated: Object.keys(provided) };
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
            } | null;
            const meterRows = await h.listMeters(s.id, ctx.user.id);
            return {
              siteId: s.id,
              name: s.name,
              entityId: s.entityId ?? null,
              state: s.state,
              buildingType: s.buildingType,
              meterCount: meterRows.length,
              analyzed: m != null,
              annualCostUsd: m?.currentCost?.breakdown?.total ?? null,
              demandCostUsd: m?.currentCost?.breakdown ? (m.currentCost.breakdown.demand ?? 0) + (m.currentCost.breakdown.cp ?? 0) : null,
              peakKw: m?.demand?.peakKw ?? null,
              loadFactor: m?.demand?.loadFactor ?? null,
              annualUsageKwh: m?.baseline?.normalizedAnnualUsage ?? null,
              annualCo2eLb: m?.emissions?.annualCo2eLb ?? null,
            };
          }),
        );
        const sum = (k: "annualCostUsd" | "peakKw" | "annualUsageKwh" | "annualCo2eLb" | "demandCostUsd") => {
          const vals = siteRollups.map((r) => r[k]).filter((v): v is number => v != null);
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
        };
        return {
          entities: allEntities,
          sites: siteRollups,
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
          },
        };
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
        const verifiedFormat: "xlsx" | "csv" | "espi_xml" =
          gate.detected === "xlsx" || gate.detected === "xls" ? "xlsx" : gate.detected === "csv_text" ? "csv" : "espi_xml";

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
            parser: verifiedFormat === "xlsx" ? "excel_build0103" : verifiedFormat === "csv" ? "csv_build0103" : "espi_xml",
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
        let series: ParsedMeterSeries[] = [];
        try {
          series = await withParseTimeout(() => {
            if (verifiedFormat === "xlsx") return parseExcelIntervals(buf);
            if (verifiedFormat === "csv") return parseCsvIntervals(buf.toString("utf8"), input.filename);
            return parseEspiXml(buf.toString("utf8"));
          }, `parse_${verifiedFormat}`);
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
          },
          ctx.user.id,
        );
        await h.audit(ctx.user.id, "bill_created", "bill", String(id), { siteId: input.siteId, quickStart: true });
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

        // Build baseline hourly profile: measured intervals if available, else archetype
        const { hourly, loadBasis, confidence, extrapolated, structure, co2eLbPerMwh, climateZone, tariffBasisDisclosure, archetypeZoneDisclosure } = await buildScenarioBasis(site, ctx.user.id);
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
        await h.audit(ctx.user.id, "tier_change", "user", String(ctx.user.id), {
          from: prev,
          to: input.tier,
          billing: "none — beta period, no payment collected",
        });
        return { tier: input.tier, previous: prev };
      }),
    exportData: protectedProcedure.mutation(async ({ ctx }) => {
      const data = await h.exportUserData(ctx.user.id);
      await h.audit(ctx.user.id, "data_export", "user", String(ctx.user.id), { tables: Object.keys(data) });
      return data;
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
    // Batch-36 (pass 1385): archetype baselines are climate-zone-driven — if the
    // zone is only the US-median fallback, say so explicitly instead of letting
    // the customer assume it was derived from their location.
    if (zoneIsUsMedianFallback) {
      const fallbackNote = `Climate zone ${climateZone} is the US-median assumption (it could not be resolved from this site's location fields) — the archetype load shape and yields may not match your actual climate; add or correct the state/ZIP to fix this.`;
      archetypeZoneDisclosure = archetypeZoneDisclosure ? `${archetypeZoneDisclosure} ${fallbackNote}` : fallbackNote;
    }
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
