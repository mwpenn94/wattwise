/**
 * GAP-O pin-drop / prospective-site mode contract:
 *  1. quickCreate accepts pinLat/pinLng + prospective and persists them — the
 *     site row carries prospective=1 and the pin coordinates (no verified place).
 *  2. The intake-assumptions insight discloses the prospective frame explicitly
 *     (modeled what-if, never a claim of occupancy) and records it in provenance.
 *  3. Default (no flag) stays prospective=0 — existing intake is unchanged.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import * as h from "./dbHelpers";

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

let user: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  user = await makeUser(`pindrop-${Date.now()}`);
}, 60_000);

describe("GAP-O pin-drop / prospective-site mode", () => {
  it("persists prospective flag + pin coordinates and discloses the modeled-only frame", async () => {
    const caller = appRouter.createCaller(ctxFor(user));
    const res = await caller.sites.quickCreate({
      address: "Pinned location (33.4484, -112.0740)",
      buildingType: "single_family",
      pinLat: 33.4484,
      pinLng: -112.074,
      prospective: true,
    });
    const site = await h.getSite(res.id, user.id);
    expect(site.prospective).toBe(1);
    expect(site.lat).toBeCloseTo(33.4484, 3);
    expect(site.lng).toBeCloseTo(-112.074, 3);

    const insights = await h.listInsights(res.id, user.id);
    const intake = insights.find((i) => i.kind === "intake_assumptions");
    expect(intake).toBeDefined();
    expect(intake!.body).toContain("PROSPECTIVE SITE");
    expect(intake!.body).toContain("modeled what-if");
    const prov = intake!.provenance as Record<string, unknown>;
    expect(prov.prospective).toBe(true);
    expect(prov.pinDropped).toBe(true);
  });

  it("defaults to prospective=0 with no pin fields — existing intake unchanged", async () => {
    const caller = appRouter.createCaller(ctxFor(user));
    const res = await caller.sites.quickCreate({
      address: "123 Main St, Phoenix, AZ 85004",
      buildingType: "office",
    });
    const site = await h.getSite(res.id, user.id);
    expect(site.prospective).toBe(0);
    const insights = await h.listInsights(res.id, user.id);
    const intake = insights.find((i) => i.kind === "intake_assumptions");
    expect(intake!.body).not.toContain("PROSPECTIVE SITE");
    expect((intake!.provenance as Record<string, unknown>).prospective).toBe(false);
  });
});
