/**
 * Insights dashboard (handoff §10) — interval chart with BUILD-010.3
 * peak-preserving decimation, demand heatmap, tariff comparison, ranked
 * opportunities, benchmark percentile card, emissions summary, and the
 * modeled-estimates disclaimer + provenance labels throughout.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { detectPersona, personaVocab } from "@/lib/persona";
import AnalysisProgress from "@/components/AnalysisProgress";
import DemandReview, { type DemandReviewData } from "@/components/DemandReview";
import MeterRateReviewCard, { type MeterRateReviewData } from "@/components/MeterRateReviewCard";
import type { FullBillEstimate as FullBillEstimateData } from "../../../../server/analytics/fullBill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, ChevronDown, Droplets, Flame, Gauge, Leaf, Lightbulb, Play, TrendingDown, Wifi, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { decimateForChart, fmtNum, fmtUsd, type ChartPoint } from "@/lib/wattwiseUi";
import { ConfidenceBadge, DisclaimerBanner, ProvChip } from "@/components/Honesty";
import { InsightCard, chipFromConfidence } from "@/components/InsightCard";
import QuickStart from "@/components/QuickStart";
import { MarkImplementedDialog, ProveItSection } from "@/components/ProveIt";
import RefineChips from "@/components/RefineChips";
import SiteGeometryPanel from "@/components/SiteGeometryPanel";
import UtilityServicesCard from "@/components/UtilityServicesCard";
import PropertyFactsCard from "@/components/PropertyFactsCard";
import { siteHref, useActiveSite, useSiteRequestGuard } from "@/hooks/useActiveSite";
import { Link } from "wouter";
import { Printer } from "lucide-react";
import SiteInsightsReport, { type InsightsPrintData } from "@/components/print/SiteInsightsReport";
import { ProvenanceBadge, classifyBasis } from "@/components/ProvenanceBadge";
import { formatSavingsRangeUsd, savingsRangeFromEstimate } from "@shared/savingsRange";
/** R2: the printed card shows the same yearly range as the queue (the card's
 * own modeled range when it has one, otherwise the confidence band). */
function printSavingsRange(o: { estCostSavingsPerYr?: number | null; confidence?: string | null; provenance?: unknown }) {
  const r = (o.provenance as { savingsRange?: unknown } | null)?.savingsRange;
  if (Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === "number" && Number.isFinite(v)) && r[0] < r[1] && r[1] > 0) {
    return { low: Math.max(0, r[0] as number), high: r[1] as number };
  }
  return savingsRangeFromEstimate(o.estCostSavingsPerYr ?? null, o.confidence ?? "medium");
}
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ProveItStatusChip } from "@/components/ProveIt";

