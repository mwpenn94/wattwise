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
  it.each(["office", "daycare"])("never chooses the K12-only plan or a migration-barred SGS plan for a non-school %s", async (buildingType) => {
    mocks.listTariffs.mockResolvedValue(SEED_TARIFFS.filter((t) => ["uns-egmgsst", "uns-egsgs"].includes(t.urdbId)).map((t, id) => ({ ...t, id })));
    const r = await computeAddressEstimate({ ...input, buildingType });
    expect(r.grounding.tariff.name).toBeNull();
    expect(r.grounding.tariff.note).toContain("state-average");
    expect(r.estimatedAnnualCostUsd).toBeGreaterThan(0);
  });
  it("prices a school on the K12 filed schedule (a stated condition, not a blocker) and never on the migration-barred SGS plan", async () => {
    mocks.listTariffs.mockResolvedValue(SEED_TARIFFS.filter((t) => ["uns-egmgsst", "uns-egsgs"].includes(t.urdbId)).map((t, id) => ({ ...t, id })));
    const r = await computeAddressEstimate({ ...input, buildingType: "school" });
    expect(r.grounding.tariff.name).toContain("EGMGSST");
    expect(r.estimatedAnnualCostUsd).toBeGreaterThan(0);
  });
});
