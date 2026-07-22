/**
 * TEL-4 — telecom bill photo extraction (internet / mobile / TV / landline).
 *
 * Mirrors the utility-bill OCR pipeline (billOcr.ts) exactly on its budget,
 * metering, and failure-mode contracts:
 *  1. hardening gate happens at the router (preParseGate)
 *  2. LLM vision extraction via built-in Forge LLM
 *  3. pre-flight budget check DERIVED from the same tile-scaled token model
 *     used for metering (Batch-36 rule — pre-flight and metering never disagree)
 *  4. metering write failure DENIES delivery (Batch-45/48 fail-loud policy)
 *  5. parse failures reported distinctly from availability failures (Batch-17)
 *
 * Output maps onto TelecomServiceInput fields so one photo prefills the
 * add-service form: provider, plan, monthly cost, promo end + post-promo
 * price, contract end, speed, lines, data allowance.
 */
import { invokeLLM } from "../_core/llm";
import { llmBudgetAllows, llmCostUsd, recordMeterEvent } from "../analytics/costModel";

function estimatePromptTokens(imageDataUrl: string): number {
  return Math.min(2600, Math.max(800, Math.ceil(imageDataUrl.length / 8000) * 85));
}
const EST_COMPLETION_TOKENS = 500;

export interface ExtractedTelecomField<T> {
  value: T | null;
  confidence: number; // 0..1
}

export interface ExtractedTelecomBill {
  serviceType: ExtractedTelecomField<"internet" | "mobile" | "tv_bundle" | "phone_landline">;
  provider: ExtractedTelecomField<string>;
  planName: ExtractedTelecomField<string>;
  monthlyCostUsd: ExtractedTelecomField<number>;
  promoEndsDate: ExtractedTelecomField<string>; // YYYY-MM-DD
  postPromoCostUsd: ExtractedTelecomField<number>;
  contractEndsDate: ExtractedTelecomField<string>; // YYYY-MM-DD
  downloadMbps: ExtractedTelecomField<number>;
  lines: ExtractedTelecomField<number>;
  dataAllowanceGb: ExtractedTelecomField<number>;
  unlimitedData: ExtractedTelecomField<boolean>;
  actualDataUsedGb: ExtractedTelecomField<number>;
  overallConfidence: number;
}

export type TelecomOcrOutcome =
  | { status: "extracted"; bill: ExtractedTelecomBill; needsReview: boolean }
  | { status: "manual_entry_required"; reason: string };

const TELECOM_SCHEMA = {
  type: "object" as const,
  properties: {
    serviceType: { type: "string", enum: ["internet", "mobile", "tv_bundle", "phone_landline"] },
    provider: { type: "string" },
    planName: { type: "string" },
    monthlyCostUsd: { type: "number", description: "current recurring monthly total in USD" },
    promoEndsDate: { type: "string", description: "YYYY-MM-DD promo/intro pricing end date if stated" },
    postPromoCostUsd: { type: "number", description: "regular price after promo ends, if stated" },
    contractEndsDate: { type: "string", description: "YYYY-MM-DD contract/agreement end date if stated" },
    downloadMbps: { type: "number", description: "internet download speed in Mbps if stated" },
    lines: { type: "number", description: "number of mobile lines on the account" },
    dataAllowanceGb: { type: "number", description: "monthly data allowance in GB for capped plans" },
    unlimitedData: { type: "boolean", description: "true if the plan is advertised as unlimited data" },
    actualDataUsedGb: { type: "number", description: "actual data used this cycle in GB if shown" },
    fieldConfidences: {
      type: "object",
      description: "0-1 confidence per field name",
      additionalProperties: { type: "number" },
    },
  },
  required: ["serviceType", "provider", "monthlyCostUsd", "fieldConfidences"],
  additionalProperties: false,
};

