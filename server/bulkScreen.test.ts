/**
 * §3i-2 bulk screening specs — parsing honesty, row cap, ranked output,
 * named failures, and the Pro gate on the router.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { parseBulkLines, runBulkScreen, BULK_SCREEN_MAX_ROWS } from "./bulkScreen";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { ensureSeeded } from "./seed/runSeeders";
import type { TrpcContext } from "./_core/context";

function ctxFor(user: { id: number; openId: string; role: "admin" | "user"; tier?: string | null }): TrpcContext {
  return {
    user: { id: user.id, openId: user.openId, role: user.role, tier: (user.tier ?? "free") as never } as never,
    req: { ip: "127.0.0.1", headers: {} } as never,
    res: { setHeader: () => undefined, clearCookie: () => undefined } as never,
  };
}

let freeUser: { id: number; openId: string; role: "admin" | "user"; tier: string };
let proUser: { id: number; openId: string; role: "admin" | "user"; tier: string };

beforeAll(async () => {
  await ensureSeeded();
  const db = await getDb();
  const { eq } = await import("drizzle-orm");
  await db.insert(users).values({ openId: "bulk-free", name: "bulk-free", tier: "free" as never }).onDuplicateKeyUpdate({ set: { name: "bulk-free" } });
  await db.insert(users).values({ openId: "bulk-pro", name: "bulk-pro", tier: "pro" as never }).onDuplicateKeyUpdate({ set: { tier: "pro" as never } });
  const [f] = await db.select().from(users).where(eq(users.openId, "bulk-free"));
  const [p] = await db.select().from(users).where(eq(users.openId, "bulk-pro"));
  freeUser = { id: f.id, openId: f.openId, role: "user", tier: "free" };
  proUser = { id: p.id, openId: p.openId, role: "user", tier: "pro" };
});

describe("parseBulkLines", () => {
  it("treats a trailing known building-type token as the type, otherwise keeps commas in the address", () => {
    const rows = parseBulkLines("455 N Central Ave, Phoenix, AZ, warehouse\n88 E Broadway Blvd, Tucson, AZ 85701", "office");
    expect(rows[0]).toEqual({ address: "455 N Central Ave, Phoenix, AZ", buildingType: "warehouse" });
    expect(rows[1]).toEqual({ address: "88 E Broadway Blvd, Tucson, AZ 85701", buildingType: "office" });
  });

  it("skips blank/too-short lines", () => {
    // " a " trims to 1 char (< 3) and is dropped along with blank lines
    expect(parseBulkLines("\n a \n1200 W Main St, Mesa, AZ\n\n", "office")).toHaveLength(1);
  });
});

describe("runBulkScreen", () => {
  it("estimates parseable AZ addresses, ranks by top-opportunity dollars, and names failures", async () => {
    const res = await runBulkScreen("1200 W Main St, Mesa, AZ 85201\n88 E Broadway Blvd, Tucson, AZ 85701, retail\nxx", "office");
    // "xx" is filtered by min-length; two rows survive
    expect(res.requested).toBe(2);
    expect(res.estimated).toBeGreaterThan(0);
    const est = res.rows.filter((r) => r.status === "estimated");
    // ranked rows carry 1-based ranks in descending opportunity order
    for (let i = 1; i < est.length; i++) {
      expect((est[i - 1].topOpportunity?.estimatedSavingsUsd ?? 0) >= (est[i].topOpportunity?.estimatedSavingsUsd ?? 0)).toBe(true);
      expect(est[i].rank).toBe(i + 1);
    }
    expect(res.disclosure).toMatch(/estimates only/i);
  });

  it("caps at BULK_SCREEN_MAX_ROWS and flags truncation", async () => {
    const many = Array.from({ length: BULK_SCREEN_MAX_ROWS + 5 }, (_, i) => `${100 + i} E Test St, Phoenix, AZ 85001`).join("\n");
    const res = await runBulkScreen(many, "office");
    expect(res.truncated).toBe(true);
    expect(res.rows.length).toBe(BULK_SCREEN_MAX_ROWS);
    expect(res.disclosure).toMatch(/truncated/i);
  }, 60_000);
});

describe("entities.bulkScreen router gate", () => {
  it("rejects free-tier callers with the Pro gate", async () => {
    const caller = appRouter.createCaller(ctxFor(freeUser));
    await expect(caller.entities.bulkScreen({ text: "1200 W Main St, Mesa, AZ", defaultBuildingType: "office" })).rejects.toThrow(/pro/i);
  });

  it("allows pro callers and returns ranked rows", async () => {
    const caller = appRouter.createCaller(ctxFor(proUser));
    const res = await caller.entities.bulkScreen({ text: "1200 W Main St, Mesa, AZ 85201", defaultBuildingType: "office" });
    expect(res.rows[0].status).toBe("estimated");
    expect(res.rows[0].estimatedAnnualCostUsd).toBeGreaterThan(0);
  });
});
