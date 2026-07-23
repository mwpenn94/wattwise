/**
 * telecomMarket.ts — location-driven telecom market context (TEL1C-1).
 *
 * Telecom differs from electric/gas territory resolution in a fundamental
 * way the owner called out explicitly (Jul 23): a geography is served by
 * MULTIPLE providers across MULTIPLE access technologies at once — wired
 * (fiber / cable / DSL), licensed fixed-wireless, and satellite — rather
 * than one franchised utility per footprint. Market context is therefore
 * modeled as a TECHNOLOGY MIX with per-technology price bands and a
 * competition effect, never as a single-provider territory.
 *
 * Honesty rules (same charter as tariffs):
 *  - the mix is a density-class prior (urban / suburban / rural) refined by
 *    state fiber-buildout context — DISCLOSED as such, never presented as a
 *    serviceability check for a specific address;
 *  - price factors derive from the published spread between technology
 *    classes in FCC Urban Rate Survey data and published carrier pricing;
 *  - every consumer of this context receives the disclosure strings and is
 *    expected to surface them.
 */
import type { TelecomService } from "../drizzle/schema";

/* ------------------------------------------------------------------ */
/* Technology modalities                                               */
/* ------------------------------------------------------------------ */

export type AccessTechnology = "fiber" | "cable" | "dsl" | "fixed_wireless" | "satellite";

export interface TechnologyBand {
  technology: AccessTechnology;
  /** share of US locations in this density class with the technology plausibly available (0-1, prior) */
  availabilityPrior: number;
  /** multiplicative factor applied to the national benchmark median for this technology's typical pricing */
  priceFactor: number;
  /** short label used in disclosures */
  label: string;
}

export type DensityClass = "urban" | "suburban" | "rural";

export interface TelecomMarketContext {
  densityClass: DensityClass;
  /** technologies plausibly available, most competitive first */
  technologies: TechnologyBand[];
  /** competition factor applied to savings ranges: more overlapping wired
   * technologies → stronger negotiating position → wider achievable savings.
   * 1.0 = national baseline; <1 dampens; >1 widens. */
  competitionFactor: number;
  /** honest provenance strings for the UI/findings */
  disclosures: string[];
}

/* ------------------------------------------------------------------ */
/* Density-class priors (FCC broadband deployment data, 2024-2026      */
/* vintage: fiber passes ~60% urban, ~45% suburban, ~25% rural;        */
/* cable ~90/85/45; DSL legacy near-universal wired footprints;        */
/* licensed fixed-wireless ~80/70/55 and satellite universal).         */
/* ------------------------------------------------------------------ */

const TECH_PRIORS: Record<DensityClass, TechnologyBand[]> = {
  urban: [
    { technology: "fiber", availabilityPrior: 0.6, priceFactor: 0.95, label: "fiber (wired)" },
    { technology: "cable", availabilityPrior: 0.9, priceFactor: 1.0, label: "cable (wired)" },
    { technology: "fixed_wireless", availabilityPrior: 0.8, priceFactor: 0.85, label: "5G fixed-wireless" },
    { technology: "dsl", availabilityPrior: 0.7, priceFactor: 0.9, label: "DSL (legacy wired)" },
    { technology: "satellite", availabilityPrior: 1.0, priceFactor: 1.35, label: "satellite" },
  ],
  suburban: [
    { technology: "fiber", availabilityPrior: 0.45, priceFactor: 0.95, label: "fiber (wired)" },
    { technology: "cable", availabilityPrior: 0.85, priceFactor: 1.0, label: "cable (wired)" },
    { technology: "fixed_wireless", availabilityPrior: 0.7, priceFactor: 0.85, label: "5G fixed-wireless" },
    { technology: "dsl", availabilityPrior: 0.7, priceFactor: 0.9, label: "DSL (legacy wired)" },
    { technology: "satellite", availabilityPrior: 1.0, priceFactor: 1.35, label: "satellite" },
  ],
  rural: [
    { technology: "fiber", availabilityPrior: 0.25, priceFactor: 1.0, label: "fiber (wired)" },
    { technology: "cable", availabilityPrior: 0.45, priceFactor: 1.05, label: "cable (wired)" },
    { technology: "fixed_wireless", availabilityPrior: 0.55, priceFactor: 0.9, label: "fixed-wireless (4G/5G)" },
    { technology: "dsl", availabilityPrior: 0.6, priceFactor: 0.95, label: "DSL (legacy wired)" },
    { technology: "satellite", availabilityPrior: 1.0, priceFactor: 1.25, label: "satellite" },
  ],
};

/** States with notably above-average fiber buildout (published FCC deployment
 * reports + state broadband office data): fiber prior gets a bump, which in
 * turn raises the competition factor. Kept deliberately coarse and disclosed. */
