/**
 * OPEN-3 (Oct 26): scenarios and composed plans for campuses with several
 * separately billed service agreements.
 *
 * A campus total is a convenience sum, not a bill. Each utility account is
 * billed on its own schedule, with its own demand peaks, blocks and ratchet,
 * so a measure is priced account by account and the dollar results are
 * summed. Nothing is priced on the summed campus load.
 *
 * Rules (all disclosed in the results):
 * - Usage-reduction (efficiency) measures apply to every account.
 * - Solar, battery and EV charging physically connect behind ONE meter, so
 *   they attach to one chosen account (default: the account with the most
 *   annual kWh — usually the one that can absorb the most on-site output).
 * - Capex and payback are computed once, on campus-level savings, with the
 *   same rules as a single-account scenario (scenarioPayback/basketPayback).
 * - Peak change is the sum of each account's own billing-peak change; the
 *   campus total's coincident peak is not what any account is billed on.
 * - Composed plans keep the current schedule per account. Rate choice is
 *   reviewed account by account in Explore (per-account rate review).
 */
import type { ScenarioResults, TariffStructure } from "../../shared/wattwise";
import { runScenario, scenarioPayback, hourlyToPoints, type ScenarioInput } from "./scenarios";
import { costOnTariff } from "./tariffEngine";
import { composeMeasures, basketPayback, type ComposedResult, type PlanMeasure } from "./composer";

export interface CampusAccountBasis {
  meterId: number;
  label: string;
  /** 8760 hour-of-year profile for this account. */
  hourly: number[];
  structure: TariffStructure;
  tariffId: number;
  tariffName: string;
  utilityName: string;
  nem?: { banking?: string | null; creditExpiry?: string | null };
  confidence: "low" | "medium" | "high";
  extrapolated: boolean;
}

export interface CampusAccountLine {
  meterId: number;
  label: string;
  tariffName: string;
  utilityName: string;
  baselineAnnualCost: number;
  scenarioAnnualCost: number;
  /** scenario − baseline (negative = saves money). */
  deltaCost: number;
  /** Null for composed plans (the composer reports cost and peaks, not kWh). */
  deltaUsageKwh: number | null;
  deltaPeakKw: number;
  measureApplied: boolean;
}

export interface CampusScenarioMeta {
  accounts: CampusAccountLine[];
  /** Account that solar/battery/EV attach to (null for efficiency-only). */
  targetMeterId: number | null;
  targetLabel: string | null;
  accountCount: number;
}

const ONE_ACCOUNT_KINDS = new Set(["solar", "battery", "solar_battery", "ev_load"]);
const cap = (v: number) => Math.round(v * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ORDER = { low: 0, medium: 1, high: 2 } as const;
const weakestOf = (xs: Array<"low" | "medium" | "high">) =>
  xs.reduce<"low" | "medium" | "high">((acc, c) => (ORDER[c] < ORDER[acc] ? c : acc), "high");

/** Account with the most annual kWh (ties: lowest meter id, deterministic). */
export function defaultTargetAccount(accounts: CampusAccountBasis[]): CampusAccountBasis {
  if (accounts.length === 0) throw new Error("A campus scenario needs at least one service agreement.");
  return [...accounts].sort((a, b) => sum(b.hourly) - sum(a.hourly) || a.meterId - b.meterId)[0];
}

export function resolveTargetAccount(accounts: CampusAccountBasis[], requestedMeterId?: number | null): CampusAccountBasis {
  if (requestedMeterId != null) {
    const hit = accounts.find((a) => a.meterId === requestedMeterId);
    if (!hit) throw new Error("The selected account is not one of this campus's service agreements.");
    return hit;
  }
  return defaultTargetAccount(accounts);
}

/**
 * Per-account dollar sentences describe one account, not the campus. They are
 * replaced by the per-account table and the campus-level lines added here.
 */
function isPerAccountDollarSentence(d: string): boolean {
  return (
    d.startsWith("Payback band is derived from") ||
    d.startsWith("Basket payback band is derived from") ||
    d.startsWith("Individually these measures would sum to") ||
    d.startsWith("Together these measures save") ||
    d.startsWith("No billing history before") ||
    d.startsWith("On your composed profile,")
  );
}

/**
 * Notes that differ only by account share a topic key: a known per-account
 * note heading (its month list or amount varies by account), or otherwise the
 * full text with numbers removed (so only number-only differences group).
 */
const PER_ACCOUNT_NOTE_HEADS = ["REST treatment unconfirmed:", "Incomplete rider coverage:", "Applied date-versioned riders by calendar month:", "Demand ratchet applied"];
function noteTopic(d: string): string {
  const head = PER_ACCOUNT_NOTE_HEADS.find((h) => d.startsWith(h));
  if (head) return head.toLowerCase();
  return d.replace(/[$\u2212-]?\d[\d,.]*%?/g, "#").trim().toLowerCase();
}
/**
 * One line per topic. When accounts carry different versions of the same note,
 * the first is kept and marked with how many accounts it applies to, so the
 * campus result does not repeat near-identical notes for every account.
 */
function mergeDisclosures(lists: string[][]): string[] {
  const order: string[] = [];
  const groups = new Map<string, { first: string; variants: Set<string>; accounts: number }>();
  for (const list of lists) {
    const seenHere = new Set<string>();
    for (const d of list) {
      if (isPerAccountDollarSentence(d)) continue;
      const k = noteTopic(d);
      let g = groups.get(k);
      if (!g) {
        g = { first: d, variants: new Set(), accounts: 0 };
        groups.set(k, g);
        order.push(k);
      }
      g.variants.add(d);
      if (!seenHere.has(k)) {
        seenHere.add(k);
        g.accounts++;
      }
    }
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    if (g.variants.size <= 1) return g.first;
    return `${g.first} (Similar note on ${g.accounts} of ${lists.length} accounts; details differ by account.)`;
  });
}

