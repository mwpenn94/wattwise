/**
 * Public estimate-first onboarding (UX addendum v1.9 §"first 60 seconds").
 *
 * Zero-signup: address (+ confirmed building type) → instant estimated annual
 * cost, peer percentile, and top opportunity. Everything here is explicitly
 * labeled "Estimated — based on buildings like yours, not your usage data."
 *
 * Grounding: address components come from Google Places (verified), climate
 * zone / utility / archetype / tariff / benchmark come from the same seeded
 * machinery the console uses — this is the real pipeline on archetype data,
 * not a marketing calculator.
 *
 * Cost control (free-tier ≤$0.20/analysis): pure DB + math, no LLM. A small
 * in-memory IP rate limiter bounds abuse of the unauthenticated endpoint.
 */
import { deriveFromAddress, BUILDING_PRIORS } from "./cascade";
import { archetypeBaseline } from "./analytics/baseline";
import * as h from "./dbHelpers";
import { costOnTariff, tariffEligible } from "./analytics/tariffEngine";
import type { TariffStructure } from "../shared/wattwise";
import { buildAccuracyLadder } from "../shared/capabilityMatrix";

/* ---------------- IP rate limiting (public endpoint guard) ---------------- */
const BUCKET_MAX = 12; // estimates per window per IP
const WINDOW_MS = 10 * 60 * 1000;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function estimateRateAllows(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // opportunistic cleanup so the map cannot grow unbounded
    if (buckets.size > 5000) {
      for (const [k, v] of Array.from(buckets.entries())) if (now >= v.resetAt) buckets.delete(k);
    }
    return true;
  }
  if (b.count >= BUCKET_MAX) return false;
  b.count += 1;
  return true;
}

/* ---------------- vintage band (mirror of pipeline semantics) ---------------- */
function vintageBand(vintage: number | null | undefined): string {
  if (vintage == null) return "all";
  if (vintage < 1980) return "pre1980";
  if (vintage < 2004) return "1980-2003";
  return "post2004";
}

export interface PublicEstimate {
  /** headline */
  estimatedAnnualCostUsd: number;
  estimatedMonthlyCostUsd: number;
  estimatedAnnualKwh: number;
  /** peer context */
  percentileBand: string | null;
  betterThanMedian: boolean | null;
  benchmarkSource: string | null;
  /** cross-commodity parity (owner report Jul 19): gas is benchmark-imputed the
   * same honest way electric is archetype-imputed — present only when a gas
   * benchmark exists for the building type. Never fabricated when absent. */
  gasEstimate: {
    annualTherms: number;
    annualCostUsd: number;
    monthlyCostUsd: number;
    tariffName: string | null;
    basis: string;
  } | null;
  /** top opportunity teaser */
  topOpportunity: { title: string; estimatedSavingsUsd: number; basis: string } | null;
  /** grounding provenance — every value states where it came from */
  grounding: {
    location: { city: string | null; state: string | null; zip: string | null; source: "place_verified" | "address_parsed" };
    climateZone: { value: string; source: string };
    buildingType: { value: string; source: "user_confirmed" };
    sqft: { value: number; source: "user_entered" | "building_type_median" };
    utility: { name: string | null; note: string };
    tariff: { name: string | null; note: string };
    loadBasis: "archetype_scaled";
  };
  /** accuracy ladder — where this estimate sits and what upgrades it */
  accuracy: {
    rung: "estimate";
    label: string;
    ladder: Array<{ rung: string; label: string; unlockedBy: string; unlocks: string[]; current: boolean }>;
  };
  disclosure: string;
}

/** v1.17 §5.0(a) + v2.8 §1: the ladder is GENERATED from the capability
 * matrix — every rung names the specific insights it unlocks, in advance.
 * The matrix (shared/capabilityMatrix.ts) is the single source of truth. */
export const ACCURACY_LADDER = buildAccuracyLadder();

