import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listTariffs: vi.fn(), getArchetype: vi.fn(), getBenchmark: vi.fn() }));
vi.mock("./dbHelpers", () => mocks);
import { computeAddressEstimate } from "./estimate";
import { SEED_TARIFFS } from "./seed/seedData";

const input = { formattedAddress: "301 N 1st St, Kingman, AZ 86401", city: "Kingman", state: "AZ", zip: "86401", placeVerified: true, buildingType: "office", sqft: 10000 };
beforeEach(() => {
  mocks.getArchetype.mockResolvedValue({ shape8760: Array(8760).fill(1 / 8760), annualUsePerSqft: 20 });
  mocks.getBenchmark.mockResolvedValue(null);
});

describe("anonymous estimates preserve filed tariff gates", () => {
  it.each(["office", "school", "daycare"])("never chooses unconfirmed K12-only or SGS plans for %s", async (buildingType) => {
    mocks.listTariffs.mockResolvedValue(SEED_TARIFFS.filter((t) => ["uns-egmgsst", "uns-egsgs"].includes(t.urdbId)).map((t, id) => ({ ...t, id })));
    const r = await computeAddressEstimate({ ...input, buildingType });
    expect(r.grounding.tariff.name).toBeNull();
    expect(r.grounding.tariff.note).toContain("state-average");
    expect(r.estimatedAnnualCostUsd).toBeGreaterThan(0);
  });
});