type Demand = {
  peakKw: number;
  peakTimestamp: number;
  avgKw: number;
  loadFactor: number;
  heatmap: number[][];
  monthlyPeaks: Array<{ month: string; peakKw: number; peakTs: number }>;
  cpProxy: { label: string; topN: number; events: Array<{ ts: number; kw: number }> } | null;
  /** PEAK-2/3/4 (Jul 19) — present on analyses run after the demand-module
   * upgrade; older analysis rows lack them, so all render paths must guard. */
  loadDurationCurve?: Array<{ pctOfHours: number; kw: number }>;
  hoursNearPeakPct?: number;
  peakHypotheses?: Array<{ month: string; ts: number; kw: number; hypothesis: string; basis: string }>;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Dashboard() {
  const { activeSiteId, activeSite, sites, setActiveSite } = useActiveSite();
  const captureSiteRequest = useSiteRequestGuard(activeSiteId);

  const meters = trpc.sites.meters.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  // Match site analysis: prefer derived coincident campus total, then MAIN.
  // Every commodity and individual account remains available for drilldown.
  const [meterSel, setMeterSel] = useState<number | null>(null);
  useEffect(() => {
    setMeterSel(null);
  }, [activeSiteId]);
  const meter =
    (meterSel != null ? meters.data?.find((m) => m.id === meterSel) : undefined) ??
    meters.data?.find((m) => m.commodity === "electric" && m.meterRole === "virtual_total") ??
    meters.data?.find((m) => m.commodity === "electric" && m.meterRole === "main") ??
    meters.data?.find((m) => m.commodity === "electric" && !["submeter", "generation", "ev", "virtual_total"].includes(m.meterRole)) ??
    meters.data?.find((m) => m.meterRole === "main") ??
    meters.data?.find((m) => !["submeter", "generation", "ev", "virtual_total"].includes(m.meterRole)) ??
    meters.data?.[0];
  const flowUnit = meter?.commodity === "gas" ? "therms/day" : meter?.commodity === "water" ? "gal/day" : "kW";
  // RC3: a background re-analysis (after an address edit) shows as "running";
  // poll until it lands, then refresh every dependent panel once.
  const latest = trpc.analysis.latest.useQuery(
    { siteId: activeSiteId! },
    { enabled: activeSiteId != null, refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false) },
  );
  const backgroundRunning = latest.data?.status === "running";
  const retiredByLocation = latest.data?.status === "failed" && /location changed/i.test(latest.data?.error ?? "");
  const baseline = trpc.analysis.baseline.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const insights = trpc.insights.list.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const opps = trpc.insights.opportunities.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const recommendationQueue = trpc.recommendations.queue.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  /* TELX-1: telecom findings join the savings feed (queried per active site) */
  const telecom = trpc.telecom.analyze.useQuery({ siteId: activeSiteId ?? undefined }, { enabled: activeSiteId != null });
  const stats = trpc.intervalsApi.stats.useQuery({ meterId: meter?.id ?? 0 }, { enabled: !!meter });
  const utils = trpc.useUtils();

  // RC3: when a background analysis finishes, refresh dependent panels once.
  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const st = latest.data?.status;
    if (prevStatus.current === "running" && st && st !== "running") {
      void Promise.all([
        utils.analysis.baseline.invalidate(),
        utils.insights.list.invalidate(),
        utils.insights.opportunities.invalidate(),
        utils.recommendations.queue.invalidate(),
        utils.sites.get.invalidate(),
        utils.sites.propertyFacts.invalidate(),
      ]);
    }
    prevStatus.current = st;
  }, [latest.data?.status, utils]);
  const run = trpc.analysis.run.useMutation({
    onSuccess: async () => {
      toast.success("Analysis complete");
      await Promise.all([
        utils.analysis.latest.invalidate(),
        utils.analysis.baseline.invalidate(),
        utils.insights.list.invalidate(),
        utils.insights.opportunities.invalidate(),
        utils.recommendations.queue.invalidate(),
        utils.sites.meters.invalidate(),
        utils.intervalsApi.stats.invalidate(),
        utils.intervalsApi.window.invalidate(),
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
  const refreshRecommendations = () => Promise.all([utils.recommendations.queue.invalidate(), utils.recommendations.portfolioPriorities.invalidate(), utils.entities.portfolio.invalidate(), utils.proveIt.list.invalidate(), utils.proveIt.verifiedTotal.invalidate()]);
  // Undo / reset: every status change can be reversed from its toast; an
  // unverified completion can be undone later from the Completed list.
  const undoRecommendation = trpc.recommendations.undo.useMutation({
    onSuccess: async () => { await refreshRecommendations(); toast.success("Change undone"); },
    onError: (error) => toast.error(error.message),
  });
  const resetRecommendation = trpc.recommendations.reset.useMutation({
    onSuccess: async () => { await refreshRecommendations(); toast.success("Completion undone — the recommendation is back in your queue"); },
    onError: (error) => toast.error(error.message),
  });
  const changeRecommendation = trpc.recommendations.setState.useMutation({
    onSuccess: async (_result, input) => {
      await refreshRecommendations();
      const label = { completed: "Marked complete — verification is ready for new data", planned: "Added to plan", in_progress: "Marked in progress", deferred: "Deferred 90 days", dismissed: "Marked not applicable" }[input.status] ?? "Recommendation updated";
      toast.success(label, { duration: 10000, action: { label: "Undo", onClick: () => undoRecommendation.mutate({ items: [{ siteId: input.siteId, measure: input.measure }] }) } });
    },
    onError: (error) => toast.error(error.message),
  });
  const reopenRecommendation = trpc.recommendations.reopen.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.recommendations.queue.invalidate(), utils.recommendations.portfolioPriorities.invalidate(), utils.entities.portfolio.invalidate(), utils.proveIt.list.invalidate()]);
      toast.success("Recommendation reopened — its prove-it history is retained");
    },
    onError: (error) => toast.error(error.message),
  });
  // PRINT (Jul 19) — print-grade Site Insights Report: generate a verify token,
  // render the static print view (hidden print:block), then window.print().
  const [printToken, setPrintToken] = useState<string | null>(null);
  const [printData, setPrintData] = useState<InsightsPrintData | null>(null);
  useEffect(() => {
    setMarkTarget(null);
    setPrintToken(null);
    setPrintData(null);
  }, [activeSiteId]);
  const genReport = trpc.reports.generate.useMutation();
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
    benchmark?: { siteEui?: number | null; percentileBand?: string | null; source?: string | null; sqft?: number | null; sqftBasis?: string | null; sqftBasisLabel?: string | null ; plausibility?: { flag?: string; note?: string } | null } | null;
    emissions?: { annualCo2eLb?: number; subregion?: string; factorYear?: number; mapped?: boolean } | null;
    currentCost?: { disclosures?: string[]; pricingStatus?: string; breakdown?: { energy: number; demand: number; fixed: number; total: number; riders?: Array<{ label: string; amount: number }>; exportCredits?: number; cp?: number | null; minBillAdjustment?: number } } | null;
    /* TEL1C-4/TUX-2: connectivity subscription spend from the pipeline summary —
       user-entered dollars in the same cost picture as metered commodities. */
    telecomSpend?: { serviceCount: number; monthlyUsd: number; annualUsd: number; findingCount: number; savingsLoUsd: number; savingsHiUsd: number } | null;
    basisStructureHasDemandCharges?: boolean | null;
    // NEXT-1/NEXT-2: machine-readable rate provenance from the pipeline summary
    ratePricing?: {
      rateUsdPerKwh?: number;
      isFallback?: boolean;
      basis?: string;
      tier?: string;
      monthlyCurve?: Array<{ month: number; rate: number; billCount: number }> | null;
      seasonalSpreadPct?: number | null;
      // UNIT-1: which unit's assignment priced this site (meter | site | site_bills | state | national)
      attribution?: { level?: string; meterId?: number | null; meterLabel?: string | null; meterTariffAssigned?: boolean } | null;
    } | null;
    demandReview?: DemandReviewData | null;
    meterRateReview?: MeterRateReviewData | null;
    fullBillEstimate?: FullBillEstimateData | null;
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
  const allOppRows = opps.data ?? [];
  // v1.18 tenure modes: the action feed shows only occupant-executable measures;
  // owner-capex items (audience: landlord) render in their own "worth raising"
  // card — never as a payback the renter is asked to buy.
  const oppRows = allOppRows.filter((o) => ((o.provenance as Record<string, unknown> | null)?.audience ?? "occupant") !== "landlord");
  /* TUX-3 (owner Jul 23): telecom findings feed the SAME ranked list as building
     measures — one unified feed, no separate widget. Persisted telecom rows
     (pipeline TEL1C-4, measure prefix telecom_) win once an analysis has run;
     the live-query fallback covers sites whose last analysis predates TEL1C-4
     so findings never vanish, without double-rendering. */
  const hasPersistedTelecomOpps = allOppRows.some((o) => o.measure?.startsWith("telecom_"));
  const telecomFindings = hasPersistedTelecomOpps ? [] : (telecom.data?.findings ?? []).filter((f) => f.estAnnualSavingsLo != null);
  /* TUX-2: live telecom totals as fallback when the persisted summary predates
     TEL1C-4 (older analyses have no telecomSpend field). */
  const telecomSpendLive =
    telecom.data != null && telecom.data.services.length > 0
      ? {
          serviceCount: telecom.data.services.length,
          monthlyUsd: Math.round(telecom.data.monthlyTotalUsd),
          annualUsd: Math.round(telecom.data.annualTotalUsd),
          findingCount: telecom.data.findings.length,
          savingsLoUsd: telecom.data.totalAnnualSavingsLo,
          savingsHiUsd: telecom.data.totalAnnualSavingsHi,
        }
      : null;
  const landlordRows = allOppRows.filter((o) => (o.provenance as Record<string, unknown> | null)?.audience === "landlord");
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
        <h1 className="mt-4 font-display text-2xl font-bold">Welcome to Meterly</h1>
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

  /* §3g persona fork — detected from building type, never asked. Flips
     vocabulary (home/facility) and hero rotation: residential leads with the
     rate check (plan choice), commercial leads with the demand story (load
     factor, peak triage). Same grammar, two voices. */
  const persona = detectPersona(activeSite?.buildingType);
  const vocab = personaVocab(persona);
  const demandFirst = vocab.heroOrder === "demand_first";

  // PRINT (Jul 19) — assemble the print payload from the queries this page has
  // already loaded; the print view renders only after a verify token exists.
  const printCandidate: InsightsPrintData | null =
    activeSite != null
      ? {
          site: {
            name: activeSite.name,
            buildingType: activeSite.buildingType ?? null,
            sqft: activeSite.sqft ?? null,
            state: activeSite.state ?? null,
            zip: (activeSite as { zip?: string | null }).zip ?? null,
            utilityName: (activeSite as { utilityName?: string | null }).utilityName ?? null,
          },
          generatedAt: Date.now(),
          demand,
          benchmark: benchmarkInsight,
          emissions: emissionsInsight,
          currentCost: costInsight,
          /* HOL-6: connectivity joins the printed cost picture — persisted
             summary totals win; live query covers pre-TEL1C-4 analyses. */
          telecom: (() => {
            const ts = summary?.telecomSpend ?? telecomSpendLive;
            return ts != null && ts.serviceCount > 0
              ? { serviceCount: ts.serviceCount, monthlyUsd: ts.monthlyUsd, annualUsd: ts.annualUsd }
              : null;
          })(),
          baseline: summary?.baseline ?? null,
          tariffComparisons: tariffInsight,
          accountRateReview: summary?.meterRateReview ?? null,
          fullBillEstimate: summary?.fullBillEstimate ?? null,
          chart: chartData,
          chartWindowLabel: rangeDays === "all" ? "full history" : `last ${rangeDays} days`,
          insights: insightRows.map((i) => ({
            kind: i.kind,
            title: i.title,
            body: i.body ?? i.title,
            confidence: i.confidence ?? null,
          })),
          opportunities: allOppRows.map((o) => ({
            title: o.title,
            description: o.description ?? null,
            estCostSavingsPerYr: o.estCostSavingsPerYr ?? null,
            savingsRangeUsd: printSavingsRange(o),
            estEnergySavingsPerYr: o.estEnergySavingsPerYr ?? null,
            energyUnit: o.energyUnit ?? null,
            paybackBandYears: o.paybackBandYears ?? null,
            confidence: o.confidence ?? null,
            audience: String((o.provenance as Record<string, unknown> | null)?.audience ?? "occupant"),
          })),
          disclaimer:
            "All figures are modeled estimates from your uploaded data and public rate/weather references — not a professional energy audit, engineering study, or financial/tax advice.",
        }
      : null;

  async function preparePrint() {
    if (activeSiteId == null || !printCandidate || genReport.isPending) return;
    const isCurrent = captureSiteRequest();
    const snapshot = structuredClone(printCandidate);
    try {
      const res = await genReport.mutateAsync({ siteId: activeSiteId, kind: "site_insights" });
      if (!isCurrent()) return;
      setPrintData(snapshot);
      setPrintToken(res.token);
      setTimeout(() => { if (isCurrent()) window.print(); }, 400);
    } catch (error) {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : "Report generation failed");
    }
  }

  return (
    <div className="container max-w-6xl py-8">
      {/* print-grade report — the only content visible when printing */}
      {printData && printToken && (
        <div className="hidden print:block">
          <SiteInsightsReport data={printData} token={printToken} origin={window.location.origin} />
        </div>
      )}
      <div className="screen-only">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Explore</h1>
          {activeSite && (
            <div className="mt-1" data-testid="explore-site-context">
              <p className="text-sm font-semibold">{activeSite.name}</p>
              <p className="text-sm text-muted-foreground">{activeSite.address || [activeSite.city, activeSite.state, activeSite.zip].filter(Boolean).join(", ") || "Address not provided"}</p>
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            The full picture for your {vocab.building} — all modeled estimates.
            {persona === "commercial" ? " Facility voice: demand story first." : " Home voice: rate check first."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            disabled={genReport.isPending}
            value={activeSiteId != null ? String(activeSiteId) : ""}
            onValueChange={(value) => {
              setMeterSel(null);
              setActiveSite(Number(value));
            }}
          >
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
          <Button
            variant="outline"
            onClick={preparePrint}
            disabled={genReport.isPending || activeSiteId == null || latest.data == null}
            title={latest.data == null ? "Run an analysis first" : "Print-optimized report — use your browser's Save as PDF"}
          >
            <Printer className="mr-1 h-4 w-4" /> {genReport.isPending ? "Preparing…" : "Print / Save PDF"}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <DisclaimerBanner />
      </div>

      {/* §3h: live pipeline narration while an analysis runs — real stages only */}
      {activeSiteId != null && <AnalysisProgress key={`analysis:${activeSiteId}`} siteId={activeSiteId} active={run.isPending} />}

      {/* Progressive participation: optional add-detail chips while quick-start
          placeholders remain in effect — each names what refining unlocks. */}
      {activeSite?.attrSource === "quick_start_defaults" && activeSiteId != null && (
        <RefineChips key={`refine:${activeSiteId}`} siteId={activeSiteId} site={activeSite} onRefined={() => run.mutate({ siteId: activeSiteId })} />
      )}

      {/* GEO stage 2b: footprint resolve + tap-to-confirm + prism massing view */}
      {activeSiteId != null && (
        <div className="mt-4">
          <SiteGeometryPanel key={activeSiteId} siteId={activeSiteId} canEdit={(activeSite as { myRole?: string } | null)?.myRole !== "read_only"} />
        </div>
      )}

      {/* Oct 24 property facts: automatic, in-app public-record enrichment
          (replaces the outbound-link card — users never leave to look things up). */}
      {activeSiteId != null && (
        <PropertyFactsCard
          key={`facts:${activeSiteId}`}
          siteId={activeSiteId}
          canEdit={(activeSite as { myRole?: string } | null)?.myRole !== "read_only"}
          onFloorAreaChanged={() => run.mutate({ siteId: activeSiteId })}
          plausibilityNote={summary?.benchmark?.plausibility?.note ?? null}
        />
      )}

      {/* SVC: per-commodity service applicability — what we analyze and why,
          with one-tap correction (all-electric, well water, off-grid). */}
      {activeSiteId != null && (
        <div className="mt-4">
          <UtilityServicesCard key={activeSiteId} siteId={activeSiteId} />
        </div>
      )}

      {(backgroundRunning || retiredByLocation) && !run.isPending && (
        <Card className="mt-6 border-dashed" data-testid="reanalysis-notice">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm">
            <span className="text-muted-foreground">
              {backgroundRunning
                ? "Updating this site's analysis for its current address — figures refresh automatically."
                : "The address changed, so the earlier figures were retired. Re-run to price this site at its current location."}
            </span>
            {retiredByLocation && activeSiteId != null && (
              <Button size="sm" onClick={() => run.mutate({ siteId: activeSiteId })}>
                <Play className="mr-1 h-4 w-4" /> Re-run analysis
              </Button>
            )}
          </CardContent>
        </Card>
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
              ? `${(String(benchmarkInsight.percentileBand ?? "").match(/\(([^)]+)\)/)?.[1] ??
                String(benchmarkInsight.percentileBand ?? "")).trim()}${
                  benchmarkInsight.sqftBasis === "public_record_estimate" && benchmarkInsight.sqft
                    ? ` · per ${Math.round(benchmarkInsight.sqft).toLocaleString()} sqft, a public-record estimate`
                    : benchmarkInsight.sqftBasis === "placeholder"
                      ? " · per a typical-size placeholder floor area"
                      : ""
                }`
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

      {/* NEXT-1 (Jul 21): calibrate-with-a-bill callout — when savings are
          priced on an IMPUTED rate (state-average / national), one real bill
          upgrades every downstream dollar to the bill-verified tier
          automatically on the next analysis. Hidden once the rate is already
          actual or bill-verified. */}
      {summary?.ratePricing?.isFallback === true && summary.ratePricing.tier !== "bill_verified" && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <ProvenanceBadge tier={(summary.ratePricing.tier as never) ?? null} basis={summary.ratePricing.basis ?? null} />
          <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
            Dollar figures are priced at {summary.ratePricing.basis ?? "an imputed rate"}. Add one real bill (total $ and
            usage) and the next analysis upgrades every figure to your bill-verified rate — automatically.
          </p>
          <Link href={siteHref("/app/upload", activeSiteId)}>
            <Button size="sm" variant="outline" className="h-7 border-amber-500/40 text-xs">
              Calibrate with a bill
            </Button>
          </Link>
        </div>
      )}

      {/* UNIT-1 (Jul 22): pricing-attribution note — names WHICH unit's
          assignment priced this site's dollars (a specific meter's assigned
          tariff vs the site-level basis). Only rendered for tariff-priced
          sites where a meter-level assignment exists, since that's the case
          where "which meter?" genuinely matters on multi-meter sites. */}
      {summary?.ratePricing?.attribution?.level === "meter" && summary.ratePricing.attribution.meterLabel && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Pricing attribution: dollars on this page are priced from the tariff assigned to meter{" "}
          <span className="font-medium text-foreground">{summary.ratePricing.attribution.meterLabel}</span>. Other meters
          on this site may carry different rates — assign tariffs per meter in Sites → Meters to price each separately.
        </p>
      )}

      {/* SEAS-1 (Jul 21): seasonal rate strip — only rendered when the
          bill-verified calibration found a material (>5%) month-to-month
          spread across 3+ billed months. Months without a bill are simply
          absent; nothing is interpolated. */}
      {summary?.ratePricing?.tier === "bill_verified" &&
        (summary.ratePricing.monthlyCurve?.length ?? 0) >= 3 &&
        summary.ratePricing.seasonalSpreadPct != null && (
          <div className="mt-3 rounded-lg border border-border/70 bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ProvenanceBadge tier="bill_verified" basis={summary.ratePricing.basis ?? null} />
              <p className="text-xs font-medium">
                Seasonal rate detected — your blended rate varies{" "}
                {(summary.ratePricing.seasonalSpreadPct * 100).toFixed(0)}% across billed months
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(() => {
                const curve = summary.ratePricing.monthlyCurve ?? [];
                const max = Math.max(...curve.map((p) => p.rate));
                const monthName = (m: number) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
                return curve.map((p) => (
                  <span
                    key={p.month}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] ${
                      p.rate === max ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "border-border bg-muted/40 text-muted-foreground"
                    }`}
                    title={`${p.billCount} bill${p.billCount === 1 ? "" : "s"}`}
                  >
                    {monthName(p.month)} ${p.rate.toFixed(3)}
                  </span>
                ));
              })()}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Per-month blended rate from your actual bills (highest month highlighted). Months without a bill are omitted — never interpolated.
            </p>
          </div>
        )}

      {/* §3g hero rotation container — CSS order flips the story order per
          persona without duplicating JSX: commercial (facility voice) leads
          with the demand story, residential leads with the rate check. */}
      <div className="flex flex-col">

      {/* Interval chart */}
      <Card className={`mt-4 border-border/70 ${demandFirst ? "order-1" : "order-3"}`}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="font-display text-base">
            {meter?.commodity === "gas" ? "Gas usage" : meter?.commodity === "water" ? "Water usage" : "Interval demand"} — {rangeDays === "all" ? "full history" : `last ${rangeDays} days of data`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            {meter && (
              <Select value={String(meter.id)} onValueChange={(value) => setMeterSel(Number(value))}>
                <SelectTrigger className="w-72 text-xs" aria-label="Chart meter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(meters.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.meterRole === "virtual_total" ? "Campus total (coincident)" : `${m.commodity} · ${m.meterRole === "main" ? "account" : m.meterRole}`} — {m.label ?? `Meter ${m.id}`} (#{m.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
            <ProvChip>{meter?.meterRole === "virtual_total" ? "derived coincident campus total" : "measured meter"}</ProvChip>
            <ProvChip>peak-preserving decimation</ProvChip>
          </div>
        </CardHeader>
        <CardContent>
          {meter && <p className="mb-3 text-xs text-muted-foreground">{meter.label ?? `Meter ${meter.id}`} · #{meter.id}. {meter.meterRole === "virtual_total" ? "Sum of aligned service-agreement readings; demand is coincident across campus." : "Meter drilldown only; site KPIs and analysis remain campus-wide."}</p>}
          {!meter ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No meter on this site — <Link href={siteHref("/app/upload", activeSiteId)} className="text-primary underline">upload interval data</Link>{" "}
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
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" })}
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  minTickGap={48}
                />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} width={52} unit={` ${flowUnit === "kW" ? "kW" : flowUnit.split("/")[0]}`} />
                <Tooltip
                  contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
                  formatter={(v) => [`${v} ${flowUnit === "kW" ? "kW" : flowUnit.split("/")[0]}`, flowUnit === "kW" ? "demand" : "usage"]}
                />
                <Area type="monotone" dataKey="kw" stroke="var(--chart-1)" strokeWidth={1.5} fill="url(#kwFill)" isAnimationActive={false} dot={false} />
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
                {demand.monthlyPeaks && demand.monthlyPeaks.length > 0 ? (() => {
                  /* PEAK-1 (owner bug, Jul 19): the table previously sliced to the
                     6 most recent months, HIDING the annual maximum — the single
                     most important row for demand charges (it sets any ratchet
                     minimum). Now: all months render (scrollable past 8), and the
                     max row is pinned visually with a “sets ratchet” badge. */
                  const maxPeakKw = Math.max(...demand.monthlyPeaks.map((m) => m.peakKw));
                  const maxRow = demand.monthlyPeaks.find((m) => m.peakKw === maxPeakKw);
                  return (
                    <>
                      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 my-1.5 text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium">Greatest peak: {fmtNum(maxPeakKw)} kW</span>
                        <span className="text-muted-foreground">
                          {maxRow ? `in ${maxRow.month} (${new Date(maxRow.peakTs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })})` : ""} — on ratcheted rates this sets your minimum billing demand for months after
                        </span>
                      </div>
                      <div className={demand.monthlyPeaks.length > 8 ? "max-h-64 overflow-y-auto" : undefined}>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs">Month</TableHead>
                              <TableHead className="text-right text-xs">Peak kW</TableHead>
                              <TableHead className="text-right text-xs">When</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {demand.monthlyPeaks.map((mp) => {
                              const isMax = mp.peakKw === maxPeakKw;
                              return (
                                <TableRow key={mp.month} className={isMax ? "bg-primary/10 hover:bg-primary/15" : undefined}>
                                  <TableCell className="py-1.5 font-mono text-xs">
                                    {mp.month}
                                    {isMax && (
                                      <Badge variant="outline" className="ml-1.5 border-primary/50 text-[9px] text-primary">max — sets ratchet</Badge>
                                    )}
                                  </TableCell>
                                  <TableCell className={`py-1.5 text-right font-mono text-xs ${isMax ? "font-semibold text-primary" : ""}`}>{fmtNum(mp.peakKw)}</TableCell>
                                  <TableCell className="py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                                    {new Date(mp.peakTs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                      <p className="mt-1 text-[10px] text-muted-foreground">All {demand.monthlyPeaks.length} months shown — the highlighted row is the annual maximum.</p>
                    </>
                  );
                })() : (
                  <p className="py-4 text-sm text-muted-foreground">No monthly peak series in the latest analysis.</p>
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

            {/* PEAK-2: load duration curve — “how rare is the peak”. Older
                analyses lack the field; a re-run adds it. */}
            {demand.loadDurationCurve && demand.loadDurationCurve.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-[10px] uppercase text-muted-foreground">Load duration curve</p>
                  {demand.hoursNearPeakPct != null && (
                    <Badge variant="outline" className="text-[10px]">
                      {(demand.hoursNearPeakPct * 100).toFixed(1)}% of hours within 90% of peak
                    </Badge>
                  )}
                </div>
                <div className="mt-2 h-36">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={demand.loadDurationCurve} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="pctOfHours" tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} interval={24} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${fmtNum(v)}`} width={48} />
                      <Tooltip
                        formatter={(v: number) => [`${fmtNum(v)} kW`, "demand"]}
                        labelFormatter={(l: number) => `top ${l}% of hours`}
                        contentStyle={{ background: "var(--card)", color: "var(--card-foreground)", border: "1px solid var(--border)", fontSize: 11 }}
                      />
                      <Area type="stepAfter" dataKey="kw" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.15} strokeWidth={1.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {demand.hoursNearPeakPct != null && demand.hoursNearPeakPct < 0.02
                    ? "A steep cliff at the left: your peak occurs in a tiny share of hours — short-duration peak shaving (staggered starts, brief load shifting, pre-cooling) can plausibly cut billed demand."
                    : "A flatter curve: demand stays near peak for many hours — sustained baseload dominates, so demand savings need equipment or schedule changes, not brief shaving."}
                </p>
              </div>
            )}

            {/* PEAK-3/4: per-month contributing-load hypotheses with weather
                coincidence — explicitly labeled hypotheses, never assertions. */}
            {demand.peakHypotheses && demand.peakHypotheses.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-[10px] uppercase text-muted-foreground">What likely drove each peak</p>
                  <Badge variant="outline" className="text-[10px]">hypotheses to check — not measured attribution</Badge>
                </div>
                <ul className="mt-2 space-y-2">
                  {[...demand.peakHypotheses]
                    .sort((a, b) => b.kw - a.kw)
                    .slice(0, 4)
                    .map((ph) => (
                      <li key={ph.month} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-mono text-xs font-medium">{ph.month} — {fmtNum(ph.kw)} kW</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {new Date(ph.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] leading-relaxed">{ph.hypothesis}</p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{ph.basis}</p>
                      </li>
                    ))}
                </ul>
                {demand.peakHypotheses.length > 4 && (
                  <p className="mt-1 text-[10px] text-muted-foreground">Showing the 4 highest peaks of {demand.peakHypotheses.length} months.</p>
                )}
              </div>
            )}
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
            {/* Oct 24 (owner): PROGRESSIVE cost view — a simple Energy / Demand /
                Fixed / Other / Total default with one plain sentence; method,
                fit, rider lines and every disclosure stay one tap away. */}
            {costInsight?.breakdown ? (
              (() => {
                const b = costInsight.breakdown;
                const other = (b.riders ?? []).reduce((sum, r) => sum + r.amount, 0) + (b.cp ?? 0) + (b.minBillAdjustment ?? 0) - (b.exportCredits ?? 0);
                const tiles: Array<{ label: string; value: number; strong?: boolean }> = [
                  { label: "Energy", value: b.energy },
                  { label: "Demand", value: b.demand },
                  { label: "Fixed", value: b.fixed },
                  ...(Math.abs(other) >= 0.5 ? [{ label: "Other", value: other }] : []),
                  { label: "Total", value: b.total, strong: true },
                ];
                const tier = summary?.ratePricing?.tier;
                // Measured demand only exists when interval data was uploaded;
                // bill-only / described sites are priced on a modeled profile.
                const usageWord = summary?.demand ? "Your interval data" : "Modeled usage for this building";
                const plain =
                  tier === "tariff_priced_actual"
                    ? `${usageWord} priced on your utility's filed rate for the period covered.`
                    : tier === "assumed" || tier === "filed"
                      ? `${usageWord} priced on the closest filed rate for the period covered. Confirm the exact rate with your utility.`
                      : `${usageWord} priced at an average local rate for the period covered.`;
                return (
                  <div data-testid="cost-simple">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">Cost for the period covered</p>
                      <ProvenanceBadge
                        tier={(summary?.ratePricing?.tier as never) ?? null}
                        basis={summary?.ratePricing?.basis ?? "modeled tariff basis — confirm actual account schedule"}
                      />
                    </div>
                    <div className={`mt-2 grid gap-2 ${tiles.length === 5 ? "grid-cols-2 sm:grid-cols-5" : "grid-cols-2 sm:grid-cols-4"}`}>
                      {tiles.map((t) => (
                        <div key={t.label} className={`rounded-md border px-3 py-2 ${t.strong ? "border-primary/40 bg-primary/5" : "border-border/70"}`}>
                          <p className="text-[11px] text-muted-foreground">{t.label}</p>
                          <p className={`font-mono text-sm ${t.strong ? "font-semibold text-foreground" : "text-foreground/90"}`}>{fmtUsd(t.value)}</p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{plain}</p>
                    {summary?.fullBillEstimate && (
                      <div className="mt-2 rounded-md border border-dashed border-border px-3 py-2" data-testid="full-bill-estimate">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-xs font-medium">
                            {summary.fullBillEstimate.taxes ? "Estimated full bill with LFCR and taxes" : "Estimated bill with LFCR, before taxes"}
                          </p>
                          <p className="font-mono text-sm font-semibold">
                            {fmtUsd(summary.fullBillEstimate.total.low)}–{fmtUsd(summary.fullBillEstimate.total.high)}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          LFCR {fmtUsd(summary.fullBillEstimate.lfcr.low)}–{fmtUsd(summary.fullBillEstimate.lfcr.high)}
                          {summary.fullBillEstimate.taxes ? ` · taxes and assessments ${fmtUsd(summary.fullBillEstimate.taxes.low)}–${fmtUsd(summary.fullBillEstimate.taxes.high)}` : ""}
                          {summary.fullBillEstimate.unconfirmedTca.high > 0.5 ? ` · unconfirmed transmission adjustor ±${fmtUsd(summary.fullBillEstimate.unconfirmedTca.high)}` : ""}
                          {" "}· estimated from published rates, not confirmed by a bill
                        </p>
                        <details className="mt-1 text-[11px]">
                          <summary className="cursor-pointer text-muted-foreground">What the range covers</summary>
                          <ul className="mt-1 list-disc space-y-1 pl-4 leading-relaxed text-muted-foreground">
                            {summary.fullBillEstimate.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                          </ul>
                          <p className="mt-1 break-words text-muted-foreground">Sources: {summary.fullBillEstimate.sources.join(" · ")}</p>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : baseline.data ? (
              <p className="text-sm text-muted-foreground">{baseline.data.confidenceLabel}</p>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="cost-empty">
                No cost yet for this site.{" "}
                <Link href={siteHref("/app/upload", activeSiteId)} className="text-primary underline">
                  Add a bill or interval file
                </Link>{" "}
                to see Energy, Demand, Fixed, and Total.
              </p>
            )}
            {(baseline.data || costInsight?.breakdown) && (
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-primary hover:underline" data-testid="cost-details-toggle">
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" /> Details
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-3" data-testid="cost-details">
                  {baseline.data && (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="font-mono text-[10px] uppercase text-muted-foreground">Baseline method</p>
                        <p className="font-mono text-xs">{baseline.data.method}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[10px] uppercase text-muted-foreground">Fit</p>
                        <p className="font-mono text-xs">
                          R² {baseline.data.rSquared != null ? baseline.data.rSquared.toFixed(2) : "n/a"} · CV(RMSE){" "}
                          {baseline.data.cvrmse != null ? `${(baseline.data.cvrmse * 100).toFixed(0)}%` : "n/a (flat or archetype baseline)"}
                        </p>
                      </div>
                      <p className="col-span-2 text-xs leading-relaxed text-muted-foreground">{baseline.data.confidenceLabel}</p>
                    </div>
                  )}
                  {costInsight?.breakdown && (
                    <>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-3">
                        {costInsight.breakdown.riders?.map((r, i) => <span key={`rider-${i}-${r.label}`}>{r.label} {fmtUsd(r.amount)}</span>)}
                        {(costInsight.breakdown.cp ?? 0) > 0 && <span>coincident-peak {fmtUsd(costInsight.breakdown.cp)}</span>}
                        {(costInsight.breakdown.minBillAdjustment ?? 0) > 0 && <span>min-bill adj {fmtUsd(costInsight.breakdown.minBillAdjustment ?? 0)}</span>}
                        {(costInsight.breakdown.exportCredits ?? 0) > 0 && <span>export credit −{fmtUsd(costInsight.breakdown.exportCredits ?? 0)}</span>}
                      </div>
                      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
                        <li>Modeled estimate on your interval data and the filed rate structure — not a bill reproduction.</li>
                        {costInsight.disclosures?.map((d, i) => <li key={`disc-${i}`}>{d}</li>)}
                      </ul>
                    </>
                  )}
                {(summary?.telecomSpend ?? telecomSpendLive) != null ? (
                  (() => {
                    const ts = (summary?.telecomSpend ?? telecomSpendLive)!;
                    return (
                      <div className="mt-2 border-t border-dashed border-border pt-2">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-4">
                          <span>
                            connectivity {fmtUsd(ts.annualUsd)} <span className="text-[10px]">({ts.serviceCount} service{ts.serviceCount === 1 ? "" : "s"})</span>
                          </span>
                          <span className="text-foreground sm:col-span-2">
                            Connectivity is annual subscription spend; the utility subtotal covers the stated observed period. Not added across unlike periods.
                          </span>
                          <Link href={`/app/explore?site=${activeSiteId}`} className="text-primary hover:underline">
                            manage →
                          </Link>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          Connectivity is your entered subscription spend (actual dollars), shown alongside the modeled utility estimate — the two bases differ and are labeled, never blended.
                        </p>
                      </div>
                    );
                  })()
                ) : telecom.data != null && (telecom.data.services?.length ?? 0) === 0 ? (
                  <div className="mt-2 border-t border-dashed border-border pt-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Connectivity is a utility too —{" "}
                      <Link href={`/app/explore?site=${activeSiteId}`} className="text-primary hover:underline">
                        add internet/mobile services
                      </Link>{" "}
                      to include subscription spend in this cost picture and get plan-vs-market findings.
                    </p>
                  </div>
                ) : null}
                </CollapsibleContent>
              </Collapsible>
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
      <MeterRateReviewCard review={summary?.meterRateReview} />

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

      {/* GAP-S winter-sewer story card: the §2.57 sewer-on-winter-water linkage
          deserves narrative treatment — the "pays twice" mechanism is the story,
          not just a row in the ranking. The row STAYS in the ranked list below
          (dollar ordering must remain honest); this card explains the why. */}
      {(() => {
        const sewer = oppRows.find((o) => o.measure === "winter_water_sewer");
        if (!sewer) return null;
        const disclosures = ((sewer.provenance as Record<string, unknown> | null)?.disclosures as string[] | undefined) ?? [];
        return (
          <Card className="mt-4 border-sky-500/40 bg-sky-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <Droplets className="h-4 w-4 text-sky-700 dark:text-sky-500" /> Your winter water use sets next year&apos;s sewer bill
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-sm leading-relaxed">
                    Most municipal utilities set sewer charges from your <span className="font-medium">winter</span> water usage — the
                    winter-quarter-average convention, because winter use is nearly all indoor and proxies what actually reaches the
                    sewer. That means every gallon you cut this winter pays <span className="font-medium">twice</span>: on the water
                    bill now, and on twelve months of sewer billing set by that winter window.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{sewer.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="bg-background" onClick={() => { window.location.href = `/app/scenarios?site=${activeSiteId}&measure=${sewer.measure}`; }}>
                      Model this in Scenarios
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setMarkTarget({ id: sewer.id, measure: sewer.measure, title: sewer.title, expectedSavingsUsd: sewer.estCostSavingsPerYr ?? null })}>
                      I did this
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col items-start gap-1 md:items-end">
                  {sewer.estCostSavingsPerYr != null ? (
                    <>
                      <span className="font-display text-2xl font-bold text-sky-600 dark:text-sky-400">{fmtUsd(sewer.estCostSavingsPerYr)}/yr</span>
                      <span className="text-[11px] text-muted-foreground">water + sewer combined, screening band</span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">No dollar figure yet (needs a priced rate)</span>
                  )}
                  <Badge variant="outline" className="mt-1 border-sky-500/40 text-[10px] text-sky-600 dark:text-sky-400">convention-based estimate</Badge>
                </div>
              </div>
              {disclosures.length > 0 && (
                <p className="mt-3 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">{disclosures[0]}</p>
              )}
            </CardContent>
          </Card>
        );
      })()}

      <Card className="mt-4 border-border/70">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Lightbulb className="h-4 w-4 text-primary" /> Ranked opportunities
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Recommendations refresh as new data arrives — re-run analysis after changes to re-rank on your current situation.
          </p>
        </CardHeader>
        <CardContent>
          {recommendationQueue.isLoading ? (
            <Skeleton className="h-36 w-full" />
          ) : (recommendationQueue.data?.progress.totalIdentified ?? 0) === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Run analysis to generate ranked measures.</p>
          ) : (
            <div className="space-y-3">
              {(() => {
                const queue = recommendationQueue.data!;
                const progress = queue.progress;
                return (
                  <>
                    <div className="grid gap-2 rounded-md border border-border/70 bg-muted/30 p-3 text-xs sm:grid-cols-4">
                      <div><span className="font-medium">Your progress</span><br />{progress.completed} of {progress.totalIdentified} completed ({progress.completionPct}%)</div>
                      <div title={progress.verificationBasis}><span className="text-muted-foreground">Verified to date</span><br />{progress.verifiedSavingsUsd == null ? "Not verified yet" : fmtUsd(progress.verifiedSavingsUsd)}</div>
                      <div title={progress.savingsBasis}><span className="text-muted-foreground">Committed / yr (combined)</span><br />{formatSavingsRangeUsd(progress.committedRangeUsd)}</div>
                      <div title={progress.savingsBasis}><span className="text-muted-foreground">Open / yr (combined)</span><br />{formatSavingsRangeUsd(progress.projectedRangeUsd)}</div>
                    </div>
                    <p className="text-[11px] text-muted-foreground" data-testid="queue-savings-basis">{progress.savingsBasis}</p>
                    {queue.refreshSuggested && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs" data-testid="queue-refresh-suggested">
                        <span>You completed {queue.refreshSuggested.measures.join(" and ")} since the last analysis. Re-run it to re-estimate what remains.</span>
                        <Button size="sm" variant="outline" disabled={run.isPending || activeSiteId == null} onClick={() => activeSiteId != null && run.mutate({ siteId: activeSiteId })}>
                          {run.isPending ? "Re-estimating…" : "Update estimates"}
                        </Button>
                      </div>
                    )}
                    {!queue.refreshSuggested && queue.connectivityChanged && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs" data-testid="queue-connectivity-changed">
                        <span>Your connectivity services or bills changed since the last analysis. Update to include them in this list.</span>
                        <Button size="sm" variant="outline" disabled={run.isPending || activeSiteId == null} onClick={() => activeSiteId != null && run.mutate({ siteId: activeSiteId })}>
                          {run.isPending ? "Re-estimating…" : "Update estimates"}
                        </Button>
                      </div>
                    )}
                    {queue.active.map((item) => (
                      <div key={item.measure} className="rounded-md border border-border/70 bg-card p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="font-display text-xl font-bold text-primary">{formatSavingsRangeUsd(item.savingsRangeUsd)}<span className="ml-1 text-sm font-semibold text-muted-foreground">/yr</span></p>
                            <p className="mt-1 text-sm font-semibold">{item.title}</p>
                            {item.description && <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>}
                            <p className="mt-2 text-[11px] text-muted-foreground" title={item.basis}>Basis: {item.basis}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.status !== "open" && <Badge variant="outline" className="text-[10px]">{item.status === "planned" || item.status === "in_progress" ? "In your plan" : item.status}</Badge>}
                            <Badge variant="secondary" className="text-[10px]">{item.commodity}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{item.confidence} confidence</Badge>
                            {item.paybackBandYears && <Badge variant="secondary" className="text-[10px]">payback {item.paybackBandYears}</Badge>}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {item.status !== "planned" && item.status !== "in_progress" && (
                            <Button size="sm" variant="outline" disabled={changeRecommendation.isPending} onClick={() => changeRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure, title: item.title, status: "planned" })}>Add to plan</Button>
                          )}
                          {item.status !== "in_progress" && (
                            <Button size="sm" variant="outline" disabled={changeRecommendation.isPending} onClick={() => changeRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure, title: item.title, status: "in_progress" })}>Start</Button>
                          )}
                          <Button size="sm" disabled={changeRecommendation.isPending} onClick={() => changeRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure, title: item.title, status: "completed" })}>Mark complete</Button>
                          <Button size="sm" variant="ghost" disabled={changeRecommendation.isPending} onClick={() => changeRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure, title: item.title, status: "deferred", deferDays: 90 })}>Defer 90 days</Button>
                          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={changeRecommendation.isPending} onClick={() => changeRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure, title: item.title, status: "dismissed" })}>Not applicable</Button>
                        </div>
                      </div>
                    ))}
                    {queue.completed.length > 0 && (
                      <Collapsible>
                        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">Completed ({queue.completed.length})</CollapsibleTrigger>
                        <CollapsibleContent className="mt-2 space-y-2">
                          {queue.completed.map((item) => (
                            <div key={item.measure} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                              <div><span className="font-medium">{item.title}</span><span className="ml-2 text-muted-foreground">{formatSavingsRangeUsd(item.savingsRangeUsd)}/yr modeled range</span></div>
                              <span className="flex items-center gap-2">{item.implementation ? <><ProveItStatusChip status={item.implementation.status} /><span className="text-muted-foreground">{item.implementation.verifiedSavingsUsd == null ? "savings attribution withheld" : `${fmtUsd(item.implementation.verifiedSavingsUsd)} verified`}</span></> : <span className="text-muted-foreground">Completion recorded</span>}{(!item.implementation || item.implementation.status === "awaiting_data") && <Button size="sm" variant="ghost" data-testid={`rec-undo-completion-${item.measure}`} title="Marked complete by mistake, or not actually done? Removes this unverified completion and puts the recommendation back in your queue." disabled={resetRecommendation.isPending} onClick={() => resetRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure })}>Undo completion</Button>}<Button size="sm" variant="ghost" title="Put this back in your queue and keep its verification history." disabled={reopenRecommendation.isPending} onClick={() => reopenRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure })}>Reopen</Button></span>
                            </div>
                          ))}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                    {(queue.inactive.length > 0 || queue.needsReview.length > 0) && (
                      <Collapsible>
                        <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" data-testid="recs-inactive-trigger">Deferred, dismissed, or needs review ({queue.inactive.length + queue.needsReview.length})</CollapsibleTrigger>
                        <CollapsibleContent className="mt-2 space-y-2">
                          {[...queue.needsReview, ...queue.inactive].map((item) => (
                            <div key={`inactive-${item.measure}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                              <div><span className="font-medium">{item.title}</span><span className="ml-2 text-muted-foreground">{queue.needsReview.includes(item) ? "no longer in the current analysis — review before acting" : item.status}</span></div>
                              <Button size="sm" variant="ghost" disabled={reopenRecommendation.isPending} onClick={() => reopenRecommendation.mutate({ siteId: activeSiteId!, measure: item.measure })}>Reopen</Button>
                            </div>
                          ))}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* v1.18 §5 stage 5: landlord-benefit measures live in a separate card with
          an ask framing — the renter's feed above leads with in-control dollars. */}
      {landlordRows.length > 0 && (
        <Card className="mt-4 border-dashed border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Lightbulb className="h-4 w-4 text-muted-foreground" /> Worth raising with your landlord
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              These building upgrades would save real money, but they are your landlord's (or HOA's) to make. Raise them at lease renewal — the numbers below are your talking points.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {landlordRows.map((o) => (
                <InsightCard
                  key={o.id}
                  title={o.title}
                  dollars={o.estCostSavingsPerYr}
                  framing="Building saves"
                  headlineFallback="No dollar figure yet (needs a priced rate)"
                  why={o.description ?? ""}
                  confidence={chipFromConfidence(o.confidence, o.disaggregationMethod === "nilmtk_1min_plus")}
                  extraChips={["landlord pays · building benefits"]}
                  metrics={[...(o.paybackBandYears ? [{ label: "payback (for owner)", value: o.paybackBandYears }] : [])]}
                  provenance={[
                    ((o.provenance as Record<string, unknown> | null)?.audienceNote as string | undefined) ??
                      "Capital measure — the property owner pays and the building benefits.",
                    ...(((o.provenance as Record<string, unknown> | null)?.disclosures as string[] | undefined) ?? []),
                  ]}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* §3e prove-it: verification ledger for implemented measures */}
      {activeSiteId != null && <ProveItSection key={`prove:${activeSiteId}`} siteId={activeSiteId} />}
      {activeSiteId != null && (
        <MarkImplementedDialog
          key={`mark:${activeSiteId}`}
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

      {/* NAT-6 rate-change timeline — material rate movements from the
          autonomous currency engine (auto-applied adjustor moves, detected
          document changes, newly acquired utilities). Renders nothing when
          the engine has seen no movement. */}
      <RateActivityCard siteId={activeSiteId} />
      </div>
    </div>
  );
}

/** NAT-6 — Dashboard rate-activity card: the audit trail of the autonomous
 * rate-currency engine, so rate movements affecting analyses are visible
 * without visiting the Tariffs page. Hidden entirely when there are no
 * material events (a quiet engine is the normal state). */
function RateActivityCard({ siteId }: { siteId: number | null }) {
  const { data } = trpc.tariffs.rateChangeTimeline.useQuery({ limit: 8, siteId: siteId ?? undefined }, { staleTime: 5 * 60 * 1000 });
  if (!data || data.events.length === 0) return null;
  const kindMeta: Record<string, { label: string; cls: string }> = {
    auto_applied: { label: "auto-applied", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
    change_detected: { label: "change detected", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
    flagged: { label: "needs review", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
    acquired: { label: "rates acquired", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
    source_moved: { label: "source moved", cls: "bg-muted text-muted-foreground" },
  };
  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="font-display text-base">Rate activity</CardTitle>
        <p className="text-xs text-muted-foreground">
          Movements caught by the autonomous rate-verification engine for this site's state and utilities — every filed rate is monitored against its official source.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.events.map((e, i) => {
          const meta = kindMeta[e.kind] ?? kindMeta.source_moved;
          return (
            <div key={i} className="flex items-start gap-3 rounded-md border border-border/50 px-3 py-2">
              <Badge variant="secondary" className={`shrink-0 text-[10px] ${meta.cls}`}>{meta.label}</Badge>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {e.utilityName}
                  {e.state ? <span className="text-muted-foreground"> · {e.state}</span> : null}
                  {e.commodity ? <span className="text-muted-foreground"> · {e.commodity}</span> : null}
                </div>
                {e.evidence ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{e.evidence}</div> : null}
                {e.impact && e.impact.affectedSites > 0 ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5" title={e.impact.disclosure}>
                    <Badge
                      variant="secondary"
                      className={`text-[10px] ${e.impact.totalUsdYrDelta > 0 ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : e.impact.totalUsdYrDelta < 0 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
                    >
                      {e.impact.affectedSites} site{e.impact.affectedSites === 1 ? "" : "s"} · {e.impact.totalUsdYrDelta >= 0 ? "+" : "−"}${Math.abs(e.impact.totalUsdYrDelta).toLocaleString(undefined, { maximumFractionDigits: 0 })}/yr projected
                    </Badge>
                    {e.impact.perSite.slice(0, 3).map((s) => (
                      <span key={`${s.siteId}-${s.siteName}`} className="text-[10px] text-muted-foreground">
                        {s.siteName}{s.estUsdYrDelta != null ? ` ${s.estUsdYrDelta >= 0 ? "+" : "−"}$${Math.abs(s.estUsdYrDelta).toLocaleString(undefined, { maximumFractionDigits: 0 })}/yr` : " (no usage basis)"}
                      </span>
                    ))}
                    {e.impact.perSite.length > 3 ? (
                      <span className="text-[10px] text-muted-foreground">+{e.impact.perSite.length - 3} more</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.at).toLocaleDateString()}</span>
            </div>
          );
        })}
        {data.totalMaterial > data.events.length ? (
          <p className="text-xs text-muted-foreground">
            {data.totalMaterial - data.events.length} older event(s) — full history on the{" "}
            <Link href={siteHref("/app/tariffs", siteId)} className="underline">Tariffs page</Link>.
          </p>
        ) : null}
      </CardContent>
    </Card>
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
  /** Oct 24: savings rest on an inferred schedule / modeled subtotal. */
  indicative?: boolean;
  /** Oct 24: what to confirm with the utility before switching. */
  conditions?: string[];
};
/** Honesty Charter: savings are ranges — wider when indicative. */
function savingsRangeText(v: number, indicative: boolean | undefined): string {
  const lo = Math.round(v * (indicative ? 0.4 : 0.7));
  return `${fmtUsd(lo)}–${fmtUsd(Math.round(v))}`;
}

/** Savings column text — shared by the table cell and the stacked phone layout. */
function savingsCellText(r: TariffRow, hasCostBasis: boolean): string {
  if (r.isCurrentBasis) return "—";
  if (!hasCostBasis || r.savingsVsCurrent == null) return "— (no current-cost baseline)"; /* Batch-37/38: null — not a zeroed sentinel */
  if (r.savingsVsCurrent >= 0.5) return `saves ${savingsRangeText(r.savingsVsCurrent, r.indicative)}/yr`; /* Oct 24: range, never a point promise */
  if (r.savingsVsCurrent > -0.5) return "about the same";
  return `adds ${fmtUsd(Math.abs(r.savingsVsCurrent))}/yr`;
}
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
  // Oct 24 (owner, production Cantex screenshot): a schedule this site cannot
  // take is NOT priced by the pipeline — its annualCost is a zero placeholder.
  // Rendering it as "$0 (ref)" read as lost rate data. Priced rows (current
  // basis + every schedule the site can take) stay in the table; schedules
  // that do not apply are listed by name with the filed reason, never a $0.
  const priced = rows.filter((r) => r.eligible || r.isCurrentBasis);
  const notApplicable = rows.filter((r) => !r.eligible && !r.isCurrentBasis);
  return (
    <>
    {noneEligible && (
      <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200/90">
        {currentAssignedIneligible
          ? "Your assigned rate is shown below but sits outside this site's eligibility bracket (sector or peak-demand size), and no other rate in the library applies to this site. Cost figures use your assigned rate as the modeling basis — verify the schedule with your utility."
          : "None of the rates in the library apply to this site's sector and size, so no rate comparison can be priced. Upload a bill so the app can read your actual rate schedule."}
      </p>
    )}
    {priced.length > 0 && (
    <Table className="mt-3" data-testid="rate-table">
      <TableHeader>
        <TableRow>
          <TableHead className="font-mono text-xs">Rate</TableHead>
          <TableHead className="hidden text-right font-mono text-xs sm:table-cell">Annual cost</TableHead>
          <TableHead className="hidden whitespace-normal text-right font-mono text-xs sm:table-cell">Savings vs current</TableHead>
          <TableHead className="hidden font-mono text-xs md:table-cell">Data freshness</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {priced.map((r, i) => (
          <TableRow key={i} data-testid="rate-row">
            {/* Oct 24: rate text wraps so cost + savings stay on screen (cells default to nowrap) */}
            <TableCell className="whitespace-normal text-xs sm:min-w-[12rem]">
              {r.utilityName} — {r.tariffName}
              {r.isCurrentBasis && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">current basis</span>}
              {r.isCurrentBasis && !r.eligible && r.ineligibleReason && (
                <span className="mt-0.5 block text-[11px] text-muted-foreground">Outside this rate's filed bracket: {r.ineligibleReason}</span>
              )}
              {r.eligible && r.indicative && !r.isCurrentBasis && (
                <span className="ml-2 rounded border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-300" data-testid="rate-indicative">indicative</span>
              )}
              {r.eligible && (r.conditions?.length ?? 0) > 0 && !r.isCurrentBasis && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground" data-testid="rate-conditions">
                  {r.conditions!.map((c, ci) => <li key={ci}>{c}</li>)}
                </ul>
              )}
              {/* phones: cost + savings stacked under the rate name instead of off-screen columns */}
              <span className="mt-1 block font-mono text-xs sm:hidden" data-testid="rate-row-mobile-figures">
                {fmtUsd(r.annualCost.total)}/yr
                <span className={`ml-2 ${(r.savingsVsCurrent ?? 0) > 0 && !r.isCurrentBasis ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  {r.isCurrentBasis ? "your current rate" : savingsCellText(r, hasCostBasis)}
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground md:hidden">{r.freshness === "urdb_stale" ? "Rate data stale — verify with utility" : `Rate data ${r.freshness.replace(/_/g, " ")}`}</span>
            </TableCell>
            <TableCell className="hidden text-right font-mono text-xs sm:table-cell">{fmtUsd(r.annualCost.total)}</TableCell>
            <TableCell className={`hidden min-w-[7rem] whitespace-normal text-right sm:table-cell font-mono text-xs ${(r.savingsVsCurrent ?? 0) > 0 ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
              {savingsCellText(r, hasCostBasis)}
            </TableCell>
            <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{r.freshness === "urdb_stale" ? "stale — verify with utility" : r.freshness.replace(/_/g, " ")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    )}
    {notApplicable.length > 0 && (
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="rate-not-applicable-toggle">
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
          {notApplicable.length} other {notApplicable.length === 1 ? "rate is" : "rates are"} not available or not a fit for this site
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground" data-testid="rate-not-applicable">
            {notApplicable.map((r, i) => (
              <li key={i}>
                <span className="text-foreground/80">{r.tariffName}</span>
                {r.ineligibleReason ? ` — ${r.ineligibleReason}` : " — not available for this site"}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    )}
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
            <Fragment key={d}>
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
            </Fragment>
          ))}
        </div>
      </div>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground">avg kW by day-of-week × hour</p>
    </div>
  );
}
