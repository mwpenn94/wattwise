/**
 * NEXT-4 (Jul 21) — live EIA drift check for the state-average rate catalog.
 *
 * Design decision (documented in the backlog synthesis): the seeded catalog in
 * STATE_PROFILES stays the single authority for state-average rates — it is
 * code-reviewed data, and the weekly reassertNationalRates pass re-emits DB
 * rows from it, so any runtime mutation of those rows would be silently
 * clobbered on the next re-assert. Instead of mutating, this module DETECTS
 * drift: when an EIA_API_KEY is configured it pulls the latest EIA v2
 * state-average retail electricity prices (residential + commercial) and
 * natural-gas prices, compares them against the seeded values, and returns a
 * drift report. Material drift lands in the owner notification so the seed
 * data gets updated deliberately (code change) rather than silently.
 *
 * Without a key the check is skipped honestly — the existing vintage
 * re-assert and freshness cadence sweep still run, and the response says
 * exactly why the live check did not happen. The key is free:
 * https://www.eia.gov/opendata/register.php
 */
import { STATE_PROFILES } from "./seed/nationalData";
import { getDb } from "./db";
import { seedFreshness } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const EIA_BASE = "https://api.eia.gov/v2";
const FETCH_TIMEOUT_MS = 20_000;

/** Drift beyond this fraction of the seeded value is reported (10%). Rate
 * vintages naturally wander a few percent between annual updates; 10% means
 * the seeded number is materially misleading for dollar estimates. */
export const DRIFT_THRESHOLD = 0.1;

export interface StateDrift {
  state: string;
  metric: "electric_res_cents_kwh" | "electric_comm_cents_kwh" | "gas_res_usd_therm" | "gas_comm_usd_therm";
  seeded: number;
  live: number;
  driftPct: number;
  period: string;
}

export interface EiaRefreshResult {
  ran: boolean;
  reason?: string;
  checkedStates?: number;
  drifted?: StateDrift[];
  electricPeriod?: string;
  gasPeriod?: string;
  errors?: string[];
}

interface EiaSeriesRow {
  period: string;
  stateid?: string;
  duoarea?: string;
  sectorid?: string;
  process?: string;
  price?: number | string | null;
  value?: number | string | null;
}

