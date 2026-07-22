/**
 * GWD-2 (owner directive Jul 22): filed-quality gas/water depth, systemically.
 *
 * Electric got nationwide filed-quality depth from the URDB bulk import; no
 * equivalent public-domain bulk dataset exists for gas LDC or municipal water
 * tariffs. The systemic equivalent is the acquisition queue: the largest gas
 * LDCs by customer count are pre-enqueued once (below), and any site added on
 * an uncovered gas/water utility auto-enqueues via the pipeline (GWD-1). The
 * monthly verification agent works the queue against official tariff
 * documents, and applyAcquisition's sanity bounds keep bad values out.
 *
 * This list is the top-20 US gas LDCs (≈70% of US gas customers) — a one-time
 * demand-independent floor so major-metro gas sites get filed-quality rates
 * without waiting for the first site to be added. Water stays purely
 * demand-driven (municipal fragmentation makes a static floor list
 * low-value; the queue covers it as sites appear).
 *
 * seedGasDepthQueue() is idempotent (enqueueAcquisition dedupes by
 * utility+state+commodity) and called from the weekly sweep.
 */
import { enqueueAcquisition } from "./urdbImport";

/** Top US gas LDCs by residential customer count (EIA-176 scale ordering). */
export const MAJOR_GAS_LDCS: Array<{ utilityName: string; state: string }> = [
  { utilityName: "SoCalGas (Southern California Gas)", state: "CA" },
  { utilityName: "Pacific Gas and Electric (gas)", state: "CA" },
  { utilityName: "Atmos Energy", state: "TX" },
  { utilityName: "Nicor Gas", state: "IL" },
  { utilityName: "Peoples Gas (Chicago)", state: "IL" },
  { utilityName: "Consumers Energy (gas)", state: "MI" },
  { utilityName: "DTE Gas", state: "MI" },
  { utilityName: "Dominion Energy Ohio (Enbridge Gas Ohio)", state: "OH" },
  { utilityName: "Columbia Gas of Ohio", state: "OH" },
  { utilityName: "National Fuel Gas Distribution", state: "NY" },
  { utilityName: "Con Edison (gas)", state: "NY" },
  { utilityName: "National Grid (KEDNY/KEDLI gas)", state: "NY" },
  { utilityName: "PSE&G (gas)", state: "NJ" },
  { utilityName: "New Jersey Natural Gas", state: "NJ" },
  { utilityName: "Philadelphia Gas Works", state: "PA" },
  { utilityName: "UGI Utilities (gas)", state: "PA" },
  { utilityName: "Washington Gas", state: "DC" },
  { utilityName: "Piedmont Natural Gas", state: "NC" },
  { utilityName: "CenterPoint Energy (gas)", state: "MN" },
  { utilityName: "Xcel Energy (gas)", state: "CO" },
];

/** Idempotent: pre-enqueue the major gas LDC floor. Existing entries just get
 * a demand bump (enqueueAcquisition semantics); acquired ones are untouched. */
export async function seedGasDepthQueue(): Promise<{ enqueued: number }> {
  let enqueued = 0;
  for (const l of MAJOR_GAS_LDCS) {
    try {
      await enqueueAcquisition(l.utilityName, l.state, "gas");
      enqueued++;
    } catch {
      /* per-entry failures are non-fatal; next sweep retries */
    }
  }
  return { enqueued };
}
