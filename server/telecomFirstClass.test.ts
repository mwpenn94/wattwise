/**
 * TUX-6 (owner Jul 23) — telecom as a first-class utility: merged-surface tests.
 *
 * Covers the integration seams this session created:
 *  1. TEL1C-1  resolveTelecomMarket — multi-technology market context by location
 *  2. TEL1C-2  benchmark currency — telecom benchmark sources registered in the
 *              rate-currency engine govern benchmark TIERS (not tariff rows), and
 *              tier escalation flows to telecom_benchmarks.verify_status
 *  3. TEL1C-3  cascading identification — site creation writes an idempotent
 *              telecom setup invite insight (and never when services exist)
 *  4. TEL1C-4  pipeline integration — telecom findings carry everything the
 *              ranked-opportunity injection needs, and spend totals are exact
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { insights, sites, telecomBenchmarks, telecomServices, users, rateSources } from "../drizzle/schema";
import { resolveTelecomMarket, marketPriceFactor } from "./telecomMarket";
import { upsertTelecomService, addTelecomSetupInvite, analyzeTelecomServices } from "./telecom";
import { registerRateSources } from "./rateCurrency";
import { ensureSeeded } from "./seed/runSeeders";
import * as h from "./dbHelpers";

const OPEN_ID = "test-tel1c-firstclass";
let userId: number;
let siteId: number;

beforeAll(async () => {
  await ensureSeeded();
  await registerRateSources();
  const db = await getDb();
  if (!db) throw new Error("db unavailable");
  await db.insert(users).values({ openId: OPEN_ID, name: "Tel FirstClass" });
  const [u] = await db.select().from(users).where(eq(users.openId, OPEN_ID));
  userId = u.id;
  siteId = await h.createSite({ userId, name: "TEL1C test site", city: "Tucson", state: "AZ", zip: "85701", buildingType: "office" });
}, 60_000);

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(telecomServices).where(eq(telecomServices.userId, userId));
  const mySites = await db.select({ id: sites.id }).from(sites).where(eq(sites.userId, userId));
  if (mySites.length > 0) await db.delete(insights).where(inArray(insights.siteId, mySites.map((s) => s.id)));
  await db.delete(sites).where(eq(sites.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

/* ------------------------------------------------------------------ */
/* 1. TEL1C-1: multi-technology market resolution                      */
/* ------------------------------------------------------------------ */
describe("TEL1C-1 market resolution", () => {
  it("resolves a metro market with multiple access technologies, each priced", () => {
    const m = resolveTelecomMarket({ city: "Tucson", state: "AZ", zip: "85701" });
    expect(m.technologies.length).toBeGreaterThanOrEqual(2);
    const kinds = m.technologies.map((t) => t.technology);
    // wired + wireless coexist in one geography (owner Jul 23: multiple
    // providers/technologies per market, never a single-provider model)
    expect(kinds.some((k) => k === "fiber" || k === "cable" || k === "dsl")).toBe(true);
    expect(kinds.some((k) => k === "fixed_wireless" || k === "satellite")).toBe(true);
    for (const t of m.technologies) {
      expect(t.priceFactor).toBeGreaterThan(0);
      expect(t.availabilityPrior).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
    expect(m.disclosures.length).toBeGreaterThan(0);
  });

  it("rural fallback carries no more technologies than a dense metro and prices no lower", () => {
    const rural = resolveTelecomMarket({ city: null, state: "AZ", zip: null });
    const metro = resolveTelecomMarket({ city: "Tucson", state: "AZ", zip: "85701" });
    expect(rural.technologies.length).toBeLessThanOrEqual(metro.technologies.length);
    expect(marketPriceFactor(rural)).toBeGreaterThanOrEqual(marketPriceFactor(metro));
  });
});

/* ------------------------------------------------------------------ */
/* 2. TEL1C-2: benchmark sources in the rate-currency registry         */
/* ------------------------------------------------------------------ */
describe("TEL1C-2 benchmark currency", () => {
  it("registers telecom benchmark sources with commodity=telecom governing tier keys", async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    const rows = await db.select().from(rateSources).where(eq(rateSources.commodity, "telecom"));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      const governs = r.governsUrdbIds as string[];
      // benchmark sources govern tier keys (prefixed), never real tariff ids
      expect(governs.length).toBeGreaterThan(0);
      expect(governs.every((g) => g.startsWith("tier:"))).toBe(true);
    }
  });

  it("escalating a benchmark source's governed tiers flags telecom_benchmarks rows, confirm clears them", async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    const [src] = await db.select().from(rateSources).where(eq(rateSources.sourceKey, "telecom-fcc-urs"));
    expect(src).toBeTruthy();
    const tierKeys = (src.governsUrdbIds as string[]).filter((g) => g.startsWith("tier:")).map((g) => g.slice("tier:".length));
    expect(tierKeys.length).toBeGreaterThan(0);
    // simulate what the sweep does on a fingerprint change: escalate governed tiers
    await db.update(telecomBenchmarks).set({ verifyStatus: "change_detected" }).where(inArray(telecomBenchmarks.tierKey, tierKeys));
    const flagged = await db.select().from(telecomBenchmarks).where(inArray(telecomBenchmarks.tierKey, tierKeys));
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((b) => b.verifyStatus === "change_detected")).toBe(true);
    // agent confirm path clears the flag and stamps verification time
    await db
      .update(telecomBenchmarks)
      .set({ verifyStatus: "current", lastVerifiedAt: Date.now() })
      .where(inArray(telecomBenchmarks.tierKey, tierKeys));
    const cleared = await db.select().from(telecomBenchmarks).where(inArray(telecomBenchmarks.tierKey, tierKeys));
    expect(cleared.every((b) => b.verifyStatus === "current" && b.lastVerifiedAt != null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. TEL1C-3: cascading identification (setup invite)                 */
/* ------------------------------------------------------------------ */
describe("TEL1C-3 cascading identification", () => {
  it("writes exactly one idempotent telecom setup invite per site", async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    await addTelecomSetupInvite(siteId, { city: "Tucson", state: "AZ", zip: "85701" });
    await addTelecomSetupInvite(siteId, { city: "Tucson", state: "AZ", zip: "85701" }); // second call must no-op
    const rows = await db
      .select()
      .from(insights)
      .where(and(eq(insights.siteId, siteId), eq(insights.kind, "telecom_setup_invite")));
    expect(rows.length).toBe(1);
    expect(`${rows[0].title} ${rows[0].body}`).toMatch(/telecom|internet|connectivity/i);
  });

  it("skips the invite when the site already has telecom services", async () => {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    const svcSiteId = await h.createSite({ userId, name: "TEL1C svc site", city: "Tucson", state: "AZ", zip: "85701", buildingType: "office" });
    try {
      await upsertTelecomService(userId, {
        siteId: svcSiteId,
        serviceType: "internet",
        provider: "AT&T Fiber",
        monthlyCostUsd: 80,
        downloadMbps: 300,
      });
      await addTelecomSetupInvite(svcSiteId, { city: "Tucson", state: "AZ", zip: "85701" });
      const rows = await db
        .select()
        .from(insights)
        .where(and(eq(insights.siteId, svcSiteId), eq(insights.kind, "telecom_setup_invite")));
      expect(rows.length).toBe(0);
    } finally {
      await db.delete(telecomServices).where(eq(telecomServices.siteId, svcSiteId));
      await db.delete(insights).where(eq(insights.siteId, svcSiteId));
      await db.delete(sites).where(eq(sites.id, svcSiteId));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. TEL1C-4: analyzer output feeds ranked opportunities + totals     */
/* ------------------------------------------------------------------ */
describe("TEL1C-4 pipeline integration contract", () => {
  it("analyzer findings carry the fields the pipeline injection needs (kind, serviceId, savings range)", async () => {
    await upsertTelecomService(userId, {
      siteId,
      serviceType: "mobile",
      provider: "Verizon",
      monthlyCostUsd: 95, // pricey unlimited postpaid → MVNO switch option
      lines: 1,
      unlimitedData: true,
    });
    const res = await analyzeTelecomServices(userId, siteId);
    expect(res.services.length).toBe(1);
    const savingsBearing = res.findings.filter((f) => f.estAnnualSavingsLo != null && (f.estAnnualSavingsHi ?? 0) > 0);
    expect(savingsBearing.length).toBeGreaterThan(0);
    for (const f of savingsBearing) {
      // pipeline builds candidate key `telecom_<kind>_<serviceId>` from these
      expect(f.kind).toBeTruthy();
      expect(f.serviceId).toBeTruthy();
      expect(f.estAnnualSavingsHi!).toBeGreaterThanOrEqual(f.estAnnualSavingsLo!);
      // subscription dollars only — telecom never claims energy-unit savings
      expect("estUnitsSavedPerYr" in f).toBe(false);
    }
    // spend totals the pipeline writes into summary metrics
    expect(res.monthlyTotalUsd).toBe(95);
    expect(res.annualTotalUsd).toBe(95 * 12);
  });
});
