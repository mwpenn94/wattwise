/**
 * §3h Processing as proof-of-work — while an analysis runs, poll the
 * pipeline's REAL narration (written stage-by-stage by the engine) and
 * render it as a live build log. Honesty rules: lines come verbatim from
 * the server; nothing is staged, delayed, or invented client-side. If the
 * run finishes before a poll ever lands (fast pipelines), the final
 * narration still renders once, then the component collapses.
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Loader2 } from "lucide-react";

export default function AnalysisProgress({ siteId, active }: { siteId: number; active: boolean }) {
  // Keep showing the log briefly after completion so users see what was done.
  const [linger, setLinger] = useState(false);
  const wasActive = useRef(false);

  const progress = trpc.analysis.progress.useQuery(
    { siteId },
    {
      enabled: active || linger,
      refetchInterval: active ? 700 : false,
    },
  );

  useEffect(() => {
    if (active) wasActive.current = true;
    if (!active && wasActive.current) {
      setLinger(true);
      const t = setTimeout(() => {
        setLinger(false);
        wasActive.current = false;
      }, 3500);
      return () => clearTimeout(t);
    }
  }, [active]);

  if (!active && !linger) return null;
  const lines = progress.data?.narration ?? [];
  const running = active && progress.data?.status !== "complete";

  return (
    <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center gap-2">
        {running ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
        <p className="font-display text-sm font-semibold">{running ? "Analyzing — here's the actual work" : "Analysis complete"}</p>
      </div>
      <ul className="mt-2 space-y-1">
        {lines.length === 0 && running && <li className="font-mono text-[11px] text-muted-foreground">Starting pipeline…</li>}
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500/80" />
            <span>{l}</span>
          </li>
        ))}
        {running && lines.length > 0 && (
          <li className="flex items-start gap-1.5 font-mono text-[11px] text-muted-foreground/70">
            <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
            <span>working…</span>
          </li>
        )}
      </ul>
      <p className="mt-2 text-[10px] text-muted-foreground/70">
        Each line is written by the engine as the stage completes — nothing staged for effect.
      </p>
    </div>
  );
}
