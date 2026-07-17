/**
 * Bill image/PDF pipeline (handoff §3 item 4).
 * Order of operations:
 *  1. hardening gate (magic bytes, size cap)
 *  2. LLM vision extraction (built-in Forge LLM) — the deployed runtime has no
 *     Tesseract binary, so the LLM is the primary OCR engine here; when the
 *     free-tier LLM budget kill-switch trips or the LLM is unreachable
 *     (offline), we degrade to a structured manual-entry prompt.
 *  3. Confidence scoring: every extracted field carries a confidence; overall
 *     parseConfidence < 0.6 → route to manual review with prefilled fields.
 */
import { invokeLLM } from "../_core/llm";
import { llmBudgetAllows, llmCostUsd, recordMeterEvent } from "../analytics/costModel";

/** Batch-36 (pass 1397): tile-scaled prompt-token estimate (floor 800, ceiling
 * 2600, /8000×85 scaling — Batch-15 semantics). Shared by the PRE-FLIGHT budget
 * check and the post-call metering fallback so the two can never disagree: a
 * hardcoded pre-flight figure that diverges from the actual estimate could
 * approve a call the budget cannot cover, producing a user-facing failure
 * after llmBudgetAllows returned true. */
function estimateBillOcrPromptTokens(imageDataUrl: string): number {
  return Math.min(2600, Math.max(800, Math.ceil(imageDataUrl.length / 8000) * 85));
}
/** Conservative completion-token allowance for the structured bill JSON. */
const EST_BILL_OCR_COMPLETION_TOKENS = 600;

export interface ExtractedBillField<T> {
  value: T | null;
  confidence: number; // 0..1
}

export interface ExtractedBill {
  utilityName: ExtractedBillField<string>;
  accountNumber: ExtractedBillField<string>;
  periodStart: ExtractedBillField<string>; // YYYY-MM-DD
  periodEnd: ExtractedBillField<string>;
  totalUsage: ExtractedBillField<number>;
  usageUnit: ExtractedBillField<string>;
  billedDemandKw: ExtractedBillField<number>;
  totalCostUsd: ExtractedBillField<number>;
  rateScheduleName: ExtractedBillField<string>;
  overallConfidence: number;
}

export type BillOcrOutcome =
  | { status: "extracted"; bill: ExtractedBill; needsReview: boolean }
  | { status: "manual_entry_required"; reason: string };

const BILL_SCHEMA = {
  type: "object" as const,
  properties: {
    utilityName: { type: "string" },
    accountNumber: { type: "string" },
    periodStart: { type: "string", description: "YYYY-MM-DD" },
    periodEnd: { type: "string", description: "YYYY-MM-DD" },
    totalUsage: { type: "number" },
    usageUnit: { type: "string", description: "kWh, therms, or gallons" },
    billedDemandKw: { type: "number" },
    totalCostUsd: { type: "number" },
    rateScheduleName: { type: "string" },
    fieldConfidences: {
      type: "object",
      description: "0-1 confidence per field name",
      additionalProperties: { type: "number" },
    },
  },
  required: ["utilityName", "periodStart", "periodEnd", "totalUsage", "usageUnit", "totalCostUsd", "fieldConfidences"],
  additionalProperties: false,
};

/**
 * Extract bill fields from an image (data URL) via LLM vision.
 * Degrades to manual entry when budget kill-switch trips or LLM offline.
 */
