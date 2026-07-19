/**
 * RATE-1..5 + PROV (owner directive Jul 19): national gas/water representative
 * rates — coverage, provenance notation ("actual as able, imputed where
 * required, notated accordingly"), territory-name alignment, and the
 * actual-first resolution ordering contract.
 *
 * These tests are PURE (generator-level) — they pin the seed catalog's shape
 * without a database, so they run in every CI pass and cannot flake on
 * connection state. DB-level seeding idempotency is covered by the seeder's
 * (utilityName, name) upsert identity, exercised in referenceRefresh tests.
 */
import { describe, expect, it } from "vitest";
import { STATE_PROFILES, generateNationalGasWaterTariffs, generateStateGasWaterTariffs } from "./seed/nationalData";

const ALL_STATES = 51; // 50 states + DC

describe("STATE_PROFILES gas/water extension", () => {
  it("covers all 51 jurisdictions with gas and water rates", () => {
    expect(STATE_PROFILES.length).toBe(ALL_STATES);
    for (const p of STATE_PROFILES) {
      expect(p.gasUtilityName, `${p.state} missing gasUtilityName`).toBeTruthy();
      expect(p.gasResPerTherm, `${p.state} missing gasResPerTherm`).toBeGreaterThan(0);
      expect(p.gasCommPerTherm, `${p.state} missing gasCommPerTherm`).toBeGreaterThan(0);
      expect(p.waterPerKgal, `${p.state} missing waterPerKgal`).toBeGreaterThan(0);
    }
  });

  it("keeps gas prices inside a sane $/therm band (0.5–6) and water inside $/kgal band (1.5–15)", () => {
    for (const p of STATE_PROFILES) {
      expect(p.gasResPerTherm!).toBeGreaterThan(0.5);
      expect(p.gasResPerTherm!).toBeLessThan(6);
      expect(p.gasCommPerTherm!).toBeGreaterThan(0.5);
      expect(p.gasCommPerTherm!).toBeLessThan(6);
      expect(p.waterPerKgal!).toBeGreaterThan(1.5);
      expect(p.waterPerKgal!).toBeLessThan(15);
      // Commercial gas is cheaper than residential in virtually every state
      // (volume + lower per-customer delivery cost) — pin the relationship.
      expect(p.gasCommPerTherm!, `${p.state} comm gas should be < res gas`).toBeLessThanOrEqual(p.gasResPerTherm!);
    }
  });
});

describe("generateNationalGasWaterTariffs — coverage + provenance notation", () => {
  const all = generateNationalGasWaterTariffs();
  const gas = all.filter((t) => t.commodity === "gas");
  const water = all.filter((t) => t.commodity === "water");

  it("emits gas rows for every state (res+comm; AZ comm-only, filed rows stay authoritative)", () => {
    const gasStates = new Set(gas.map((t) => t.state));
    expect(gasStates.size).toBe(ALL_STATES);
    // AZ: only the commercial row is generated — the hand-modeled Southwest
    // Gas G-5 residential row must NOT be overwritten by an imputed twin.
    const az = gas.filter((t) => t.state === "AZ");
    expect(az.length).toBe(1);
    expect(az[0].sector).toBe("commercial");
    // Every other state gets residential + commercial.
    for (const st of Array.from(gasStates).filter((s) => s !== "AZ")) {
      const rows = gas.filter((t) => t.state === st);
      expect(rows.map((r) => r.sector).sort()).toEqual(["commercial", "residential"]);
    }
  });

  it("emits water rows for every state except AZ (hand-modeled Phoenix row is authoritative)", () => {
    const waterStates = new Set(water.map((t) => t.state));
    expect(waterStates.size).toBe(ALL_STATES - 1);
    expect(waterStates.has("AZ")).toBe(false);
  });

  it("notates every imputed row: name carries 'state-average imputed', structure notes say IMPUTED + verify", () => {
    for (const t of all) {
      expect(t.name, `${t.state}/${t.commodity} name must disclose imputation`).toContain("state-average imputed");
      const notes = (t.structure as { notes?: string }).notes ?? "";
      expect(notes, `${t.state}/${t.commodity} notes must lead with IMPUTED`).toContain("IMPUTED (state-average)");
      expect(notes.toLowerCase(), `${t.state}/${t.commodity} notes must direct bill verification`).toContain("verify");
    }
  });

  it("state-qualifies gas row names so multi-state LDCs (e.g. Southwest Gas AZ+NV) cannot collide on the (utilityName, name) seed identity", () => {
    const identities = all.map((t) => `${t.utilityName}::${t.name}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const t of gas) {
      expect(t.name, `${t.state} gas name must embed the state`).toContain(`— ${t.state} (`);
    }
  });

  it("prices water per GALLON (cost-engine unit convention), derived from the $/kgal survey figure", () => {
    for (const t of water) {
      const p = STATE_PROFILES.find((s) => s.state === t.state)!;
      const rate = (t.structure as { energy: Array<{ ratePerUnit: number }> }).energy[0].ratePerUnit;
      expect(rate).toBeCloseTo(p.waterPerKgal! / 1000, 6);
      expect(rate).toBeLessThan(0.02); // per-gallon, never per-kgal magnitude
    }
  });

  it("names gas rows for the territory registry's dominant LDC so ZIP → territory → tariff resolution chains by utilityName", () => {
    for (const t of gas) {
      const p = STATE_PROFILES.find((s) => s.state === t.state)!;
      expect(t.utilityName).toBe(p.gasUtilityName);
    }
  });
});

describe("generateStateGasWaterTariffs — skip options honored", () => {
  const az = STATE_PROFILES.find((p) => p.state === "AZ")!;
  it("skipWater omits the water row; skipGas omits gas rows", () => {
    expect(generateStateGasWaterTariffs(az, { skipWater: true }).every((t) => t.commodity === "gas")).toBe(true);
    expect(generateStateGasWaterTariffs(az, { skipGas: true }).every((t) => t.commodity === "water")).toBe(true);
  });
});
