/**
 * Per-site per-commodity service applicability (owner reports Jul 19: "not
 * all sites are dual fuel", "not necessarily every building has a water or
 * electric hookup", "there appear to be given service areas for utilities —
 * ways to directly attribute or reasonably impute this").
 *
 * ONE shared resolution ladder decides whether a commodity is analyzed for a
 * site. Every tier is disclosed with its provenance — the answer is never a
 * silent assumption:
 *
 *  1. USER OVERRIDE — sites.servicesProfile[commodity] = "active" | "none".
 *     The user's word is final in both directions.
 *  2. DIRECT EVIDENCE — a meter of that commodity on the site (any role), or
 *     user-confirmed/entered equipment burning that fuel (inferred equipment
 *     rows are excluded: inference derives from meter presence, so counting
 *     them would be circular). Evidence proves ACTIVE; absence proves nothing.
 *  3. TERRITORY IMPUTATION — the seeded tariff snapshot doubles as a service-
 *     territory registry: if NO utility in the site's state serves that
 *     commodity (with the site's named utility, when known, not offering it
 *     either), service is imputed ABSENT for gas — the one commodity commonly
 *     not present. A populated territory keeps the ladder falling through to
 *     the default (being IN a gas territory makes gas plausible, not certain).
 *  4. COMMODITY DEFAULT — electric and water default to plausible-active
 *     (grid electricity and municipal water are near-universal for occupied
 *     buildings); gas defaults to NOT ANALYZED without evidence (plenty of
 *     buildings are all-electric — assuming dual fuel fabricates savings).
 *
 * Resolutions:
 *  - "active"   → analyze (measured or imputed baselines per the usual rules)
 *  - "none"     → skip entirely, narrated with the reason
 *  - "unknown"  → commodity default applies (electric/water analyze, gas skip)
 */
import * as h from "./dbHelpers";

export type Commodity = "electric" | "gas" | "water";
export type ServiceState = "active" | "none" | "unknown";

/** Shape stored in sites.servicesProfile (JSON, all keys optional). */
export type ServicesProfile = Partial<Record<Commodity, ServiceState>>;

export interface ServiceResolution {
  commodity: Commodity;
  /** Final answer: should this commodity be analyzed for this site? */
  analyze: boolean;
  /** Which ladder tier decided. */
  basis: "user_override" | "meter_evidence" | "equipment_evidence" | "territory_imputed" | "default";
  /** Human-readable provenance line, safe to narrate/disclose verbatim. */
  reason: string;
}

interface SiteForResolution {
  id: number;
  state: string | null;
  utilityName?: string | null;
  servicesProfile?: unknown;
}

function readProfile(raw: unknown): ServicesProfile {
  if (raw == null || typeof raw !== "object") return {};
  const out: ServicesProfile = {};
  for (const c of ["electric", "gas", "water"] as const) {
    const v = (raw as Record<string, unknown>)[c];
    if (v === "active" || v === "none" || v === "unknown") out[c] = v;
  }
  return out;
}

/**
 * Resolve service applicability for one commodity on one site.
 * DB reads are limited to what the tier being evaluated needs.
 */
export async function resolveCommodityService(
  site: SiteForResolution,
  userId: number,
  commodity: Commodity,
): Promise<ServiceResolution> {
  // Tier 1 — user override, final in both directions.
  const profile = readProfile(site.servicesProfile);
  const override = profile[commodity];
  if (override === "active" || override === "none") {
    return {
      commodity,
      analyze: override === "active",
      basis: "user_override",
      reason:
        override === "active"
          ? `you marked ${commodity} service as active on this site`
          : `you marked this site as having no ${commodity} service`,
    };
  }

  // Tier 2 — direct evidence proves ACTIVE (absence proves nothing).
  const meters = await h.listMeters(site.id, userId);
  if (meters.some((m) => m.commodity === commodity)) {
    return {
      commodity,
      analyze: true,
      basis: "meter_evidence",
      reason: `this site has a ${commodity} meter`,
    };
  }
  if (commodity === "gas") {
    const equipment = await h.listEquipment(site.id, userId);
    const gasEquip = equipment.find(
      (e) => e.source !== "inferred" && /gas|propane/i.test(`${e.label ?? ""} ${e.notes ?? ""}`),
    );
    if (gasEquip) {
      return {
        commodity,
        analyze: true,
        basis: "equipment_evidence",
        reason: `you confirmed gas-burning equipment on this site (${gasEquip.label})`,
      };
    }
  }

  // Tier 3 — territory imputation from the seeded tariff snapshot. Only a
  // NEGATIVE signal is conclusive: no utility serving the commodity in the
  // site's state → impute absent (disclosed as snapshot-based). A populated
  // territory only means "plausible" and falls through.
  if (site.state) {
    try {
      const territory = await h.listTariffs(commodity, site.state);
      if (territory.length === 0) {
        return {
          commodity,
          analyze: false,
          basis: "territory_imputed",
          reason: `no ${commodity} utility serves ${site.state} in the seeded tariff snapshot — service imputed absent; mark it active in site settings if this is wrong`,
        };
      }
      // Named-utility refinement for gas: the site's own (electric) utility not
      // offering gas is NOT evidence of absence (separate gas utilities are
      // common), so no decision here — fall through to the default.
    } catch {
      /* territory lookup failure never blocks resolution — fall through */
    }
  }

  // Tier 4 — commodity default.
  if (commodity === "gas") {
    return {
      commodity,
      analyze: false,
      basis: "default",
      reason:
        "no gas meter, confirmed gas equipment, or user setting on this site — treated as all-electric (gas is never assumed); add any of those to unlock gas analysis",
    };
  }
  return {
    commodity,
    analyze: true,
    basis: "default",
    reason: `${commodity === "electric" ? "grid electricity" : "municipal water"} service is near-universal for occupied buildings — assumed present until you mark it absent in site settings`,
  };
}

/** Resolve all three commodities at once (site settings UI + analysis narration). */
export async function resolveAllCommodityServices(
  site: SiteForResolution,
  userId: number,
): Promise<Record<Commodity, ServiceResolution>> {
  const [electric, gas, water] = await Promise.all([
    resolveCommodityService(site, userId, "electric"),
    resolveCommodityService(site, userId, "gas"),
    resolveCommodityService(site, userId, "water"),
  ]);
  return { electric, gas, water };
}
