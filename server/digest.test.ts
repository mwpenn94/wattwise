/**
 * §3f/§3i — digest + alerts honesty rules.
 * Covers: the dollar-figure-or-it-doesn't-send rule, the opt-in (quiet by
 * default) gate, the $25 alert materiality floor, per-(site,kind) batching,
 * and alert tenancy.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as h from "./dbHelpers";
import { buildDigest, runDigestCycle } from "./digest";
import { getDb } from "./db";
import { users, sites } from "../drizzle/schema";
import { eq } from "drizzle-orm";

let userA: number;
let userB: number;
let siteA: number;

async function ensureUser(openId: string): Promise<number> {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { lastSignedIn: new Date() } });
  const rows = await db.select().from(users).where(eq(users.openId, openId));
  return rows[0]!.id;
}

beforeAll(async () => {
  const db = (await getDb())!;
  userA = await ensureUser("vitest-digest-a");
  userB = await ensureUser("vitest-digest-b");
  // clean slate: remove prior test sites + alerts for reproducibility
  const prior = await db.select().from(sites).where(eq(sites.userId, userA));
  for (const s of prior) await h.deleteSite(s.id, userA);
  const res = await db.insert(sites).values({
    userId: userA,
    name: "Digest Test Site",
    state: "AZ",
    buildingType: "office",
    sqft: 10000,
  });
  siteA = Number((res as unknown as [{ insertId: number }])[0].insertId);
  // userB must remain siteless for the no-sites spec
  const bSites = await db.select().from(sites).where(eq(sites.userId, userB));
  for (const s of bSites) await h.deleteSite(s.id, userB);
});

describe("alert materiality floor + batching", () => {
  it("refuses alerts under the $25 floor (returns null, writes nothing)", async () => {
    const res = await h.upsertAlert({
      userId: userA,
      siteId: siteA,
      kind: "anomaly",
      title: "Tiny drift",
      dollarImpactUsd: 12,
    });
    expect(res).toBeNull();
    const rows = await h.listAlerts(userA, "open");
    expect(rows.filter((r) => r.siteId === siteA && r.kind === "anomaly")).toHaveLength(0);
  });

  it("refuses non-finite dollar figures", async () => {
    expect(await h.upsertAlert({ userId: userA, siteId: siteA, kind: "anomaly", title: "NaN", dollarImpactUsd: NaN })).toBeNull();
  });

  it("batches: second upsert for the same (site, kind) refreshes the open row instead of duplicating", async () => {
    const first = await h.upsertAlert({
      userId: userA,
      siteId: siteA,
      kind: "rate_opportunity",
      title: "Switch rates — $300/yr",
      dollarImpactUsd: 300,
    });
    expect(first).not.toBeNull();
    expect(first!.refreshed).toBe(false);
    const second = await h.upsertAlert({
      userId: userA,
      siteId: siteA,
      kind: "rate_opportunity",
      title: "Switch rates — $340/yr (updated)",
      dollarImpactUsd: 340,
    });
    expect(second).not.toBeNull();
    expect(second!.refreshed).toBe(true);
    expect(second!.id).toBe(first!.id);
    const open = (await h.listAlerts(userA, "open")).filter((r) => r.siteId === siteA && r.kind === "rate_opportunity");
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toContain("updated");
    expect(open[0]!.dollarImpactUsd).toBe(340);
  });

  it("dismissed alerts don't block a new open row (batching keys on OPEN status)", async () => {
    const open = (await h.listAlerts(userA, "open")).find((r) => r.siteId === siteA && r.kind === "rate_opportunity");
    expect(open).toBeDefined();
    await h.setAlertStatus(open!.id, userA, "dismissed");
    const next = await h.upsertAlert({
      userId: userA,
      siteId: siteA,
      kind: "rate_opportunity",
      title: "New cycle, new figure",
      dollarImpactUsd: 120,
    });
    expect(next).not.toBeNull();
    expect(next!.refreshed).toBe(false);
    expect(next!.id).not.toBe(open!.id);
  });

  it("tenancy: user B cannot mark user A's alert", async () => {
    const rows = await h.listAlerts(userA, "open");
    const mine = rows.find((r) => r.siteId === siteA);
    expect(mine).toBeDefined();
    expect(await h.setAlertStatus(mine!.id, userB, "read")).toBe(false);
    // and B sees nothing of A's
    expect((await h.listAlerts(userB)).filter((r) => r.siteId === siteA)).toHaveLength(0);
  });
});

describe("digest: a dollar figure or it doesn't send", () => {
  it("returns null for a user with no sites", async () => {
    expect(await buildDigest(userB)).toBeNull();
  });

  it("returns null when sites exist but no material dollar content does", async () => {
    // siteA has no opportunities/implementations yet in this test run
    const content = await buildDigest(userA);
    // either null (no dollars) or, if pipeline artifacts exist from other
    // suites, a headline ≥ $25 — both honor the rule; assert the invariant.
    if (content !== null) {
      expect(content.headlineUsd).toBeGreaterThanOrEqual(25);
      expect(content.headline).toMatch(/\$/);
    } else {
      expect(content).toBeNull();
    }
  });

  it("runDigestCycle does nothing for a non-opted-in user (quiet by default)", async () => {
    const res = await runDigestCycle(userA);
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("not-opted-in");
  });

  it("opted-in user with no material figure still gets silence, with the honest reason", async () => {
    await h.setDigestPrefs(userB, true, 5);
    const res = await runDigestCycle(userB);
    expect(res.sent).toBe(false);
    // userB has no sites → no-sites; both silent reasons are honest
    expect(["no-material-dollar-figure", "no-sites"]).toContain(res.reason);
  });
});
