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

/* ------------------------------------------------------------------------
 * UCONV-1 (Oct 26): usage-unit conversion for MODELING.
 *
 * Readings are stored exactly as the file states them (LGE-2): a CCF column
 * stays CCF, an HCF column stays HCF. Every modeled figure (baselines,
 * tariff pricing, savings, scenarios, M&V) works in the commodity's model
 * unit, which is also the unit tariff rates are priced in: kWh, therms,
 * gallons (water tariffs are quoted per kgal and priced per gallon).
 * usageConversion() maps a stated unit to the model unit. Electric is never
 * converted. An unrecognized gas/water unit is used as-is and says so.
 * ---------------------------------------------------------------------- */
/** EIA U.S. average heat content of natural gas delivered to consumers:
 * about 1,037 Btu per cubic foot, i.e. 1.037 therms per CCF. A utility bills
 * on its own measured heat content, which can differ by a few percent. */
export const GAS_THERMS_PER_CCF = 1.037;
/** 1 cubic foot = 7.48052 U.S. gallons, so 1 CCF (100 ft³) = 748.052 gallons. */
export const GALLONS_PER_CUBIC_FOOT = 7.48052;
const CUBIC_FEET_PER_M3 = 35.3147;
const GALLONS_PER_M3 = 264.172;

export interface UsageConversion {
  /** multiply a stated reading by this to get the model unit */
  factor: number;
  /** true when the unit is known for this commodity (or is the model unit) */
  recognized: boolean;
  /** the unit as stated (trimmed) */
  fromUnit: string;
  /** the model unit (kWh / therms / gallons) */
  toUnit: string;
  /** plain disclosure when the factor is not 1 or the unit is unknown; null otherwise */
  note: string | null;
  /** compact form for basis labels, e.g. "converted from CCF at 1.037 therms per CCF (U.S. average)"; null when nothing changed */
  shortNote: string | null;
}

type UnitRule = { factor: number; label: string; heatContent?: boolean };
const GAS_UNITS: Record<string, UnitRule> = {
  therm: { factor: 1, label: "therms" },
  therms: { factor: 1, label: "therms" },
  thm: { factor: 1, label: "therms" },
  dth: { factor: 10, label: "Dth" },
  dekatherm: { factor: 10, label: "Dth" },
  dekatherms: { factor: 10, label: "Dth" },
  mmbtu: { factor: 10, label: "MMBtu" },
  kbtu: { factor: 0.01, label: "kBtu" },
  ccf: { factor: GAS_THERMS_PER_CCF, label: "CCF", heatContent: true },
  hcf: { factor: GAS_THERMS_PER_CCF, label: "HCF", heatContent: true },
  mcf: { factor: GAS_THERMS_PER_CCF * 10, label: "Mcf", heatContent: true },
  cf: { factor: GAS_THERMS_PER_CCF / 100, label: "cubic feet", heatContent: true },
  ft3: { factor: GAS_THERMS_PER_CCF / 100, label: "cubic feet", heatContent: true },
  cubicfeet: { factor: GAS_THERMS_PER_CCF / 100, label: "cubic feet", heatContent: true },
  m3: { factor: (GAS_THERMS_PER_CCF / 100) * CUBIC_FEET_PER_M3, label: "m³", heatContent: true },
};
const WATER_UNITS: Record<string, UnitRule> = {
  gal: { factor: 1, label: "gallons" },
  gallon: { factor: 1, label: "gallons" },
  gallons: { factor: 1, label: "gallons" },
  kgal: { factor: 1000, label: "kgal" },
  tgal: { factor: 1000, label: "kgal" },
  thousandgallons: { factor: 1000, label: "kgal" },
  ccf: { factor: GALLONS_PER_CUBIC_FOOT * 100, label: "CCF" },
  hcf: { factor: GALLONS_PER_CUBIC_FOOT * 100, label: "HCF" },
  cf: { factor: GALLONS_PER_CUBIC_FOOT, label: "cubic feet" },
  ft3: { factor: GALLONS_PER_CUBIC_FOOT, label: "cubic feet" },
  cubicfeet: { factor: GALLONS_PER_CUBIC_FOOT, label: "cubic feet" },
  m3: { factor: GALLONS_PER_M3, label: "m³" },
};

function normUnit(u: string): string {
  return u.trim().toLowerCase().replace(/³/g, "3").replace(/[\s_.\-]+/g, "");
}
function fmtFactor(f: number): string {
  return Number(f.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 5 });
}

/** Convert a stated usage unit to the commodity's model unit. Pure; never throws. */
export function usageConversion(commodity: string | null | undefined, unit: string | null | undefined): UsageConversion {
  const meta = commodityMeta(commodity);
  const fromUnit = String(unit ?? "").trim();
  const toUnit = meta.usageUnit;
  if (meta.key === "electric") return { factor: 1, recognized: true, fromUnit: fromUnit || toUnit, toUnit, note: null, shortNote: null };
  if (!fromUnit) return { factor: 1, recognized: true, fromUnit: toUnit, toUnit, note: null, shortNote: null };
  const rule = (meta.key === "gas" ? GAS_UNITS : WATER_UNITS)[normUnit(fromUnit)];
  if (!rule) {
    return {
      factor: 1,
      recognized: false,
      fromUnit,
      toUnit,
      note: `This meter's readings are in "${fromUnit}", a unit Meterly does not convert, so they are used as ${toUnit} as-is. Check the unit before relying on costs and savings.`,
      shortNote: `readings in "${fromUnit}" used as ${toUnit} as-is (unit not recognized)`,
    };
  }
  if (rule.factor === 1) return { factor: 1, recognized: true, fromUnit, toUnit, note: null, shortNote: null };
  const how = rule.heatContent
    ? `using the U.S. average of ${GAS_THERMS_PER_CCF} therms per CCF (EIA heat content); your utility's billing factor can differ by a few percent`
    : `(1 ${rule.label} = ${fmtFactor(rule.factor)} ${toUnit})`;
  return {
    factor: rule.factor,
    recognized: true,
    fromUnit,
    toUnit,
    note: `Readings are in ${rule.label}; costs and savings convert them to ${toUnit} ${how}. The readings themselves are kept as recorded.`,
    shortNote: rule.heatContent
      ? `converted from ${rule.label} to ${toUnit} at ${GAS_THERMS_PER_CCF} therms per CCF (U.S. average)`
      : `converted from ${rule.label} to ${toUnit} (1 ${rule.label} = ${fmtFactor(rule.factor)} ${toUnit})`,
  };
}

/** Convert one quantity from a stated unit to the model unit (bills, typed entries). */
export function toModelUsage(value: number, commodity: string | null | undefined, unit: string | null | undefined): number {
  return value * usageConversion(commodity, unit).factor;
}

/** RATE-7b: water meter sizes as utilities bill them (City of Phoenix filed
 * service charges are by these sizes). Used by the meter-size picker and the
 * meter update API; the tariff engine matches them to `meterSizeCharges`. */
export const WATER_METER_SIZES = ["5/8 in.", "3/4 in.", "1 in.", "1-1/2 in.", "2 in.", "3 in.", "4 in.", "6 in.", "8 in.", "10 in.", "12 in."] as const;
export type WaterMeterSize = (typeof WATER_METER_SIZES)[number];
