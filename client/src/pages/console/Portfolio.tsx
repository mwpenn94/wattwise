/**
 * Portfolio rollup (Gap-9, Jul 2026) — entity → sites → meters view.
 * Combines each site's latest persisted analysis summary into per-owner and
 * account-wide totals. Honesty rules: never-analyzed sites show "not analyzed"
 * (null KPIs), not fabricated zeros; the peak column is explicitly labeled as
 * a NON-coincident sum of individual site peaks.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, BadgeCheck, ChevronDown, FolderKanban, Gauge, Leaf, Plus, Tags, Trash2, Trophy, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { fmtNum, fmtUsd } from "@/lib/wattwiseUi";
import { DisclaimerBanner } from "@/components/Honesty";
import { Link } from "wouter";

export default function Portfolio() {
  // "all" = every site; "none" = ungrouped sites only; numeric = that entity
  const [filter, setFilter] = useState<string>("all");
  // §3i-2: additional group-by slice using site_groups tags ("g:<id>")
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const entityId = filter === "all" ? undefined : filter === "none" ? null : Number(filter);
  const portfolio = trpc.entities.portfolio.useQuery({ entityId });
  const groupsQ = trpc.sites.groups.useQuery();
  const entities = portfolio.data?.entities ?? [];
  const allRows = portfolio.data?.sites ?? [];
  const activeGroup = groupFilter === "all" ? null : (groupsQ.data ?? []).find((g) => String(g.id) === groupFilter) ?? null;
  const rows = activeGroup ? allRows.filter((r) => activeGroup.siteIds.includes(r.siteId)) : allRows;
  const totals = portfolio.data?.totals;

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
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-52">
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
              <SelectTrigger className="w-44">
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
              label="Annual cost (modeled)"
              value={totals?.annualCostUsd != null ? fmtUsd(totals.annualCostUsd) : "—"}
              sub={
                totals
                  ? `${totals.analyzedCount}/${totals.siteCount} sites analyzed${totals.demandCostUsd != null ? ` · ${fmtUsd(totals.demandCostUsd)} demand/CP` : ""}`
                  : ""
              }
            />
            <TotalCard
              icon={<BadgeCheck className="h-4 w-4" />}
              label="Verified savings"
              value={totals?.verifiedSavingsUsd != null && totals.verifiedSavingsUsd > 0 ? fmtUsd(totals.verifiedSavingsUsd) : "$0"}
              sub={totals?.verifiedSavingsUsd ? "measured vs weather-adjusted baseline" : "mark measures “I did this” to start verifying"}
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

          {/* §3i-2 league table: weather- and size-normalized — never raw kWh across climates */}
          <LeagueTable rows={rows} />

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
                  <Link href="/app/sites" className="text-primary underline">
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
                      <TableHead className="text-right">Annual cost</TableHead>
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
                            <>
                              <TableCell className="text-right">{r.annualCostUsd != null ? fmtUsd(r.annualCostUsd) : "—"}</TableCell>
                              <TableCell className="text-right">{r.demandCostUsd != null ? fmtUsd(r.demandCostUsd) : "—"}</TableCell>
                              <TableCell className="text-right">{r.peakKw != null ? fmtNum(r.peakKw) : "—"}</TableCell>
                              <TableCell className="text-right">{r.loadFactor != null ? `${(r.loadFactor * 100).toFixed(0)}%` : "—"}</TableCell>
                              <TableCell className="text-right">{r.annualUsageKwh != null ? fmtNum(r.annualUsageKwh) : "—"}</TableCell>
                            </>
                          ) : (
                            <TableCell colSpan={5} className="text-right">
                              <Badge variant="secondary" className="text-[10px]">
                                not analyzed yet
                              </Badge>
                            </TableCell>
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
  sqft: number | null;
  analyzed: boolean;
  annualCostUsd: number | null;
  euiKwhPerSqft: number | null;
  euiBasis: string | null;
  topOpportunityTitle: string | null;
  topOpportunityUsd: number | null;
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
          <span className="font-display text-sm font-bold text-primary">{fmtUsd(r.topOpportunityUsd)}/yr open</span>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {r.hasAnomaly && r.anomalyTitle && <p className="text-amber-600 dark:text-amber-400">{r.anomalyTitle}</p>}
          {r.topOpportunityTitle ? (
            <p>
              Biggest open opportunity: {r.topOpportunityTitle}
              {r.topOpportunityUsd != null ? ` — est. ${fmtUsd(r.topOpportunityUsd)}/yr` : ""}
            </p>
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
                      {r.sqft ? ` · ${fmtNum(r.sqft)} sqft` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium">{(r.euiKwhPerSqft ?? 0).toFixed(1)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {best != null && best > 0 ? `${((r.euiKwhPerSqft ?? 0) / best).toFixed(1)}×` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {r.euiBasis ? `normalized — ${r.euiBasis}` : "raw annualized — no baseline"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {unrankable.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Not rankable ({unrankable.map((r) => r.name).join(", ")}) — missing square footage or an annualizable usage figure; shown nowhere rather
            than ranked on fabricated numbers.
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