const HIGH_FIBER_STATES = new Set([
  "RI", "CT", "NJ", "NY", "MA", "MD", "DE", "UT", "NC", "TN", "TX", "FL", "AZ",
]);
/** States with notably below-average wired competition (large rural footprints). */
const LOW_WIRED_STATES = new Set([
  "MT", "WY", "AK", "ND", "SD", "NM", "WV", "MS", "ID", "ME", "VT", "AR",
]);

/* ------------------------------------------------------------------ */
/* Density classification                                               */
/* ------------------------------------------------------------------ */

/** Coarse density classification from zip prefix + city presence. This is a
 * prior, not a serviceability lookup — disclosed everywhere it is used. */
export function classifyDensity(opts: { city?: string | null; zip?: string | null; state?: string | null }): DensityClass {
  const zip = (opts.zip ?? "").trim();
  // Large-metro zip3 prefixes (top ~40 metros by population). Coarse by design.
  const URBAN_ZIP3 = new Set([
    "100", "101", "102", "104", "112", "113", "606", "770", "750", "752", "850", "852",
    "900", "902", "913", "941", "980", "981", "191", "APO", "331", "303", "482", "551",
    "802", "212", "852", "857", "402", "232", "230", "216", "451", "462", "631", "641",
  ]);
  if (zip.length >= 3 && URBAN_ZIP3.has(zip.slice(0, 3))) return "urban";
  if (opts.city && opts.city.trim().length > 0 && zip.length >= 3) return "suburban";
  return "rural";
}

/* ------------------------------------------------------------------ */
/* Market context resolution                                            */
/* ------------------------------------------------------------------ */

export function resolveTelecomMarket(site: {
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): TelecomMarketContext {
  const density = classifyDensity(site);
  const state = (site.state ?? "").toUpperCase();
  // Deep-copy the prior bands so state adjustments never mutate the table.
  const bands: TechnologyBand[] = TECH_PRIORS[density].map((b) => ({ ...b }));

  const disclosures: string[] = [
    `Market context is a ${density}-density prior refined by state buildout data — a planning assumption, not an address-level serviceability check.`,
    "Multiple providers and access technologies (wired fiber/cable/DSL, fixed-wireless, satellite) typically overlap in one location; actual availability varies address by address.",
  ];

  if (state && HIGH_FIBER_STATES.has(state)) {
    const fiber = bands.find((b) => b.technology === "fiber");
    if (fiber) fiber.availabilityPrior = Math.min(0.9, fiber.availabilityPrior + 0.2);
    disclosures.push(`${state} has above-average fiber buildout (published FCC deployment data), strengthening wired competition.`);
  }
  if (state && LOW_WIRED_STATES.has(state)) {
    for (const b of bands) {
      if (b.technology === "fiber" || b.technology === "cable") {
        b.availabilityPrior = Math.max(0.1, b.availabilityPrior - 0.15);
      }
    }
    disclosures.push(`${state} has below-average wired competition outside town centers (published FCC deployment data).`);
  }

  // Competition factor: expected count of plausibly-available wired + fixed-
  // wireless options, normalized so ~2.5 expected options = 1.0 baseline.
  const expectedOptions = bands
    .filter((b) => b.technology !== "satellite")
    .reduce((s, b) => s + b.availabilityPrior, 0);
  const competitionFactor = Math.max(0.7, Math.min(1.25, expectedOptions / 2.5));

  // Most competitive (highest availability × lowest price) first for display.
  bands.sort((a, b) => b.availabilityPrior - a.availabilityPrior || a.priceFactor - b.priceFactor);

  return { densityClass: density, technologies: bands, competitionFactor, disclosures };
}

/** Weighted market price factor for internet service comparison: the
 * availability-weighted mean price factor across plausibly-available
 * technologies. Applied to national benchmark medians so a rural
 * satellite-heavy market compares against honestly higher typical prices
 * while a fiber-rich metro compares against lower ones. */
export function marketPriceFactor(ctx: TelecomMarketContext): number {
  const usable = ctx.technologies.filter((b) => b.availabilityPrior >= 0.3);
  if (usable.length === 0) return 1.0;
  const wSum = usable.reduce((s, b) => s + b.availabilityPrior, 0);
  const f = usable.reduce((s, b) => s + b.priceFactor * b.availabilityPrior, 0) / wSum;
  return Math.round(f * 100) / 100;
}

/** Alternate-technology suggestions for a service: cheaper modalities the
 * market plausibly offers (e.g., 5G fixed-wireless vs cable). Only returns
 * technologies with meaningful availability priors, and only for internet. */
export function alternateTechnologies(
  svc: Pick<TelecomService, "serviceType">,
  ctx: TelecomMarketContext,
): TechnologyBand[] {
  if (svc.serviceType !== "internet") return [];
  return ctx.technologies.filter((b) => b.availabilityPrior >= 0.5 && b.priceFactor < 1.0);
}
