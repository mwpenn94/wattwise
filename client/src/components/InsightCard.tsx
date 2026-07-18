/**
 * InsightCard — the single card grammar for every insight in the product
 * (UX addendum v1.9 §2). Structure, top to bottom, always:
 *
 *   1. Headline: the dollar figure (or the honest reason there isn't one)
 *   2. One-line why: cause, not restatement
 *   3. Confidence chip: Estimated / Good / Measured (3 states, never more)
 *   4. One-tap action: the single next thing that raises accuracy or captures value
 *   5. Provenance expander: "where this number comes from" — collapsed by default
 *
 * No naked kWh above the fold: energy quantities live in the expander or
 * after the dollar headline, never as the headline itself.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export type InsightConfidence = "estimated" | "good" | "measured";

const CHIP_STYLES: Record<InsightConfidence, string> = {
  estimated: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  good: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  measured: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};

const CHIP_LABELS: Record<InsightConfidence, string> = {
  estimated: "Estimated",
  good: "Good",
  measured: "Measured",
};

/** Map engine confidence (low/medium/high) to the three chip states. */
export function chipFromConfidence(level: "low" | "medium" | "high" | null | undefined, measured = false): InsightConfidence {
  if (measured) return "measured";
  if (level === "high") return "good";
  return "estimated";
}

export interface InsightCardProps {
  /** The dollar figure. Positive = savings/opportunity, negative = cost increase. Null = no dollar figure exists (headlineFallback explains why). */
  dollars: number | null;
  /** Cadence suffix, e.g. "/yr", "/mo". Default "/yr". */
  per?: string;
  /** Framing verb phrase before the number, e.g. "Save", "You spend", "Costs you". */
  framing?: string;
  /** When dollars is null: the honest headline (e.g. "Not enough data for a dollar figure yet"). */
  headlineFallback?: string;
  /** One line explaining WHY — the cause, not a restatement of the number. */
  why: string;
  confidence: InsightConfidence;
  /** Extra chips (e.g. "ratchet-aware") rendered after the confidence chip. */
  extraChips?: string[];
  /** One-tap action. Omit when the card is purely informational. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Optional secondary action (e.g. §3e "I did this" prove-it entry point). */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  /** Provenance lines shown in the collapsed-by-default expander. */
  provenance?: string[];
  /** Secondary metrics rendered small, below the fold (kWh, kW, payback). */
  metrics?: Array<{ label: string; value: string }>;
  /** Optional rank badge for ordered lists. */
  rank?: number;
  className?: string;
}

function fmtDollars(v: number): string {
  const abs = Math.abs(v);
  const s = abs >= 10_000 ? `$${Math.round(abs / 100) / 10}k` : `$${Math.round(abs).toLocaleString()}`;
  return v < 0 ? `−${s}` : s;
}

export function InsightCard(p: InsightCardProps) {
  const [open, setOpen] = useState(false);
  const per = p.per ?? "/yr";

  return (
    <div className={`rounded-md border border-border/70 bg-card p-4 text-card-foreground ${p.className ?? ""}`}>
      {/* 1 — dollar headline */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display text-xl font-bold tracking-tight">
          {p.rank != null && <span className="mr-2 font-mono text-xs font-normal text-primary">#{p.rank}</span>}
          {p.dollars != null ? (
            <>
              {p.framing && <span className="mr-1.5 text-sm font-semibold text-muted-foreground">{p.framing}</span>}
              <span className={p.dollars >= 0 ? "text-primary" : "text-destructive"}>{fmtDollars(p.dollars)}</span>
              <span className="text-sm font-semibold text-muted-foreground">{per}</span>
            </>
          ) : (
            <span className="text-base font-semibold">{p.headlineFallback ?? "No dollar figure yet"}</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {p.extraChips?.map((c) => (
            <span key={c} className="prov-chip">
              {c}
            </span>
          ))}
          {/* 3 — confidence chip */}
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${CHIP_STYLES[p.confidence]}`}>
            {CHIP_LABELS[p.confidence]}
          </span>
        </div>
      </div>

      {/* 2 — one-line why */}
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.why}</p>

      {/* below-the-fold metrics (kWh/kW/payback live here, never as headline) */}
      {p.metrics && p.metrics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          {p.metrics.map((m) => (
            <span key={m.label}>
              {m.label} <span className="text-foreground/80">{m.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* 4 — one-tap action + 5 — provenance expander */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {p.action || p.secondaryAction ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {p.action && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={p.action.disabled} onClick={p.action.onClick}>
                {p.action.label}
              </Button>
            )}
            {p.secondaryAction && (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-foreground" disabled={p.secondaryAction.disabled} onClick={p.secondaryAction.onClick}>
                {p.secondaryAction.label}
              </Button>
            )}
          </span>
        ) : (
          <span />
        )}
        {p.provenance && p.provenance.length > 0 && (
          <button
            type="button"
            className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            where this comes from
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      {open && p.provenance && (
        <ul className="mt-2 space-y-0.5 border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          {p.provenance.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
