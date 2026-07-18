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
import { Battery, Check, Layers, Lightbulb, Save, Sun, TrendingDown, X } from "lucide-react";
import { Input } from "@/components/ui/input";
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
  // §3m plan persistence — saved baskets survive the session and feed the
  // My Energy Plan report. Saving is the Plus unlock; composing stays free.
  const utils = trpc.useUtils();
  const savedPlans = trpc.scenariosApi.listBaskets.useQuery({ siteId });
  const saveBasket = trpc.scenariosApi.saveBasket.useMutation({
    onSuccess: () => {
      setPlanName("");
      setSaving(false);
      utils.scenariosApi.listBaskets.invalidate();
    },
  });
  const deleteBasket = trpc.scenariosApi.deleteBasket.useMutation({
    onSuccess: () => utils.scenariosApi.listBaskets.invalidate(),
  });
  const [saving, setSaving] = useState(false);
  const [planName, setPlanName] = useState("");
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

        {/* §3m save / saved plans */}
        {(selected.size > 0 || (savedPlans.data?.length ?? 0) > 0) && (
          <div className="space-y-2 border-t border-border pt-3">
            {selected.size > 0 && !saving && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSaving(true)}>
                <Save className="mr-1 h-3.5 w-3.5" /> Save this plan
              </Button>
            )}
            {saving && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  placeholder="Plan name — e.g. Summer readiness"
                  className="h-8 max-w-xs text-xs"
                  autoFocus
                />
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!planName.trim() || saveBasket.isPending}
                  onClick={() =>
                    saveBasket.mutate({
                      siteId,
                      name: planName.trim(),
                      measures: Array.from(selected.values()) as unknown as Array<Record<string, unknown>>,
                      composedResults: (compose.data?.result ?? null) as unknown as Record<string, unknown> | null,
                    })
                  }
                >
                  {saveBasket.isPending ? "Saving…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSaving(false)}>
                  Cancel
                </Button>
              </div>
            )}
            {saveBasket.error && <p className="text-[11px] text-destructive">{saveBasket.error.message}</p>}
            {(savedPlans.data?.length ?? 0) > 0 && (
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Saved plans</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {savedPlans.data!.map((p) => (
                    <span key={p.id} className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs">
                      <button
                        type="button"
                        className="hover:text-primary"
                        title="Load this plan"
                        onClick={() => {
                          const ms = (p.measures as Measure[]) ?? [];
                          setSelected(new Map(ms.map((m) => [m.key, m])));
                        }}
                      >
                        {p.name}
                      </button>
                      <span className="text-[10px] text-muted-foreground">· {(p.measures as Measure[]).length} measures</span>
                      <button
                        type="button"
                        title="Delete plan"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => deleteBasket.mutate({ id: p.id })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground/70">
                  Loading a plan re-prices it against your latest baseline — saved dollar figures refresh rather than being replayed.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
