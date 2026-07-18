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
import { FolderKanban, Gauge, Leaf, Plus, Tags, Trash2, Wallet, Zap } from "lucide-react";
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
  const entityId = filter === "all" ? undefined : filter === "none" ? null : Number(filter);
  const portfolio = trpc.entities.portfolio.useQuery({ entityId });
  const entities = portfolio.data?.entities ?? [];
  const rows = portfolio.data?.sites ?? [];
  const totals = portfolio.data?.totals;

  return (
    <div className="container max-w-6xl py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Rollup across owners, sites, and meters — figures come from each site&apos;s latest analysis.
          </p>
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-60">
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
          {/* Totals row */}
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
              icon={<Zap className="h-4 w-4" />}
              label="Annual usage"
              value={totals?.annualUsageKwh != null ? `${fmtNum(totals.annualUsageKwh)} kWh` : "—"}
              sub="normalized where a baseline exists"
            />
            <TotalCard
              icon={<Gauge className="h-4 w-4" />}
              label="Sum of site peaks"
              value={totals?.sumOfSitePeaksKw != null ? `${fmtNum(totals.sumOfSitePeaksKw)} kW` : "—"}
              sub="non-coincident — overstates any true portfolio peak"
            />
            <TotalCard
              icon={<Leaf className="h-4 w-4" />}
              label="Emissions"
              value={totals?.annualCo2eLb != null ? `${fmtNum(totals.annualCo2eLb)} lb CO₂e/yr` : "—"}
              sub="eGRID annual averages"
            />
          </div>

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
