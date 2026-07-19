/**
 * Cross-commodity opportunity generation — parity with the electric-framed
 * stage-7 measures (owner report Jul 19: "we are not doing gas and water like
 * we are on an energy basis").
 *
 * For each non-electric commodity (gas, water) this module resolves an annual
 * usage basis with the SAME measured-vs-imputed discipline the electric path
 * uses, then emits auto-ranked opportunity candidates priced at the site's
 * real tariff rate (assigned tariff → first seeded state tariff → disclosed
 * national default). Every candidate carries the basis verbatim in its
 * disclosures — benchmark-imputed numbers are never dressed up as measured.
 *
 * Baseline discipline per commodity:
 *  - measured: ≥60 days of that commodity's meter data → annualized
 *  - imputed:  benchmark median intensity (CBECS/RECS/WaterSense) × sqft
 *  - neither:  NO opportunities for that commodity (never fabricate)
 *
 * Fuel applicability (owner report Jul 19: "not all sites are dual fuel"):
 *  - GAS is only analyzed when the site shows EVIDENCE of gas service — a gas
 *    meter of any kind, or gas-burning equipment the user confirmed/entered
 *    themselves (inferred equipment doesn't count: it is itself derived from
 *    meter presence, so it can never bootstrap gas onto an all-electric site).
 *    No evidence → no gas baselines, no gas opportunities, and the skip is
 *    narrated so the absence is legible, not silent.
 *  - WATER is imputed-allowed without a meter: municipal water service is
 *    near-universal for occupied buildings, unlike gas. Leak screening still
 *    requires MEASURED data (a continuous-flow signature cannot be imputed).
 *
 * Savings fractions cite their sources in the rationale (ENERGY STAR / DOE /
 * EPA WaterSense typical bands) and always use the LOW end for the lo bound.
 */
import * as h from "./dbHelpers";
import type { OpportunityCandidate } from "./analytics/scenarios";
import type { MonthNormalRow } from "./analytics/baseline";
import { COMMODITY_UNITS, TariffStructure, MODELED_ESTIMATES_DISCLAIMER } from "../shared/wattwise";
import { resolveCommodityService } from "./commodityService";
import { lookupTerritory } from "./serviceTerritories";

export type XcOpportunity = OpportunityCandidate & {
  estUnitsSavedPerYr?: number;
  unit?: string;
  commodity?: string;
};

interface SiteLite {
  id: number;
  buildingType: string | null;
  sqft: number | null;
  state: string | null;
  zip?: string | null;
  utilityName?: string | null;
  servicesProfile?: unknown;
}

interface Basis {
  annualUnits: number;
  kind: "measured" | "imputed";
  label: string;
}

/** Disclosed national-average fallback rates (EIA 2025 blended). */
const DEFAULT_RATE: Record<"gas" | "water", { rate: number; label: string }> = {
  gas: { rate: 1.2, label: "national average $1.20/therm (EIA) — no seeded tariff matched" },
  water: { rate: 0.0055, label: "national average $5.50/kgal (~$0.0055/gal) — no seeded tariff matched" },
};

/**
 * Back-compat shim: "does this site have gas?" now delegates to the shared
 * per-commodity service resolution ladder (server/commodityService.ts — user
 * override → meter/equipment evidence → territory imputation → never-assumed
 * default). Kept exported for the pipeline stage-2 baseline pass.
 */
export async function hasGasEvidence(siteId: number, userId: number, site?: SiteLite): Promise<boolean> {
  const res = await resolveCommodityService(
    { id: siteId, state: site?.state ?? null, utilityName: site?.utilityName ?? null, servicesProfile: site?.servicesProfile },
    userId,
    "gas",
  );
  return res.analyze;
}

