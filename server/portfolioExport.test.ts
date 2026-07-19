/**
 * GAP-N portfolio export contracts:
 *  1. portfolioManagerCsv: ESPM header vocabulary, known types map to PM's
 *     picklist, unknown types export as "Other" (Meterly type preserved),
 *     unanalyzed sites keep figures BLANK (never fabricated zeros), and the
 *     modeled-estimates disclaimer rides the final row.
 *  2. reports.portfolioExport (Pro): builds one row per owned site from
 *     persisted data only; free tier is refused with the feature name.
 *  3. reports.portfolioVerified: verified total counts ONLY persisted
 *     implementation verdicts — a site with zero implementations contributes
 *     nothing and does not appear in perSite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { portfolioManagerCsv, type PortfolioExportRow } from "./reports";

function ctxFor(user: { id: number; openId: string }, tier: "free" | "pro" = "pro"): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: "user",
      tier,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
async function makeUser(openId: string, tier: "free" | "pro" = "pro") {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: openId } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.update(users).set({ tier }).where(eq(users.id, rows[0].id));
  return rows[0];
}

describe("GAP-N portfolioManagerCsv shaper", () => {
  const rows: PortfolioExportRow[] = [
    {
      siteId: 1,
      siteName: "HQ, Office",
      buildingType: "office",
      state: "AZ",
      zip: "85004",
      sqft: 20000,
      annualUsageKwh: 300000,
      annualCostUsd: 42000,
      euiKwhPerSqft: 15,
      euiBasis: "good",
      verifiedSavingsUsd: 1200,
      analyzed: true,
    },
    {
      siteId: 2,
      siteName: "Weird Yard",
      buildingType: "car_wash",
      state: "TX",
      zip: null,
      sqft: null,
      annualUsageKwh: null,
      annualCostUsd: null,
      euiKwhPerSqft: null,
      euiBasis: null,
      verifiedSavingsUsd: 0,
      analyzed: false,
    },
  ];
  const csv = portfolioManagerCsv(rows);
  const lines = csv.split("\n");

  it("uses Portfolio Manager vocabulary in the header", () => {
    expect(lines[0]).toContain("Property Name");
    expect(lines[0]).toContain("Primary Function");
    expect(lines[0]).toContain("Gross Floor Area (ft2)");
    expect(lines[0]).toContain("Annual Electricity Use (kWh)");
  });

  it("maps known types to the PM picklist and unknown types to Other with the Meterly type preserved", () => {
    expect(lines[1]).toContain("Office");
    expect(lines[2]).toContain("Other");
    expect(lines[2]).toContain("car_wash");
  });

  it("leaves unanalyzed figures blank — never fabricated zeros — and names the status", () => {
    const cols = lines[2].split(",");
    // sqft, kWh, cost, EUI columns are empty strings
    expect(cols[5]).toBe("");
    expect(cols[6]).toBe("");
    expect(cols[7]).toBe("");
    expect(cols[8]).toBe("");
    expect(lines[2]).toContain("not yet analyzed");
  });

  it("quotes commas correctly and carries the disclaimer on the final row", () => {
    expect(lines[1].startsWith('"HQ, Office"')).toBe(true);
    expect(lines[lines.length - 1].toLowerCase()).toContain("estimate");
  });
});

describe("GAP-N portfolio endpoints", () => {
  let pro: Awaited<ReturnType<typeof makeUser>>;
  let free: Awaited<ReturnType<typeof makeUser>>;
  beforeAll(async () => {
    const run = Date.now();
    pro = await makeUser(`espm-pro-${run}`, "pro");
    free = await makeUser(`espm-free-${run}`, "free");
    const pc = appRouter.createCaller(ctxFor(pro));
    await pc.sites.create({ name: "Export site", state: "AZ", buildingType: "office", sqft: 10_000 });
  }, 60_000);

  it("portfolioExport returns one row per owned site; free tier is refused by feature name", async () => {
    const pc = appRouter.createCaller(ctxFor(pro));
    const res = await pc.reports.portfolioExport();
    expect(res.siteCount).toBe(1);
    expect(res.csv.split("\n")[1]).toContain("Export site");

    const fc = appRouter.createCaller(ctxFor(free, "free"));
    await expect(fc.reports.portfolioExport()).rejects.toThrow(/portfolio manager export/i);
  });

  it("portfolioVerified counts only persisted implementation verdicts", async () => {
    const pc = appRouter.createCaller(ctxFor(pro));
    const v = await pc.reports.portfolioVerified();
    expect(v.siteCount).toBe(1);
    expect(v.verifiedTotalUsd).toBe(0);
    expect(v.perSite.length).toBe(0); // no implementations → no ledger rows
  });
});