export async function extractBill(
  imageDataUrl: string,
  userId: number,
  tier: string,
  analysisId?: number,
): Promise<BillOcrOutcome> {
  // Kill-switch: free-tier monthly LLM budget → automatic downgrade to
  // template-only parsing (no template applies to arbitrary bill images, so
  // the honest degradation is a structured manual-entry prompt).
  // Batch-36 (pass 1397): the pre-flight estimate is DERIVED from the same
  // tile-scaled token model used for metering (plus a conservative completion
  // allowance), not a hardcoded constant — so the check can never approve a
  // call whose own metering estimate would exceed the remaining budget.
  const estPreflightCostUsd = llmCostUsd(estimateBillOcrPromptTokens(imageDataUrl), EST_BILL_OCR_COMPLETION_TOKENS);
  const allowed = await llmBudgetAllows(userId, tier, estPreflightCostUsd);
  if (!allowed) {
    // Batch-61 (pass 3127): tier-aware wording. Telling a plus/pro user who
    // exhausted their (10×) budget to "upgrade to Plus" was wrong on both
    // counts — they may already be on Plus/Pro, and upgrading RAISES the cap,
    // it does not remove it (bounded self-serve-beta budget, Batch-47 design).
    return {
      status: "manual_entry_required",
      reason:
        tier === "free"
          ? "Free-tier AI parsing budget for this month is exhausted — enter the bill fields manually below (upgrading to Plus raises this cap)."
          : `This month's AI parsing budget for your ${tier} plan is exhausted — enter the bill fields manually below; the budget resets next month.`,
    };
  }

  try {
    const resp = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a utility-bill data extractor. Extract ONLY what is legible on the bill. Use null for anything not clearly present. Report a 0-1 confidence per field in fieldConfidences. Dates as YYYY-MM-DD. Never guess account numbers.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the bill fields from this utility bill." },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "bill_extraction", strict: true, schema: BILL_SCHEMA },
      },
    });

    const raw = resp.choices?.[0]?.message?.content;
    const usage = resp.usage;
    // Cycle 7 (pass 367): when the provider omits `usage`, estimate tokens from
    // actual payload sizes rather than a fixed 1500/300. Batch-15 (pass 137):
    // vision billing scales with image TILES/resolution, not base64 byte length,
    // so the estimate is BOUNDED — floor 800 (conservative base for one image),
    // ceiling 2600 (≈ realistic hi-detail cost for a single bill photo plus
    // prompt text). An unbounded length-proportional estimate would prematurely
    // trip the free-tier kill-switch on large photos while still failing safe.
    const estPromptTokens = estimateBillOcrPromptTokens(imageDataUrl); // Batch-36 (pass 1397): shared with pre-flight
    const estCompletionTokens = Math.ceil((typeof raw === "string" ? raw.length : 0) / 4);
    // Batch-46 (pass 2007): recordMeterEvent throws on DB-unavailable (Batch-45
    // pass 1927 fail-loud rule). Without its own catch, that throw would fall
    // into the outer `catch (llmErr)` and be misreported as an LLM availability
    // incident — the LLM call SUCCEEDED and cost was incurred. Catch it here,
    // attribute the failure accurately, and degrade to manual entry.
    try {
      await recordMeterEvent({
        userId,
        analysisId,
        kind: "bill_ocr_llm",
        llmTokensIn: usage?.prompt_tokens ?? estPromptTokens,
        llmTokensOut: usage?.completion_tokens ?? estCompletionTokens,
        tier,
      });
    } catch (meterErr) {
      console.error("[billOcr] metering write failed (DB availability, NOT an LLM failure) — LLM cost was incurred but could not be recorded:", meterErr);
      // Batch-48 (pass 2207) ADJUDICATED POLICY: a reviewer proposed returning
      // the successful extraction anyway (cost was incurred either way) with a
      // warning. Deliberately NOT adopted: delivering the result while the
      // metering write failed makes the usage permanently unmetered — exactly
      // the silent-unmetered-delivery hole the Batch-45 (pass 1927) fail-loud
      // contract closed. Denying delivery keeps the incentive to fix metering
      // aligned (an outage degrades UX loudly instead of quietly eroding the
      // unit-economics ledger), and the user keeps a zero-cost path (manual
      // entry) plus retry. The one-call LLM cost is absorbed as an operator
      // loss, logged above for reconciliation.
      return {
        status: "manual_entry_required",
        reason: "Usage metering is temporarily unavailable, so AI parsing results cannot be delivered right now — enter the bill fields manually below, or retry shortly.",
      };
    }

    if (!raw || typeof raw !== "string") {
      return { status: "manual_entry_required", reason: "AI parser returned no result — please enter the bill fields manually." };
    }
    // Batch-17 (pass 296): parse/shape failures are a DISTINCT failure mode from
    // LLM unreachability — collapsing them into one "unavailable" message would
    // misattribute malformed model output as an availability incident. Parse
    // errors get their own catch, message, and log line.
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> & { fieldConfidences?: Record<string, number> };
      const fc = parsed.fieldConfidences ?? {};
      const field = <T,>(key: string): ExtractedBillField<T> => ({
        value: (parsed[key] ?? null) as T | null,
        confidence: typeof fc[key] === "number" ? Math.max(0, Math.min(1, fc[key])) : parsed[key] != null ? 0.5 : 0,
      });
      const bill: ExtractedBill = {
        utilityName: field<string>("utilityName"),
        accountNumber: field<string>("accountNumber"),
        periodStart: field<string>("periodStart"),
        periodEnd: field<string>("periodEnd"),
        totalUsage: field<number>("totalUsage"),
        usageUnit: field<string>("usageUnit"),
        billedDemandKw: field<number>("billedDemandKw"),
        totalCostUsd: field<number>("totalCostUsd"),
        rateScheduleName: field<string>("rateScheduleName"),
        overallConfidence: 0,
      };
      const critical = [bill.periodStart, bill.periodEnd, bill.totalUsage, bill.totalCostUsd];
      bill.overallConfidence = critical.reduce((a, f) => a + f.confidence, 0) / critical.length;
      return { status: "extracted", bill, needsReview: bill.overallConfidence < 0.6 };
    } catch (parseErr) {
      console.error("[billOcr] LLM returned malformed JSON output (parse failure, NOT availability):", parseErr);
      return {
        status: "manual_entry_required",
        reason: "The AI parser returned malformed output for this bill — please enter the bill fields manually.",
      };
    }
  } catch (llmErr) {
    // LLM unreachable (offline/network/timeout) → automatic degradation to manual entry
    console.error("[billOcr] LLM invocation failed (availability):", llmErr);
    return {
      status: "manual_entry_required",
      reason: "AI bill parsing is currently unavailable — enter the bill fields manually below.",
    };
  }
}