const peakOf = (h: number[]) => (h.length ? Math.max(0, ...h) : 0);

export function runCampusScenario(
  accounts: CampusAccountBasis[],
  input: ScenarioInput,
  climateZone: string,
  co2eLbPerMwh: number,
  requestedTargetMeterId?: number | null,
): ScenarioResults & { campus: CampusScenarioMeta } {
  if (accounts.length === 0) throw new Error("A campus scenario needs at least one service agreement.");
  const oneAccount = ONE_ACCOUNT_KINDS.has(input.kind);
  const target = oneAccount ? resolveTargetAccount(accounts, requestedTargetMeterId) : null;
  const perAccountInput: ScenarioInput = { ...input, capexUsd: undefined };
  const lines: CampusAccountLine[] = [];
  const disclosureLists: string[][] = [];
  const confidences: Array<"low" | "medium" | "high"> = [];
  let anyExtrapolated = false;
  let deltaCo2eLb = 0;
  let dispatchMethod: ScenarioResults["dispatchMethod"];
  for (const a of accounts) {
    const applies = !oneAccount || a.meterId === target!.meterId;
    if (!applies) {
      // Untouched account: its bill does not change. Priced only so the table
      // shows its current cost (no measure applied).
      // Same baseline basis runScenario uses (no solar flag).
      const base = costOnTariff(hourlyToPoints(a.hourly), a.structure).breakdown.total;
      lines.push({ meterId: a.meterId, label: a.label, tariffName: a.tariffName, utilityName: a.utilityName, baselineAnnualCost: cap(base), scenarioAnnualCost: cap(base), deltaCost: 0, deltaUsageKwh: 0, deltaPeakKw: 0, measureApplied: false });
      continue;
    }
    const r = runScenario(a.hourly, perAccountInput, a.structure, climateZone, co2eLbPerMwh, a.confidence, a.extrapolated, a.nem);
    const e = r.perCommodity.electric;
    lines.push({
      meterId: a.meterId,
      label: a.label,
      tariffName: a.tariffName,
      utilityName: a.utilityName,
      baselineAnnualCost: cap(r.baselineAnnualCost ?? 0),
      scenarioAnnualCost: cap(r.scenarioAnnualCost ?? 0),
      deltaCost: cap(r.siteTotalDeltaCost),
      deltaUsageKwh: cap(e?.deltaUsage ?? 0),
      deltaPeakKw: cap(e?.deltaDemandKw ?? 0),
      measureApplied: true,
    });
    disclosureLists.push(r.disclosures);
    confidences.push(r.confidence);
    anyExtrapolated = anyExtrapolated || r.extrapolated;
    deltaCo2eLb += r.siteTotalDeltaCo2eLb;
    dispatchMethod = dispatchMethod ?? r.dispatchMethod;
  }
  const applied = lines.filter((l) => l.measureApplied);
  const deltaCost = cap(sum(applied.map((l) => l.deltaCost)));
  const baselineAnnualCost = cap(sum(lines.map((l) => l.baselineAnnualCost)));
  const scenarioAnnualCost = cap(sum(lines.map((l) => l.scenarioAnnualCost)));
  const confidence = weakestOf(confidences.length ? confidences : ["low"]);
  const payback = scenarioPayback(input.capexUsd, deltaCost, confidence);
  const disclosures = mergeDisclosures(disclosureLists);
  disclosures.unshift(
    oneAccount
      ? `Campus with ${accounts.length} separately billed service agreements: this measure connects behind one meter, so it is modeled on ${target!.label} (${target!.tariffName}). The other ${accounts.length - 1} account${accounts.length - 1 === 1 ? "" : "s"} keep their current bills. Choose a different account to compare.`
      : `Campus with ${accounts.length} separately billed service agreements: the reduction is applied to each account and each one is priced on its own schedule, then the dollar results are added. Nothing is priced on the combined campus load.`,
  );
  disclosures.push("Peak change is the sum of each account's own billing-peak change, because each account is billed on its own peak.");
  if (payback.disclosure) disclosures.push(payback.disclosure.replace("this scenario's", "this campus scenario's weakest account"));
  return {
    perCommodity: {
      electric: {
        deltaUsage: cap(sum(applied.map((l) => l.deltaUsageKwh ?? 0))),
        deltaDemandKw: cap(sum(applied.map((l) => l.deltaPeakKw))),
        deltaCost,
        deltaCo2eLb: cap(deltaCo2eLb),
      },
    },
    siteTotalDeltaCost: deltaCost,
    siteTotalDeltaCo2eLb: cap(deltaCo2eLb),
    paybackYears: payback.paybackYears,
    paybackBand: payback.paybackBand,
    confidence,
    confidenceLabel: `${confidence} confidence — campus scenario inherits its weakest account's baseline uncertainty${anyExtrapolated ? " (extrapolated baseline)" : ""}`,
    disclosures,
    assumptions: {
      solar: input.solarKwDc ? { kwDc: input.solarKwDc } : undefined,
      battery: input.batteryKwh ? { kwh: input.batteryKwh, kw: input.batteryKw ?? null } : undefined,
      efficiency: input.efficiencyReductions,
      ev: input.evAnnualKwh,
      capexUsd: input.capexUsd,
      pricing: "per_service_agreement",
      targetMeterId: target?.meterId ?? null,
    },
    extrapolated: anyExtrapolated,
    dispatchMethod,
    baselineAnnualCost,
    scenarioAnnualCost,
    campus: { accounts: lines, targetMeterId: target?.meterId ?? null, targetLabel: target?.label ?? null, accountCount: accounts.length },
  };
}

