/**
 * Progressive participation tests (Jul 2026).
 * A user can begin with NOTHING but a free-text address: quickCreate parses
 * state/ZIP/city, fills disclosed placeholders, writes an intake_assumptions
 * insight enumerating every assumption, and refine() replaces placeholders
 * (flipping attrSource to user_entered) without ever gating on a full form.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users, sites, insights } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { parseQuickAddress, quickStartAssumptions, QUICK_START_DEFAULTS } from "../shared/wattwise";
import { BUILDING_PRIORS } from "./cascade";

function ctxFor(user: { id: number; openId: string; role?: "user" | "admin" }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: user.role ?? "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  };
}

let qsUserId = 0;
const OPEN_ID = "vitest-quickstart";

beforeAll(async () => {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId: OPEN_ID, name: OPEN_ID, email: `${OPEN_ID}@test.local`, loginMethod: "test", role: "admin" })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date(), role: "admin" } });
  const rows = await db.select().from(users).where(eq(users.openId, OPEN_ID));
  qsUserId = rows[0]!.id;
  // Deterministic across runs: this user's sites (and their insights) are
  // recreated fresh each run. Admin role → pro tier → no free-site quota, so
  // cleanup is a determinism nicety rather than a quota necessity.
  const mine = await db.select().from(sites).where(eq(sites.userId, qsUserId));
  for (const s of mine) {
    await db.delete(insights).where(eq(insights.siteId, s.id));
    await db.delete(sites).where(eq(sites.id, s.id));
  }
}, 30_000);

describe("parseQuickAddress (pure)", () => {
  it("extracts state, ZIP, and city from a full street address", () => {
    const p = parseQuickAddress("500 N Central Ave, Phoenix, AZ 85004");
    expect(p.state).toBe("AZ");
    expect(p.zip).toBe("85004");
    expect(p.city).toBe("Phoenix");
  });

  it("handles city+state with no ZIP", () => {
    const p = parseQuickAddress("Austin, TX");
    expect(p.state).toBe("TX");
    expect(p.zip).toBeNull();
  });

  it("returns nulls (never throws) on an unparseable line, and the assumption list discloses it", () => {
    const p = parseQuickAddress("123 Main St");
    expect(p.state).toBeNull();
    expect(p.zip).toBeNull();
    const a = quickStartAssumptions(p);
    expect(a.find((x) => x.field === "state")).toBeTruthy();
    expect(a.find((x) => x.field === "zip")).toBeTruthy();
    // core placeholders always disclosed
    for (const f of ["buildingType", "sqft", "vintage", "intervalData"]) {
      expect(a.find((x) => x.field === f)).toBeTruthy();
    }
  });

  it("does not mistake street tokens for states ('Dr', 'St') — only USPS codes match", () => {
    const p = parseQuickAddress("742 Evergreen Dr");
    expect(p.state).toBeNull();
  });
});

describe("sites.quickCreate + refine (progressive participation)", () => {
  it("creates an analyzable site from a bare address with disclosed placeholders", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: qsUserId, openId: OPEN_ID, role: "admin" }));
    const res = await caller.sites.quickCreate({ address: "500 N Central Ave, Phoenix, AZ 85004" });
    expect(res.id).toBeGreaterThan(0);
    expect(res.parse.state).toBe("AZ");
    expect(res.parse.zip).toBe("85004");
    // assumption list enumerates the placeholders and what refining unlocks
    const fields = res.assumptions.map((a) => a.field);
    expect(fields).toEqual(expect.arrayContaining(["buildingType", "sqft", "vintage", "intervalData"]));
    for (const a of res.assumptions) expect(a.unlocks.length).toBeGreaterThan(10);

    const site = await caller.sites.get({ siteId: res.id });
    // Gap-8 cascade: stored priors come from BUILDING_PRIORS (type-specific
    // medians), not the legacy flat QUICK_START_DEFAULTS 10k office.
    expect(site.buildingType).toBe(QUICK_START_DEFAULTS.buildingType);
    expect(site.sqft).toBe(BUILDING_PRIORS[QUICK_START_DEFAULTS.buildingType].sqft);
    expect(site.vintage).toBe(BUILDING_PRIORS[QUICK_START_DEFAULTS.buildingType].vintage);
    expect(site.attrSource).toBe("quick_start_defaults");
    expect(site.climateZone).toBe("2B"); // Phoenix ZIP prefix
    expect(site.utilityName).toBeTruthy(); // AZ candidate utility derived from state

    // the assumptions text mirrors the persisted cascade priors, never the flat default
    const sqftAssumption = res.assumptions.find((a) => a.field === "sqft");
    expect(sqftAssumption!.assumed).toContain(BUILDING_PRIORS[QUICK_START_DEFAULTS.buildingType].sqft.toLocaleString());

    // disclosure insight exists BEFORE any analysis has run
    const rows = await caller.insights.list({ siteId: res.id });
    const intake = rows.find((r) => r.kind === "intake_assumptions");
    expect(intake).toBeTruthy();
    expect(intake!.body).toContain("derived");
    const intakeMetrics = intake!.metrics as { cascade?: Record<string, { value: unknown; source: string }> };
    expect(intakeMetrics.cascade).toBeTruthy();
    expect(intakeMetrics.cascade!.climateZone.source).toBe("zip_inferred");
    const metrics = intake!.metrics as { assumptions: Array<{ field: string }> };
    expect(metrics.assumptions.map((a) => a.field)).toEqual(expect.arrayContaining(["sqft", "buildingType"]));
  }, 30_000);

  it("quick-start site produces an immediate quick-win analysis, and the pipeline re-emits the disclosure", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: qsUserId, openId: OPEN_ID, role: "admin" }));
    const created = await caller.sites.quickCreate({ address: "Tucson, AZ 85701" });
    const result = await caller.analysis.run({ siteId: created.id });
    // quick win: archetype-synthetic baseline + tariff comparisons from placeholders alone
    expect(result.baseline).toBeTruthy();
    expect(result.baseline!.method).toBe("archetype_synthetic");
    expect(result.tariffComparisons.length).toBeGreaterThan(0);
    // replaceInsights wiped creation-time rows — the pipeline must re-emit the disclosure
    const rows = await caller.insights.list({ siteId: created.id });
    const intake = rows.find((r) => r.kind === "intake_assumptions");
    expect(intake).toBeTruthy();
    expect(intake!.confidence).toBe("low");
  }, 60_000);

  it("refine replaces placeholders field-by-field and flips attrSource once a core attribute is real", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: qsUserId, openId: OPEN_ID, role: "admin" }));
    const created = await caller.sites.quickCreate({ address: "Mesa, AZ" });
    // non-core refinement (utility) does NOT flip attrSource
    await caller.sites.refine({ siteId: created.id, utilityName: "SRP" });
    let site = await caller.sites.get({ siteId: created.id });
    expect(site.utilityName).toBe("SRP");
    expect(site.attrSource).toBe("quick_start_defaults");
    // core refinement flips it
    const r = await caller.sites.refine({ siteId: created.id, sqft: 25_000, buildingType: "retail" });
    expect(r.updated.sort()).toEqual(["buildingType", "sqft"]);
    site = await caller.sites.get({ siteId: created.id });
    expect(site.sqft).toBe(25_000);
    expect(site.buildingType).toBe("retail");
    expect(site.attrSource).toBe("user_entered");
  }, 30_000);

  it("refine with a new ZIP re-infers the climate zone, flips attrSource, and keeps tracking later moves", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: qsUserId, openId: OPEN_ID, role: "admin" }));
    const created = await caller.sites.quickCreate({ address: "somewhere with no location info at all" });
    let site = await caller.sites.get({ siteId: created.id });
    expect(site.state).toBeNull();
    expect(site.climateZone).toBe("4A"); // disclosed US-median fallback
    await caller.sites.refine({ siteId: created.id, state: "AZ", zip: "86001" });
    site = await caller.sites.get({ siteId: created.id });
    expect(site.climateZone).toBe("5B"); // Flagstaff high country ZIP prefix
    // Batch-21 (pass 565): explicitly-entered location IS user-entered data —
    // the intake-assumptions insight must stop being re-emitted against it.
    expect(site.attrSource).toBe("user_entered");
    // Batch-21 (pass 566): climateZone always tracks location — a later move
    // re-infers the zone even after attrSource has already flipped.
    await caller.sites.refine({ siteId: created.id, zip: "85004" });
    site = await caller.sites.get({ siteId: created.id });
    expect(site.climateZone).toBe("2B"); // Phoenix — re-inferred post-flip
  }, 30_000);

  it("Batch-45 (pass 1959): refinedFields is per-field — refining one core attr keeps the others' placeholder lines", async () => {
    const caller = appRouter.createCaller(ctxFor({ id: qsUserId, openId: OPEN_ID, role: "admin" }));
    const created = await caller.sites.quickCreate({ address: "600 W Broadway, San Diego, CA 92101" });
    let site = await caller.sites.get({ siteId: created.id });
    // quick-start origin starts with an empty (non-null) refinement record
    expect(site.refinedFields).toEqual([]);
    // refine ONLY buildingType — site-level attrSource flips, but the
    // per-field record shows sqft/vintage are still placeholders
    await caller.sites.refine({ siteId: created.id, buildingType: "warehouse" });
    site = await caller.sites.get({ siteId: created.id });
    expect(site.attrSource).toBe("user_entered");
    expect(site.refinedFields).toEqual(["buildingType"]);
    // pipeline re-emit must still disclose sqft + vintage but NOT buildingType
    await caller.analysis.run({ siteId: created.id });
    const rows = await caller.insights.list({ siteId: created.id });
    const intake = rows.find((r) => r.kind === "intake_assumptions" && r.title.includes("placeholder"));
    expect(intake).toBeTruthy();
    const fields = ((intake!.metrics as { assumptions: Array<{ field: string }> }).assumptions ?? []).map((a) => a.field);
    expect(fields).toContain("sqft");
    expect(fields).toContain("vintage");
    expect(fields).not.toContain("buildingType");
    // refining the remaining core fields clears their lines too
    await caller.sites.refine({ siteId: created.id, sqft: 42_000, vintage: 1998 });
    site = await caller.sites.get({ siteId: created.id });
    expect(([...(site.refinedFields as string[])]).sort()).toEqual(["buildingType", "sqft", "vintage"]);
    await caller.analysis.run({ siteId: created.id });
    const rows2 = await caller.insights.list({ siteId: created.id });
    const intake2 = rows2.find((r) => r.kind === "intake_assumptions" && r.title.includes("placeholder"));
    if (intake2) {
      const fields2 = ((intake2.metrics as { assumptions: Array<{ field: string }> }).assumptions ?? []).map((a) => a.field);
      expect(fields2).not.toContain("buildingType");
      expect(fields2).not.toContain("sqft");
      expect(fields2).not.toContain("vintage");
    }
  }, 120_000);
});
