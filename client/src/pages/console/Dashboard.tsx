/**
 * Insights dashboard (handoff §10) — interval chart with BUILD-010.3
 * peak-preserving decimation, demand heatmap, tariff comparison, ranked
 * opportunities, benchmark percentile card, emissions summary, and the
 * modeled-estimates disclaimer + provenance labels throughout.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { detectPersona, personaVocab } from "@/lib/persona";
import AnalysisProgress from "@/components/AnalysisProgress";
import DemandReview, { type DemandReviewData } from "@/components/DemandReview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Flame, Gauge, Leaf, Lightbulb, Play, TrendingDown, Zap } from "lucide-react";
import { decimateForChart, fmtNum, fmtUsd, type ChartPoint } from "@/lib/wattwiseUi";
import { ConfidenceBadge, DisclaimerBanner, ProvChip } from "@/components/Honesty";
import { InsightCard, chipFromConfidence } from "@/components/InsightCard";
import QuickStart from "@/components/QuickStart";
import { MarkImplementedDialog, ProveItSection } from "@/components/ProveIt";
import RefineChips from "@/components/RefineChips";
import { Link, useSearch } from "wouter";

type Demand = {
  peakKw: number;
  peakTimestamp: number;
  avgKw: number;
  loadFactor: number;
  heatmap: number[][];
  monthlyPeaks: Array<{ month: string; peakKw: number; peakTs: number }>;
  cpProxy: { label: string; topN: number; events: Array<{ ts: number; kw: number }> } | null;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Dashboard() {
  const search = useSearch();
  const urlSite = new URLSearchParams(search).get("site");
  const sites = trpc.sites.list.useQuery();
  const [siteSel, setSiteSel] = useState<string>("");
  const activeSiteId = siteSel ? Number(siteSel) : urlSite ? Number(urlSite) : (sites.data?.[0]?.id ?? null);

  const meters = trpc.sites.meters.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const meter = meters.data?.find((m) => m.commodity === "electric") ?? meters.data?.[0];
  const latest = trpc.analysis.latest.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const baseline = trpc.analysis.baseline.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const insights = trpc.insights.list.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const opps = trpc.insights.opportunities.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const stats = trpc.intervalsApi.stats.useQuery({ meterId: meter?.id ?? 0 }, { enabled: !!meter });
  const utils = trpc.useUtils();

  const run = trpc.analysis.run.useMutation({
    onSuccess: async () => {
      toast.success("Analysis complete");
      await Promise.all([
        utils.analysis.latest.invalidate(),
        utils.analysis.baseline.invalidate(),
        utils.insights.list.invalidate(),
        utils.insights.opportunities.invalidate(),
      ]);
    },
    onError: (e) => toast.error(e.message),
  });

  // Interval chart window — Gap-3 (Jul 2026): user-selectable range presets
  // replace the old hardcoded 30-day slice. "all" spans minTs→maxTs so long
  // histories are fully visible (peak-preserving decimation keeps it fast).
  const [rangeDays, setRangeDays] = useState<30 | 90 | 365 | "all">(30);
  // §3e prove-it: which opportunity the "I did this" dialog is marking
  const [markTarget, setMarkTarget] = useState<{ id?: number; measure: string; title: string; expectedSavingsUsd: number | null } | null>(null);
  const windowRange = useMemo(() => {
    if (!stats.data?.maxTs) return null;
    const from = rangeDays === "all" ? (stats.data.minTs ?? 0) : stats.data.maxTs - rangeDays * 86_400_000;
    return { fromTs: from, toTs: stats.data.maxTs };
  }, [stats.data?.maxTs, stats.data?.minTs, rangeDays]);
  const win = trpc.intervalsApi.window.useQuery(
    { meterId: meter?.id ?? 0, fromTs: windowRange?.fromTs ?? 0, toTs: windowRange?.toTs ?? 0 },
    { enabled: !!meter && !!windowRange },
  );

  const chartData = useMemo(() => {
    if (!win.data) return [];
    const pts: ChartPoint[] = win.data
      .map((r) => ({ ts: Number(r.ts), usage: r.usage, demand: r.demand, durationMin: r.durationMin ?? 60 }))
      .filter((p) => Number.isFinite(p.usage));
    // BUILD-010.3 peak-preserving decimation (verbatim logic reuse)
    return decimateForChart(pts, 1400).map((p) => {
      const kw = p.demand ?? (p.durationMin > 0 ? (p.usage * 60) / p.durationMin : p.usage);
      return { ts: p.ts, kw: Number(kw.toFixed(3)) };
    });
  }, [win.data]);

  const allInsightRows = insights.data ?? [];
  const summaryRow = allInsightRows.find((i) => i.kind === "summary");
  const summary = (summaryRow?.metrics ?? null) as {
    demand?: Demand | null;
    benchmark?: { siteEui?: number | null; percentileBand?: string | null; source?: string | null } | null;
    emissions?: { annualCo2eLb?: number; subregion?: string; factorYear?: number; mapped?: boolean } | null;
    currentCost?: { breakdown?: { energy: number; demand: number; fixed: number; total: number; cp?: number | null; minBillAdjustment?: number } } | null;
    basisStructureHasDemandCharges?: boolean | null;
    demandReview?: DemandReviewData | null;
    tariffComparisons?: Array<{
      tariffName: string;
      utilityName: string;
      freshness: string;
      eligible: boolean;
      ineligibleReason?: string | null;
      annualCost: { total: number };
      savingsVsCurrent: number | null;
      eligibilityNote?: string;
    }> | null;
    baseline?: { method?: string; rSquared?: number | null; cvrmse?: number | null; confidenceLabel?: string } | null;
  } | null;
  // Narrative rows exclude the machine-readable summary
  const insightRows = allInsightRows.filter((i) => i.kind !== "summary");
  const oppRows = opps.data ?? [];
  const demand = summary?.demand ?? null;
  const benchmarkInsight = summary?.benchmark ?? null;
  const emissionsInsight = summary?.emissions ?? null;
  const costInsight = summary?.currentCost ?? null;
  const tariffInsight = summary?.tariffComparisons ?? null;
  const cpInsight = allInsightRows.find((i) => i.kind === "cp_exposure");

  if (sites.isLoading) {
    return (
      <div className="container max-w-6xl py-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="mt-6 h-64 w-full" />
      </div>
    );
  }

  if ((sites.data ?? []).length === 0) {
    return (
      <div className="container max-w-2xl py-16 text-center">
        <Activity className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 font-display text-2xl font-bold">Welcome to WattWise</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The fastest start needs only an address — or a bill photo. Detailed forms exist too, but they are always
          optional.
        </p>
        <div className="mt-6 text-left">
          <QuickStart />
        </div>
        <div className="mt-5 flex justify-center gap-3">
          <Link href="/app/sites">
            <Button variant="outline">Full site form</Button>
          </Link>
          <Link href="/app/wizard">
            <Button variant="outline">Guided wizard</Button>
          </Link>
        </div>
      </div>
    );
  }

  const activeSite = (sites.data ?? []).find((s) => s.id === activeSiteId) ?? null;

  /* §3g persona fork — detected from building type, never asked. Flips
     vocabulary (home/facility) and hero rotation: residential leads with the
     rate check (plan choice), commercial leads with the demand story (load
     factor, peak triage). Same grammar, two voices. */
  const persona = detectPersona(activeSite?.buildingType);
  const vocab = personaVocab(persona);
  const demandFirst = vocab.heroOrder === "demand_first";

  return (
    <div className="container max-w-6xl py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Explore</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The full picture for your {vocab.building} — all modeled estimates.
            {persona === "commercial" ? " Facility voice: demand story first." : " Home voice: rate check first."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={activeSiteId != null ? String(activeSiteId) : ""} onValueChange={setSiteSel}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Site…" />
            </SelectTrigger>
            <SelectContent>
              {(sites.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => activeSiteId != null && run.mutate({ siteId: activeSiteId })} disabled={run.isPending || activeSiteId == null}>
            <Play className="mr-1 h-4 w-4" /> {run.isPending ? "Analyzing…" : "Run analysis"}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <DisclaimerBanner />
      </div>

      {/* §3h: live pipeline narration while an analysis runs — real stages only */}
      {activeSiteId != null && <AnalysisProgress siteId={activeSiteId} active={run.isPending} />}

      {/* Progressive participation: optional add-detail chips while quick-start
          placeholders remain in effect — each names what refining unlocks. */}
      {activeSite?.attrSource === "quick_start_defaults" && activeSiteId != null && (
        <RefineChips siteId={activeSiteId} site={activeSite} onRefined={() => run.mutate({ siteId: activeSiteId })} />
      )}

      {latest.data == null && !latest.isLoading && (
        <Card className="mt-6 border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No analysis yet for this site — press <span className="font-medium text-foreground">Run analysis</span>. If the
            site has no interval data, the pipeline falls back to an archetype-synthetic baseline (honestly labeled).
          </CardContent>
        </Card>
      )}

      {/* KPI row */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<Gauge className="h-4 w-4" />}
          label="Peak demand"
          value={demand ? `${fmtNum(demand.peakKw)} kW` : "—"}
          sub={demand ? new Date(demand.peakTimestamp).toLocaleDateString() : "run analysis"}
        />
        <Kpi
          icon={<Activity className="h-4 w-4" />}
          label="Load factor"
          value={demand ? `${(demand.loadFactor * 100).toFixed(0)}%` : "—"}
          /* Batch-29 (pass 1018) + Batch-33 (pass 1248): a low load factor implies
             demand-charge exposure only on tariffs that HAVE demand charges — gate
             the cost warning on the actual breakdown (demand or CP $ > 0).
             Batch-36 (pass 1398): `demand` is null unless the pipeline had ≥10
             measured interval points (pipeline.ts hasIntervals gate) — archetype
             sites never reach these branches — so the sub-text explicitly names
             its measured-interval provenance to keep that basis visible. */
          /* Batch-40 (pass 1748): when the current rate could not be priced at
             all (no cost basis → breakdown null/undefined), we cannot claim the
             rate "has no demand charges" — say the cost impact is unknown.
             Batch-45 (pass 1928): the "(yours has none)" claim now requires the
             tariff STRUCTURE to affirmatively lack demand/CP charges
             (basisStructureHasDemandCharges === false from the pipeline) — a $0
             priced breakdown alone no longer implies the rate has none, since
             $0 can also mean the components were not computable. When the
             structure flag is unavailable (older analyses), fall back to the
             honest "not determined" wording instead of "yours has none". */
          /* Batch-46 (pass 2038): explicit priority order — (1) unpriced rate,
             (2) PRICED demand/CP dollars in the breakdown (unequivocal — wins
             even when the structure flag is null on older analyses), (3) the
             structure flag, (4) flag unavailable → honest "not determined".
             Batch-46 (pass 2058b): the flat-profile branch previously rendered
             NOTHING when the rate could not be priced — a silent gap that let
             "reasonably flat" read as verified-good without cost context. The
             unpriced disclosure now shows regardless of load factor. */
          sub={
            demand
              ? costInsight?.breakdown == null
                ? demand.loadFactor < 0.4
                  ? "peaky measured profile — cost impact unknown (current rate could not be priced)"
                  : "reasonably flat — cost context unavailable (current rate could not be priced)"
                : demand.loadFactor < 0.4
                  ? (costInsight.breakdown.demand ?? 0) + (costInsight.breakdown.cp ?? 0) > 0
                    ? "peaky measured profile — costly on a demand-charge rate like yours"
                    : summary?.basisStructureHasDemandCharges === true
                      ? "peaky measured profile — your rate has demand charges, though none were priced this period"
                      : summary?.basisStructureHasDemandCharges === false
                        ? "peaky measured profile — would matter only on a rate with demand charges (yours has none)"
                        : "peaky measured profile — whether your rate bills demand charges could not be determined (re-run analysis)"
                  : "reasonably flat"
              : ""
          }
        />
        <Kpi
          icon={<BarChart3 className="h-4 w-4" />}
          label="Benchmark"
          value={benchmarkInsight?.percentileBand ? String(benchmarkInsight.percentileBand).split("(")[0].trim() : "—"}
          /* Batch-17 (pass 298): the main label already reads "vs national median EUI" —
             the sub shows only the extracted descriptive text, no redundant suffix */
          sub={
            benchmarkInsight
              ? (String(benchmarkInsight.percentileBand ?? "").match(/\(([^)]+)\)/)?.[1] ??
                String(benchmarkInsight.percentileBand ?? "")).trim()
              : ""
          }
        />
        <Kpi
          icon={<Leaf className="h-4 w-4" />}
          label="Emissions"
          value={emissionsInsight ? `${fmtNum(emissionsInsight.annualCo2eLb ?? null)} lb CO₂e/yr` : "—"}
          /* Batch-16 (pass 268): eGRID provenance label is unconditional whenever a figure is shown.
             Batch-49 (pass 2466b): when neither the ZIP3 crosswalk nor the state resolved an eGRID
             subregion (mapped === false, e.g. territories like PR/GU), citing "AZNM · eGRID annual avg"
             misattributes the region — name the fallback explicitly instead.
             Batch-51 (passes 2618/2628): in the unresolved case the stored subregion IS the
             unverified default — naming it ("the AZNM default factor") lends false specificity,
             so the disclosure stays generic and names no region. */
          sub={
            emissionsInsight
              ? emissionsInsight.mapped === false
                ? "region unresolved — a default factor was applied, not a verified regional match"
                : `${emissionsInsight.subregion ? `${emissionsInsight.subregion} · ` : ""}eGRID annual avg`
              : ""
          }
        />
      </div>

      {/* §3g hero rotation container — CSS order flips the story order per
          persona without duplicating JSX: commercial (facility voice) leads
          with the demand story, residential leads with the rate check. */}
      <div className="flex flex-col">

      {/* Interval chart */}
      <Card className={`mt-4 border-border/70 ${demandFirst ? "order-1" : "order-3"}`}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="font-display text-base">
            Interval demand — {rangeDays === "all" ? "full history" : `last ${rangeDays} days of data`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {([30, 90, 365, "all"] as const).map((d) => (
              <button
                key={String(d)}
                type="button"
                onClick={() => setRangeDays(d)}
                className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                  rangeDays === d
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {d === "all" ? "All" : `${d}d`}
              </button>
            ))}
            <ProvChip>measured</ProvChip>
            <ProvChip>peak-preserving decimation</ProvChip>
          </div>
        </CardHeader>
        <CardContent>
          {!meter ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No meter on this site — <Link href="/app/upload" className="text-primary underline">upload interval data</Link>{" "}
              or use the <Link href="/app/wizard" className="text-primary underline">hypothetical wizard</Link>.
            </p>
          ) : win.isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : chartData.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No interval points in window.</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="kwFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.8 0.16 80)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="oklch(0.8 0.16 80)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.35 0.01 260)" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })}
                  stroke="oklch(0.6 0.01 260)"
                  fontSize={11}
                  minTickGap={48}
                />
                <YAxis stroke="oklch(0.6 0.01 260)" fontSize={11} width={44} unit=" kW" />
                <Tooltip
                  contentStyle={{ background: "oklch(0.22 0.012 260)", border: "1px solid oklch(0.35 0.01 260)", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
                  formatter={(v) => [`${v} kW`, "demand"]}
                />
                <Area type="monotone" dataKey="kw" stroke="oklch(0.8 0.16 80)" strokeWidth={1.5} fill="url(#kwFill)" isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Demand & peak charges — Gap-4 (Jul 2026): first-class visibility for
          the demand side of the bill. Only renders once analysis produced a
          measured demand block (archetype-only sites have none to show). */}
      {demand && (
        <Card className={`mt-4 border-border/70 ${demandFirst ? "order-2" : "order-4"}`}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Gauge className="h-4 w-4 text-primary" /> Demand & peak charges
            </CardTitle>
            <ProvChip>measured intervals</ProvChip>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <p className="font-mono text-[10px] uppercase text-muted-foreground">Monthly peak demand</p>
                {demand.monthlyPeaks && demand.monthlyPeaks.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Month</TableHead>
                        <TableHead className="text-right text-xs">Peak kW</TableHead>
                        <TableHead className="text-right text-xs">When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {demand.monthlyPeaks.slice(-6).map((mp) => (
                        <TableRow key={mp.month}>
                          <TableCell className="py-1.5 font-mono text-xs">{mp.month}</TableCell>
                          <TableCell className="py-1.5 text-right font-mono text-xs">{fmtNum(mp.peakKw)}</TableCell>
                          <TableCell className="py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                            {new Date(mp.peakTs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">No monthly peak series in the latest analysis.</p>
                )}
                {demand.monthlyPeaks && demand.monthlyPeaks.length > 6 && (
                  <p className="mt-1 text-[10px] text-muted-foreground">Showing the 6 most recent of {demand.monthlyPeaks.length} months.</p>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <p className="font-mono text-[10px] uppercase text-muted-foreground">Demand share of modeled bill</p>
                  {costInsight?.breakdown ? (
                    (() => {
                      const dPlusCp = (costInsight.breakdown.demand ?? 0) + (costInsight.breakdown.cp ?? 0);
                      const share = costInsight.breakdown.total > 0 ? dPlusCp / costInsight.breakdown.total : 0;
                      return (
                        <>
                          <p className="mt-1 font-display text-xl font-bold">
                            {fmtUsd(dPlusCp)} <span className="text-sm font-normal text-muted-foreground">({(share * 100).toFixed(0)}%)</span>
                          </p>
                          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                            {dPlusCp > 0
                              ? "demand + coincident-peak charges on your current rate — shaving peaks reduces this portion"
                              : "your current rate has no demand or CP charges — peaks affect eligibility for other rates, not this bill"}
                          </p>
                        </>
                      );
                    })()
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">unknown — current rate could not be priced</p>
                  )}
                </div>
                {demand.cpProxy && demand.cpProxy.events.length > 0 && (
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">{demand.cpProxy.label}</p>
                    <ul className="mt-1 space-y-1">
                      {demand.cpProxy.events.slice(0, 5).map((ev) => (
                        <li key={ev.ts} className="flex justify-between font-mono text-[11px] text-muted-foreground">
                          <span>{new Date(ev.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}</span>
                          <span>{fmtNum(ev.kw)} kW</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className={`mt-4 grid gap-4 lg:grid-cols-2 ${demandFirst ? "order-3" : "order-5"}`}>
        {/* Demand heatmap */}
        <Card className="border-border/70">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Flame className="h-4 w-4 text-primary" /> Demand heatmap
            </CardTitle>
            {demand && <ConfidenceBadge level={summaryRow?.confidence ?? "medium"} />}
          </CardHeader>
          <CardContent>
            {demand?.heatmap ? (
              <Heatmap grid={demand.heatmap} />
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">Run analysis on a metered site to see day × hour demand.</p>
            )}
            {cpInsight && (
              <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
                {cpInsight.title}: {cpInsight.body}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Baseline + cost breakdown */}
        <Card className="border-border/70">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <TrendingDown className="h-4 w-4 text-primary" /> Baseline & cost
            </CardTitle>
            {baseline.data && <ProvChip>{baseline.data.weatherBasis}</ProvChip>}
          </CardHeader>
          <CardContent className="space-y-3">
            {baseline.data ? (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Method</p>
                    <p className="font-mono text-xs">{baseline.data.method}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Fit</p>
                    <p className="font-mono text-xs">
                      R² {baseline.data.rSquared != null ? baseline.data.rSquared.toFixed(2) : "n/a"} · CV(RMSE){" "}
                      {baseline.data.cvrmse != null ? `${(baseline.data.cvrmse * 100).toFixed(0)}%` : "n/a (flat or archetype baseline)"}
                    </p>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{baseline.data.confidenceLabel}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No baseline yet.</p>
            )}
            {costInsight?.breakdown && (
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium">Modeled annual cost on current rate</p>
                <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-4">
                  <span>energy {fmtUsd(costInsight.breakdown.energy)}</span>
                  <span>demand {fmtUsd(costInsight.breakdown.demand)}</span>
                  <span>fixed {fmtUsd(costInsight.breakdown.fixed)}</span>
                  {/* Batch-23 (pass 772): CP proxy charges are tracked separately from
                      windowed demand in the engine breakdown — omitting this line made
                      energy+demand+fixed visibly fall short of total for CP tariffs. */}
                  {(costInsight.breakdown.cp ?? 0) > 0 && <span>coincident-peak {fmtUsd(costInsight.breakdown.cp)}</span>}
                  {/* Batch-40 (pass 1742): minimum-bill uplift is its own line so
                      components always sum to total — not silently folded in. */}
                  {(costInsight.breakdown.minBillAdjustment ?? 0) > 0 && (
                    <span>min-bill adj {fmtUsd(costInsight.breakdown.minBillAdjustment ?? 0)}</span>
                  )}
                  <span className="text-foreground">total {fmtUsd(costInsight.breakdown.total)}</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  Modeled estimate on your interval data and the seeded rate structure — not a bill reproduction.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tariff comparison — §3g hero rotation: residential renders this ABOVE
          the demand story (order-none default), commercial pushes it after. */}
      {tariffInsight && tariffInsight.length > 0 && (
        <Card className={`mt-4 border-border/70 ${demandFirst ? "order-5" : "order-1"}`}>
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-base">Rate check{persona === "residential" ? " — is there a better plan for your home?" : ""}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">Your load profile re-priced on every seeded rate you may be eligible for</p>
            {tariffInsight[0]?.eligibilityNote && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tariffInsight[0].eligibilityNote}</p>
            )}
            {/* Batch-37 (pass 1518): when no current-cost basis exists the
                pipeline zeroes savingsVsCurrent (Batch-35) — rendering those
                zeros as "saves $0/yr" would fake a comparison against a real
                baseline. Pass the basis flag so the column can say so instead. */}
            <TariffTable metrics={{ comparisons: tariffInsight as unknown as TariffRow[], hasCostBasis: costInsight != null }} />
          </CardContent>
        </Card>
      )}

      </div>{/* end §3g hero rotation container */}

      {/* Opportunities */}
      {/* §3b Peak attribution story — what made the peak happen. Rendered as its
          own card with a visual split bar; falls back silently when the
          pipeline had insufficient data to attribute. */}
      {(() => {
        const attr = allInsightRows.find((i) => i.kind === "peak_attribution");
        if (!attr) return null;
        const m = (attr.metrics ?? {}) as {
          peakKw?: number;
          shape?: string;
          weatherKw?: number | null;
          scheduleKw?: number;
          coincidenceKw?: number;
          counterfactualSavingsUsd?: number | null;
        };
        const peak = m.peakKw ?? 0;
        const segs = [
          { label: "Schedule", kw: m.scheduleKw ?? 0, cls: "bg-primary/70" },
          ...(m.weatherKw != null ? [{ label: "Weather", kw: m.weatherKw, cls: "bg-chart-2/70" }] : []),
          { label: "Coincidence", kw: m.coincidenceKw ?? 0, cls: "bg-chart-4/80" },
        ].filter((s) => s.kw > 0.05);
        return (
          <Card className="mt-4 border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <Zap className="h-4 w-4 text-primary" /> What made your peak happen
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InsightCard
                dollars={m.counterfactualSavingsUsd ?? null}
                framing="Save"
                headlineFallback={attr.title}
                why={attr.body ?? attr.title}
                confidence={chipFromConfidence(attr.confidence)}
                extraChips={[m.shape === "spike" ? "short spike" : "sustained plateau", "modeled split"]}
                metrics={segs.map((s) => ({ label: s.label.toLowerCase(), value: `${s.kw.toFixed(1)} kW` }))}
                action={{
                  label: "Model peak shaving in Scenarios",
                  onClick: () => {
                    window.location.href = `/app/scenarios?site=${activeSiteId}&measure=battery_peak_shave`;
                  },
                }}
                provenance={[
                  `Peak: ${peak.toFixed(1)} kW. Split method: median same-day-of-week/hour load = schedule share; monthly weather fit scaled to the peak hour = weather share (modeled); remainder = coincidence.`,
                  "Counterfactual dollars come from a full-year re-price on your assigned rate with the peak window shaved — same engine that prices your bills.",
                ]}
              />
              {peak > 0 && segs.length > 0 && (
                <div className="mt-3">
                  <div className="flex h-3 w-full overflow-hidden rounded-full border border-border/60">
                    {segs.map((s) => (
                      <div key={s.label} className={s.cls} style={{ width: `${Math.min((s.kw / peak) * 100, 100)}%` }} title={`${s.label}: ${s.kw.toFixed(1)} kW`} />
                    ))}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    {segs.map((s) => (
                      <span key={s.label} className="flex items-center gap-1">
                        <span className={`inline-block h-2 w-2 rounded-sm ${s.cls}`} /> {s.label} {s.kw.toFixed(1)} kW
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* §3i demand review ritual — per-cycle set-point + ratchet watch + one
          priced action. Only for sites whose rate actually has demand charges
          (structure flag or priced demand $); residential rate-check sites
          never see a demand ritual. */}
      {summary?.demandReview &&
        activeSiteId != null &&
        ((costInsight?.breakdown?.demand ?? 0) > 0 || summary?.basisStructureHasDemandCharges === true) && (
          <div className="mt-4">
            <DemandReview
              data={summary.demandReview as DemandReviewData}
              siteId={activeSiteId}
              attributionSummary={allInsightRows.find((i) => i.kind === "peak_attribution")?.title ?? null}
              topDemandAction={(() => {
                const d = oppRows.find((o) => /peak|demand|battery|load/i.test(o.measure) || /demand|peak/i.test(o.title));
                return d ? { title: d.title, estUsdPerYr: d.estCostSavingsPerYr, measure: d.measure } : null;
              })()}
            />
          </div>
        )}

      <Card className="mt-4 border-border/70">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Lightbulb className="h-4 w-4 text-primary" /> Ranked opportunities
          </CardTitle>
        </CardHeader>
        <CardContent>
          {oppRows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Run analysis to generate ranked measures.</p>
          ) : (
            <div className="space-y-3">
              {/* UX v1.9 §2 card grammar: dollar headline → one-line why →
                  confidence chip → one-tap action → provenance expander.
                  kWh/kW/payback live below the fold, never as the headline. */}
              {oppRows.map((o) => (
                <InsightCard
                  key={o.id}
                  rank={o.rank}
                  dollars={o.estCostSavingsPerYr}
                  framing="Save"
                  headlineFallback={`${o.title} — no dollar figure yet (needs a priced rate)`}
                  why={o.description ?? o.title}
                  confidence={chipFromConfidence(o.confidence, o.disaggregationMethod === "nilmtk_1min_plus")}
                  extraChips={[
                    ...(o.ratchetAware ? ["ratchet-aware"] : []),
                    ...(o.disaggregationMethod ? [o.disaggregationMethod.replace(/_/g, " ")] : []),
                  ]}
                  metrics={[
                    ...(o.estEnergySavingsPerYr != null
                      ? [{ label: "energy", value: `${fmtNum(o.estEnergySavingsPerYr)} ${o.energyUnit ?? "kWh"}/yr` }]
                      : []),
                    ...(o.estDemandSavingsKw != null
                      ? [{ label: "demand", value: `${fmtNum(o.estDemandSavingsKw)} kW post-ratchet` }]
                      : []),
                    ...(o.paybackBandYears ? [{ label: "payback", value: o.paybackBandYears }] : []),
                  ]}
                  action={{
                    label: "Model this in Scenarios",
                    onClick: () => {
                      window.location.href = `/app/scenarios?site=${activeSiteId}&measure=${o.measure}`;
                    },
                  }}
                  secondaryAction={{
                    label: "I did this",
                    onClick: () =>
                      setMarkTarget({ id: o.id, measure: o.measure, title: o.title, expectedSavingsUsd: o.estCostSavingsPerYr ?? null }),
                  }}
                  provenance={[
                    `Measure: ${o.measure.replace(/_/g, " ")} · ranked #${o.rank} by estimated annual dollar impact.`,
                    o.disaggregationMethod
                      ? `End-use split method: ${o.disaggregationMethod.replace(/_/g, " ")}.`
                      : "Savings band from archetype priors for this building type and climate.",
                    "Modeled estimate — run the scenario to re-price a full year on your rate.",
                  ]}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* §3e prove-it: verification ledger for implemented measures */}
      {activeSiteId != null && <ProveItSection siteId={activeSiteId} />}
      {activeSiteId != null && (
        <MarkImplementedDialog
          open={markTarget != null}
          onOpenChange={(v) => !v && setMarkTarget(null)}
          siteId={activeSiteId}
          opportunity={markTarget}
        />
      )}

      {/* Other insights */}
      {insightRows.filter((i) => !["demand", "benchmark", "emissions", "cost", "tariff_comparison", "cp_proxy", "peak_attribution"].includes(i.kind)).length > 0 && (
        <Card className="mt-4 border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-base">Additional insights</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Same card grammar as opportunities — these narrative insights
                rarely carry a dollar figure, so the headline is the honest
                title and the why-line carries the substance. */}
            {insightRows
              .filter((i) => !["demand", "benchmark", "emissions", "cost", "tariff_comparison", "cp_proxy", "peak_attribution"].includes(i.kind))
              .map((i) => (
                <InsightCard
                  key={i.id}
                  dollars={null}
                  headlineFallback={i.title}
                  why={i.body ?? i.title}
                  confidence={chipFromConfidence(i.confidence)}
                  extraChips={i.disaggregationMethod ? [i.disaggregationMethod.replace(/_/g, " ")] : []}
                  provenance={
                    i.provenance && typeof i.provenance === "object"
                      ? Object.entries(i.provenance as Record<string, unknown>)
                          .filter(([, v]) => v != null && typeof v !== "object")
                          .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(v)}`)
                      : undefined
                  }
                />
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type TariffRow = {
  tariffName: string;
  utilityName: string;
  freshness: string;
  isCurrentBasis?: boolean;
  eligible: boolean;
  ineligibleReason?: string | null;
  annualCost: { total: number };
  /** Null when no current-cost basis exists (Batch-38, pass 1559). */
  savingsVsCurrent: number | null;
  eligibilityNote?: string;
};

function TariffTable({ metrics }: { metrics: { comparisons?: TariffRow[]; hasCostBasis?: boolean } | null }) {
  const rows = metrics?.comparisons ?? [];
  if (rows.length === 0) return null;
  const noneEligible = rows.length > 0 && rows.every((r) => !r.eligible);
  // Batch-43 (pass 1868): "No seeded rate matches" is factually wrong when the
  // user's ASSIGNED rate IS in the table — it matched (by assignment), it is
  // merely outside the eligibility bracket. Name that case distinctly.
  const currentAssignedIneligible = rows.some((r) => r.isCurrentBasis && !r.eligible);
  // Batch-37 (pass 1518): no current-cost basis → savings deltas are zero
  // sentinels, not real comparisons — never render them as "$0/yr".
  const hasCostBasis = metrics?.hasCostBasis ?? true;
  return (
    <>
    {noneEligible && (
      <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        {currentAssignedIneligible
          ? "Your assigned rate is shown below but sits outside this site's eligibility bracket (sector or peak-demand size), and no eligible seeded rate could be found for this site. Cost figures are computed on your assigned rate as the modeling basis — verify the assignment against an actual bill. The seeded rate library is a snapshot; your actual utility rate may not be included."
          : "No seeded rate is eligible for this site's sector and peak-demand size — the rates shown below are for reference only (closest available structures, not offers you qualify for). The seeded rate library is a snapshot; your actual utility rate may not be included. Cost figures use the closest available structure as a modeling basis — verify against an actual bill."}
      </p>
    )}
    <Table className="mt-3">
      <TableHeader>
        <TableRow>
          <TableHead className="font-mono text-xs">Rate</TableHead>
          <TableHead className="text-right font-mono text-xs">Annual cost</TableHead>
          <TableHead className="text-right font-mono text-xs">Savings vs current</TableHead>
          <TableHead className="font-mono text-xs">Data freshness</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i} className={r.eligible ? "" : "opacity-50"}>
            <TableCell className="text-xs">
              {r.utilityName} — {r.tariffName}
              {r.isCurrentBasis && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">current basis</span>}
              {!r.eligible && <span className="ml-2 font-mono text-[10px] text-muted-foreground">ineligible{r.ineligibleReason ? `: ${r.ineligibleReason}` : ""}</span>}
            </TableCell>
            {/* Batch-17 (pass 308): costs ARE calculated for ineligible rates (the banner says
                "for reference only") — show them in muted styling instead of a contradictory "—" */}
            <TableCell className={`text-right font-mono text-xs ${r.eligible ? "" : "text-muted-foreground/70"}`}>
              {fmtUsd(r.annualCost.total)}
              {!r.eligible && <span className="ml-1 text-[10px]">(ref)</span>}
            </TableCell>
            <TableCell className={`text-right font-mono text-xs ${r.eligible && (r.savingsVsCurrent ?? 0) > 0 ? "text-emerald-400" : !r.eligible ? "text-muted-foreground/70" : ""}`}>
              {r.isCurrentBasis
                ? "—"
                : !hasCostBasis || r.savingsVsCurrent == null
                  ? "— (no current-cost baseline)" /* Batch-37/38 (passes 1518/1559): null — not a zeroed sentinel */
                  : r.savingsVsCurrent >= 0
                    ? `saves ${fmtUsd(r.savingsVsCurrent)}/yr${r.eligible ? "" : " (ref)"}` /* Batch-30 (pass 1078): verified both branches carry (ref) */
                    : `adds ${fmtUsd(Math.abs(r.savingsVsCurrent))}/yr${r.eligible ? "" : " (ref)"}`}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{r.freshness === "urdb_stale" ? "stale — verify with utility" : r.freshness.replace(/_/g, " ")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </>
  );
}

function Kpi({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card className="border-border/70">
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 text-muted-foreground">
          {icon}
          <span className="font-mono text-[10px] uppercase tracking-widest">{label}</span>
        </div>
        <p className="mt-2 font-display text-xl font-bold">{value}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Heatmap({ grid }: { grid: number[][] }) {
  const all = grid.flat();
  const flat = all.filter((v) => v > 0);
  // Batch-46 (pass 2088b): a grid with real readings whose averages are ALL
  // zero-or-negative (net-export site) is NOT missing data — telling the user
  // to "upload interval data" they already uploaded misdirects them. The grid
  // arrives zero-filled 7×24 even with no data, so "has data" is detected by
  // any NONZERO cell (negative averages only occur when real export readings
  // exist; an untouched grid is exactly zero everywhere). An all-exactly-zero
  // grid with data is indistinguishable from no data at this layer and keeps
  // the upload prompt — the conservative direction.
  const hasAnyCells = all.some((v) => Number.isFinite(v) && v !== 0);
  // Batch-28 (pass 998): use the TRUE data maximum — the previous
  // `Math.max(...flat, 0.001)` floor inflated max above tiny-but-real values
  // (grids where every cell < 0.001 kW), which clipped legitimate readings to
  // zero intensity and rendered real demand as absent. Empty grids take the
  // explicit empty-state branch below; uniform grids the fixed mid intensity.
  const max = flat.length ? Math.max(...flat) : 0;
  const min = flat.length ? Math.min(...flat) : 0;
  // Pass-458: when every non-zero cell shares one value (max === min), the
  // normalized intensity collapses to 0 and the whole heatmap renders as
  // near-invisible — misleading "no load" appearance. Render presence at a
  // fixed mid intensity instead.
  const uniform = flat.length > 0 && max - min < 1e-9;
  // Batch-24 (pass 848): an all-zero/empty grid previously rendered the faint
  // 0.04-intensity background — visually implying a low constant baseline load
  // where none exists. Render an explicit empty state instead.
  if (flat.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {hasAnyCells
          ? "No positive net-import demand in this period — the site was exporting or idle in every hour, so there is no import intensity to map."
          : "No demand data available for the heatmap — upload interval data to populate it."}
      </p>
    );
  }
  const intensity = (v: number) =>
    v <= 0 ? 0.04 : uniform ? 0.55 : Math.max(0.04, Math.pow(Math.max(0, (v - min) / (max - min)), 1.6) * 0.95);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="grid" style={{ gridTemplateColumns: "36px repeat(24, 1fr)" }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="pb-1 text-center font-mono text-[9px] text-muted-foreground">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
          {grid.map((row, d) => (
            <>
              <div key={`d${d}`} className="pr-1 text-right font-mono text-[9px] leading-4 text-muted-foreground">
                {DAYS[d]}
              </div>
              {row.map((v, h) => (
                <div
                  key={`${d}-${h}`}
                  title={`${DAYS[d]} ${h}:00 — ${v.toFixed(1)} kW avg`}
                  className="m-px h-4 rounded-[2px]"
                  style={{ background: `oklch(0.8 0.16 80 / ${intensity(v)})` }}
                />
              ))}
            </>
          ))}
        </div>
      </div>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground">avg kW by day-of-week × hour</p>
    </div>
  );
}
