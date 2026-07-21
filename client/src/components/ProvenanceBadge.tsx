/**
 * NEXT-2 (Jul 21) — provenance tier badge for dollar figures.
 *
 * Owner directive: "actual as able, imputed where required, notated
 * accordingly" — every displayed dollar should wear its provenance tier, not
 * bury it in a footnote. The server already emits basis strings with tier
 * keywords everywhere (pipeline / scenarios / estimate / opportunities /
 * M&V); this chip classifies the string into a tier and color-codes it, with
 * the full verbatim basis in a tooltip.
 *
 * Tier ladder (best → weakest), keyed by the phrases the server actually emits:
 *   actual        (green)  "tariff-priced", "your tariff-priced cost basis", "your assigned"
 *   bill-verified (green)  "bill-verified"
 *   filed         (blue)   "filed-tariff", "filed tariff"
 *   imputed       (amber)  "state-average imputed", "territory-matched", "benchmark-imputed", "imputed"
 *   assumed       (gray)   "national average", "national-average", "assumption"
 */
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BadgeCheck, FileCheck2, Landmark, TriangleAlert, Globe } from "lucide-react";
import type { ReactNode } from "react";

export type ProvenanceTier = "actual" | "bill_verified" | "filed" | "imputed" | "assumed";

const TIER_META: Record<ProvenanceTier, { label: string; className: string; icon: ReactNode }> = {
  actual: {
    label: "Actual",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: <BadgeCheck className="h-3 w-3" />,
  },
  bill_verified: {
    label: "Bill-verified",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: <FileCheck2 className="h-3 w-3" />,
  },
  filed: {
    label: "Filed tariff",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    icon: <Landmark className="h-3 w-3" />,
  },
  imputed: {
    label: "Imputed",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-500",
    icon: <TriangleAlert className="h-3 w-3" />,
  },
  assumed: {
    label: "National avg",
    className: "border-border bg-muted/60 text-muted-foreground",
    icon: <Globe className="h-3 w-3" />,
  },
};

/** Classify a server basis/disclosure string into a provenance tier.
 * Order matters: the strongest specific phrase wins so a string like
 * "state-average imputed ... verify against your bill" never reads as
 * bill-verified (checked first via exact phrase). */
export function classifyBasis(basis: string | null | undefined): ProvenanceTier | null {
  if (!basis) return null;
  const s = basis.toLowerCase();
  if (s.includes("bill-verified")) return "bill_verified";
  if (s.includes("tariff-priced") || s.includes("your assigned") || s.includes("cost basis (actual)") || s.includes("verified against bill")) return "actual";
  if (s.includes("filed-tariff") || s.includes("filed tariff")) return "filed";
  if (s.includes("imputed") || s.includes("territory-matched") || s.includes("state-average") || s.includes("state average")) return "imputed";
  if (s.includes("national average") || s.includes("national-average") || s.includes("assumption")) return "assumed";
  return null;
}

/**
 * Color-coded provenance chip. Pass either an explicit `tier` (when the
 * server sends machine-readable provenance, e.g. summary.ratePricing.tier) or
 * a raw `basis` string to classify. Renders nothing when neither resolves —
 * never guesses a tier.
 */
export function ProvenanceBadge({
  tier,
  basis,
  className,
}: {
  tier?: ProvenanceTier | "tariff_priced_actual" | "state_average_imputed" | "national_assumption" | null;
  basis?: string | null;
  className?: string;
}) {
  // Map the pipeline's machine tier names onto the badge tiers.
  const mapped: ProvenanceTier | null =
    tier === "tariff_priced_actual"
      ? "actual"
      : tier === "state_average_imputed"
        ? "imputed"
        : tier === "national_assumption"
          ? "assumed"
          : tier === "bill_verified"
            ? "bill_verified"
            : (tier as ProvenanceTier | null | undefined) ?? classifyBasis(basis);
  if (!mapped || !(mapped in TIER_META)) return null;
  const meta = TIER_META[mapped];
  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none",
        meta.className,
        className,
      )}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
  if (!basis) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
        {basis}
      </TooltipContent>
    </Tooltip>
  );
}
