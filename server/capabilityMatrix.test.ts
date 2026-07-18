/**
 * v1.17 §5.0(a) + v2.8 §1 — capability matrix / ladder-as-contract specs.
 *
 * The accuracy ladder must be GENERATED from the capability matrix, and every
 * rung must name the specific insights it unlocks in advance. Over-promising
 * here poisons the core loop (v2.8 P75) — so these specs pin: (1) rung shape
 * and ordering, (2) every rung after Estimate names ≥1 concrete unlock,
 * (3) unlock names match matrix rows exactly (the announcement can never
 * drift from the source of truth), (4) cell-state math is monotone (once
 * unlocked, never re-locked at a higher rung).
 */
import { describe, expect, it } from "vitest";
import {
  INSIGHT_CLASSES,
  RUNG_ORDER,
  buildAccuracyLadder,
  cellState,
  nextRungContract,
  unlockedAtRung,
  type DataRung,
} from "../shared/capabilityMatrix";
import { ACCURACY_LADDER } from "./estimate";

const RUNGS: DataRung[] = ["estimate", "good", "great", "measured"];

describe("capability matrix (v1.17 §5.0a)", () => {
  it("every insight class unlocks at a valid rung with a cited gate", () => {
    for (const row of INSIGHT_CLASSES) {
      expect(RUNGS).toContain(row.unlockedAt);
      expect(row.gate.length).toBeGreaterThan(10);
      // degradedAt rungs must strictly precede the unlock rung
      for (const d of row.degradedAt ?? []) {
        expect(RUNG_ORDER[d]).toBeLessThan(RUNG_ORDER[row.unlockedAt]);
      }
    }
  });

  it("cell state is monotone: once unlocked, never re-locked at a higher rung", () => {
    for (const row of INSIGHT_CLASSES) {
      let seenUnlocked = false;
      for (const rung of RUNGS) {
        const s = cellState(row, rung);
        if (seenUnlocked) expect(s).toBe("unlocked");
        if (s === "unlocked") seenUnlocked = true;
      }
      expect(seenUnlocked).toBe(true); // every class unlocks somewhere
    }
  });

  it("every class is reachable: unlockedAtRung partitions the matrix", () => {
    const total = RUNGS.reduce((n, r) => n + unlockedAtRung(r).length, 0);
    expect(total).toBe(INSIGHT_CLASSES.length);
  });
});

describe("ladder-as-contract (v2.8 §1)", () => {
  const ladder = buildAccuracyLadder();

  it("has the four rungs in order with unlock lists", () => {
    expect(ladder.map((r) => r.rung)).toEqual(["estimate", "good", "great", "measured"]);
    for (const rung of ladder) {
      expect(Array.isArray(rung.unlocks)).toBe(true);
      expect(rung.unlockedBy.length).toBeGreaterThan(5);
    }
  });

  it("every rung names at least one concrete insight it unlocks — the contract, never vague encouragement", () => {
    for (const rung of ladder) {
      expect(rung.unlocks.length).toBeGreaterThan(0);
    }
  });

  it("unlock names come verbatim from matrix rows — announcement can never drift from the source of truth", () => {
    const names = new Set(INSIGHT_CLASSES.map((r) => r.name));
    for (const rung of ladder) {
      for (const u of rung.unlocks) expect(names.has(u)).toBe(true);
    }
  });

  it("estimate.ts ACCURACY_LADDER IS the generated ladder (no drift)", () => {
    expect(ACCURACY_LADDER).toEqual(ladder);
  });

  it("measured rung names the interval-only insight classes (demand analytics, peak story, full tariff sweep)", () => {
    const measured = ladder.find((r) => r.rung === "measured")!;
    const joined = measured.unlocks.join(" | ").toLowerCase();
    expect(joined).toContain("demand");
    expect(joined).toContain("peak");
    expect(joined).toContain("tariff");
  });

  it("nextRungContract names the next upload and its unlocks; null at the top", () => {
    const c = nextRungContract("great");
    expect(c).toContain("Interval data");
    expect(c).toContain("→");
    expect(nextRungContract("measured")).toBeNull();
  });
});
