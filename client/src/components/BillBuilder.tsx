/**
 * Bill Builder (UX addendum §3c) — composed what-if across recommendations.
 *
 * Savings never add; profiles compose. Toggling measures re-prices ONE
 * composed profile server-side. The plan bar shows current → new annual bill
 * with an animated count-up; the overlap honesty line names the difference
 * between sum-of-parts and the composed figure whenever ≥2 measures are
 * selected; the rate re-sweep runs last on the composed profile.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Battery, Check, Layers, Lightbulb, Sun, TrendingDown } from "lucide-react";
import { ConfidenceBadge } from "@/components/Honesty";

interface Measure {
  key: string;
  label: string;
  kind: "efficiency" | "solar" | "battery";
  solarKwDc?: number;
  batteryKwh?: number;
  batteryKw?: number;
  efficiencyReductions?: Record<string, number>;
  capexUsd?: number;
}

const MEASURE_ICON: Record<Measure["kind"], typeof Sun> = {
  efficiency: Lightbulb,
  solar: Sun,
  battery: Battery,
};

/** Animated count-up dollar figure (motion budget: this IS the plan bar's one animation). */
function CountUpUsd({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const dur = 450;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      fromRef.current = value;
    };
  }, [value]);
  return <span className="tabular-nums">${Math.round(display).toLocaleString()}</span>;
}

export default function BillBuilder({ siteId }: { siteId: number }) {
  const presets = trpc.scenariosApi.presets.useQuery({ siteId });
  const compose = trpc.scenariosApi.compose.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const [selected, setSelected] = useState<Map<string, Measure>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // All available measures = union of the preset baskets (each openable/editable
  // at the individual-measure level).
  const available = useMemo(() => {
    if (!presets.data) return [] as Measure[];
    const seen = new Map<string, Measure>();
    for (const basket of [presets.data.conservative, presets.data.balanced, presets.data.aggressive]) {
      for (const m of basket) if (!seen.has(m.key)) seen.set(m.key, m as Measure);
    }
    return Array.from(seen.values());
  }, [presets.data]);

  // Debounced server re-price on every toggle (§3c: <300ms budget, debounced).
  useEffect(() => {
    if (selected.size === 0) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      compose.mutate({ siteId, measures: Array.from(selected.values()) });
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, siteId]);

  function toggle(m: Measure) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(m.key)) next.delete(m.key);
      else next.set(m.key, m);
      return next;
    });
  }

  function applyPreset(name: "conservative" | "balanced" | "aggressive") {
    if (!presets.data) return;
    setSelected(new Map(presets.data[name].map((m) => [m.key, m as Measure])));
  }

  const r = selected.size > 0 ? compose.data?.result : undefined;

  if (presets.isLoading) return <Skeleton className="h-48" />;
  if (available.length === 0) return null;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Layers className="h-4 w-4 text-primary" />
            Bill Builder — compose your plan
          </CardTitle>
          <div className="flex gap-1.5">
            {(["conservative", "balanced", "aggressive"] as const).map((p) => (
              <Button key={p} size="sm" variant="outline" className="h-7 text-xs capitalize" onClick={() => applyPreset(p)}>
                {p}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Measures compose on one profile — savings are never naively summed. Toggle measures; the plan re-prices live.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* measure toggles */}
        <div className="grid gap-1.5 sm:grid-cols-2">
          {available.map((m) => {
            const Icon = MEASURE_ICON[m.kind as Measure["kind"]] ?? Lightbulb;
            const on = selected.has(m.key);
            return (
              <button
                key={m.key}
                onClick={() => toggle(m)}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  on ? "border-primary bg-primary/10" : "border-border hover:border-primary/50"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 text-primary" />
                <span className="flex-1">
                  {m.label}
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {m.capexUsd ? `~$${m.capexUsd.toLocaleString()} upfront` : "no upfront cost"}
                  </span>
                </span>
                {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>

        {/* plan bar */}
        {selected.size > 0 && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
            {compose.isPending && !r ? (
              <Skeleton className="h-12" />
            ) : r ? (
              <>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Current annual bill → with your plan</p>
                    <p className="font-display text-2xl font-bold">
                      <span className="text-muted-foreground line-through decoration-2">${Math.round(r.baselineAnnualCost).toLocaleString()}</span>{" "}
                      → <CountUpUsd value={r.composedAnnualCost} />
                      <span className="ml-2 text-base text-emerald-500">
                        <TrendingDown className="mr-0.5 inline h-4 w-4" />
                        save <CountUpUsd value={r.composedSavings} />/yr
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfidenceBadge level={r.confidence} label={`${r.confidence} confidence — the basket inherits its weakest measure's chip`} />
                    {r.basketPaybackBand && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        payback {r.basketPaybackBand}
                      </Badge>
                    )}
                  </div>
                </div>
                {/* overlap honesty line (§3c) */}
                {selected.size >= 2 && Math.abs(r.overlap) > 1 && (
                  <p className="mt-2 border-t border-primary/20 pt-2 text-xs text-muted-foreground">
                    {r.overlap > 0 ? (
                      <>
                        Together: <strong className="text-foreground">${Math.round(r.composedSavings).toLocaleString()}/yr</strong> — individually they'd
                        sum to ${Math.round(r.sumOfIndividualSavings).toLocaleString()}; they overlap by ${Math.round(r.overlap).toLocaleString()} (measures
                        compete for the same energy and peaks).
                      </>
                    ) : (
                      <>
                        Together these measures save <strong className="text-foreground">${Math.round(r.composedSavings).toLocaleString()}/yr</strong> —
                        more than their individual sum (${Math.round(r.sumOfIndividualSavings).toLocaleString()}); one measure reshapes the profile in a way
                        that amplifies another. Modeled synergy, not a guarantee.
                      </>
                    )}
                  </p>
                )}
                {/* secondary composed outputs */}
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Peak kW</p>
                    <p className="font-mono text-sm">
                      {r.baselinePeakKw.toFixed(1)} → {r.composedPeakKw.toFixed(1)}
                    </p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">CO₂e / yr</p>
                    <p className="font-mono text-sm">
                      {Math.round(Math.abs(r.deltaCo2eLb)).toLocaleString()} lb {r.deltaCo2eLb < 0 ? "less" : "more"}
                    </p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Upfront</p>
                    <p className="font-mono text-sm">${Math.round(r.basketCapexUsd).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Measures</p>
                    <p className="font-mono text-sm">{selected.size} selected</p>
                  </div>
                </div>
                {/* rate re-sweep (§3c: rate choice evaluated last, automatically) */}
                {r.ratePlanOvertake && (
                  <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                    On your new profile, <strong>{r.ratePlanOvertake.utilityName} — {r.ratePlanOvertake.tariffName}</strong> overtakes your current rate:
                    another ${Math.round(r.ratePlanOvertake.additionalSavings).toLocaleString()}/yr on top. Eligibility checked on sector and peak size only —
                    confirm with your utility.
                  </p>
                )}
                {r.disclosures.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
                      Where this comes from
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {r.disclosures.map((d, i) => (
                        <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                          • {d}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : null}
          </div>
        )}
        {selected.size === 0 && (
          <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            Pick measures above, or start from a preset — the plan bar shows your current bill against the composed plan.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
