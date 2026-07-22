/**
 * CURR-8 — rate-currency engine specs.
 * Pure-logic tests (cadence, fingerprint normalization) run against the
 * module directly; DB-touching flows (sweep, apply) are covered against the
 * live dev DB with synthetic source rows cleaned up after each spec.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { getDb } from "./db";
import { rateSources, rateVerifications, tariffs } from "../drizzle/schema";
import {
  RATE_SOURCE_SEEDS,
  applyAgentFinding,
  effectiveCadenceDays,
  fingerprintSource,
  getVerifyTargets,
  registerRateSources,
  sweepRateSources,
} from "./rateCurrency";

const TEST_PREFIX = "curr-test-";

async function cleanup() {
  const db = await getDb();
  if (!db) return;
  await db.delete(rateSources).where(like(rateSources.sourceKey, `${TEST_PREFIX}%`));
  await db.delete(rateVerifications).where(like(rateVerifications.sourceKey, `${TEST_PREFIX}%`));
  await db.delete(tariffs).where(like(tariffs.urdbId, `${TEST_PREFIX}%`));
}

afterAll(cleanup);

describe("effectiveCadenceDays", () => {
  it("caps monthly-PGA sources at 45 days regardless of base cadence", () => {
    expect(effectiveCadenceDays({ adjustorCycle: "monthly_pga", verifyCadenceDays: 120 })).toBe(45);
  });
  it("caps quarterly GSC/PGA sources at 100 days", () => {
    expect(effectiveCadenceDays({ adjustorCycle: "quarterly_gsc", verifyCadenceDays: 365 })).toBe(100);
    expect(effectiveCadenceDays({ adjustorCycle: "quarterly_pga", verifyCadenceDays: 90 })).toBe(90);
  });
  it("uses base cadence for annual/none cycles", () => {
    expect(effectiveCadenceDays({ adjustorCycle: "annual", verifyCadenceDays: 120 })).toBe(120);
    expect(effectiveCadenceDays({ adjustorCycle: "none", verifyCadenceDays: 90 })).toBe(90);
  });
});

describe("fingerprintSource", () => {
  const mkFetch = (body: string, contentType: string): typeof fetch =>
    (async () =>
      new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;

  it("hashes PDFs byte-exactly", async () => {
    const h1 = await fingerprintSource("https://x/pdf", mkFetch("PDFBYTES-A", "application/pdf"));
    const h2 = await fingerprintSource("https://x/pdf", mkFetch("PDFBYTES-A", "application/pdf"));
    const h3 = await fingerprintSource("https://x/pdf", mkFetch("PDFBYTES-B", "application/pdf"));
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toBe(createHash("sha256").update("PDFBYTES-A").digest("hex"));
  });

  it("normalizes volatile HTML (scripts, nonces, whitespace) so only content changes flip the hash", async () => {
    const a = `<html><script nonce="abc">var x=1;</script><body>Rate: $0.11 / kWh</body></html>`;
    const b = `<html><script nonce="zzz">var y=2;</script><body>Rate:   $0.11 / kWh</body></html>`;
    const c = `<html><script nonce="abc">var x=1;</script><body>Rate: $0.13 / kWh</body></html>`;
    const ha = await fingerprintSource("https://x/page", mkFetch(a, "text/html"));
    const hb = await fingerprintSource("https://x/page", mkFetch(b, "text/html"));
    const hc = await fingerprintSource("https://x/page", mkFetch(c, "text/html"));
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
  });

  it("throws on non-OK responses", async () => {
    const fail: typeof fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(fingerprintSource("https://x/missing", fail)).rejects.toThrow(/404/);
  });
});

describe("source registry", () => {
  it("registers all seeded sources idempotently and stamps sourceUrl onto governed rows", async () => {
    const db = await getDb();
    if (!db) return;
    await registerRateSources();
    const first = await db.select().from(rateSources);
    expect(first.length).toBeGreaterThanOrEqual(RATE_SOURCE_SEEDS.length);
    await registerRateSources(); // second run must not duplicate
    const second = await db.select().from(rateSources);
    expect(second.length).toBe(first.length);
    // filed LG&E electric rows carry the registry URL
    const lge = await db.select().from(tariffs).where(eq(tariffs.urdbId, "lge-rs"));
    if (lge.length > 0) {
      expect(lge[0].sourceUrl).toContain("lge-ku.com");
    }
  });

  it("covers every filed (hand-modeled) tariff urdbId in exactly one source", () => {
    const seen = new Map<string, string>();
    for (const s of RATE_SOURCE_SEEDS) {
      for (const id of s.governsUrdbIds) {
        expect(seen.has(id), `${id} governed by both ${seen.get(id)} and ${s.sourceKey}`).toBe(false);
        seen.set(id, s.sourceKey);
      }
    }
    // the new filed rows from this session must be governed
    for (const id of ["lge-rs", "lge-rtod-energy", "lge-gs", "lge-rgs", "lge-cgs", "unsg-grres", "unsg-ggsvs"]) {
      expect(seen.has(id), `${id} missing from RATE_SOURCE_SEEDS`).toBe(true);
    }
  });
});

describe("verification targets", () => {
  it("prioritizes change_detected sources above merely-stale ones and caps the list", async () => {
    const db = await getDb();
    if (!db) return;
    await registerRateSources();
    // synthetic: one changed source, one very stale source
    await db.insert(rateSources).values({
      sourceKey: `${TEST_PREFIX}changed`,
      utilityName: "Test Changed Util",
      commodity: "electric",
      state: "ZZ",
      sourceUrl: "https://example.com/changed.pdf",
      sourceLabel: "Test changed source",
      governsUrdbIds: [`${TEST_PREFIX}t1`],
      adjustorCycle: "none",
      verifyCadenceDays: 90,
      changeDetectedAt: Date.now(),
    });
    await db.insert(rateSources).values({
      sourceKey: `${TEST_PREFIX}stale`,
      utilityName: "Test Stale Util",
      commodity: "electric",
      state: "ZZ",
      sourceUrl: "https://example.com/stale.pdf",
      sourceLabel: "Test stale source",
      governsUrdbIds: [`${TEST_PREFIX}t2`],
      adjustorCycle: "none",
      verifyCadenceDays: 90,
      lastVerifiedAt: Date.now() - 400 * 86_400_000,
    });
    const targets = await getVerifyTargets();
    expect(targets.length).toBeLessThanOrEqual(10);
    const changedIdx = targets.findIndex((t) => t.sourceKey === `${TEST_PREFIX}changed`);
    const staleIdx = targets.findIndex((t) => t.sourceKey === `${TEST_PREFIX}stale`);
    expect(changedIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx === -1 || changedIdx < staleIdx).toBe(true);
  });
});

describe("applyAgentFinding", () => {
  async function mkSourceWithTariff(key: string, rate: number) {
    const db = await getDb();
    if (!db) throw new Error("db unavailable");
    const urdbId = `${key}-row`;
    await db.insert(tariffs).values({
      urdbId,
      utilityName: `Util ${key}`,
      name: `Test rate ${key}`,
      sector: "residential",
      commodity: "electric",
      state: "ZZ",
      structure: {
        fixedMonthly: 10,
        energy: [{ label: "All hours", months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hourStart: 0, hourEnd: 24, ratePerUnit: rate }],
        demand: [],
      },
      freshness: "urdb_stale",
      source: "urdb_snapshot_modeled",
    });
    await db.insert(rateSources).values({
      sourceKey: key,
      utilityName: `Util ${key}`,
      commodity: "electric",
      state: "ZZ",
      sourceUrl: "https://example.com/t.pdf",
      sourceLabel: `Test source ${key}`,
      governsUrdbIds: [urdbId],
      adjustorCycle: "none",
      verifyCadenceDays: 90,
    });
    return urdbId;
  }

  it("confirmed → stamps lastVerifiedAt and flips rows to current", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}confirm`;
    const urdbId = await mkSourceWithTariff(key, 0.1);
    const res = await applyAgentFinding({ sourceKey: key, status: "confirmed", evidence: "matched $0.10/kWh on sheet 12" });
    expect(res.action).toBe("verified");
    const row = (await db.select().from(tariffs).where(eq(tariffs.urdbId, urdbId)))[0];
    expect(row.verifyStatus).toBe("current");
    expect(row.lastVerifiedAt).toBeGreaterThan(Date.now() - 60_000);
    const src = (await db.select().from(rateSources).where(eq(rateSources.sourceKey, key)))[0];
    expect(src.lastVerifiedAt).not.toBeNull();
  });

  it("small adjustor-band change → auto-applies with audit row", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}autoapply`;
    const urdbId = await mkSourceWithTariff(key, 0.1);
    const res = await applyAgentFinding({
      sourceKey: key,
      status: "changed",
      observed: [{ urdbId, energyRates: [{ label: "All hours", ratePerUnit: 0.105 }] }],
      evidence: "sheet shows 0.105 effective this quarter",
    });
    expect(res.action).toBe("auto_applied");
    const row = (await db.select().from(tariffs).where(eq(tariffs.urdbId, urdbId)))[0];
    const st = row.structure as { energy: Array<{ ratePerUnit: number }> };
    expect(st.energy[0].ratePerUnit).toBeCloseTo(0.105, 6);
    expect(row.verifyStatus).toBe("current");
    const audits = await db.select().from(rateVerifications).where(eq(rateVerifications.sourceKey, key));
    expect(audits.some((a) => a.applied)).toBe(true);
  });

  it("large change → flags for review, NEVER mutates the filed rate", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}bigchange`;
    const urdbId = await mkSourceWithTariff(key, 0.1);
    const res = await applyAgentFinding({
      sourceKey: key,
      status: "changed",
      observed: [{ urdbId, energyRates: [{ label: "All hours", ratePerUnit: 0.2 }] }],
      evidence: "sheet shows 0.20 — doubled",
    });
    expect(res.action).toBe("flagged_for_review");
    const row = (await db.select().from(tariffs).where(eq(tariffs.urdbId, urdbId)))[0];
    const st = row.structure as { energy: Array<{ ratePerUnit: number }> };
    expect(st.energy[0].ratePerUnit).toBeCloseTo(0.1, 6); // untouched
    expect(row.verifyStatus).toBe("change_detected");
  });

  it("unreachable → increments failure count only", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}unreach`;
    await mkSourceWithTariff(key, 0.1);
    await applyAgentFinding({ sourceKey: key, status: "unreachable", evidence: "404" });
    await applyAgentFinding({ sourceKey: key, status: "unreachable", evidence: "404" });
    const src = (await db.select().from(rateSources).where(eq(rateSources.sourceKey, key)))[0];
    expect(src.consecutiveFailures).toBe(2);
  });

  it("source_moved → adopts the new URL and resets the fingerprint", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}moved`;
    await mkSourceWithTariff(key, 0.1);
    const res = await applyAgentFinding({
      sourceKey: key,
      status: "source_moved",
      newSourceUrl: "https://example.com/new-location.pdf",
      evidence: "old URL 404s; found at new path",
    });
    expect(res.action).toBe("source_updated");
    const src = (await db.select().from(rateSources).where(eq(rateSources.sourceKey, key)))[0];
    expect(src.sourceUrl).toBe("https://example.com/new-location.pdf");
    expect(src.contentFingerprint).toBeNull();
  });
});

describe("weekly sweep", () => {
  it("detects a fingerprint change and flags governed rows without throwing on unreachable sources", async () => {
    const db = await getDb();
    if (!db) return;
    const key = `${TEST_PREFIX}sweep`;
    const urdbId = `${key}-row`;
    await db.insert(tariffs).values({
      urdbId,
      utilityName: `Util ${key}`,
      name: `Sweep test rate`,
      sector: "residential",
      commodity: "electric",
      state: "ZZ",
      structure: { fixedMonthly: 5, energy: [], demand: [] },
      freshness: "urdb_stale",
      source: "urdb_snapshot_modeled",
    });
    await db.insert(rateSources).values({
      sourceKey: key,
      utilityName: `Util ${key}`,
      commodity: "electric",
      state: "ZZ",
      sourceUrl: "https://sweep-test.invalid/doc.pdf",
      sourceLabel: "Sweep test source",
      governsUrdbIds: [urdbId],
      adjustorCycle: "none",
      verifyCadenceDays: 90,
      contentFingerprint: "old-fingerprint",
      fingerprintAt: Date.now() - 7 * 86_400_000,
      lastVerifiedAt: Date.now(),
    });
    let call = 0;
    const mockFetch: typeof fetch = (async (url: RequestInfo | URL) => {
      call++;
      const u = String(url);
      if (u.includes("sweep-test.invalid")) {
        return new Response("NEW DOCUMENT BYTES", { status: 200, headers: { "content-type": "application/pdf" } });
      }
      // all real registry sources: pretend unreachable so the test is hermetic
      return new Response("err", { status: 503 });
    }) as unknown as typeof fetch;
    const result = await sweepRateSources(Date.now(), mockFetch);
    expect(call).toBeGreaterThan(0);
    expect(result.changed).toContain(key);
    const row = (await db.select().from(tariffs).where(eq(tariffs.urdbId, urdbId)))[0];
    expect(row.verifyStatus).toBe("change_detected");
    // audit row written by the sweep
    const audits = await db.select().from(rateVerifications).where(eq(rateVerifications.sourceKey, key));
    expect(audits.some((a) => a.method === "weekly_fingerprint" && a.status === "change_detected")).toBe(true);
  });
});
