/**
 * CUR/EIA (Jul 19) — currency maintenance for reference data.
 * Covers: national territory lookups (EIA-861 ingest), refresh idempotency,
 * versioned supersession of stale vintages, and incentive catalog
 * verification (freshness stamping + expiry flagging).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// In-memory stand-in for the service_territories table.
interface Row {
  id: number;
  zip3: string;
  state: string;
  commodity: string;
  utilityName: string;
  sourceVersion: string | null;
  lastVerifiedAt: number | null;
}
let rows: Row[] = [];
let nextId = 1;

vi.mock("./db", () => ({
  getDb: async () => ({
    select: (proj?: Record<string, unknown>) => ({
      from: () => {
        const chain = {
          where: (_cond: unknown) => Promise.resolve(applyWhere(_cond)),
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (resolve: (v: Row[]) => void) => resolve([...rows]),
        };
        return chain;
      },
    }),
    insert: () => ({
      values: (vals: Omit<Row, "id"> | Array<Omit<Row, "id">>) => {
        const list = Array.isArray(vals) ? vals : [vals];
        for (const v of list) rows.push({ ...(v as Omit<Row, "id">), id: nextId++ } as Row);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (cond: unknown) => {
          const ids = idsFromCond(cond);
          rows = rows.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r));
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (cond: unknown) => {
        const ids = idsFromCond(cond);
        rows = rows.filter((r) => !ids.includes(r.id));
        return Promise.resolve();
      },
    }),
  }),
}));

// drizzle `and(eq(zip3,..), eq(commodity,..))` / `eq(id, n)` produce opaque
// objects; capture the calls instead by mocking drizzle-orm operators.
let lastFilters: Record<string, unknown> = {};
vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    eq: (col: { name?: string }, val: unknown) => ({ __eq: colName(col), val }),
    and: (...conds: unknown[]) => ({ __and: conds }),
    ne: (col: { name?: string }, val: unknown) => ({ __ne: colName(col), val }),
  };
});

function colName(col: { name?: string } | unknown): string {
  const c = col as { name?: string };
  return c?.name ?? "";
}
function applyWhere(cond: unknown): Row[] {
  const conds = (cond as { __and?: unknown[] })?.__and ?? [cond];
  return rows.filter((r) =>
    conds.every((c) => {
      const e = c as { __eq?: string; val?: unknown };
      if (!e.__eq) return true;
      const key = e.__eq === "utility_name" ? "utilityName" : e.__eq === "source_version" ? "sourceVersion" : e.__eq;
      return (r as unknown as Record<string, unknown>)[key] === e.val;
    })
  );
}
function idsFromCond(cond: unknown): number[] {
  const e = cond as { __eq?: string; val?: unknown };
  if (e?.__eq === "id") return [e.val as number];
  return [];
}

import { refreshServiceTerritories, lookupTerritory, territoryFreshness } from "./serviceTerritories";
import { NATIONAL_SOURCE_VERSION } from "./serviceTerritoriesData";

beforeEach(() => {
  rows = [];
  nextId = 1;
});

describe("national territory registry (EIA-861 ingest)", () => {
  it("covers a national ZIP3 — Manhattan (100) electric served by Con Edison", async () => {
    await refreshServiceTerritories(1000);
    const res = await lookupTerritory("10001", "electric");
    expect(res.covered).toBe(true);
    expect(res.served).toBe(true);
    expect(res.utilities.join("|")).toContain("Con Edison");
    expect(res.sourceVersion).toBe(NATIONAL_SOURCE_VERSION);
  });

  it("imputes gas ABSENT for rural Alaska (997) — positively-unserved sentinel", async () => {
    await refreshServiceTerritories(1000);
    const res = await lookupTerritory("99701", "gas");
    expect(res.covered).toBe(true);
    expect(res.served).toBe(false);
    expect(res.utilities).toHaveLength(0);
  });

  it("keeps the honesty contract for uncovered lookups — no ZIP → uncovered, fall back to state level", async () => {
    await refreshServiceTerritories(1000);
    const res = await lookupTerritory(null, "gas");
    expect(res.covered).toBe(false);
    expect(res.served).toBeNull();
  });

  it("preserves hand-curated AZ detail (Phoenix 850 has APS + SRP electric)", async () => {
    await refreshServiceTerritories(1000);
    const res = await lookupTerritory("85004", "electric");
    expect(res.utilities).toEqual(expect.arrayContaining([
      expect.stringContaining("APS"),
      expect.stringContaining("SRP"),
    ]));
  });
});

describe("scheduled refresh — idempotency and supersession", () => {
  it("second run inserts nothing and re-verifies everything", async () => {
    const first = await refreshServiceTerritories(1000);
    expect(first.inserted).toBeGreaterThan(3000);
    const second = await refreshServiceTerritories(2000);
    expect(second.inserted).toBe(0);
    expect(second.verified).toBe(first.inserted);
    expect(second.superseded).toBe(0);
  });

  it("supersedes rows from an older vintage that the current catalog no longer asserts", async () => {
    rows.push({ id: nextId++, zip3: "857", state: "AZ", commodity: "gas", utilityName: "Defunct Gas Co", sourceVersion: "eia861-2023.old", lastVerifiedAt: 1 });
    const result = await refreshServiceTerritories(5000);
    expect(result.superseded).toBe(1);
    const res = await lookupTerritory("85701", "gas");
    expect(res.utilities.join("|")).not.toContain("Defunct");
    expect(res.served).toBe(true); // Southwest Gas still asserted
  });

  it("stamps lastVerifiedAt so freshness is disclosable", async () => {
    await refreshServiceTerritories(777777);
    const f = await territoryFreshness();
    expect(f).not.toBeNull();
    expect(f!.lastVerifiedAt).toBe(777777);
    expect(f!.sourceVersion).toBe(NATIONAL_SOURCE_VERSION);
    expect(f!.rows).toBeGreaterThan(3000);
  });

  it("national catalog covers major metros after refresh (Chicago gas)", async () => {
    // Note: seedServiceTerritories() caches a module-level seededOnce flag,
    // so within this suite (which already refreshed) we assert via refresh —
    // the production boot path calls seed on an empty table equivalently.
    await refreshServiceTerritories(1000);
    const res = await lookupTerritory("60601", "gas"); // Chicago
    expect(res.covered).toBe(true);
    expect(res.served).toBe(true);
    expect(res.utilities.join("|")).toContain("Gas");
  });
});
