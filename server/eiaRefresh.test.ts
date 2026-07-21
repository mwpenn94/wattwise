/**
 * NEXT-4 — EIA live drift check.
 *
 * Verifies the gate (no key → honest skip), the drift math against seeded
 * STATE_PROFILES values, and that upstream failure degrades to an error
 * report instead of a throw. fetch is stubbed; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIFT_THRESHOLD, checkEiaRateDrift } from "./eiaRefresh";
import { STATE_PROFILES } from "./seed/nationalData";

const AZ = STATE_PROFILES.find((p) => p.state === "AZ")!;

function eiaResponse(data: unknown[]) {
  return {
    ok: true,
    json: async () => ({ response: { data } }),
  } as Response;
}

describe("checkEiaRateDrift", () => {
  const originalKey = process.env.EIA_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.EIA_API_KEY = "test-key";
  });
  afterEach(() => {
    if (originalKey == null) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips honestly when no API key is configured", async () => {
    delete process.env.EIA_API_KEY;
    const out = await checkEiaRateDrift();
    expect(out.ran).toBe(false);
    expect(out.reason).toContain("no_api_key");
  });

  it("reports no drift when live prices match the seeded catalog", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/electricity/retail-sales/")) {
        return eiaResponse([
          { period: "2026-04", stateid: "AZ", sectorid: "RES", price: AZ.resRateCents },
          { period: "2026-04", stateid: "AZ", sectorid: "COM", price: AZ.commRateCents },
        ]);
      }
      // natural gas: value is $/Mcf; seeded is $/therm → multiply back by 10.37
      if (url.includes("facets%5Bprocess%5D%5B%5D=PRS") || url.includes("facets[process][]=PRS")) {
        return eiaResponse([{ period: "2026-04", duoarea: "SAZ", value: (AZ.gasResPerTherm ?? 1) * 10.37 }]);
      }
      return eiaResponse([{ period: "2026-04", duoarea: "SAZ", value: (AZ.gasCommPerTherm ?? 1) * 10.37 }]);
    }) as typeof fetch;

    const out = await checkEiaRateDrift();
    expect(out.ran).toBe(true);
    expect(out.electricPeriod).toBe("2026-04");
    expect(out.drifted).toEqual([]);
    expect(out.checkedStates).toBeGreaterThan(0);
  });

  it("flags a state whose live rate drifted beyond the threshold", async () => {
    const inflated = AZ.resRateCents * (1 + DRIFT_THRESHOLD + 0.1); // ~20% above seeded
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/electricity/retail-sales/")) {
        return eiaResponse([{ period: "2026-05", stateid: "AZ", sectorid: "RES", price: inflated }]);
      }
      return eiaResponse([]);
    }) as typeof fetch;

    const out = await checkEiaRateDrift();
    expect(out.ran).toBe(true);
    const hit = (out.drifted ?? []).find((d) => d.state === "AZ" && d.metric === "electric_res_cents_kwh");
    expect(hit).toBeDefined();
    expect(hit!.seeded).toBe(AZ.resRateCents);
    expect(hit!.driftPct).toBeGreaterThan(DRIFT_THRESHOLD);
  });

  it("degrades to an error report when EIA is unreachable (never throws)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("EIA down");
    }) as typeof fetch;

    const out = await checkEiaRateDrift();
    expect(out.ran).toBe(true);
    expect(out.errors?.length).toBeGreaterThan(0);
    expect(out.drifted).toEqual([]);
  });
});