export function composeCampusMeasures(
  accounts: CampusAccountBasis[],
  measures: PlanMeasure[],
  climateZone: string,
  co2eLbPerMwh: number,
  endUseFractions: Record<string, number> | undefined,
  sectorClass: string,
  siteHasSolar: boolean,
  requestedTargetMeterId?: number | null,
): ComposedResult & { campus: CampusScenarioMeta } {
  if (accounts.length === 0) throw new Error("A campus plan needs at least one service agreement.");
  const needsTarget = measures.some((m) => ONE_ACCOUNT_KINDS.has(m.kind));
  const target = needsTarget ? resolveTargetAccount(accounts, requestedTargetMeterId) : null;
  const lines: CampusAccountLine[] = [];
  const disclosureLists: string[][] = [];
  const confidences: Array<"low" | "medium" | "high"> = [];
  const perMeasureSavings = new Map<string, { key: string; label: string; individualSavings: number; confidence: "low" | "medium" | "high" }>();
  let sumOfIndividual = 0;
  let baselinePeakSum = 0;
  let composedPeakSum = 0;
  let deltaCo2eLb = 0;
  for (const a of accounts) {
    const forAccount = measures
      .filter((m) => !ONE_ACCOUNT_KINDS.has(m.kind) || a.meterId === target?.meterId)
      .map((m) => ({ ...m, capexUsd: undefined }));
    if (forAccount.length === 0) {
      // Same baseline basis composeMeasures uses (site solar flag).
      const base = cap(costOnTariff(hourlyToPoints(a.hourly), a.structure, { hasSolar: siteHasSolar }).breakdown.total);
      lines.push({ meterId: a.meterId, label: a.label, tariffName: a.tariffName, utilityName: a.utilityName, baselineAnnualCost: base, scenarioAnnualCost: base, deltaCost: 0, deltaUsageKwh: null, deltaPeakKw: 0, measureApplied: false });
      const pk = peakOf(a.hourly);
      baselinePeakSum += pk;
      composedPeakSum += pk;
      continue;
    }
    const r = composeMeasures(a.hourly, forAccount, a.structure, climateZone, co2eLbPerMwh, a.confidence, a.extrapolated, endUseFractions, [], sectorClass, siteHasSolar, a.nem);
    lines.push({
      meterId: a.meterId,
      label: a.label,
      tariffName: a.tariffName,
      utilityName: a.utilityName,
      baselineAnnualCost: r.baselineAnnualCost,
      scenarioAnnualCost: r.composedAnnualCost,
      deltaCost: cap(r.composedAnnualCost - r.baselineAnnualCost),
      deltaUsageKwh: null,
      deltaPeakKw: cap(r.composedPeakKw - r.baselinePeakKw),
      measureApplied: true,
    });
    baselinePeakSum += r.baselinePeakKw;
    composedPeakSum += r.composedPeakKw;
    deltaCo2eLb += r.deltaCo2eLb;
    sumOfIndividual += r.sumOfIndividualSavings;
    disclosureLists.push(r.disclosures);
    confidences.push(r.confidence);
    for (const pm of r.perMeasure) {
      const prev = perMeasureSavings.get(pm.key);
      perMeasureSavings.set(pm.key, {
        key: pm.key,
        label: pm.label,
        individualSavings: cap((prev?.individualSavings ?? 0) + pm.individualSavings),
        confidence: prev ? weakestOf([prev.confidence, pm.confidence]) : pm.confidence,
      });
    }
  }
  const baselineAnnualCost = cap(sum(lines.map((l) => l.baselineAnnualCost)));
  const composedAnnualCost = cap(sum(lines.map((l) => l.scenarioAnnualCost)));
  const composedSavings = cap(baselineAnnualCost - composedAnnualCost);
  const overlap = cap(sumOfIndividual - composedSavings);
  const confidence = weakestOf(confidences.length ? confidences : ["low"]);
  const basketCapexUsd = cap(measures.reduce((acc, m) => acc + (m.capexUsd ?? 0), 0));
  const bp = basketPayback(basketCapexUsd, composedSavings, confidence);
  const disclosures = mergeDisclosures(disclosureLists);
  disclosures.unshift(
    `Campus with ${accounts.length} separately billed service agreements: each account is priced on its own schedule and the results are added.${
      target ? ` Solar, battery and EV measures connect behind one meter and are modeled on ${target.label} (${target.tariffName}).` : ""
    } Nothing is priced on the combined campus load.`,
  );
  if (measures.length >= 2 && Math.abs(overlap) > 1) {
    disclosures.push(
      overlap > 0
        ? `Across the campus, these measures would save $${Math.round(sumOfIndividual).toLocaleString()}/yr one at a time, but together they save $${Math.round(composedSavings).toLocaleString()}/yr. They overlap by $${Math.round(overlap).toLocaleString()} because they compete for the same energy and peaks.`
        : `Across the campus, these measures save $${Math.round(composedSavings).toLocaleString()}/yr together, more than the $${Math.round(sumOfIndividual).toLocaleString()} they save one at a time. This is a modeled effect, not a guarantee.`,
    );
  }
  disclosures.push("Rate choice is reviewed separately for each account in Explore (per-account rate review); this plan keeps each account on its current schedule.");
  if (bp.disclosure) disclosures.push(bp.disclosure);
  return {
    baselineAnnualCost,
    composedAnnualCost,
    composedSavings,
    sumOfIndividualSavings: cap(sumOfIndividual),
    overlap,
    perMeasure: Array.from(perMeasureSavings.values()),
    confidence,
    basketCapexUsd,
    basketPaybackYears: bp.paybackYears,
    basketPaybackBand: bp.paybackBand,
    baselinePeakKw: cap(baselinePeakSum),
    composedPeakKw: cap(composedPeakSum),
    deltaCo2eLb: cap(deltaCo2eLb),
    rateSweep: [],
    ratePlanOvertake: null,
    disclosures,
    campus: { accounts: lines, targetMeterId: target?.meterId ?? null, targetLabel: target?.label ?? null, accountCount: accounts.length },
  };
}
