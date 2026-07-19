/**
 * SVC — per-commodity service applicability ladder (owner reports Jul 19).
 * Verifies each tier: user override (both directions), meter evidence,
 * user-confirmed equipment evidence (gas), territory imputation from the
 * seeded tariff snapshot, and the commodity defaults (gas never assumed;
 * electric/water plausible-active).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMeters: vi.fn(),
  listEquipment: vi.fn(),
  listTariffs: vi.fn(),
}));

vi.mock("./dbHelpers", () => ({
  listMeters: mocks.listMeters,
  listEquipment: mocks.listEquipment,
  listTariffs: mocks.listTariffs,
}));

import { resolveCommodityService, resolveAllCommodityServices } from "./commodityService";

const site = (over: Partial<{ state: string | null; servicesProfile: unknown }> = {}) => ({
  id: 1,
  state: "AZ",
  utilityName: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMeters.mockResolvedValue([]);
  mocks.listEquipment.mockResolvedValue([]);
  // Default territory: state has utilities for every commodity → falls through.
  mocks.listTariffs.mockResolvedValue([{ utilityName: "X Utility" }]);
});

describe("tier 1 — user override", () => {
  it("override 'none' blocks analysis even when a meter exists", async () => {
    mocks.listMeters.mockResolvedValue([{ commodity: "gas" }]);
    const res = await resolveCommodityService(site({ servicesProfile: { gas: "none" } }), 7, "gas");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("user_override");
    expect(res.reason).toContain("no gas service");
  });

  it("override 'active' unlocks gas without any evidence", async () => {
    const res = await resolveCommodityService(site({ servicesProfile: { gas: "active" } }), 7, "gas");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("user_override");
  });

  it("override 'none' turns water off despite the plausible-active default", async () => {
    const res = await resolveCommodityService(site({ servicesProfile: { water: "none" } }), 7, "water");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("user_override");
  });

  it("override 'unknown' clears the override and falls to lower tiers", async () => {
    const res = await resolveCommodityService(site({ servicesProfile: { gas: "unknown" } }), 7, "gas");
    expect(res.basis).not.toBe("user_override");
    expect(res.analyze).toBe(false); // gas default: never assumed
  });
});

describe("tier 2 — direct evidence", () => {
  it("a gas meter proves gas active", async () => {
    mocks.listMeters.mockResolvedValue([{ commodity: "gas" }]);
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("meter_evidence");
  });

  it("user-confirmed gas equipment proves gas active without a meter", async () => {
    mocks.listEquipment.mockResolvedValue([{ source: "user_confirmed", label: "Gas boiler / furnace", notes: null }]);
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("equipment_evidence");
  });

  it("INFERRED gas equipment is excluded (circular with meter presence)", async () => {
    mocks.listEquipment.mockResolvedValue([{ source: "inferred", label: "Gas furnace", notes: null }]);
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("default");
  });
});

describe("tier 3 — territory imputation", () => {
  it("no gas utility in the state's snapshot → gas imputed absent, disclosed", async () => {
    mocks.listTariffs.mockResolvedValue([]);
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("territory_imputed");
    expect(res.reason).toContain("seeded tariff snapshot");
  });

  it("a populated gas territory only means plausible — falls to the gas default (skip)", async () => {
    mocks.listTariffs.mockResolvedValue([{ utilityName: "Southwest Gas" }]);
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("default");
  });

  it("territory lookup failure never blocks resolution", async () => {
    mocks.listTariffs.mockRejectedValue(new Error("db down"));
    const res = await resolveCommodityService(site(), 7, "water");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("default");
  });
});

describe("tier 4 — commodity defaults", () => {
  it("electric defaults to plausible-active with the assumption disclosed", async () => {
    const res = await resolveCommodityService(site(), 7, "electric");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("default");
    expect(res.reason).toContain("grid electricity");
  });

  it("water defaults to plausible-active", async () => {
    const res = await resolveCommodityService(site(), 7, "water");
    expect(res.analyze).toBe(true);
    expect(res.basis).toBe("default");
  });

  it("gas defaults to NOT analyzed — dual fuel is never assumed", async () => {
    const res = await resolveCommodityService(site(), 7, "gas");
    expect(res.analyze).toBe(false);
    expect(res.basis).toBe("default");
    expect(res.reason).toContain("never assumed");
  });
});

describe("resolveAllCommodityServices", () => {
  it("returns all three commodities with independent resolutions", async () => {
    mocks.listMeters.mockResolvedValue([{ commodity: "electric" }]);
    const all = await resolveAllCommodityServices(site({ servicesProfile: { water: "none" } }), 7);
    expect(all.electric.analyze).toBe(true);
    expect(all.electric.basis).toBe("meter_evidence");
    expect(all.gas.analyze).toBe(false);
    expect(all.water.analyze).toBe(false);
    expect(all.water.basis).toBe("user_override");
  });
});
