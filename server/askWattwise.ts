/**
 * §3k Ask Meterly — natural language as an ENTRANCE to existing engines.
 *
 * The question box never produces free-text answers. It classifies the
 * question into one of the engine intents and returns a dispatch card that
 * the client renders in the standard card grammar (headline → why →
 * confidence chip → action → provenance). Every card's numbers come from
 * engines that already exist (attribution, opportunities, tariff sweep,
 * scenarios, prove-it) — the LLM only routes, it never invents figures.
 *
 * Honesty rules:
 *  - LLM output is routing metadata only; all displayed numbers come from
 *    stored analysis rows.
 *  - If the LLM is unavailable or over budget, a deterministic keyword
 *    router answers instead (disclosed in the card provenance).
 *  - Unknown intents return an honest "can't route this" card listing what
 *    CAN be asked — never a hallucinated answer.
 */
import { invokeLLM } from "./_core/llm";

export type AskIntent =
  | "attribution" // why was my bill/peak high?
  | "scenario_battery"
  | "scenario_solar"
  | "scenario_efficiency"
  | "scenario_ev"
  | "rate_switch" // is there a cheaper plan?
  | "top_opportunity" // what should I do first / how do I save?
  | "verified_savings" // is it working / what have I saved?
  | "benchmark" // how do I compare?
  | "emissions"
  | "unknown";

export interface AskRoute {
  intent: AskIntent;
  /** How the route was decided — surfaced in card provenance. */
  routedBy: "llm" | "keyword_fallback";
}

const INTENT_VALUES: AskIntent[] = [
  "attribution",
  "scenario_battery",
  "scenario_solar",
  "scenario_efficiency",
  "scenario_ev",
  "rate_switch",
  "top_opportunity",
  "verified_savings",
  "benchmark",
  "emissions",
  "unknown",
];

/**
 * Deterministic keyword router — the zero-cost fallback when the LLM is
 * unavailable or the account's LLM budget is exhausted. Ordered: more
 * specific patterns first.
 */
export function keywordRoute(question: string): AskIntent {
  const q = question.toLowerCase();
  if (/\bbattery|storage|peak.?shav/i.test(q)) return "scenario_battery";
  if (/\bsolar|panels?|pv\b/i.test(q)) return "scenario_solar";
  if (/\bev\b|electric vehicle|charger/i.test(q)) return "scenario_ev";
  if (/led|lighting|hvac|insulat|efficien|retrofit|setpoint|thermostat/i.test(q)) return "scenario_efficiency";
  if (/rate|tariff|plan\b|cheaper plan|switch/i.test(q)) return "rate_switch";
  if (/why.*(high|spike|peak|expensive|bill)|what (made|caused|drove)|peak.*(happen|come from)/i.test(q)) return "attribution";
  if (/verif|working|saved so far|actually sav|prove/i.test(q)) return "verified_savings";
  if (/compare|benchmark|percentile|similar building|peers?/i.test(q)) return "benchmark";
  if (/carbon|co2|emission|footprint/i.test(q)) return "emissions";
  if (/save|reduce|lower|cut|first|start|do next|opportunit/i.test(q)) return "top_opportunity";
  if (/high|spike|expensive|bill went up/i.test(q)) return "attribution";
  return "unknown";
}

/**
 * Route a question to an engine intent. Tries the LLM (bounded, cheap,
 * structured output); falls back to keywords on any failure. The caller is
 * responsible for budget checks BEFORE calling with allowLlm=true.
 */
export async function routeQuestion(question: string, allowLlm: boolean): Promise<AskRoute> {
  if (allowLlm) {
    try {
      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You route energy-analytics questions to engine intents. Respond ONLY with JSON. Intents: attribution (why was a bill/peak high, what caused usage), scenario_battery, scenario_solar, scenario_efficiency (LED/HVAC/insulation/setpoints), scenario_ev, rate_switch (cheaper plan/tariff), top_opportunity (how to save, what to do first), verified_savings (is it working, savings so far), benchmark (comparison to peers), emissions (carbon), unknown (anything else, incl. questions needing data you don't have).",
          },
          { role: "user", content: question.slice(0, 500) },
        ],
        maxTokens: 60,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "ask_route",
            schema: {
              type: "object",
              properties: { intent: { type: "string", enum: INTENT_VALUES } },
              required: ["intent"],
              additionalProperties: false,
            },
          },
        },
      });
      const text =
        typeof res.choices?.[0]?.message?.content === "string"
          ? res.choices[0].message.content
          : JSON.stringify(res.choices?.[0]?.message?.content ?? "");
      const parsed = JSON.parse(text) as { intent?: string };
      if (parsed.intent && (INTENT_VALUES as string[]).includes(parsed.intent)) {
        return { intent: parsed.intent as AskIntent, routedBy: "llm" };
      }
    } catch {
      // fall through to keyword routing — disclosed via routedBy
    }
  }
  return { intent: keywordRoute(question), routedBy: "keyword_fallback" };
}

