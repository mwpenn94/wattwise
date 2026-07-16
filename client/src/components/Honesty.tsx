/**
 * Honesty primitives — provenance labels, confidence badges, and the
 * modeled-estimates disclaimer. Verbatim label constants come from
 * shared/wattwise.ts so UI and engine can never drift.
 */
import { Info, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MODELED_ESTIMATES_DISCLAIMER } from "@shared/wattwise";

export function ProvChip({ children }: { children: React.ReactNode }) {
  return <span className="prov-chip">{children}</span>;
}

export function ConfidenceBadge({ level, label }: { level: "low" | "medium" | "high"; label?: string }) {
  const styles: Record<string, string> = {
    low: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    medium: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
    high: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  };
  return (
    <Badge variant="outline" className={`font-mono text-[10px] uppercase tracking-wider ${styles[level]}`}>
      {label ?? `${level} confidence`}
    </Badge>
  );
}

export function DisclaimerBanner() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <span>{MODELED_ESTIMATES_DISCLAIMER}</span>
    </div>
  );
}

export function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="inline h-3.5 w-3.5 cursor-help text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{text}</TooltipContent>
    </Tooltip>
  );
}