/** Extract telecom bill fields from a photo/screenshot (data URL). */
export async function extractTelecomBill(
  imageDataUrl: string,
  userId: number,
  tier: string,
): Promise<TelecomOcrOutcome> {
  const estPreflightCostUsd = llmCostUsd(estimatePromptTokens(imageDataUrl), EST_COMPLETION_TOKENS);
  const allowed = await llmBudgetAllows(userId, tier, estPreflightCostUsd);
  if (!allowed) {
    return {
      status: "manual_entry_required",
      reason:
        tier === "free"
          ? "Free-tier AI parsing budget for this month is exhausted — enter the service fields manually below (upgrading to Plus raises this cap)."
          : `This month's AI parsing budget for your ${tier} plan is exhausted — enter the service fields manually below; the budget resets next month.`,
    };
  }

  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a telecom-bill data extractor (internet, mobile/cell phone, TV, landline bills). Extract ONLY what is legible on the bill. Use null for anything not clearly present. Report a 0-1 confidence per field in fieldConfidences. Dates as YYYY-MM-DD. The monthly cost is the recurring total (exclude one-time charges/credits when they are itemized separately). Never guess account numbers or invent promo dates.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the telecom service fields from this bill." },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "telecom_bill_extraction", strict: true, schema: TELECOM_SCHEMA },
      },
    });

    const raw = resp.choices?.[0]?.message?.content;
    const usage = resp.usage;
    const estPromptTokens = estimatePromptTokens(imageDataUrl);
    const estCompletionTokens = Math.ceil((typeof raw === "string" ? raw.length : 0) / 4);
    try {
      await recordMeterEvent({
        userId,
        kind: "telecom_ocr_llm",
        llmTokensIn: usage?.prompt_tokens ?? estPromptTokens,
        llmTokensOut: usage?.completion_tokens ?? estCompletionTokens,
        tier,
      });
    } catch (meterErr) {
      console.error(
        "[telecomOcr] metering write failed (DB availability, NOT an LLM failure) — LLM cost was incurred but could not be recorded:",
        meterErr,
      );
      return {
        status: "manual_entry_required",
        reason:
          "Usage metering is temporarily unavailable, so AI parsing results cannot be delivered right now — enter the service fields manually below, or retry shortly.",
      };
    }

    if (!raw || typeof raw !== "string") {
      return { status: "manual_entry_required", reason: "AI parser returned no result — please enter the service fields manually." };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> & { fieldConfidences?: Record<string, number> };
      const fc = parsed.fieldConfidences ?? {};
      const field = <T,>(key: string): ExtractedTelecomField<T> => ({
        value: (parsed[key] ?? null) as T | null,
        confidence: typeof fc[key] === "number" ? Math.max(0, Math.min(1, fc[key])) : parsed[key] != null ? 0.5 : 0,
      });
      const bill: ExtractedTelecomBill = {
        serviceType: field("serviceType"),
        provider: field<string>("provider"),
        planName: field<string>("planName"),
        monthlyCostUsd: field<number>("monthlyCostUsd"),
        promoEndsDate: field<string>("promoEndsDate"),
        postPromoCostUsd: field<number>("postPromoCostUsd"),
        contractEndsDate: field<string>("contractEndsDate"),
        downloadMbps: field<number>("downloadMbps"),
        lines: field<number>("lines"),
        dataAllowanceGb: field<number>("dataAllowanceGb"),
        unlimitedData: field<boolean>("unlimitedData"),
        actualDataUsedGb: field<number>("actualDataUsedGb"),
        overallConfidence: 0,
      };
      const critical = [bill.serviceType, bill.provider, bill.monthlyCostUsd];
      bill.overallConfidence = critical.reduce((a, f) => a + f.confidence, 0) / critical.length;
      return { status: "extracted", bill, needsReview: bill.overallConfidence < 0.6 };
    } catch (parseErr) {
      console.error("[telecomOcr] LLM returned malformed JSON output (parse failure, NOT availability):", parseErr);
      return {
        status: "manual_entry_required",
        reason: "The AI parser returned malformed output for this bill — please enter the service fields manually.",
      };
    }
  } catch (llmErr) {
    console.error("[telecomOcr] LLM invocation failed (availability):", llmErr);
    return {
      status: "manual_entry_required",
      reason: "AI bill parsing is currently unavailable — enter the service fields manually below.",
    };
  }
}
