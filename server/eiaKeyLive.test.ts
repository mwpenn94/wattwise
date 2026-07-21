/**
 * KEY-1 (Jul 21) — live validation that the configured EIA_API_KEY works.
 *
 * Unlike eiaRefresh.test.ts (mocked fetch), this spec hits the real EIA v2
 * API using the secret set in the environment. It self-skips when the key is
 * absent so CI without secrets stays green, but with the key present it
 * asserts the full drift check runs end-to-end against live data.
 */
import { describe, expect, it } from "vitest";
import { checkEiaRateDrift } from "./eiaRefresh";

const hasKey = Boolean(process.env.EIA_API_KEY);

describe("EIA_API_KEY live validation", () => {
  it.skipIf(!hasKey)(
    "runs the real drift check against live EIA data",
    async () => {
      const result = await checkEiaRateDrift();
      expect(result.ran).toBe(true);
      // Both upstream families should have responded without errors.
      expect(result.errors).toBeUndefined();
      // A real key yields real data: dozens of states compared, with the
      // upstream periods recorded.
      expect(result.checkedStates ?? 0).toBeGreaterThan(20);
      expect(result.electricPeriod).toMatch(/^\d{4}/);
      expect(result.gasPeriod).toMatch(/^\d{4}/);
      // drifted is a well-formed array (may or may not be empty — that's the
      // point of the detector).
      expect(Array.isArray(result.drifted)).toBe(true);
    },
    60_000,
  );

  it.skipIf(hasKey)("skips honestly when no key is configured", async () => {
    const result = await checkEiaRateDrift();
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("no_api_key");
  });
});