/** Rough token estimate for the routing call (budget pre-check). */
export const ASK_ROUTE_EST_COST_USD = 0.002;

/* ================= card dispatch (stored rows only, never LLM text) ================= */

export interface AskCard {
  /** Headline dollars (null → headlineFallback shown instead). */
  dollars: number | null;
  framing: "Save" | "Verified" | null;
  headlineFallback?: string;
  why: string;
  confidence: "measured" | "good" | "estimated";
  extraChips: string[];
  /** Deep link into the engine surface that owns this answer. */
  action: { label: string; href: string } | null;
  provenance: string[];
}

interface AskContext {
  siteId: number;
  siteName: string;
  insights: Array<{ kind: string; title: string; body: string | null; confidence: string | null; metrics: unknown }>;
  summaryMetrics: Record<string, unknown> | null;
  opportunities: Array<{
    id: number;
    rank: number;
    measure: string;
    title: string;
    description: string | null;
    estCostSavingsPerYr: number | null;
    confidence: string | null;
    paybackBandYears: string | null;
  }>;
  verifiedTotalUsd: number;
}

function conf(c: string | null | undefined): "measured" | "good" | "estimated" {
  return c === "high" ? "good" : c === "medium" ? "good" : "estimated";
}

const RUN_FIRST: AskCard = {
  dollars: null,
  framing: null,
  headlineFallback: "Run an analysis first",
  why: "This question needs an analysis to answer from real figures. Run one from the Explore page — it takes under a minute.",
  confidence: "estimated",
  extraChips: [],
  action: { label: "Go to Explore", href: "/app/explore" },
  provenance: ["No stored analysis rows exist for this site yet — Meterly never answers from generated text."],
};

/**
 * Build the dispatch card for an intent from STORED engine rows. Falls back
 * to an honest "run analysis first" card when the needed rows don't exist.
 */
