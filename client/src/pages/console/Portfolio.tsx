/**
 * Portfolio rollup (Gap-9, Jul 2026) — entity → sites → meters view.
 * Combines each site's latest persisted analysis summary into per-owner and
 * account-wide totals. Honesty rules: never-analyzed sites show "not analyzed"
 * (null KPIs), not fabricated zeros; the peak column is explicitly labeled as
 * a NON-coincident sum of individual site peaks.
 */
import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, BadgeCheck, Building2, ChevronDown, Download, FileCheck2, FolderKanban, Gauge, Leaf, Plus, Tags, Trash2, Trophy, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { fmtNum, fmtUsd } from "@/lib/wattwiseUi";
import { ProvenanceBadge } from "@/components/ProvenanceBadge";
import { DisclaimerBanner } from "@/components/Honesty";
import { MapView } from "@/components/Map";
import { MapPin } from "lucide-react";
import { Link, useLocation } from "wouter";
import { formatSavingsRangeUsd } from "@shared/savingsRange";
import { siteHref, useActiveSite } from "@/hooks/useActiveSite";

export default function Portfolio() {
  const { activeSiteId, sites: selectableSites, setActiveSite } = useActiveSite();
  // "all" = every site; "none" = ungrouped sites only; numeric = that entity
  const [filter, setFilter] = useState<string>("all");
  // §3i-2: additional group-by slice using site_groups tags ("g:<id>")
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [priorityScope, setPriorityScope] = useState<"all" | "group" | "custom">("all");
  const [priorityGroupId, setPriorityGroupId] = useState<string>("");
  const [prioritySiteSelection, setPrioritySiteSelection] = useState<Set<number>>(new Set());
  const [priorityItemSelection, setPriorityItemSelection] = useState<Set<string>>(new Set());
  const entityId = filter === "all" ? undefined : filter === "none" ? null : Number(filter);
  const portfolio = trpc.entities.portfolio.useQuery({ entityId });
  const groupsQ = trpc.sites.groups.useQuery();
  const entities = portfolio.data?.entities ?? [];
  // One source of truth: the server rollup derives each site's next action
  // from the same recommendation queue the site view uses (R4 #6).
  const allRows = portfolio.data?.sites ?? [];
  const activeGroup = groupFilter === "all" ? null : (groupsQ.data ?? []).find((g) => String(g.id) === groupFilter) ?? null;
  const rows = activeGroup ? allRows.filter((r) => activeGroup.siteIds.includes(r.siteId)) : allRows;
  const totals = portfolio.data?.totals;
  const rateConfidence = portfolio.data?.rateConfidence;
  const entitySubtotals = portfolio.data?.entitySubtotals ?? null;
  // "All sites" follows the page's owner/group filter, so a district view
  // prioritizes only that district's campuses.
  const pageFiltered = filter !== "all" || activeGroup != null;
  const inViewKey = rows.map((r) => r.siteId).join(",");
  const inViewSiteIds = useMemo(() => (inViewKey ? inViewKey.split(",").map(Number) : []), [inViewKey]);
  const priorityQueryEnabled =
    (priorityScope === "all" && (!pageFiltered || portfolio.data != null)) ||
    (priorityScope === "group" && priorityGroupId !== "") ||
    (priorityScope === "custom" && prioritySiteSelection.size > 0);
  const priorities = trpc.recommendations.portfolioPriorities.useQuery(
    {
      groupId: priorityScope === "group" && priorityGroupId !== "" ? Number(priorityGroupId) : null,
      siteIds:
        priorityScope === "custom" && prioritySiteSelection.size > 0
          ? Array.from(prioritySiteSelection)
          : priorityScope === "all" && pageFiltered
            ? inViewSiteIds
            : null,
    },
    { enabled: priorityQueryEnabled },
  );
  const priorityUtils = trpc.useUtils();
  const refreshPriorities = () => Promise.all([
    priorityUtils.recommendations.portfolioPriorities.invalidate(),
    priorityUtils.recommendations.queue.invalidate(),
    priorityUtils.entities.portfolio.invalidate(),
  ]);
  const undoPriority = trpc.recommendations.undo.useMutation({
    onSuccess: async (r) => { await refreshPriorities(); toast.success(r.results.length === 1 ? "Change undone" : `${r.results.length} changes undone`); },
    onError: (error) => toast.error(error.message),
  });
  const changePriority = trpc.recommendations.setState.useMutation({
    onSuccess: async (_result, input) => {
      await refreshPriorities();
      toast.success("Recommendation updated", { duration: 10000, action: { label: "Undo", onClick: () => undoPriority.mutate({ items: [{ siteId: input.siteId, measure: input.measure }] }) } });
    },
    onError: (error) => toast.error(error.message),
  });
  const bulkPlan = trpc.recommendations.bulkSetState.useMutation({
    onSuccess: async (_result, input) => {
      setPriorityItemSelection(new Set());
      await Promise.all([
        priorityUtils.recommendations.portfolioPriorities.invalidate(),
        priorityUtils.recommendations.queue.invalidate(),
        priorityUtils.entities.portfolio.invalidate(),
      ]);
      toast.success(`${input.items.length} recommendation${input.items.length === 1 ? "" : "s"} added to plan`, { duration: 10000, action: { label: "Undo", onClick: () => undoPriority.mutate({ items: input.items.map((i) => ({ siteId: i.siteId, measure: i.measure })) }) } });
    },
    onError: (error) => toast.error(error.message),
  });

  const reopenPriority = trpc.recommendations.reopen.useMutation({
    onSuccess: async () => { await Promise.all([priorityUtils.recommendations.portfolioPriorities.invalidate(), priorityUtils.recommendations.queue.invalidate(), priorityUtils.entities.portfolio.invalidate()]); toast.success("Recommendation reopened"); },
    onError: error => toast.error(error.message),
  });

  // §3i-2 exception-first ranking: dollar opportunity + anomaly severity.
  // Anomalies get a large additive bump so a flagged site outranks a merely
  // expensive one; within each class, biggest open $ first.
  const ranked = [...rows].sort((a, b) => {
    const score = (r: (typeof rows)[number]) => (r.hasAnomaly ? 100000 : 0) + (r.topOpportunityUsd ?? 0);
    return score(b) - score(a);
  });

  return (
    <div className="container max-w-6xl py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rollup across owners, sites, and meters — figures come from each site&apos;s latest analysis.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={activeSiteId != null ? String(activeSiteId) : undefined} onValueChange={(value) => setActiveSite(Number(value))}>
            <SelectTrigger className="w-64" aria-label="Active site (navigation context)"><SelectValue placeholder="Active site…" /></SelectTrigger>
            <SelectContent>
              {(selectableSites.data ?? []).map((site) => <SelectItem key={`active-${site.id}`} value={String(site.id)}>{site.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-52" aria-label="Filter sites by owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sites</SelectItem>
              <SelectItem value="none">Ungrouped sites only</SelectItem>
              {entities.map((en) => (
                <SelectItem key={en.id} value={String(en.id)}>
                  {en.name} ({en.kind.replace(/_/g, " ")})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(groupsQ.data ?? []).length > 0 && (
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger className="w-44" aria-label="Filter sites by group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All groups</SelectItem>
                {(groupsQ.data ?? []).map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    {g.name} ({g.kind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <PortfolioExports />
        </div>
      </div>

      <div className="mt-4">
        <DisclaimerBanner />
      </div>

      {portfolio.isLoading ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          {/* §3i-2 roll-up KPI header: spend · verified savings · portfolio LF · emissions */}
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TotalCard
              icon={<Wallet className="h-4 w-4" />}
              label="Observed-period cost (modeled)"
              value={totals?.annualCostUsd != null ? fmtUsd(totals.annualCostUsd) : "—"}
              sub={
                totals
                  ? `${totals.analyzedCount}/${totals.siteCount} sites analyzed${totals.demandCostUsd != null ? ` · ${fmtUsd(totals.demandCostUsd)} demand/CP` : ""}${
                      totals.fullBillRangeUsd
                        ? ` · Estimated full bill with LFCR and taxes ${fmtUsd(totals.fullBillRangeUsd.low)}–${fmtUsd(totals.fullBillRangeUsd.high)} (${totals.fullBillSiteCount} site${totals.fullBillSiteCount === 1 ? "" : "s"}; not bill-confirmed)`
                        : ""
                    }${
                      /* TUX-5: all-services line — modeled utility + entered telecom,
                         labeled distinctly so the two bases never blend. */
                      (totals as { telecomAnnualUsd?: number | null }).telecomAnnualUsd != null && ((totals as { telecomAnnualUsd?: number | null }).telecomAnnualUsd ?? 0) > 0
                        ? ` · Connectivity shown separately on its entered annual basis`
                        : ""
                    }`
                  : ""
              }
            />
            <TotalCard
              icon={<BadgeCheck className="h-4 w-4" />}
              label="Savings attribution"
              value="Inconclusive"
              sub="Amounts withheld until immutable baselines and unique site/month allocation are available."
            />
            <TotalCard
              icon={<Gauge className="h-4 w-4" />}
              label="Portfolio load factor"
              value={totals?.portfolioLoadFactor != null ? `${(totals.portfolioLoadFactor * 100).toFixed(0)}%` : "—"}
              sub="usage-weighted mean of site load factors — not a coincident-meter figure"
            />
            <TotalCard
              icon={<Leaf className="h-4 w-4" />}
              label="Emissions"
              value={totals?.annualCo2eLb != null ? `${fmtNum(totals.annualCo2eLb)} lb CO₂e/yr` : "—"}
              sub="eGRID annual averages"
            />
          </div>

          <Card className="mt-4 border-border/70">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 font-display text-base">
                    <Zap className="h-4 w-4 text-primary" /> Portfolio priorities
                  </CardTitle>
                  <CardDescription>
                    Screening estimates, re-estimated after completed measures. Combined amounts are an overlap-aware bound, not a simple sum.
                    {priorityScope === "all" && pageFiltered && (
                      <> Scoped to the {inViewSiteIds.length} site{inViewSiteIds.length === 1 ? "" : "s"} shown by the filter above.</>
                    )}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Select value={priorityScope} onValueChange={(value) => setPriorityScope(value as "all" | "group" | "custom")}>
                    <SelectTrigger className="w-36" aria-label="Priority scope"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{pageFiltered ? "All sites in view" : "All sites"}</SelectItem>
                      <SelectItem value="group">Saved group</SelectItem>
                      <SelectItem value="custom">Custom sites</SelectItem>
                    </SelectContent>
                  </Select>
                  {priorityScope === "group" && (
                    <Select value={priorityGroupId} onValueChange={setPriorityGroupId}>
                      <SelectTrigger className="w-48" aria-label="Priority group"><SelectValue placeholder="Choose group…" /></SelectTrigger>
                      <SelectContent>
                        {(groupsQ.data ?? []).map((group) => <SelectItem key={group.id} value={String(group.id)}>{group.name} ({group.siteIds.length})</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {priorityScope === "custom" && (
                <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-border/60 p-3 text-xs">
                  {rows.map((site) => (
                    <label key={site.siteId} className="flex cursor-pointer items-center gap-1.5">
                      <Checkbox
                        checked={prioritySiteSelection.has(site.siteId)}
                        onCheckedChange={(checked) => setPrioritySiteSelection((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(site.siteId); else next.delete(site.siteId);
                          return next;
                        })}
                      />
                      {site.name}
                    </label>
                  ))}
                </div>
              )}
              {!priorityQueryEnabled ? (
                <p className="py-4 text-center text-sm text-muted-foreground">Choose a saved group or at least one site to compare priorities.</p>
              ) : priorities.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : priorities.data ? (
                <>
                  <div className="grid gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs sm:grid-cols-4">
                    <div><span className="font-medium">Progress</span><br />{priorities.data.progress.completed}/{priorities.data.progress.totalIdentified} complete ({priorities.data.progress.completionPct}%)</div>
                    <div><span className="text-muted-foreground">In plan</span><br />{priorities.data.progress.planned + priorities.data.progress.inProgress} actions</div>
                    <div data-testid="priorities-combined"><span className="text-muted-foreground">Combined open / yr</span><br /><span title={priorities.data.progress.savingsBasis}>{priorities.data.progress.projectedRangeUsd ? formatSavingsRangeUsd(priorities.data.progress.projectedRangeUsd) : "No open ranges"}</span></div>
                    <div><span className="text-muted-foreground">Savings attribution</span><br />Inconclusive</div>
                  </div>
                  <p className="text-xs text-muted-foreground">{priorities.data.progress.savingsBasis}</p>
                  <p className="text-xs text-muted-foreground">{priorities.data.progress.verificationBasis}</p>
                  <p className="text-xs text-muted-foreground">Ranking: {priorities.data.rankingBasis}</p>
                  {priorityItemSelection.size > 0 && (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                      <span>{priorityItemSelection.size} selected</span>
                      <Button
                        size="sm"
                        disabled={bulkPlan.isPending}
                        onClick={() => bulkPlan.mutate({
                          status: "planned",
                          items: priorities.data.items.filter((item) => priorityItemSelection.has(`${item.siteId}:${item.measure}`)).map((item) => ({ siteId: item.siteId, measure: item.measure, title: item.title })),
                        })}
                      >
                        {bulkPlan.isPending ? "Adding…" : "Add selected to plan"}
                      </Button>
                    </div>
                  )}
                  {priorities.data.items.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">No active recommendations in this scope. Completed, deferred, and dismissed measures are retained in site progress.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8" />
                            <TableHead>Site</TableHead>
                            <TableHead>Recommendation</TableHead>
                            <TableHead className="text-right">Standalone range / yr</TableHead>
                            <TableHead>Payback</TableHead>
                            <TableHead>Confidence</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {priorities.data.items.map((item) => {
                            const key = `${item.siteId}:${item.measure}`;
                            return (
                              <TableRow key={key}>
                                <TableCell><Checkbox checked={priorityItemSelection.has(key)} onCheckedChange={(checked) => setPriorityItemSelection((current) => { const next = new Set(current); if (checked === true) next.add(key); else next.delete(key); return next; })} /></TableCell>
                                <TableCell className="min-w-[10rem] max-w-[16rem] whitespace-normal"><Link href={`/app/explore?site=${item.siteId}`} className="font-medium text-primary hover:underline">{item.siteName}</Link></TableCell>
                                <TableCell className="min-w-[14rem] max-w-[22rem] whitespace-normal"><span>{item.title}</span><details className="mt-0.5 text-[10px] text-muted-foreground"><summary className="cursor-pointer">Basis and all disclosures</summary><p>{item.basis}</p></details></TableCell>
                                <TableCell className="text-right font-medium" title={item.basis}>{formatSavingsRangeUsd(item.savingsRangeUsd)}</TableCell>
                                <TableCell className="text-xs">{item.paybackBandYears ?? "—"}</TableCell>
                                <TableCell className="capitalize text-xs">{item.confidence}</TableCell>
                                <TableCell><Badge variant="secondary" className="text-[10px]">{item.status === "planned" || item.status === "in_progress" ? "in plan" : "open"}</Badge></TableCell>
                                <TableCell className="text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="outline" disabled={changePriority.isPending} onClick={() => changePriority.mutate({ siteId: item.siteId, measure: item.measure, title: item.title, status: "planned" })}>Plan</Button><Button size="sm" disabled={changePriority.isPending} onClick={() => changePriority.mutate({ siteId: item.siteId, measure: item.measure, title: item.title, status: "in_progress" })}>Start</Button></div></TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {priorities.data.inactive.length > 0 && <details className="border-t pt-3 text-xs"><summary className="cursor-pointer">Completed, deferred, dismissed and needs review ({priorities.data.inactive.length})</summary><div className="mt-2 space-y-2">{priorities.data.inactive.map(item => <div key={`${item.siteId}:${item.measure}`} className="flex items-center justify-between gap-2"><span>{item.siteName} · {item.title} · {item.status.replace(/_/g, " ")}{item.deferUntil && item.status === "deferred" ? ` until ${new Date(item.deferUntil).toLocaleDateString()}` : ""}</span><Button size="sm" variant="ghost" disabled={reopenPriority.isPending} onClick={() => reopenPriority.mutate({siteId:item.siteId,measure:item.measure})}>Reopen</Button></div>)}</div></details>}
                  {priorities.data.byMeasure.length > 0 && (
                    <div className="border-t border-border/60 pt-3">
                      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">By measure</p>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {priorities.data.byMeasure.map((measure) => <div key={measure.measure} className="rounded-md border border-border/60 p-2 text-xs"><span className="font-medium">{measure.title}</span> · {measure.sites.length} site{measure.sites.length === 1 ? "" : "s"}<span className="float-right text-muted-foreground">Combined amount withheld</span><p className="mt-1 text-[10px] text-muted-foreground">{measure.sites.map((site) => site.siteName).join(", ")}</p></div>)}
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </CardContent>
          </Card>

          {/* CONF-1 (Jul 21): rate-confidence rollup — how many sites' dollar
              figures stand on actual/verified pricing vs an imputed average,
              with one-click calibrate links for each imputed site. */}
          <RateConfidenceCard rows={rows} rateConfidence={rateConfidence} />

          {/* UNIT-1 (Jul 22): owner/entity subtotals — the organization layer of
              the attribution hierarchy (meter → site → entity). Renders only
              when the user actually uses entities. */}
          {entitySubtotals != null && entitySubtotals.length > 0 && filter === "all" && (
            <Card className="mt-4 border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building2 className="h-4 w-4 text-muted-foreground" /> Spend by owner
                </CardTitle>
                <CardDescription>
                  Subtotals per organization — sites not assigned to an entity roll up under “Unassigned”.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">Owner</th>
                        <th className="py-1.5 pr-3 font-medium">Sites</th>
                        <th className="py-1.5 pr-3 font-medium">Observed-period cost (modeled)</th>
                        <th className="py-1.5 pr-3 font-medium">Connectivity (entered)</th>
                        <th className="py-1.5 pr-3 font-medium">Annual usage</th>
                        <th className="py-1.5 font-medium">Open opportunity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entitySubtotals.map((e) => (
                        <tr key={String(e.entityId)} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 pr-3">
                            {e.entityId != null ? (
                              <button className="text-left underline-offset-2 hover:underline" onClick={() => setFilter(String(e.entityId))}>
                                {e.name}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">{e.name}</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">
                            {e.analyzedCount}/{e.siteCount} analyzed
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">{e.annualCostUsd > 0 ? fmtUsd(e.annualCostUsd) : "—"}</td>
                          {/* TUX-5: telecom subtotal at the owner layer — entered dollars */}
                          <td className="py-1.5 pr-3 tabular-nums">
                            {(e as { telecomAnnualUsd?: number }).telecomAnnualUsd && (e as { telecomAnnualUsd?: number }).telecomAnnualUsd! > 0
                              ? fmtUsd((e as { telecomAnnualUsd?: number }).telecomAnnualUsd!)
                              : "—"}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums">{e.annualUsageKwh > 0 ? `${fmtNum(e.annualUsageKwh)} kWh` : "—"}</td>
                          <td className="py-1.5 tabular-nums" title="Sum of each site's next recommended action (sites are independent).">{e.openOpportunityRangeUsd ? formatSavingsRangeUsd(e.openOpportunityRangeUsd) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* §3i-2 exception-first view: ranked by $ opportunity + anomaly severity */}
          {ranked.length > 0 && (
            <Card className="mt-4 border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 font-display text-base">
                  <AlertTriangle className="h-4 w-4 text-primary" /> Needs attention first
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Ranked by open dollar opportunity and anomaly flags — top {Math.min(3, ranked.length)} expanded, the rest collapsed below.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {ranked.slice(0, 3).map((r) => (
                  <ExceptionRow key={r.siteId} r={r} expanded />
                ))}
                {ranked.length > 3 && <CollapsedRows rows={ranked.slice(3)} />}
              </CardContent>
            </Card>
          )}

          {/* §1b portfolio map: saved sites pinned, colored by open opportunity
              size. Only sites with a verified-address geocode get a pin — the
              rest are counted honestly under the map, never guessed onto it. */}
          <PortfolioMap rows={rows} />

          {/* §3i-2 league table: weather- and size-normalized — never raw kWh across climates */}
          <LeagueTable rows={rows} />

          {/* §3i-2 utility-exposure rollup: spend concentration by provider */}
          <UtilityExposure rows={rows} />

          {/* §3i-2 portfolio basket (Pro): one measure across selected sites */}
          <PortfolioBasket rows={rows.map((r) => ({ siteId: r.siteId, name: r.name, analyzed: r.analyzed }))} />

          {/* §3i-2 bulk site screening (Pro): paste addresses → ranked estimate screen */}
          <BulkScreen />

          {/* Per-site table */}
          <Card className="mt-4 border-border/70">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <FolderKanban className="h-4 w-4 text-primary" /> Sites in view
              </CardTitle>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No sites match this filter —{" "}
                  <Link href={siteHref("/app/sites", activeSiteId)} className="text-primary underline">
                    add or group sites
                  </Link>
                  .
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Site</TableHead>
                      <TableHead>Owner group</TableHead>
                      <TableHead className="text-right">Meters</TableHead>
                      <TableHead className="text-right">Observed-period cost</TableHead>
                      <TableHead className="text-right">Connectivity</TableHead>
                      <TableHead className="text-right">Demand/CP $</TableHead>
                      <TableHead className="text-right">Peak kW</TableHead>
                      <TableHead className="text-right">Load factor</TableHead>
                      <TableHead className="text-right">Annual kWh</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const owner = entities.find((en) => en.id === r.entityId);
                      return (
                        <TableRow key={r.siteId}>
                          <TableCell>
                            <Link href={`/app?site=${r.siteId}`} className="font-medium text-primary hover:underline">
                              {r.name}
                            </Link>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {r.state ?? ""}
                              {r.buildingType ? ` · ${r.buildingType.replace(/_/g, " ")}` : ""}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{owner ? owner.name : "—"}</TableCell>
                          <TableCell className="text-right">{r.meterCount}</TableCell>
                          {r.analyzed ? (
                            <TableCell className="text-right">
                              <span className="inline-flex items-center gap-1.5">
                                {r.rateTier != null && <ProvenanceBadge tier={r.rateTier as never} basis={r.rateBasis} />}
                                {r.annualCostUsd != null ? fmtUsd(r.annualCostUsd) : "—"}
                              </span>
                            </TableCell>
                          ) : (
                            <TableCell className="text-right">
                              <Badge variant="secondary" className="text-[10px]">
                                not analyzed yet
                              </Badge>
                            </TableCell>
                          )}
                          {/* HOL-4: connectivity is a first-class column — entered
                              subscription dollars, shown whether or not the site's
                              metered analysis has run (it is bill-based, not modeled). */}
                          <TableCell className="text-right">
                            {(r as { telecomAnnualUsd?: number | null }).telecomAnnualUsd != null
                              ? fmtUsd((r as { telecomAnnualUsd?: number | null }).telecomAnnualUsd!)
                              : "—"}
                          </TableCell>
                          {r.analyzed ? (
                            <>
                              <TableCell className="text-right">{r.demandCostUsd != null ? fmtUsd(r.demandCostUsd) : "—"}</TableCell>
                              <TableCell className="text-right">{r.peakKw != null ? fmtNum(r.peakKw) : "—"}</TableCell>
                              <TableCell className="text-right">{r.loadFactor != null ? `${(r.loadFactor * 100).toFixed(0)}%` : "—"}</TableCell>
                              <TableCell className="text-right">{r.annualUsageKwh != null ? fmtNum(r.annualUsageKwh) : "—"}</TableCell>
                            </>
                          ) : (
                            <TableCell colSpan={4} />
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Site groups management (v1.7 §2.2a) */}
          <GroupsManager sites={rows.map((r) => ({ siteId: r.siteId, name: r.name }))} />
        </>
      )}
    </div>
  );
}

function RateConfidenceCard({
  rows,
  rateConfidence,
}: {
  rows: { siteId: number; name: string; analyzed: boolean; rateTier: string | null; rateBasis: string | null; annualCostUsd: number | null }[];
  rateConfidence?: { actualCount: number; billVerifiedCount: number; imputedCount: number; unknownCount: number };
}) {
  if (!rateConfidence) return null;
  const analyzed = rateConfidence.actualCount + rateConfidence.billVerifiedCount + rateConfidence.imputedCount + rateConfidence.unknownCount;
  if (analyzed === 0) return null;
  const imputedSites = rows.filter((r) => r.analyzed && (r.rateTier === "state_average_imputed" || r.rateTier === "national_assumption"));
  const solidCount = rateConfidence.actualCount + rateConfidence.billVerifiedCount;
  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <BadgeCheck className="h-4 w-4 text-primary" /> Rate confidence
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Which pricing tier each site&apos;s dollar figures stand on — {solidCount}/{analyzed} analyzed sites priced on actual or bill-verified rates.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {rateConfidence.actualCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <ProvenanceBadge tier="actual" /> {rateConfidence.actualCount} tariff-priced
            </span>
          )}
          {rateConfidence.billVerifiedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <ProvenanceBadge tier="bill_verified" /> {rateConfidence.billVerifiedCount} bill-verified
            </span>
          )}
          {rateConfidence.imputedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <ProvenanceBadge tier="imputed" /> {rateConfidence.imputedCount} on imputed averages
            </span>
          )}
          {rateConfidence.unknownCount > 0 && (
            <span className="text-xs text-muted-foreground">{rateConfidence.unknownCount} analyzed before provenance tracking — re-run analysis to tier them</span>
          )}
        </div>
        {imputedSites.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {imputedSites.length === 1 ? "1 site prices" : `${imputedSites.length} sites price`} dollars on a state-average assumption — one real bill each pins the true rate:
            </p>
            <ul className="space-y-1">
              {imputedSites.map((s) => (
                <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {s.name}
                    {s.annualCostUsd != null ? ` · ${fmtUsd(s.annualCostUsd)} observed-period subtotal` : ""}
                  </span>
                  <Link href={`/app/upload?site=${s.siteId}`} className="font-medium text-primary underline underline-offset-2">
                    Calibrate with a bill →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** §1b portfolio map: pins colored by open opportunity size. Only sites with a
 * verified-address geocode get a pin; the rest are counted honestly below the
 * map. The whole card hides when no site has coordinates — an empty map that
 * pretends to know locations would be a spec failure. */
/** GAP-N — portfolio-level exports (Pro): ENERGY STAR Portfolio Manager CSV
 * download + the portfolio verified-savings statement dialog. Tier errors
 * surface as toasts with the server's honest feature-naming copy. */
function PortfolioExports() {
  const [verifiedOpen, setVerifiedOpen] = useState(false);
  const exportCsv = trpc.reports.portfolioExport.useMutation({
    onSuccess: (r) => {
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meterly-portfolio-manager-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${r.siteCount} site${r.siteCount === 1 ? "" : "s"} — Portfolio Manager–compatible CSV`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <Button size="sm" variant="outline" className="bg-background" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
        <Download className="mr-1.5 h-3.5 w-3.5" /> {exportCsv.isPending ? "Exporting…" : "Portfolio Manager CSV"}
      </Button>
      <Button size="sm" variant="outline" className="bg-background" onClick={() => setVerifiedOpen(true)}>
        <FileCheck2 className="mr-1.5 h-3.5 w-3.5" /> Verified savings statement
      </Button>
      {verifiedOpen && <PortfolioVerifiedDialog open={verifiedOpen} onClose={() => setVerifiedOpen(false)} />}
    </>
  );
}

function PortfolioVerifiedDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const data = trpc.reports.portfolioVerified.useQuery(undefined, { enabled: open, retry: false });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <BadgeCheck className="h-4 w-4 text-primary" /> Portfolio verified savings
          </DialogTitle>
        </DialogHeader>
        {data.isLoading && <Skeleton className="h-40 w-full" />}
        {data.error && <p className="text-sm text-destructive">{data.error.message}</p>}
        {data.data && (
          <div>
            <div className="rounded-lg border border-border/70 bg-muted/40 p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Cumulative verified savings</p>
              <p className="mt-1 font-display text-3xl font-bold">Attribution inconclusive</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {data.data.analyzedCount}/{data.data.siteCount} sites analyzed · historical amounts withheld: unique site/month allocation and immutable pre-change baselines are required.
              </p>
            </div>
            {data.data.perSite.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No implemented measures yet. Mark a recommendation “I did this” on any site and Meterly will start verifying savings against its weather-adjusted baseline.
              </p>
            ) : (
              data.data.perSite.map((s) => (
                <div key={s.siteId} className="mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{s.siteName}</p>
                    <Badge variant="secondary" className="text-[10px]">Attribution inconclusive</Badge>
                  </div>
                  <Table className="mt-1.5">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Measure</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Months</TableHead>
                        <TableHead className="text-right text-xs">Verified $</TableHead>
                        <TableHead className="text-xs">Basis</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.verdicts.map((v, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{v.measure.replace(/_/g, " ")}</TableCell>
                          <TableCell className="text-xs">{v.status === "awaiting_data" ? "awaiting data" : "inconclusive"}</TableCell>
                          <TableCell className="text-xs">{v.months}</TableCell>
                          <TableCell className="text-right text-xs">{"Withheld"}</TableCell>
                          <TableCell className="text-xs">{v.chip}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))
            )}
            <p className="mt-4 text-[11px] text-muted-foreground">{data.data.disclaimer}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PortfolioMap({
  rows,
}: {
  rows: Array<{
    siteId: number;
    name: string;
    lat: number | null;
    lng: number | null;
    analyzed: boolean;
    topOpportunityUsd: number | null;
    hasAnomaly: boolean;
  }>;
}) {
  const pinned = rows.filter((r) => r.lat != null && r.lng != null);
  const unpinned = rows.length - pinned.length;
  if (pinned.length === 0) return null;

  const center = {
    lat: pinned.reduce((s, r) => s + (r.lat as number), 0) / pinned.length,
    lng: pinned.reduce((s, r) => s + (r.lng as number), 0) / pinned.length,
  };

  // Opportunity-size color scale (matches the exception-first ranking bands).
  const colorFor = (r: (typeof pinned)[number]) =>
    r.hasAnomaly ? "#dc2626" : (r.topOpportunityUsd ?? 0) >= 500 ? "#ea580c" : (r.topOpportunityUsd ?? 0) >= 100 ? "#d97706" : (r.topOpportunityUsd ?? 0) > 0 ? "#16a34a" : "#64748b";

  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <MapPin className="h-4 w-4 text-primary" /> Portfolio map
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Pins colored by standalone screening midpoint (not additive savings) — red means an anomaly needs attention. Click a pin to open that site.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-md border border-border/70">
          <MapView
            className="h-72 w-full"
            initialCenter={center}
            initialZoom={pinned.length === 1 ? 13 : 5}
            onMapReady={(map) => {
              const bounds = new google.maps.LatLngBounds();
              for (const r of pinned) {
                const pos = { lat: r.lat as number, lng: r.lng as number };
                bounds.extend(pos);
                const dot = document.createElement("div");
                const usd = r.topOpportunityUsd;
                dot.style.cssText = `background:${colorFor(r)};color:#fff;border-radius:9999px;padding:4px 8px;font:600 11px/1.2 system-ui;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:pointer;white-space:nowrap`;
                dot.textContent = r.name;
                dot.title = r.analyzed ? (usd != null && usd > 0 ? "Standalone screening priority — see range and basis in the table" : "Analyzed — no open opportunity sized yet") : "Not analyzed yet";
                const marker = new google.maps.marker.AdvancedMarkerElement({ map, position: pos, title: r.name, content: dot });
                marker.addListener("click", () => {
                  window.location.href = `/app?site=${r.siteId}`;
                });
              }
              if (pinned.length > 1) map.fitBounds(bounds, 48);
            }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#dc2626" }} /> anomaly</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#ea580c" }} /> ≥$500/yr open</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#d97706" }} /> $100–500/yr</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#16a34a" }} /> under $100/yr</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "#64748b" }} /> not sized yet</span>
          {unpinned > 0 && (
            <span className="ml-auto">
              {unpinned} site{unpinned === 1 ? "" : "s"} without a verified address {unpinned === 1 ? "isn’t" : "aren’t"} shown — re-add with an address suggestion to pin {unpinned === 1 ? "it" : "them"}.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Create/delete site groups and toggle site membership — portfolio-scale organization. */
function GroupsManager({ sites }: { sites: { siteId: number; name: string }[] }) {
  const utils = trpc.useUtils();
  const groups = trpc.sites.groups.useQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; kind: "region" | "manager" | "brand" | "custom" }>({ name: "", kind: "custom" });

  const create = trpc.sites.createGroup.useMutation({
    onSuccess: async () => {
      toast.success("Group created");
      setCreateOpen(false);
      setForm({ name: "", kind: "custom" });
      await utils.sites.groups.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const setMembership = trpc.sites.setGroupMembership.useMutation({
    onSuccess: () => utils.sites.groups.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.sites.deleteGroup.useMutation({
    onSuccess: async () => {
      toast.success("Group deleted");
      await utils.sites.groups.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Tags className="h-4 w-4 text-primary" /> Site groups
        </CardTitle>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="bg-background">
              <Plus className="mr-1 h-3.5 w-3.5" /> New group
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="font-display">New site group</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Group name (e.g. Midwest region)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as typeof f.kind }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="region">Region</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="brand">Brand</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <Button className="w-full" disabled={!form.name.trim() || create.isPending} onClick={() => create.mutate({ name: form.name.trim(), kind: form.kind })}>
                {create.isPending ? "Creating…" : "Create group"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {groups.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (groups.data ?? []).length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No groups yet — group sites by region, manager, or brand to slice the portfolio.
          </p>
        ) : (
          <div className="space-y-4">
            {(groups.data ?? []).map((g) => (
              <div key={g.id} className="rounded-lg border border-border/70 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{g.name}</span>
                    <Badge variant="secondary" className="text-[10px]">{g.kind}</Badge>
                    <span className="text-xs text-muted-foreground">{g.siteIds.length} site{g.siteIds.length === 1 ? "" : "s"}</span>
                  </div>
                  <button
                    type="button"
                    className="text-muted-foreground transition-colors hover:text-destructive"
                    title="Delete group (sites are not deleted)"
                    onClick={() => {
                      if (window.confirm(`Delete group “${g.name}”? Sites in it are not affected.`)) del.mutate({ groupId: g.id });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {sites.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                    {sites.map((s) => (
                      <label key={s.siteId} className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={g.siteIds.includes(s.siteId)}
                          onCheckedChange={(v) => setMembership.mutate({ groupId: g.id, siteId: s.siteId, member: v === true })}
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type PortfolioRow = {
  siteId: number;
  name: string;
  state: string | null;
  buildingType: string | null;
  climateZone: string | null;
  utilityName?: string | null;
  sqft: number | null;
  /** Oct 24 property facts: public_record_estimate | as_entered | none */
  sqftBasis?: string | null;
  analyzed: boolean;
  annualCostUsd: number | null;
  euiKwhPerSqft: number | null;
  euiBasis: string | null;
  euiPlausibilityNote?: string | null;
  connectivityUsdPerSqft?: number | null;
  topOpportunityTitle: string | null;
  topOpportunityUsd: number | null;
  topOpportunityRange?: {low:number;high:number} | null;
  topOpportunityBasis?: string | null;
  hasAnomaly: boolean;
  anomalyTitle: string | null;
};

/** One exception-first row: name, biggest open $ opportunity, anomaly chip. */
function ExceptionRow({ r, expanded }: { r: PortfolioRow; expanded?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${r.hasAnomaly ? "border-amber-500/40 bg-amber-500/5" : "border-border/70"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href={`/app/explore?site=${r.siteId}`} className="font-medium text-primary hover:underline">
            {r.name}
          </Link>
          {r.hasAnomaly && (
            <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mr-1 h-3 w-3" /> anomaly
            </Badge>
          )}
          {!r.analyzed && (
            <Badge variant="secondary" className="text-[10px]">
              not analyzed yet
            </Badge>
          )}
        </div>
        {r.topOpportunityUsd != null && r.topOpportunityUsd > 0 && (
          <span className="font-display text-sm font-bold text-primary">{formatSavingsRangeUsd(r.topOpportunityRange)}/yr standalone</span>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {r.hasAnomaly && r.anomalyTitle && <p className="text-amber-600 dark:text-amber-400">{r.anomalyTitle}</p>}
          {r.topOpportunityTitle ? (
            <div>
              Biggest open opportunity: {r.topOpportunityTitle}
              {r.topOpportunityRange ? ` — ${formatSavingsRangeUsd(r.topOpportunityRange)}/yr standalone` : ""}
              {r.topOpportunityBasis && <details><summary className="cursor-pointer">Basis</summary>{r.topOpportunityBasis}</details>}
            </div>
          ) : r.analyzed ? (
            <p>No open opportunities — everything found so far is marked implemented or none were material.</p>
          ) : (
            <p>Run an analysis to surface opportunities for this site.</p>
          )}
        </div>
      )}
    </div>
  );
}

function CollapsedRows({ rows }: { rows: PortfolioRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        {open ? "Collapse" : `Show ${rows.length} more site${rows.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {rows.map((r) => (
            <ExceptionRow key={r.siteId} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

/** §3i-2 league table — kWh/sqft/yr, weather-normalized where a baseline exists.
    Sites missing sqft or usage are listed unranked with the reason, never as 0. */
function LeagueTable({ rows }: { rows: PortfolioRow[] }) {
  const rankable = rows.filter((r) => r.euiKwhPerSqft != null).sort((a, b) => (a.euiKwhPerSqft ?? 0) - (b.euiKwhPerSqft ?? 0));
  const unrankable = rows.filter((r) => r.euiKwhPerSqft == null);
  if (rows.length < 2) return null;
  const best = rankable[0]?.euiKwhPerSqft ?? null;
  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Trophy className="h-4 w-4 text-primary" /> Efficiency league table
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Ranked on energy per square foot per year (kWh/sqft/yr), weather-normalized where a baseline exists — raw kWh is never compared across
          climates or sizes.
        </p>
      </CardHeader>
      <CardContent>
        {rankable.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No sites are rankable yet — ranking needs square footage AND an annualizable usage figure per site.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">kWh/sqft/yr</TableHead>
                <TableHead className="text-right">Connectivity $/sqft/yr</TableHead>
                <TableHead className="text-right">vs best</TableHead>
                <TableHead>Basis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rankable.map((r, i) => (
                <TableRow key={r.siteId}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell>
                    <Link href={`/app/explore?site=${r.siteId}`} className="font-medium text-primary hover:underline">
                      {r.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.climateZone ? `zone ${r.climateZone}` : (r.state ?? "")}
                      {r.sqft ? ` · ${r.sqftBasis === "public_record_estimate" ? "≈" : ""}${fmtNum(r.sqft)} sqft` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium">{(r.euiKwhPerSqft ?? 0).toFixed(1)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {r.connectivityUsdPerSqft != null ? `$${r.connectivityUsdPerSqft.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {best != null && best > 0 ? `${((r.euiKwhPerSqft ?? 0) / best).toFixed(1)}×` : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[10px]">
                        {r.euiBasis ? `normalized — ${r.euiBasis}` : "raw annualized — no baseline"}
                      </Badge>
                      {r.sqftBasis === "public_record_estimate" && (
                        <Badge variant="outline" className="text-[10px]" title="Floor area estimated from public building footprints; replace it on the site's Explore page if you know the actual figure.">
                          floor area: public-record estimate
                        </Badge>
                      )}
                      {r.sqftBasis === "placeholder" && (
                        <Badge variant="outline" className="text-[10px]" title="A typical-size placeholder from quick start, not this building's floor area. Set it on the site's Explore page.">
                          floor area: placeholder
                        </Badge>
                      )}
                      {r.euiPlausibilityNote && (
                        <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-800 dark:text-amber-300" title={r.euiPlausibilityNote} data-testid="league-eui-check">
                          unusually low — check inputs
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rankable.some((r) => r.sqftBasis === "public_record_estimate") && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            ≈ marks floor area estimated automatically from public building footprints (one story assumed where heights are unpublished), so those
            rankings are screening-grade. Open a site to see how its estimate was calculated or to enter the actual figure.
          </p>
        )}
        {unrankable.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Not rankable ({unrankable.map((r) => r.name).join(", ")}) — missing square footage or an annualizable usage figure; shown nowhere rather
            than ranked on fabricated numbers. Each site's Explore page shows what public records found and lets you add the floor area in one step.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TotalCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <Card className="border-border/70">
      <CardContent className="pt-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          {icon} {label}
        </div>
        <div className="mt-1 font-display text-xl font-bold">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** §3i-2 utility-exposure rollup — how much annual spend sits with each
 * provider. Concentration is decision-relevant for rate-change risk: a
 * portfolio 80% exposed to one utility should watch that utility's filings.
 * Honesty rules: sites without an analyzed cost are counted by site, not
 * dollars; provider names come from each site's confirmed/derived utility
 * (never guessed at display time), and unknowns are shown as their own row. */
function UtilityExposure({ rows }: { rows: PortfolioRow[] }) {
  const byUtility = new Map<string, { spendUsd: number; siteCount: number; analyzedCount: number }>();
  for (const r of rows) {
    const key = r.utilityName ?? "Utility not set";
    const cur = byUtility.get(key) ?? { spendUsd: 0, siteCount: 0, analyzedCount: 0 };
    cur.siteCount += 1;
    if (r.annualCostUsd != null) {
      cur.spendUsd += r.annualCostUsd;
      cur.analyzedCount += 1;
    }
    byUtility.set(key, cur);
  }
  const entries = Array.from(byUtility.entries()).sort((a, b) => b[1].spendUsd - a[1].spendUsd);
  const totalSpend = entries.reduce((a, [, v]) => a + v.spendUsd, 0);
  if (rows.length === 0 || entries.length === 0) return null;
  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Zap className="h-4 w-4 text-primary" /> Utility exposure
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Where your annual spend is concentrated — a rate filing at your biggest provider moves more of your budget.
          Dollars reflect analyzed sites only; unanalyzed sites are counted but not priced.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map(([name, v]) => {
          const pct = totalSpend > 0 ? (v.spendUsd / totalSpend) * 100 : 0;
          return (
            <div key={name}>
              <div className="flex items-baseline justify-between text-sm">
                <span className={name === "Utility not set" ? "text-muted-foreground" : ""}>{name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {v.spendUsd > 0 ? `${fmtUsd(v.spendUsd)}/yr · ` : ""}
                  {v.siteCount} site{v.siteCount === 1 ? "" : "s"}
                  {v.analyzedCount < v.siteCount ? ` (${v.siteCount - v.analyzedCount} not analyzed)` : ""}
                </span>
              </div>
              {totalSpend > 0 && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 1 && entries[0][0] !== "Utility not set" && totalSpend > 0 && (
          <p className="pt-1 text-[11px] text-muted-foreground">
            All priced spend sits with one provider — their next rate filing affects your whole portfolio. The rate
            check on each site's Explore page re-prices you against every eligible plan we have on file.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** §3i-2 Bulk site screening (Pro) — paste one address per line (optionally
    "address, building_type"), get a ranked estimate screen. Every row is an
    archetype ESTIMATE priced on seeded rates; failures are named per row,
    never silently dropped. Server enforces the Pro gate and the 50-row cap. */
function BulkScreen() {
  const [text, setText] = useState("");
  const [defaultType, setDefaultType] = useState("office");
  const screen = trpc.entities.bulkScreen.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const res = screen.data;
  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Zap className="h-4 w-4 text-primary" /> Bulk site screening
          <Badge variant="outline" className="ml-1 text-[10px]">
            Pro
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Paste up to 50 addresses (one per line, optionally &ldquo;address, building_type&rdquo;) to rank where to look
          first. Archetype estimates on seeded rates — a screen, not a measurement.
        </p>
      </CardHeader>
      <CardContent>
        <textarea
          className="min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
          placeholder={"1200 W Main St, Mesa, AZ 85201\n455 N Central Ave, Phoenix, AZ, warehouse\n88 E Broadway Blvd, Tucson, AZ 85701, retail"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={defaultType} onValueChange={setDefaultType}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["office", "retail", "warehouse", "restaurant", "single_family", "multifamily", "school", "hotel"].map((t) => (
                <SelectItem key={t} value={t}>
                  default: {t.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => screen.mutate({ text, defaultBuildingType: defaultType })} disabled={text.trim().length < 3 || screen.isPending}>
            {screen.isPending ? "Screening…" : "Screen addresses"}
          </Button>
          {res && (
            <span className="text-[11px] text-muted-foreground">
              {res.estimated} estimated · {res.failed} failed{res.truncated ? " · list truncated to 50" : ""}
            </span>
          )}
        </div>
        {res && res.rows.length > 0 && (
          <>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Est. annual cost</TableHead>
                    <TableHead>Top opportunity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {res.rows.map((r, i) => (
                    <TableRow key={`${r.input}-${i}`} className={r.status === "failed" ? "opacity-60" : ""}>
                      <TableCell className="font-mono text-xs">{r.rank ?? "—"}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs" title={r.address}>
                        {r.address}
                      </TableCell>
                      <TableCell className="text-xs">{r.buildingType.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-right text-xs">
                        {r.status === "failed" ? (
                          <span className="text-destructive" title={r.error ?? undefined}>
                            {r.error ?? "failed"}
                          </span>
                        ) : (
                          fmtUsd(r.estimatedAnnualCostUsd ?? 0)
                        )}
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-xs" title={r.topOpportunity?.title}>
                        {r.topOpportunity ? (
                          <>
                            {r.topOpportunity.title}{" "}
                            <span className="text-muted-foreground">(~{fmtUsd(r.topOpportunity.estimatedSavingsUsd)}/yr)</span>
                          </>
                        ) : r.status === "estimated" ? (
                          <span className="text-muted-foreground">none priced</span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">{res.disclosure}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * §3i-2 portfolio basket (Pro): apply ONE measure across selected sites; each
 * site is composed independently through the same composer as Bill Builder,
 * then rolled up with weakest-chip confidence inheritance. Sites that cannot
 * compose are named with their reason — never silently dropped.
 */
function PortfolioBasket({ rows }: { rows: { siteId: number; name: string; analyzed: boolean }[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [measureKey, setMeasureKey] = useState<string>("led_retrofit");
  const compose = trpc.scenariosApi.portfolioCompose.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const MEASURES: Record<string, { label: string; kind: "efficiency" | "solar" | "battery"; efficiencyReductions?: Record<string, number>; solarKwDc?: number; batteryKwh?: number; batteryKw?: number; capexUsd?: number }> = {
    // Capex figures are typical-project placeholders (disclosed in the result);
    // reductions mirror the server scenario presets (DOE/ENERGY STAR typical ranges).
    led_retrofit: { label: "LED retrofit (~$8k typ. capex)", kind: "efficiency", efficiencyReductions: { lighting: 0.5 }, capexUsd: 8000 },
    hvac_tuneup: { label: "HVAC tune-up / controls (~$5k typ. capex)", kind: "efficiency", efficiencyReductions: { cooling: 0.15, heating: 0.1 }, capexUsd: 5000 },
    smart_thermostats: { label: "Smart thermostats / setpoints (~$1.2k typ. capex)", kind: "efficiency", efficiencyReductions: { cooling: 0.08, heating: 0.08 }, capexUsd: 1200 },
    solar_50kw: { label: "Solar 50 kW DC (~$110k typ. capex)", kind: "solar", solarKwDc: 50, capexUsd: 110000 },
    battery_100kwh: { label: "Battery 100 kWh / 50 kW (~$90k typ. capex)", kind: "battery", batteryKwh: 100, batteryKw: 50, capexUsd: 90000 },
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = () => {
    const m = MEASURES[measureKey];
    compose.mutate({
      siteIds: Array.from(selected),
      measure: { key: measureKey, label: m.label, kind: m.kind, efficiencyReductions: m.efficiencyReductions, solarKwDc: m.solarKwDc, batteryKwh: m.batteryKwh, batteryKw: m.batteryKw, capexUsd: m.capexUsd },
    });
  };

  const data = compose.data;
  const confBadge = (c?: "low" | "medium" | "high") =>
    c === "high" ? "Measured-grade" : c === "medium" ? "Good" : "Est.";

  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <FolderKanban className="h-4 w-4 text-primary" /> Portfolio basket
          <Badge variant="secondary" className="text-[10px]">Pro</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Apply one measure across selected sites — each site is composed independently on its own tariff and load
          shape, then rolled up. The rollup chip inherits the weakest site&apos;s confidence.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length < 2 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">Add at least two sites to use the portfolio basket.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={measureKey} onValueChange={setMeasureKey}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MEASURES).map(([k, m]) => (
                    <SelectItem key={k} value={k}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={selected.size < 2 || compose.isPending} onClick={run}>
                {compose.isPending ? "Composing…" : `Compose across ${selected.size} site${selected.size === 1 ? "" : "s"}`}
              </Button>
              {selected.size < 2 && <span className="text-xs text-muted-foreground">select at least 2 sites below</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {rows.map((r) => (
                <label
                  key={r.siteId}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-xs"
                >
                  <Checkbox checked={selected.has(r.siteId)} onCheckedChange={() => toggle(r.siteId)} />
                  {r.name}
                  {!r.analyzed && <span className="text-[10px] text-muted-foreground">(estimate basis)</span>}
                </label>
              ))}
            </div>
            {data && (
              <div className="space-y-2 rounded-md border border-border/70 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-display text-lg font-bold text-primary">{fmtUsd(data.rollup.annualSavingsUsd)}/yr</span>
                  <Badge variant="outline" className="text-[10px]">{confBadge(data.rollup.confidence)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {data.rollup.sitesComposed} composed{data.rollup.sitesFailed > 0 ? ` · ${data.rollup.sitesFailed} could not compose` : ""} ·{" "}
                    {fmtNum(Math.abs(data.rollup.co2eDeltaLb))} lb CO₂e/yr {data.rollup.co2eDeltaLb <= 0 ? "avoided" : "added"}
                  </span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Site</TableHead>
                      <TableHead className="text-right">Annual savings</TableHead>
                      <TableHead className="text-right">Confidence</TableHead>
                      <TableHead>Basis</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.perSite.map((r) => (
                      <TableRow key={r.siteId}>
                        <TableCell className="text-sm">{r.siteName}</TableCell>
                        {r.ok ? (
                          <>
                            <TableCell className="text-right text-sm">{fmtUsd(r.annualSavingsUsd ?? 0)}/yr</TableCell>
                            <TableCell className="text-right">
                              <Badge variant="outline" className="text-[10px]">{confBadge(r.confidence)}</Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {r.loadBasis === "archetype_scaled" ? "archetype load shape" : "measured intervals"}
                            </TableCell>
                          </>
                        ) : (
                          <TableCell colSpan={3} className="text-xs text-amber-600 dark:text-amber-400">
                            not composed — {r.reason}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-[11px] text-muted-foreground">{data.disclosure}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