/** Resolve the annual usage basis for a commodity: measured ≥60d, else benchmark-imputed. */
async function resolveBasis(site: SiteLite, userId: number, com: "gas" | "water"): Promise<Basis | null> {
  const meters = await h.listMeters(site.id, userId);
  const cMeter =
    meters.find((m) => m.commodity === com && m.meterRole !== "submeter") ?? meters.find((m) => m.commodity === com) ?? null;
  if (cMeter) {
    const pts = await h.getIntervalPoints(cMeter.id, userId);
    if (pts.length >= 2) {
      const spanDays = Math.max(1, (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000);
      const total = pts.reduce((s, p) => s + p.usage, 0);
      if (spanDays >= 60 && total > 0) {
        return {
          annualUnits: (total / spanDays) * 365,
          kind: "measured",
          label: `measured — annualized from ${Math.round(spanDays)} days of ${com} meter data`,
        };
      }
    }
  }
  if (site.sqft && site.sqft > 0 && site.buildingType) {
    const bm = await h.getBenchmark(site.buildingType, com);
    if (bm) {
      return {
        annualUnits: bm.medianEui * site.sqft,
        kind: "imputed",
        label: `benchmark-imputed — ${bm.medianEui} ${bm.unit} (${bm.source}) × ${site.sqft.toLocaleString()} sqft; screening-grade`,
      };
    }
  }
  return null;
}

/** Resolve the $/unit price for a commodity, actual-first with the tier
 * notated in the label (owner directive Jul 19: "actual as able, imputed
 * where required, notated accordingly"):
 *   1. the meter's ASSIGNED tariff (closest to actual — user/bill-selected)
 *   2. a FILED seeded tariff (hand-modeled, source ≠ state-average imputed)
 *   3. the TERRITORY-ATTRIBUTED utility's state-average imputed row (the ZIP's
 *      dominant LDC per the EIA-861/176 registry)
 *   4. any state row → 5. disclosed national default. */
async function resolveRate(site: SiteLite, userId: number, com: "gas" | "water"): Promise<{ rate: number; label: string }> {
  const meters = await h.listMeters(site.id, userId);
  const cMeter = meters.find((m) => m.commodity === com) ?? null;
  const tryTariff = async (id: number | null | undefined) => {
    if (!id) return null;
    const t = await h.getTariff(id);
    if (!t || t.commodity !== com) return null;
    const r = (t.structure as TariffStructure)?.energy?.[0]?.ratePerUnit;
    return typeof r === "number" && r > 0 ? { rate: r, label: `your assigned ${t.name} rate` } : null;
  };
  const assigned = await tryTariff(cMeter?.currentTariffId);
  if (assigned) return assigned;
  const seeded = site.state ? await h.listTariffs(com, site.state) : [];
  const rateOf = (t: (typeof seeded)[number]) => {
    const r = (t.structure as TariffStructure)?.energy?.[0]?.ratePerUnit;
    return typeof r === "number" && r > 0 ? r : null;
  };
  // Tier 2: filed (non-imputed) seeded rows first — actual before imputed.
  const isImputed = (t: (typeof seeded)[number]) => t.source === "state_representative_synthesized";
  for (const t of seeded.filter((t) => !isImputed(t))) {
    const r = rateOf(t);
    if (r != null) return { rate: r, label: `seeded ${t.name} rate (filed-tariff modeled)` };
  }
  // Tier 3: territory-attributed utility's imputed row — the ZIP's dominant
  // LDC per the registry, so the name on the estimate matches who actually
  // serves the address.
  if (site.zip && com === "gas") {
    try {
      const terr = await lookupTerritory(site.zip, com);
      if (terr.covered && terr.utilities.length > 0) {
        const match = seeded.find((t) => rateOf(t) != null && terr.utilities.includes(t.utilityName));
        if (match) {
          return {
            rate: rateOf(match)!,
            label: `${match.utilityName} — ${match.name} (territory-matched to your ZIP; state-average imputed, verify against your bill)`,
          };
        }
      }
    } catch {
      /* territory lookup is best-effort — fall through to state row */
    }
  }
  // Tier 4: any state row (imputed) — still notated.
  for (const t of seeded) {
    const r = rateOf(t);
    if (r != null) return { rate: r, label: `seeded ${t.name} rate${isImputed(t) ? " (state-average imputed)" : ""}` };
  }
  return DEFAULT_RATE[com];
}

/**
 * Generate cross-commodity opportunity candidates for a site. Called from
 * pipeline stage 7 in the SAME run as electric ranking (replaceOpportunities
 * wipes per-site, so cross-commodity candidates must ride along, never a
 * separate pass).
 */
export async function generateCommodityOpportunities(
  site: SiteLite,
  userId: number,
  normals: MonthNormalRow[],
  narrate: (line: string) => void,
): Promise<XcOpportunity[]> {
  const out: XcOpportunity[] = [];

  /* ---------------- natural gas ---------------- */
  // Service-applicability gate (shared ladder): user override → meter/equipment
  // evidence → territory imputation → never-assumed default. An all-electric
  // site gets zero gas cards and the skip is narrated with the resolved reason.
  const gasSvc = await resolveCommodityService(site, userId, "gas");
  const gasBasis = gasSvc.analyze ? await resolveBasis(site, userId, "gas") : null;
  if (!gasSvc.analyze) {
    narrate(`Gas opportunities skipped: ${gasSvc.reason}.`);
  }
  if (gasBasis) {
    const { rate, label: rateLabel } = await resolveRate(site, userId, "gas");
    const unit = COMMODITY_UNITS.gas.usageUnit;
    // HDD-weighted heating share: EIA CBECS end-use prior puts space heating at
    // ~55% of commercial gas use in heating climates; clamp by actual HDD
    // presence so a hot-climate site never claims a big heating measure.
    const totalHdd = normals.reduce((s, n) => s + (n.hddBase65 ?? 0), 0);
    const heatingFrac = Math.max(0.15, Math.min(0.65, totalHdd > 0 ? 0.55 * Math.min(1, totalHdd / 3000) : 0.15));
    const heatingTherms = gasBasis.annualUnits * heatingFrac;

    // 1. Heating tune-up + controls: 5–12% of heating gas (DOE/ENERGY STAR band).
    {
      const lo = heatingTherms * 0.05;
      const hi = heatingTherms * 0.12;
      out.push({
        key: "gas_heating_tuneup",
        title: "Gas heating tune-up + controls",
        category: "gas_efficiency",
        annualSavingsUsdLo: Math.round(lo * rate),
        annualSavingsUsdHi: Math.round(hi * rate),
        capexBand: "low",
        confidence: gasBasis.kind === "measured" ? "medium" : "low",
        rationale: `Combustion tune-up, setback schedules, and boiler/furnace controls typically recover 5–12% of heating gas (DOE/ENERGY STAR). Heating estimated at ${Math.round(heatingFrac * 100)}% of annual gas (HDD-weighted EIA end-use prior). Priced at ${rateLabel}.`,
        disclosures: [gasBasis.label, MODELED_ESTIMATES_DISCLAIMER],
        estUnitsSavedPerYr: Math.round((lo + hi) / 2),
        unit,
        commodity: "gas",
      });
    }

    // 2. Water-heating efficiency: low-flow + setpoint on the non-heating share.
    {
      const dhwTherms = gasBasis.annualUnits * Math.min(0.25, 1 - heatingFrac);
      const lo = dhwTherms * 0.08;
      const hi = dhwTherms * 0.15;
      if (hi * rate >= 20) {
        out.push({
          key: "gas_dhw_efficiency",
          title: "Hot-water efficiency (setpoint + low-flow)",
          category: "gas_efficiency",
          annualSavingsUsdLo: Math.round(lo * rate),
          annualSavingsUsdHi: Math.round(hi * rate),
          capexBand: "low",
          confidence: "low",
          rationale: `Lowering water-heater setpoint to 120°F and installing low-flow fixtures typically saves 8–15% of water-heating gas (ENERGY STAR). Water heating estimated at up to 25% of annual gas (EIA end-use prior). Priced at ${rateLabel}.`,
          disclosures: [gasBasis.label, MODELED_ESTIMATES_DISCLAIMER],
          estUnitsSavedPerYr: Math.round((lo + hi) / 2),
          unit,
          commodity: "gas",
        });
      }
    }

    // 3. Weatherization — tied to confirmed envelope geometry when available.
    {
      const geo = await h.getSiteGeometry(site.id, userId);
      const hasEnvelope = !!geo && (geo.footprintSqft != null || geo.exposureScore != null);
      const lo = heatingTherms * 0.08;
      const hi = heatingTherms * 0.2;
      if (hi * rate >= 25) {
        out.push({
          key: "gas_weatherization",
          title: "Weatherization (air sealing + insulation)",
          category: "gas_efficiency",
          annualSavingsUsdLo: Math.round(lo * rate),
          annualSavingsUsdHi: Math.round(hi * rate),
          capexBand: "medium",
          confidence: gasBasis.kind === "measured" && hasEnvelope ? "medium" : "low",
          rationale: `Air sealing and insulation upgrades typically cut heating gas 8–20% (DOE Weatherization program data).${hasEnvelope ? ` Scoped using your confirmed building geometry${geo?.exposureScore != null ? ` (exposure score ${geo.exposureScore.toFixed(2)})` : ""}.` : " Confirm your building footprint in Explore to tighten this estimate with real wall-area exposure."} Priced at ${rateLabel}.`,
          disclosures: [gasBasis.label, MODELED_ESTIMATES_DISCLAIMER],
          estUnitsSavedPerYr: Math.round((lo + hi) / 2),
          unit,
          commodity: "gas",
        });
      }
    }
    narrate(`Gas opportunities generated (${gasBasis.kind}): ${out.filter((c) => c.commodity === "gas").length} measures on ${Math.round(gasBasis.annualUnits).toLocaleString()} therms/yr basis`);
  }

  /* ---------------- water ---------------- */
  // Same ladder for water: default is plausible-active (municipal water is
  // near-universal), but a user override or territory-absence turns it off.
  const waterSvc = await resolveCommodityService(site, userId, "water");
  const waterBasis = waterSvc.analyze ? await resolveBasis(site, userId, "water") : null;
  if (!waterSvc.analyze) {
    narrate(`Water opportunities skipped: ${waterSvc.reason}.`);
  }
  if (waterBasis) {
    const { rate, label: rateLabel } = await resolveRate(site, userId, "water");
    const unit = COMMODITY_UNITS.water.usageUnit;

    // 1. Fixture efficiency: 10–20% of indoor use (EPA WaterSense).
    {
      const lo = waterBasis.annualUnits * 0.1;
      const hi = waterBasis.annualUnits * 0.2;
      if (hi * rate >= 20) {
        out.push({
          key: "water_fixture_efficiency",
          title: "Water fixture efficiency (WaterSense retrofit)",
          category: "water_efficiency",
          annualSavingsUsdLo: Math.round(lo * rate),
          annualSavingsUsdHi: Math.round(hi * rate),
          capexBand: "low",
          confidence: waterBasis.kind === "measured" ? "medium" : "low",
          rationale: `WaterSense-labeled fixtures (faucets, toilets, aerators) typically cut total water use 10–20% (EPA WaterSense program data). Priced at ${rateLabel}. Sewer charges often scale with usage — actual dollar savings may be higher than shown.`,
          disclosures: [waterBasis.label, MODELED_ESTIMATES_DISCLAIMER],
          estUnitsSavedPerYr: Math.round((lo + hi) / 2),
          unit,
          commodity: "water",
        });
      }
    }

    // 2. Leak screening — only claimable with MEASURED data (a continuous-flow
    //    signature needs real readings; never imputed).
    if (waterBasis.kind === "measured") {
      const lo = waterBasis.annualUnits * 0.05;
      const hi = waterBasis.annualUnits * 0.1;
      if (hi * rate >= 15) {
        out.push({
          key: "water_leak_screening",
          title: "Leak screening + repair",
          category: "water_efficiency",
          annualSavingsUsdLo: Math.round(lo * rate),
          annualSavingsUsdHi: Math.round(hi * rate),
          capexBand: "low",
          confidence: "low",
          rationale: `EPA estimates ~6% of metered water is lost to leaks on average; screening minimum-night-flow against your meter data and repairing found leaks typically recovers 5–10%. Priced at ${rateLabel}.`,
          disclosures: [waterBasis.label, MODELED_ESTIMATES_DISCLAIMER],
          estUnitsSavedPerYr: Math.round((lo + hi) / 2),
          unit,
          commodity: "water",
        });
      }
    }
    narrate(`Water opportunities generated (${waterBasis.kind}): ${out.filter((c) => c.commodity === "water").length} measures on ${Math.round(waterBasis.annualUnits).toLocaleString()} gal/yr basis`);
  }

  return out;
}
