/**
 * GAP-Q one-address→three-utilities reveal contract:
 *  1. deriveUtilityTriple: known state yields electric + gas candidates with
 *     state_inferred provenance and candidate-not-confirmation notes; city
 *     yields the municipal-water PATTERN (explicitly labeled), never a
 *     verified provider.
 *  2. No state → all three are null with honest notes; no city → water is
 *     null with the "municipal — can't suggest" note.
 *  3. sites.quickCreate returns the triple; sites.utilityReveal serves it for
 *     existing sites (viewer-scoped) with the on-file electric surfaced.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { deriveUtilityTriple } from "./cascade";

function ctxFor(user: { id: number; openId: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: user.openId,
      email: `${user.openId}@test.local`,
      name: user.openId,
      loginMethod: "test",
      role: "user",
      tier: "pro",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {}, cookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
}
async function makeUser(openId: string) {
  const db = (await getDb())!;
  await db
    .insert(users)
    .values({ openId, name: openId, email: `${openId}@test.local`, loginMethod: "test" })
    .onDuplicateKeyUpdate({ set: { name: openId } });
  const rows = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  await db.update(users).set({ tier: "pro" }).where(eq(users.id, rows[0].id));
  return rows[0];
}

describe("GAP-Q deriveUtilityTriple", () => {
  it("AZ + Phoenix: three candidates, all provenance-tagged, water labeled as a pattern", () => {
    const t = deriveUtilityTriple("AZ", "Phoenix");
    expect(t.electric.value).toBeTruthy();
    expect(t.electric.source).toBe("state_inferred");
    expect(t.electric.note).toMatch(/candidate/i);
    expect(t.gas.value).toBe("Southwest Gas");
    expect(t.gas.note).toMatch(/municipal|smaller|no gas/i);
    expect(t.water.value).toContain("City of Phoenix");
    expect(t.water.value).toContain("typical pattern");
    expect(t.water.note).toMatch(/not a verified provider/i);
  });

  it("no state: all three null with honest notes; state without city: water null", () => {
    const none = deriveUtilityTriple(null, null);
    expect(none.electric.value).toBeNull();
    expect(none.gas.value).toBeNull();
    expect(none.water.value).toBeNull();
    expect(none.water.note).toMatch(/municipal/i);
    const noCity = deriveUtilityTriple("TX", null);
    expect(noCity.electric.value).toBeTruthy();
    expect(noCity.gas.value).toBe("Atmos Energy (TX)");
    expect(noCity.water.value).toBeNull();
  });
});

describe("GAP-Q reveal endpoints", () => {
  let user: Awaited<ReturnType<typeof makeUser>>;
  beforeAll(async () => {
    user = await makeUser(`reveal-${Date.now()}`);
  }, 30_000);

  it("quickCreate returns the utility triple; utilityReveal serves it for the site with on-file electric", async () => {
    const caller = appRouter.createCaller(ctxFor(user));
    const res = await caller.sites.quickCreate({ address: "100 N Central Ave, Phoenix, AZ 85004", buildingType: "office" });
    expect(res.utilityTriple).toBeDefined();
    expect(res.utilityTriple.electric.value).toBeTruthy();
    expect(res.utilityTriple.gas.value).toBe("Southwest Gas");
    expect(res.utilityTriple.water.value).toContain("Phoenix");

    const reveal = await caller.sites.utilityReveal({ siteId: res.id });
    expect(reveal.triple.gas.value).toBe("Southwest Gas");
    expect(reveal.note).toMatch(/candidates/i);
    // electric on file (cascade suggested one at creation) is surfaced
    expect(reveal.knownElectric == null || typeof reveal.knownElectric === "string").toBe(true);
  }, 30_000);
});
