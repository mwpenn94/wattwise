/**
 * Shared commodity metadata — the single vocabulary for electric, gas, and
 * water across server derivations and client UI. The platform's spec is
 * commodity-agnostic ("one pipeline, actual or hypothetical"), so any surface
 * that prints a unit or names a commodity must read from here instead of
 * hardcoding kWh.
 */
export type Commodity = "electric" | "gas" | "water";

export interface CommodityMeta {
  key: Commodity;
  label: string;
  /** volumetric usage unit as stored in interval/bill rows */
  usageUnit: string;
  /** short unit for compact chips */
  usageUnitShort: string;
  /** demand unit or null when the commodity has no demand concept */
  demandUnit: string | null;
  /** unit the tariff ratePerUnit prices. NOTE: the cost engine multiplies
   * ratePerUnit by usage in usageUnit directly — tariffRateUnit must therefore
   * denominate the SAME quantity the meter records (see seed semantics). */
  tariffRateUnit: string;
  /** scope-1/2 emission handling: electric uses eGRID (lb/MWh); gas uses a
   * fixed combustion factor (lb CO2e per therm, EPA GHG Emission Factors Hub);
   * water carries none (embodied energy is a disclosed MVP gap). */
  co2e: { kind: "egrid" } | { kind: "per_unit"; lbPerUnit: number; source: string } | { kind: "none"; gapNote: string };
}

export const COMMODITIES: Record<Commodity, CommodityMeta> = {
  electric: {
    key: "electric",
    label: "Electric",
    usageUnit: "kWh",
    usageUnitShort: "kWh",
    demandUnit: "kW",
    tariffRateUnit: "kWh",
    co2e: { kind: "egrid" },
  },
  gas: {
    key: "gas",
    label: "Natural gas",
    usageUnit: "therms",
    usageUnitShort: "thm",
    demandUnit: null,
    tariffRateUnit: "therm",
    co2e: {
      kind: "per_unit",
      // EPA GHG Emission Factors Hub: 0.005311 metric ton CO2e / therm ≈ 11.71 lb/therm
      lbPerUnit: 11.71,
      source: "EPA GHG Emission Factors Hub (natural gas combustion, scope 1)",
    },
  },
  water: {
    key: "water",
    label: "Water",
    usageUnit: "gallons",
    usageUnitShort: "gal",
    demandUnit: null,
    tariffRateUnit: "gal",
    co2e: {
      kind: "none",
      gapNote: "Water embodied energy/emissions are a disclosed MVP gap — no factor is applied.",
    },
  },
};

export function commodityMeta(c: string | null | undefined): CommodityMeta {
  return COMMODITIES[(c as Commodity) ?? "electric"] ?? COMMODITIES.electric;
}

/** Format a usage quantity with its commodity unit, e.g. "12,400 kWh". */
export function fmtUsage(value: number, c: string | null | undefined, digits = 0): string {
  const m = commodityMeta(c);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${m.usageUnit}`;
}

/** Rate label for tariff rows, e.g. "$0.1245/kWh", "$1.1245/therm", "$5.19/kgal". */
export function fmtRate(ratePerUnit: number, c: string | null | undefined, digits = 4): string {
  const m = commodityMeta(c);
  return `$${ratePerUnit.toFixed(digits)}/${m.tariffRateUnit}`;
}
