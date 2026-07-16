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
import { llmBudgetAllows, recordMeterEvent } from "../analytics/costModel";

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
  const allowed = await llmBudgetAllows(userId, tier, 0.03);
  if (!allowed) {
    return {
      status: "manual_entry_required",
      reason:
        "Free-tier AI parsing budget for this month is exhausted — enter the bill fields manually below (upgrading to Plus removes this cap).",
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
    await recordMeterEvent({
      userId,
      analysisId,
      kind: "bill_ocr_llm",
      llmTokensIn: usage?.prompt_tokens ?? 1500,
      llmTokensOut: usage?.completion_tokens ?? 300,
      tier,
    });

    if (!raw || typeof raw !== "string") {
      return { status: "manual_entry_required", reason: "AI parser returned no result — please enter the bill fields manually." };
    }
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
  } catch {
    // LLM unreachable (offline) → automatic degradation to manual entry
    return {
      status: "manual_entry_required",
      reason: "AI bill parsing is currently unavailable — enter the bill fields manually below.",
    };
  }
}