export async function buildAskCard(intent: AskIntent, ctx: AskContext): Promise<AskCard> {
  const { siteId } = ctx;
  switch (intent) {
    case "attribution": {
      const attr = ctx.insights.find((i) => i.kind === "peak_attribution");
      if (!attr) return { ...RUN_FIRST, why: "Peak attribution needs an analysis with interval data. Upload interval data (or re-run analysis) and ask again." };
      const m = (attr.metrics ?? {}) as { counterfactualSavingsUsd?: number | null };
      return {
        dollars: m.counterfactualSavingsUsd ?? null,
        framing: m.counterfactualSavingsUsd != null ? "Save" : null,
        headlineFallback: attr.title,
        why: attr.body ?? attr.title,
        confidence: conf(attr.confidence),
        extraChips: ["§3b attribution", "modeled split"],
        action: { label: "See the full attribution card", href: `/app/explore?site=${siteId}` },
        provenance: ["From your stored peak-attribution insight — schedule/weather/coincidence split with counterfactual re-pricing on your assigned rate."],
      };
    }
    case "scenario_battery":
    case "scenario_solar":
    case "scenario_efficiency":
    case "scenario_ev": {
      const measure = intent === "scenario_battery" ? "battery_peak_shave" : intent === "scenario_solar" ? "solar_pv" : intent === "scenario_ev" ? "ev_charging" : "efficiency";
      const label = intent.replace("scenario_", "").replace(/_/g, " ");
      const opp = ctx.opportunities.find((o) => o.measure.includes(measure.split("_")[0]));
      return {
        dollars: opp?.estCostSavingsPerYr ?? null,
        framing: opp?.estCostSavingsPerYr != null ? "Save" : null,
        headlineFallback: `Model a ${label} scenario for ${ctx.siteName}`,
        why: opp ? (opp.description ?? opp.title) : `The scenario engine re-prices a full year of your usage with a ${label} change applied — same pricing engine as your bills.`,
        confidence: conf(opp?.confidence),
        extraChips: opp ? [`ranked #${opp.rank}`] : [],
        action: { label: `Open ${label} in Scenarios`, href: `/app/scenarios?site=${siteId}&measure=${measure}` },
        provenance: [
          opp
            ? `Dollar figure from your stored opportunity row (rank #${opp.rank}); the scenario run refines it with a full-year re-price.`
            : "No stored opportunity for this measure yet — the Scenarios page will compute one from your baseline.",
        ],
      };
    }
    case "rate_switch": {
      const cmp = (ctx.summaryMetrics?.tariffComparisons ?? null) as Array<{ tariffName: string; eligible: boolean; savingsVsCurrent: number | null }> | null;
      if (!cmp || cmp.length === 0) return { ...RUN_FIRST, why: "The rate sweep needs an analysis. Run one and ask again — every seeded rate you may be eligible for gets re-priced." };
      const best = cmp.filter((t) => t.eligible && t.savingsVsCurrent != null && t.savingsVsCurrent > 0).sort((a, b) => (b.savingsVsCurrent ?? 0) - (a.savingsVsCurrent ?? 0))[0];
      return {
        dollars: best?.savingsVsCurrent ?? null,
        framing: best ? "Save" : null,
        headlineFallback: "No cheaper eligible rate found in the seeded sweep",
        why: best
          ? `${best.tariffName} prices out cheaper than your current rate on your actual load profile.`
          : "Your current rate was the cheapest eligible option in the stored sweep — that's worth knowing too.",
        confidence: "good",
        extraChips: ["rate sweep"],
        action: { label: "See the full rate check", href: `/app/explore?site=${siteId}` },
        provenance: ["From your stored tariff-comparison sweep — your load re-priced on every seeded rate, eligibility-filtered. Verify final eligibility with your utility."],
      };
    }
    case "top_opportunity": {
      const top = ctx.opportunities[0];
      if (!top) return { ...RUN_FIRST, why: "Ranked opportunities need an analysis. Run one and ask again." };
      return {
        dollars: top.estCostSavingsPerYr,
        framing: top.estCostSavingsPerYr != null ? "Save" : null,
        headlineFallback: top.title,
        why: top.description ?? top.title,
        confidence: conf(top.confidence),
        extraChips: [`ranked #${top.rank}`, ...(top.paybackBandYears ? [`payback ${top.paybackBandYears}`] : [])],
        action: { label: "Model this in Scenarios", href: `/app/scenarios?site=${siteId}&measure=${top.measure}` },
        provenance: ["Your #1 stored opportunity, ranked by estimated annual dollar impact across all detected measures."],
      };
    }
    case "verified_savings": {
      return {
        dollars: ctx.verifiedTotalUsd > 0 ? ctx.verifiedTotalUsd : null,
        framing: ctx.verifiedTotalUsd > 0 ? "Verified" : null,
        headlineFallback: "No verified savings yet",
        why:
          ctx.verifiedTotalUsd > 0
            ? "Sum of band-clearing months across your implemented measures — actual usage vs the weather-adjusted counterfactual."
            : "Mark a measure “I did this” on an opportunity card and Meterly will verify savings month by month against the weather-adjusted counterfactual.",
        confidence: ctx.verifiedTotalUsd > 0 ? "measured" : "estimated",
        extraChips: ["prove-it loop"],
        action: { label: "See the verification ledger", href: `/app/explore?site=${siteId}` },
        provenance: ["Only months that clear the model's uncertainty band count as verified — inside-band months are reported as inconclusive, never claimed."],
      };
    }
    case "benchmark": {
      const b = (ctx.summaryMetrics?.benchmark ?? null) as { percentileBand?: string | null; siteEui?: number | null } | null;
      if (!b?.percentileBand) return { ...RUN_FIRST, why: "Benchmarking needs an analysis. Run one and ask again." };
      return {
        dollars: null,
        framing: null,
        headlineFallback: String(b.percentileBand),
        why: `Energy-use intensity${b.siteEui != null ? ` of ${Math.round(b.siteEui)} kBtu/sqft/yr` : ""} compared against seeded medians for this building type.`,
        confidence: "good",
        extraChips: ["EUI benchmark"],
        action: { label: "See the benchmark card", href: `/app/explore?site=${siteId}` },
        provenance: ["From your stored benchmark insight — percentile vs seeded national medians (CBECS/RECS-derived), not a live peer network."],
      };
    }
    case "emissions": {
      const e = (ctx.summaryMetrics?.emissions ?? null) as { annualCo2eLb?: number; subregion?: string; mapped?: boolean } | null;
      if (!e) return { ...RUN_FIRST, why: "Emissions figures need an analysis. Run one and ask again." };
      return {
        dollars: null,
        framing: null,
        headlineFallback: `~${Math.round(e.annualCo2eLb ?? 0).toLocaleString()} lb CO₂e/yr`,
        why: e.mapped === false ? "Estimated with a default grid factor — the region could not be verified." : `Annual grid emissions using the ${e.subregion ?? "regional"} eGRID factor.`,
        confidence: e.mapped === false ? "estimated" : "good",
        extraChips: ["eGRID annual avg"],
        action: { label: "See the emissions card", href: `/app/explore?site=${siteId}` },
        provenance: ["From your stored emissions insight — annual eGRID subregion factor applied to modeled annual usage."],
      };
    }
    default:
      return {
        dollars: null,
        framing: null,
        headlineFallback: "I can't route that question yet",
        why: "Ask Meterly answers from your stored analysis engines. Try: “Why was my peak high?”, “Is there a cheaper rate?”, “What if I add a battery?”, “What should I do first?”, “How much have I saved?”, or “How do I compare?”.",
        confidence: "estimated",
        extraChips: [],
        action: null,
        provenance: ["The question didn't match any engine intent — Meterly never answers with generated text, so no answer is safer than a made-up one."],
      };
  }
}