async function eiaFetch(path: string, params: Record<string, string | string[]>, apiKey: string): Promise<EiaSeriesRow[]> {
  const url = new URL(`${EIA_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, v);
  }
  // EIA's API intermittently returns HTTP 500 ("Something unexpected
  // happened.") for queries that succeed seconds later — observed live on
  // Jul 21 2026: identical request 500'd then 200'd on retry. One retry with a
  // short backoff absorbs the flake without masking a real outage (a second
  // 5xx still surfaces as an error into the drift report).
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "Meterly/1.0 (rate drift check)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { response?: { data?: EiaSeriesRow[] } };
      return body.response?.data ?? [];
    }
    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    throw new Error(`EIA ${path} HTTP ${res.status}`);
  }
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Latest-period map: stateId → price, plus the period label used. */
function latestByState(rows: EiaSeriesRow[], stateKey: "stateid" | "duoarea", valueKey: "price" | "value"): { byState: Map<string, number>; period: string | null } {
  // rows arrive sorted desc by period (we request that); first occurrence per state wins
  const byState = new Map<string, number>();
  let period: string | null = null;
  for (const r of rows) {
    const rawState = r[stateKey];
    if (!rawState) continue;
    // duoarea for NG is like "SAL" (S + state); normalize to the 2-letter code
    const st = stateKey === "duoarea" ? rawState.replace(/^S/, "") : rawState;
    if (st.length !== 2) continue;
    const p = num(r[valueKey]);
    if (p == null) continue;
    if (!byState.has(st)) {
      byState.set(st, p);
      if (period == null) period = r.period;
    }
  }
  return { byState, period };
}

/**
 * Run the live drift check. Gated on EIA_API_KEY — absent key returns
 * { ran: false } with the reason, never throws.
 */
export async function checkEiaRateDrift(now = Date.now()): Promise<EiaRefreshResult> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return { ran: false, reason: "no_api_key — set EIA_API_KEY (free at eia.gov/opendata) to enable live rate drift checks" };
  }
  const errors: string[] = [];

  // Electricity: EIA v2 retail-sales, monthly average price (¢/kWh) by state & sector.
  let elecRes = new Map<string, number>();
  let elecComm = new Map<string, number>();
  let electricPeriod: string | null = null;
  try {
    const rows = await eiaFetch(
      "/electricity/retail-sales/data/",
      {
        frequency: "monthly",
        "data[0]": "price",
        "facets[sectorid][]": ["RES", "COM"],
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        length: "500",
      } as unknown as Record<string, string | string[]>,
      apiKey,
    );
    const res = latestByState(rows.filter((r) => r.sectorid === "RES"), "stateid", "price");
    const com = latestByState(rows.filter((r) => r.sectorid === "COM"), "stateid", "price");
    elecRes = res.byState;
    elecComm = com.byState;
    electricPeriod = res.period ?? com.period;
  } catch (e) {
    errors.push(`electricity: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Natural gas: residential + commercial price, $/Mcf → $/therm (÷10.37).
  const MCF_TO_THERM = 10.37;
  const gasRes = new Map<string, number>();
  const gasComm = new Map<string, number>();
  let gasPeriod: string | null = null;
  try {
    const [resRows, comRows] = await Promise.all([
      eiaFetch(
        "/natural-gas/pri/sum/data/",
        {
          frequency: "monthly",
          "data[0]": "value",
          "facets[process][]": "PRS", // residential price
          "sort[0][column]": "period",
          "sort[0][direction]": "desc",
          length: "300",
        } as unknown as Record<string, string | string[]>,
        apiKey,
      ),
      eiaFetch(
        "/natural-gas/pri/sum/data/",
        {
          frequency: "monthly",
          "data[0]": "value",
          "facets[process][]": "PCS", // commercial price
          "sort[0][column]": "period",
          "sort[0][direction]": "desc",
          length: "300",
        } as unknown as Record<string, string | string[]>,
        apiKey,
      ),
    ]);
    const r = latestByState(resRows, "duoarea", "value");
    const c = latestByState(comRows, "duoarea", "value");
    r.byState.forEach((v, k) => gasRes.set(k, v / MCF_TO_THERM));
    c.byState.forEach((v, k) => gasComm.set(k, v / MCF_TO_THERM));
    gasPeriod = r.period ?? c.period;
  } catch (e) {
    errors.push(`natural gas: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Compare against the seeded catalog.
  const drifted: StateDrift[] = [];
  let checkedStates = 0;
  for (const p of STATE_PROFILES) {
    let touched = false;
    const compare = (metric: StateDrift["metric"], seeded: number | undefined, live: number | undefined, period: string | null) => {
      if (seeded == null || live == null || seeded <= 0) return;
      touched = true;
      const driftPct = Math.abs(live - seeded) / seeded;
      if (driftPct > DRIFT_THRESHOLD) {
        drifted.push({ state: p.state, metric, seeded, live: Math.round(live * 100) / 100, driftPct: Math.round(driftPct * 100) / 100, period: period ?? "latest" });
      }
    };
    compare("electric_res_cents_kwh", p.resRateCents, elecRes.get(p.state), electricPeriod);
    compare("electric_comm_cents_kwh", p.commRateCents, elecComm.get(p.state), electricPeriod);
    compare("gas_res_usd_therm", p.gasResPerTherm, gasRes.get(p.state), gasPeriod);
    compare("gas_comm_usd_therm", p.gasCommPerTherm, gasComm.get(p.state), gasPeriod);
    if (touched) checkedStates++;
  }

  // Record that the upstream was actually consulted: lastCheckedAt + the
  // upstream release (period) seen, on the rate seed-freshness rows.
  try {
    const db = await getDb();
    if (db && (electricPeriod || gasPeriod)) {
      const seen = [electricPeriod, gasPeriod].filter(Boolean).join("/");
      // "national_rate_averages" is the registered seed-freshness source for
      // the EIA-861/EIA-176/AWWA state-average catalog (seedLifecycle.ts).
      await db
        .update(seedFreshness)
        .set({ lastCheckedAt: now, upstreamReleaseSeen: seen.slice(0, 64) })
        .where(eq(seedFreshness.source, "national_rate_averages"));
    }
  } catch {
    /* freshness bookkeeping is best-effort */
  }

  return {
    ran: true,
    checkedStates,
    drifted,
    electricPeriod: electricPeriod ?? undefined,
    gasPeriod: gasPeriod ?? undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
