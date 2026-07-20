/**
 * AC13 — probable equipment inventory, lifecycle horizon, sizing diagnostics,
 * degradation drift, and the annual checkup story.
 *
 * Honesty contract:
 *  - inventory rows are INFERRED from what the analysis actually observed
 *    (disaggregation shares, demand shape, building attributes) — every row
 *    carries source='inferred' + a confidence and the observation that
 *    justified it, until the user confirms or edits it;
 *  - lifecycle horizon = installYear + serviceLife vs today, stated as a
 *    planning window, never a failure prediction;
 *  - degradation drift compares this year's weather-normalized usage against
 *    last year's on the same site — it names the drift, not a diagnosis.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { equipmentInventory } from "../drizzle/schema";

/* ------------------------------------------------------------------ */
/* Inference                                                           */
/* ------------------------------------------------------------------ */

export interface InferredEquip {
  equipKey: string;
  label: string;
  confidence: "high" | "medium" | "low";
  serviceLifeYears: number;
  basis: string; // the observation that justified the inference
}

/** Infer a probable equipment inventory from analysis signals. Pure. */
export function inferEquipment(opts: {
  buildingType: string | null;
  sqft: number | null;
  state: string | null;
  hvacShare: number | null; // 0..1 from disaggregation, null when unknown
  baseloadShare: number | null;
  hasSolar: boolean;
  hasGasMeter: boolean;
  peakKw: number | null;
}): InferredEquip[] {
  const out: InferredEquip[] = [];
  const bt = opts.buildingType ?? "unknown";
  const residential = ["single_family", "multifamily"].includes(bt);

  // Cooling: in AZ/NV/TX-like climates a meaningful HVAC share implies
  // compressor-based cooling; hot-dry states default to AC or heat pump.
  if ((opts.hvacShare ?? 0) >= 0.2) {
    out.push({
      equipKey: "cooling_system",
      label: residential ? "Central air conditioner / heat pump" : "Packaged rooftop units (RTUs)",
      confidence: "high",
      serviceLifeYears: residential ? 15 : 18,
      basis: `HVAC-attributed share of usage is ${Math.round((opts.hvacShare ?? 0) * 100)}% — compressor-based cooling is almost certainly present.`,
    });
  } else if (["AZ", "NV", "TX", "FL"].includes(opts.state ?? "")) {
    out.push({
      equipKey: "cooling_system",
      label: residential ? "Air conditioner (assumed for the climate)" : "Cooling plant (assumed for the climate)",
      confidence: "low",
      serviceLifeYears: 15,
      basis: "No strong HVAC signature in the data yet, but buildings in this climate almost always have mechanical cooling.",
    });
  }

  // Heating: gas meter implies furnace/boiler; otherwise electric heat likely
  // bundled in the HVAC share.
  if (opts.hasGasMeter) {
    out.push({
      equipKey: "heating_system",
      label: residential ? "Gas furnace" : "Gas boiler / furnace",
      confidence: "medium",
      serviceLifeYears: residential ? 18 : 25,
      basis: "A gas meter is on file — fossil heating equipment is the most likely load behind it.",
    });
    out.push({
      equipKey: "water_heater",
      label: "Gas water heater",
      confidence: "medium",
      serviceLifeYears: 12,
      basis: "Gas service typically includes water heating.",
    });
  } else {
    out.push({
      equipKey: "water_heater",
      label: "Electric water heater",
      confidence: "low",
      serviceLifeYears: 12,
      basis: "No gas meter on file — water heating is most likely electric.",
    });
  }

  // Always-on plug/refrigeration load.
  if ((opts.baseloadShare ?? 0) >= 0.35) {
    out.push({
      equipKey: "refrigeration_baseload",
      label: residential ? "Refrigerator(s) + always-on plug load" : "Refrigeration / server / always-on equipment",
      confidence: "medium",
      serviceLifeYears: 14,
      basis: `Baseload is ${Math.round((opts.baseloadShare ?? 0) * 100)}% of usage — a large always-on population of equipment.`,
    });
  }

  if (opts.hasSolar) {
    out.push({
      equipKey: "solar_pv",
      label: "Rooftop solar PV system",
      confidence: "high",
      serviceLifeYears: 28,
      basis: "Solar confirmed on this site (user-confirmed or detected in the interval data).",
    });
  }

  // Lighting for commercial.
  if (!residential && opts.sqft && opts.sqft > 2000) {
    out.push({
      equipKey: "lighting_system",
      label: "Interior lighting system",
      confidence: "medium",
      serviceLifeYears: 12,
      basis: "Commercial floor area implies a managed lighting system; vintage unknown until you confirm.",
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Persistence — upsert inferred rows without clobbering user edits     */
/* ------------------------------------------------------------------ */

export async function syncInferredEquipment(siteId: number, userId: number, inferred: InferredEquip[]): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const existing = await db
    .select()
    .from(equipmentInventory)
    .where(and(eq(equipmentInventory.siteId, siteId), eq(equipmentInventory.userId, userId)));
  const byKey = new Map(existing.map((e) => [e.equipKey, e]));
  let written = 0;
  for (const inf of inferred) {
    const cur = byKey.get(inf.equipKey);
    if (cur && cur.source !== "inferred") continue; // never clobber user-confirmed/entered rows
    if (cur) {
      await db
        .update(equipmentInventory)
        .set({ label: inf.label, confidence: inf.confidence, serviceLifeYears: inf.serviceLifeYears, notes: inf.basis, updatedAt: Date.now() })
        .where(eq(equipmentInventory.id, cur.id));
    } else {
      await db.insert(equipmentInventory).values({
        siteId,
        userId,
        equipKey: inf.equipKey,
        label: inf.label,
        source: "inferred",
        confidence: inf.confidence,
        installYear: null,
        serviceLifeYears: inf.serviceLifeYears,
        notes: inf.basis,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    written++;
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* Lifecycle horizon                                                    */
/* ------------------------------------------------------------------ */

export interface LifecycleItem {
  equipKey: string;
  label: string;
  installYear: number | null;
  serviceLifeYears: number | null;
  yearsRemaining: number | null;
  window: "past_typical_life" | "inside_5yr_window" | "healthy_horizon" | "unknown";
  message: string;
}

export function lifecycleHorizon(rows: Array<{ equipKey: string; label: string; installYear: number | null; serviceLifeYears: number | null }>, now = new Date()): LifecycleItem[] {
  const year = now.getFullYear();
  return rows.map((r) => {
    if (r.installYear == null || r.serviceLifeYears == null) {
      return {
        equipKey: r.equipKey,
        label: r.label,
        installYear: r.installYear,
        serviceLifeYears: r.serviceLifeYears,
        yearsRemaining: null,
        window: "unknown" as const,
        message: `${r.label}: add the install year to see its replacement-planning window.`,
      };
    }
    const remaining = r.installYear + r.serviceLifeYears - year;
    const window = remaining < 0 ? ("past_typical_life" as const) : remaining <= 5 ? ("inside_5yr_window" as const) : ("healthy_horizon" as const);
    const message =
      window === "past_typical_life"
        ? `${r.label} is ${-remaining} year${remaining === -1 ? "" : "s"} past its typical service life — plan (don't panic): equipment often outlives the average, but budgeting for replacement now beats an emergency swap at the worst price.`
        : window === "inside_5yr_window"
          ? `${r.label} enters its typical replacement window within ${remaining} year${remaining === 1 ? "" : "s"} — a good horizon to compare high-efficiency options while you have time to choose.`
          : `${r.label} has roughly ${remaining} years of typical service life remaining.`;
    return { equipKey: r.equipKey, label: r.label, installYear: r.installYear, serviceLifeYears: r.serviceLifeYears, yearsRemaining: remaining, window, message };
  });
}

/* ------------------------------------------------------------------ */
/* Degradation drift + sizing                                           */
/* ------------------------------------------------------------------ */

export interface DriftResult {
  driftPct: number; // + = using more than last year
  material: boolean;
  message: string;
}

/** Year-over-year weather-normalized drift. Caller passes two normalized
 * annual figures (this-year, last-year) from the SAME normalization basis. */
export function degradationDrift(currentAnnual: number | null, priorAnnual: number | null): DriftResult | null {
  if (currentAnnual == null || priorAnnual == null || priorAnnual <= 0) return null;
  const drift = (currentAnnual - priorAnnual) / priorAnnual;
  const pct = Math.round(drift * 1000) / 10;
  const material = Math.abs(drift) >= 0.08;
  return {
    driftPct: pct,
    material,
    message: material
      ? drift > 0
        ? `Weather-normalized usage is up ${pct}% vs the prior year — past our 8% materiality threshold (normalized baselines typically wobble a few percent year-to-year from non-weather noise; ASHRAE-style monthly models carry roughly that much residual error). With no reported change in how the building is used, the pattern is consistent with equipment losing efficiency (dirty coils, refrigerant, failing economizers). Worth a service visit; the data names the drift, not the diagnosis.`
        : `Weather-normalized usage is down ${Math.abs(pct)}% vs the prior year — whatever changed is working in your favor.`
      : `Year-over-year weather-normalized drift is ${pct >= 0 ? "+" : ""}${pct}% — below the 8% materiality threshold (within typical noise for a normalized monthly baseline).`,
  };
}

export interface SizingDiagnostic {
  kind: "short_cycling_suspect" | "oversize_suspect" | "undersize_suspect" | "no_finding";
  message: string;
}

/** Sizing diagnostics from load-shape statistics (pure heuristics, disclosed
 * as suspicions). loadFactor = avg/peak; hvacShare from disagg. */
export function sizingDiagnostic(opts: { loadFactor: number | null; hvacShare: number | null; peakKw: number | null; sqft: number | null }): SizingDiagnostic {
  const { loadFactor, hvacShare, peakKw, sqft } = opts;
  if (loadFactor == null || peakKw == null) return { kind: "no_finding", message: "Not enough demand-shape data for a sizing read." };
  const wPerSqft = sqft && sqft > 0 ? (peakKw * 1000) / sqft : null;
  if ((hvacShare ?? 0) >= 0.3 && loadFactor < 0.2 && wPerSqft != null && wPerSqft > 8) {
    return {
      kind: "oversize_suspect",
      message: `Peak demand is high for the floor area (${wPerSqft.toFixed(1)} W/sqft) while average use is low (load factor ${(loadFactor * 100).toFixed(0)}%) — a shape consistent with oversized HVAC that cycles hard. An oversized unit costs more up front AND runs less efficiently. Worth asking at the next service visit.`,
    };
  }
  if ((hvacShare ?? 0) >= 0.4 && loadFactor > 0.7) {
    return {
      kind: "undersize_suspect",
      message: `HVAC runs nearly flat-out (load factor ${(loadFactor * 100).toFixed(0)}% with ${Math.round((hvacShare ?? 0) * 100)}% of usage in HVAC) — a shape consistent with equipment struggling to keep up. If comfort complaints match, the system may be undersized or degraded.`,
    };
  }
  return { kind: "no_finding", message: "Demand shape shows no sizing red flags." };
}

/* ------------------------------------------------------------------ */
/* Annual checkup story                                                 */
/* ------------------------------------------------------------------ */

export function annualCheckupStory(opts: {
  siteName: string;
  lifecycle: LifecycleItem[];
  drift: DriftResult | null;
  sizing: SizingDiagnostic;
}): string {
  const parts: string[] = [`Annual equipment checkup for ${opts.siteName}:`];
  const attention = opts.lifecycle.filter((l) => l.window === "past_typical_life" || l.window === "inside_5yr_window");
  parts.push(
    attention.length > 0
      ? `${attention.length} item${attention.length === 1 ? "" : "s"} in or past the replacement-planning window (${attention.map((a) => a.label).join("; ")}).`
      : "No equipment is inside its typical replacement window (based on what we know — add install years to sharpen this).",
  );
  if (opts.drift) parts.push(opts.drift.message);
  if (opts.sizing.kind !== "no_finding") parts.push(opts.sizing.message);
  parts.push("Everything above is inferred from your usage data and typical service lives — confirm or edit the inventory to make this page yours.");
  return parts.join(" ");
}