export async function computeAddressEstimate(input: {
  /** verified components from places.resolve, or raw address fallback */
  formattedAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  placeVerified: boolean;
  buildingType: string;
  sqft?: number | null;
}): Promise<PublicEstimate> {
  // 1. Location cascade — same derivation the console uses (climate zone,
  //    utility suggestion) seeded from verified components when present.
  const cascade = deriveFromAddress(input.formattedAddress, {
    state: input.state,
    zip: input.zip,
    city: input.city,
    buildingType: input.buildingType,
    sqft: input.sqft ?? null,
    placeVerified: input.placeVerified,
  });
  const state = cascade.state.value ?? input.state ?? null;
  const zip = cascade.zip.value ?? input.zip ?? null;
  const climateZone = cascade.climateZone.value ?? "4A";

  // 2. Size prior — user-entered sqft wins; otherwise the building-type median
  //    (a 1,800 sqft home, never a 15,000 sqft office default).
  const priors = BUILDING_PRIORS[input.buildingType] ?? BUILDING_PRIORS.office;
  const sqft = input.sqft != null && input.sqft > 0 ? input.sqft : priors.sqft;
  const sqftSource: "user_entered" | "building_type_median" = input.sqft != null && input.sqft > 0 ? "user_entered" : "building_type_median";

  // 3. Archetype 8760 scaled to the confirmed type/size/zone.
  const arch = await h.getArchetype(input.buildingType, climateZone, vintageBand(priors.vintage));
  if (!arch) throw new Error("No archetype profile available for this building type — cannot estimate.");
  const calibMid = (arch as { calibMidSqft?: number | null }).calibMidSqft ?? null;
  const ab = archetypeBaseline(arch.shape8760 as number[], arch.annualUsePerSqft, sqft, {
    outOfCalibrationRange: false,
    calibMidSqft: calibMid,
  });
  const annualKwh = ab.hourly.reduce((a, b) => a + b, 0);

  // 4. Price on the best eligible seeded tariff for the state (sector-matched).
  //    Fall back to a state-blended rate when no structure matches.
  const hourStart = Date.UTC(new Date().getUTCFullYear(), 0, 1);
  const points = ab.hourly.map((usage, i) => ({ ts: hourStart + i * 3_600_000, durationMin: 60, usage, demand: null as number | null }));
  const sector = input.buildingType === "single_family" || input.buildingType === "multifamily" ? "residential" : "commercial";
  const allTariffs = state ? await h.listTariffs("electric", state) : [];
  const peakKw = Math.max(...ab.hourly);
  const eligible = allTariffs.filter(
    (t) =>
      tariffEligible(
        // v1.18 applicability: an anonymous estimate assumes no solar and no
        // grandfathered status — closed and solar-only plans are excluded so the
        // public number is one the visitor could actually sign up for.
        { sector: t.sector, commodity: t.commodity, peakKwMin: t.peakKwMin ?? null, peakKwMax: t.peakKwMax ?? null, closedToNew: t.closedToNew, techCondition: t.techCondition },
        { sectorClass: sector, hasSolar: false },
        peakKw,
      ).eligible,
  );
  let annualCost: number | null = null;
  let tariffName: string | null = null;
  for (const t of eligible) {
    try {
      const c = costOnTariff(points, t.structure as TariffStructure);
      if (annualCost == null || c.breakdown.total < annualCost) {
        annualCost = c.breakdown.total;
        tariffName = t.name;
      }
    } catch {
      /* skip malformed structures — estimate must not 500 on one bad row */
    }
  }
  if (annualCost == null) {
    // national average residential/commercial blended rates (EIA 2025) — last resort
    const blended = sector === "residential" ? 0.17 : 0.13;
    annualCost = annualKwh * blended;
    tariffName = null;
  }

  // 5. Peer percentile from seeded benchmarks (median EUI comparison).
  const bench = await h.getBenchmark(input.buildingType, "electric");
  let percentileBand: string | null = null;
  let betterThanMedian: boolean | null = null;
  if (bench && sqft > 0) {
    const eui = annualKwh / sqft;
    // archetype-scaled EUI ≈ archetype EUI, so this reads near-median by
    // construction; still honest ("typical for buildings like yours").
    betterThanMedian = eui < bench.medianEui;
    const p25 = bench.p25Eui;
    const p75 = bench.p75Eui;
    percentileBand =
      p25 != null && eui < p25
        ? "top quartile"
        : eui < bench.medianEui
          ? "better than median"
          : p75 != null && eui < p75
            ? "worse than median"
            : "bottom quartile";
  }

  // 5b. Gas estimate — benchmark intensity × sqft, priced on the first seeded
  //     state gas tariff's flat rate, else a disclosed national average. Water
  //     is deliberately omitted from the public teaser (rates vary too much by
  //     district to be honest without an address-verified utility).
  let gasEstimate: PublicEstimate["gasEstimate"] = null;
  const gasBench = await h.getBenchmark(input.buildingType, "gas");
  if (gasBench && sqft > 0) {
    const annualTherms = gasBench.medianEui * sqft;
    let gasRate: number | null = null;
    let gasTariffName: string | null = null;
    const gasTariffs = state ? await h.listTariffs("gas", state) : [];
    for (const t of gasTariffs) {
      const s = t.structure as TariffStructure;
      const r = s.energy?.[0]?.ratePerUnit;
      if (typeof r === "number" && r > 0) {
        gasRate = r;
        gasTariffName = t.name;
        break;
      }
    }
    const NATIONAL_AVG_PER_THERM = 1.2; // EIA 2025 blended commercial/residential — disclosed fallback
    const rate = gasRate ?? NATIONAL_AVG_PER_THERM;
    const fixed = 0; // public teaser: usage charge only, disclosed in basis
    const annualGasCost = annualTherms * rate + fixed;
    gasEstimate = {
      annualTherms: Math.round(annualTherms),
      annualCostUsd: Math.round(annualGasCost),
      monthlyCostUsd: Math.round(annualGasCost / 12),
      tariffName: gasTariffName,
      basis: `${gasBench.medianEui} therms/sqft-yr median (${gasBench.source}) × ${sqft.toLocaleString()} sqft, priced at ${gasTariffName ? `the seeded ${gasTariffName} rate` : `a national average $${NATIONAL_AVG_PER_THERM.toFixed(2)}/therm`} — benchmark-imputed, not your bill`,
    };
  }

  // 6. Top opportunity teaser — largest generic lever for the type, honestly
  //    framed as archetype-based until real data lands.
  const coolingHeavy = ["1A", "1B", "2A", "2B", "3B"].includes(climateZone);
  const topOpportunity =
    sector === "residential"
      ? {
          title: coolingHeavy ? "Cooling setpoint + duct sealing" : "Heat-pump upgrade & envelope sealing",
          estimatedSavingsUsd: Math.round(annualCost * 0.12),
          basis: "Typical savings band (8–15%) for homes of this type and climate — refine with a bill upload",
        }
      : {
          title: "Schedule tightening + demand management",
          estimatedSavingsUsd: Math.round(annualCost * 0.15),
          basis: "Typical savings band (10–20%) for commercial buildings of this type — refine with interval data",
        };

  return {
    estimatedAnnualCostUsd: Math.round(annualCost),
    estimatedMonthlyCostUsd: Math.round(annualCost / 12),
    estimatedAnnualKwh: Math.round(annualKwh),
    percentileBand,
    betterThanMedian,
    benchmarkSource: bench ? `${bench.source} (${bench.sourceVersion})` : null,
    gasEstimate,
    topOpportunity,
    grounding: {
      location: {
        city: cascade.city.value ?? input.city,
        state,
        zip,
        source: input.placeVerified ? "place_verified" : "address_parsed",
      },
      climateZone: { value: climateZone, source: cascade.climateZone.source },
      buildingType: { value: input.buildingType, source: "user_confirmed" },
      sqft: { value: sqft, source: sqftSource },
      utility: {
        name: cascade.utilityName.value ?? null,
        note: state ? `Largest utility in ${state} — a suggestion, not verified for your address` : "Unknown until an address resolves",
      },
      tariff: {
        name: tariffName,
        note: tariffName
          ? "Cheapest eligible seeded rate for your area — your actual rate may differ"
          : "No seeded tariff matched; priced at a national blended rate",
      },
      loadBasis: "archetype_scaled",
    },
    accuracy: {
      rung: "estimate",
      label: "Estimated — based on buildings like yours, not your usage data",
      ladder: ACCURACY_LADDER.map((r) => ({ ...r, current: r.rung === "estimate" })),
    },
    disclosure:
      "Modeled estimate from prototype building archetypes scaled to your confirmed type and size — not a professional energy audit. Upload a bill or interval data to replace every number here with your own.",
  };
}
