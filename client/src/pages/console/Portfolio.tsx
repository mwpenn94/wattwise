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
import { FolderKanban, Gauge, Leaf, Wallet, Zap } from "lucide-react";
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
        </>
      )}
    </div>
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
