/**
 * Insights dashboard (handoff §10) — interval chart with BUILD-010.3
 * peak-preserving decimation, demand heatmap, tariff comparison, ranked
 * opportunities, benchmark percentile card, emissions summary, and the
 * modeled-estimates disclaimer + provenance labels throughout.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Flame, Gauge, Leaf, Lightbulb, Play, TrendingDown } from "lucide-react";
import { decimateForChart, fmtNum, fmtUsd, type ChartPoint } from "@/lib/wattwiseUi";
import { ConfidenceBadge, DisclaimerBanner, ProvChip } from "@/components/Honesty";
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

  // Interval chart window: latest 30 days of data
  const windowRange = useMemo(() => {
    if (!stats.data?.maxTs) return null;
    return { fromTs: stats.data.maxTs - 30 * 86_400_000, toTs: stats.data.maxTs };
  }, [stats.data?.maxTs]);
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

  const insightRows = insights.data ?? [];
  const oppRows = opps.data ?? [];
  const demandInsight = insightRows.find((i) => i.kind === "demand");
  const demand = (demandInsight?.metrics ?? null) as Demand | null;
  const benchmarkInsight = insightRows.find((i) => i.kind === "benchmark");
  const emissionsInsight = insightRows.find((i) => i.kind === "emissions");
  const costInsight = insightRows.find((i) => i.kind === "cost");
  const tariffInsight = insightRows.find((i) => i.kind === "tariff_comparison");
  const cpInsight = insightRows.find((i) => i.kind === "cp_proxy");

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
          Start by creating a site and uploading interval data — or model a fully hypothetical building with no meter data
          at all.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/app/sites">
            <Button>Create a site</Button>
          </Link>
          <Link href="/app/wizard">
            <Button variant="outline">Hypothetical building</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-6xl py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Analytics for the selected site — all modeled estimates.</p>
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
          sub={demand ? (demand.loadFactor < 0.4 ? "peaky — demand-charge exposure" : "reasonably flat") : ""}
        />
        <Kpi
          icon={<BarChart3 className="h-4 w-4" />}
          label="Benchmark"
          value={benchmarkInsight ? ((benchmarkInsight.metrics as { percentileBand?: string })?.percentileBand ?? "—") : "—"}
          sub={benchmarkInsight ? "vs national peer EUI" : ""}
        />
        <Kpi
          icon={<Leaf className="h-4 w-4" />}
          label="Emissions"
          value={
            emissionsInsight
              ? `${fmtNum((emissionsInsight.metrics as { annualCo2eLb?: number })?.annualCo2eLb ?? null)} lb CO₂e/yr`
              : "—"
          }
          sub={emissionsInsight ? ((emissionsInsight.metrics as { subregion?: string })?.subregion ?? "") : ""}
        />
      </div>

      {/* Interval chart */}
      <Card className="mt-4 border-border/70">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="font-display text-base">Interval demand — last 30 days</CardTitle>
          <div className="flex gap-1.5">
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
                <Area type="monotone" dataKey="kw" stroke="oklch(0.8 0.16 80)" strokeWidth={1.5} fill="url(#kwFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Demand heatmap */}
        <Card className="border-border/70">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Flame className="h-4 w-4 text-primary" /> Demand heatmap
            </CardTitle>
            {demandInsight && <ConfidenceBadge level={demandInsight.confidence} />}
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
                      R² {baseline.data.rSquared != null ? baseline.data.rSquared.toFixed(2) : "—"} · CV(RMSE){" "}
                      {baseline.data.cvrmse != null ? `${(baseline.data.cvrmse * 100).toFixed(0)}%` : "—"}
                    </p>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{baseline.data.confidenceLabel}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No baseline yet.</p>
            )}
            {costInsight && (
              <div className="border-t border-border pt-3">
                <p className="text-sm font-medium">{costInsight.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{costInsight.body}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Tariff comparison */}
      {tariffInsight && (
        <Card className="mt-4 border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-base">Rate check</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{tariffInsight.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tariffInsight.body}</p>
            <TariffTable metrics={tariffInsight.metrics as { comparisons?: TariffRow[] } | null} />
          </CardContent>
        </Card>
      )}

      {/* Opportunities */}
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
              {oppRows.map((o) => (
                <div key={o.id} className="rounded-md border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      <span className="mr-2 font-mono text-xs text-primary">#{o.rank}</span>
                      {o.title}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {o.ratchetAware && <ProvChip>ratchet-aware</ProvChip>}
                      {o.disaggregationMethod && <ProvChip>{o.disaggregationMethod.replace(/_/g, " ")}</ProvChip>}
                      <ConfidenceBadge level={o.confidence} />
                    </div>
                  </div>
                  {o.description && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{o.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
                    {o.estCostSavingsPerYr != null && (
                      <span>
                        est. <span className="text-emerald-400">{fmtUsd(o.estCostSavingsPerYr)}</span>/yr
                      </span>
                    )}
                    {o.estEnergySavingsPerYr != null && (
                      <span>
                        {fmtNum(o.estEnergySavingsPerYr)} {o.energyUnit ?? "kWh"}/yr
                      </span>
                    )}
                    {o.estDemandSavingsKw != null && <span>{fmtNum(o.estDemandSavingsKw)} kW post-ratchet</span>}
                    {o.paybackBandYears && <span>payback {o.paybackBandYears}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Other insights */}
      {insightRows.filter((i) => !["demand", "benchmark", "emissions", "cost", "tariff_comparison", "cp_proxy"].includes(i.kind)).length > 0 && (
        <Card className="mt-4 border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-base">Additional insights</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {insightRows
              .filter((i) => !["demand", "benchmark", "emissions", "cost", "tariff_comparison", "cp_proxy"].includes(i.kind))
              .map((i) => (
                <div key={i.id} className="border-b border-border/50 pb-3 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{i.title}</p>
                    <div className="flex items-center gap-1.5">
                      {i.disaggregationMethod && <ProvChip>{i.disaggregationMethod.replace(/_/g, " ")}</ProvChip>}
                      <ConfidenceBadge level={i.confidence} />
                    </div>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{i.body}</p>
                </div>
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
  annualCostUsd: number;
  deltaVsCurrentUsd: number | null;
  isCurrent: boolean;
  confidence: string;
  eligibilityNote?: string;
  disclosures?: string[];
};

function TariffTable({ metrics }: { metrics: { comparisons?: TariffRow[] } | null }) {
  const rows = metrics?.comparisons ?? [];
  if (rows.length === 0) return null;
  return (
    <Table className="mt-3">
      <TableHeader>
        <TableRow>
          <TableHead className="font-mono text-xs">Rate</TableHead>
          <TableHead className="text-right font-mono text-xs">Annual cost</TableHead>
          <TableHead className="text-right font-mono text-xs">Δ vs current</TableHead>
          <TableHead className="font-mono text-xs">Confidence</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="text-xs">
              {r.utilityName} — {r.tariffName} {r.isCurrent && <ProvChip>current</ProvChip>}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{fmtUsd(r.annualCostUsd)}</TableCell>
            <TableCell className={`text-right font-mono text-xs ${r.deltaVsCurrentUsd != null && r.deltaVsCurrentUsd < 0 ? "text-emerald-400" : ""}`}>
              {r.deltaVsCurrentUsd == null ? "—" : `${r.deltaVsCurrentUsd < 0 ? "−" : "+"}${fmtUsd(Math.abs(r.deltaVsCurrentUsd))}`}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{r.confidence}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
  const max = Math.max(...grid.flat(), 0.001);
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
                  style={{ background: `oklch(0.8 0.16 80 / ${Math.max(0.04, (v / max) * 0.95)})` }}
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
