/**
 * Tariff library — nationwide seeded representative rates (URDB-style
 * snapshot, all 50 states + DC) with honest freshness + eligibility
 * disclosure, per-tariff TOU/demand structure detail (Gap-4), and
 * assignment to site meters.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Receipt } from "lucide-react";
import { ProvChip } from "@/components/Honesty";

export default function Tariffs() {
  const sites = trpc.sites.list.useQuery();
  const [siteId, setSiteId] = useState<string>("");
  const activeSiteId = siteId ? Number(siteId) : (sites.data?.[0]?.id ?? null);
  // Default the library to the active site's state so users see their own
  // utility's rates first; "all" shows the whole nationwide snapshot.
  const [stateFilter, setStateFilter] = useState<string>("");
  const [commodity, setCommodity] = useState<"electric" | "gas" | "water">("electric");
  const activeSiteState = (sites.data ?? []).find((s) => s.id === activeSiteId)?.state ?? undefined;
  const effectiveState = stateFilter === "all" ? undefined : stateFilter || activeSiteState;
  const tariffs = trpc.tariffs.list.useQuery({ state: effectiveState, commodity });
  const meters = trpc.sites.meters.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const utils = trpc.useUtils();
  const assign = trpc.sites.setMeterTariff.useMutation({
    onSuccess: async () => {
      toast.success("Tariff assigned to meter");
      await utils.sites.meters.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const eligibilityNote = tariffs.data?.[0]?.eligibilityNote;

  return (
    <div className="container max-w-5xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Tariff library</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Nationwide representative rates (all 50 states + DC) from a URDB-style snapshot — electric, natural gas, and
        water structures per state. Assign a rate to a meter, then re-run analysis for an exact-rules bill
        simulation. Expand any row to see its TOU windows, demand charges, ratchet, and coincident-peak terms.
      </p>
      <div className="mt-4 flex gap-1 rounded-lg border border-border/70 bg-muted/30 p-1 w-fit">
        {(["electric", "gas", "water"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCommodity(c)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              commodity === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {c === "electric" ? "Electric" : c === "gas" ? "Natural gas" : "Water"}
          </button>
        ))}
      </div>
      {eligibilityNote && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
          {eligibilityNote}
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-[240px_1fr]">
        <div>
          <label className="text-sm font-medium">Assign to site</label>
          <Select value={activeSiteId != null ? String(activeSiteId) : ""} onValueChange={setSiteId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select site…" />
            </SelectTrigger>
            <SelectContent>
              {(sites.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(meters.data ?? []).length === 0 && activeSiteId != null && (
            <p className="mt-2 text-xs text-muted-foreground">No meters on this site yet — upload interval data first.</p>
          )}
        </div>
        <div className="sm:max-w-60">
          <label className="text-sm font-medium">State filter</label>
          <Select value={stateFilter || (activeSiteState ?? "all")} onValueChange={setStateFilter}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              {US_STATES.map((st) => (
                <SelectItem key={st} value={st}>
                  {st}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">Defaults to the selected site&apos;s state.</p>
        </div>
      </div>

      <Card className="mt-6 border-border/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Receipt className="h-4 w-4 text-primary" /> Available rates
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tariffs.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-xs">Utility</TableHead>
                  <TableHead className="font-mono text-xs">Rate</TableHead>
                  <TableHead className="font-mono text-xs">Sector</TableHead>
                  <TableHead className="font-mono text-xs">Features</TableHead>
                  <TableHead className="font-mono text-xs">Freshness</TableHead>
                  <TableHead className="font-mono text-xs">Assign</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tariffs.data ?? []).map((t) => (
                  <TariffRowGroup
                    key={t.id}
                    t={t}
                    rateUnit={commodity === "electric" ? "kWh" : commodity === "gas" ? "therm" : "gal"}
                    meters={(meters.data ?? []).filter((m) => (m as { commodity?: string }).commodity === commodity || (m as { commodity?: string }).commodity == null)}
                    onAssign={(mid) => assign.mutate({ meterId: mid, tariffId: t.id })}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {!tariffs.isLoading && (tariffs.data ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No seeded {commodity === "gas" ? "natural gas" : commodity} rates for this state filter — the snapshot's gas and water coverage is thinner than electric; assign rates manually or broaden the state filter.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","IA","ID","IL","IN","KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY",
];

type TariffListRow = {
  id: number;
  utilityName: string;
  name: string;
  sector: string;
  freshness: string;
  hasRatchet: boolean;
  hasCp: boolean;
  peakKwMin: number | null;
  peakKwMax: number | null;
};
type MeterRow = { id: number; label: string | null; currentTariffId: number | null };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtMonths(months: number[]): string {
  if (!months || months.length === 0 || months.length === 12) return "all year";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months.map((m) => names[m - 1]).join(", ");
}
function fmtDays(days?: number[]): string {
  if (!days || days.length === 0 || days.length === 7) return "all days";
  return days.map((d) => DOW[d]).join(", ");
}
function fmtHours(hs?: number, he?: number): string {
  if (hs == null || he == null) return "anytime";
  const f = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
  return `${f(hs)}–${f(he)}`;
}

/** Gap-4: expandable tariff row — fetches full structure on expand and renders
 *  TOU windows, demand charges, ratchet, CP, and export terms explicitly. */
function TariffRowGroup({ t, meters, onAssign, rateUnit }: { t: TariffListRow; meters: MeterRow[]; onAssign: (meterId: number) => void; rateUnit: string }) {
  const [openDetail, setOpenDetail] = useState(false);
  const detail = trpc.tariffs.detail.useQuery({ tariffId: t.id }, { enabled: openDetail });
  const s = (detail.data?.structure ?? null) as {
    fixedMonthly?: number;
    energy?: Array<{ label: string; months: number[]; daysOfWeek: number[]; hourStart: number; hourEnd: number; ratePerUnit: number }>;
    demand?: Array<{ label: string; months: number[]; hourStart?: number; hourEnd?: number; daysOfWeek?: number[]; ratePerKw: number; demandGroup?: string }>;
    ratchet?: { lookbackMonths: number; ratchetPct: number; applicablePeriod: string };
    cp?: { topN: number; peakSeasonMonths: number[]; ratePerKw: number };
    exportRate?: { type: string; ratePerKwh: number; notes?: string };
    minBill?: number;
  } | null;
  return (
    <>
      <TableRow>
        <TableCell className="text-sm">{t.utilityName}</TableCell>
        <TableCell className="max-w-64 text-sm">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-left hover:text-primary"
            onClick={() => setOpenDetail((v) => !v)}
            title="Show rate structure"
          >
            {t.name}
            {openDetail ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          </button>
        </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {t.sector}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {t.hasRatchet && <ProvChip>ratchet</ProvChip>}
                        {t.hasCp && <ProvChip>CP charge</ProvChip>}
                        {t.peakKwMin != null && <ProvChip>≥{t.peakKwMin} kW</ProvChip>}
                        {t.peakKwMax != null && <ProvChip>≤{t.peakKwMax} kW</ProvChip>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-[10px] text-muted-foreground">{t.freshness}</span>
                    </TableCell>
        <TableCell>
          {meters.length > 0 ? (
            <Select onValueChange={(mid) => onAssign(Number(mid))}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder="Pick meter…" />
              </SelectTrigger>
              <SelectContent>
                {meters.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.label} {m.currentTariffId === t.id ? "✓" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button size="sm" variant="ghost" disabled>
              No meters
            </Button>
          )}
        </TableCell>
      </TableRow>
      {openDetail && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30">
            {detail.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : s ? (
              <div className="grid gap-4 py-2 text-xs lg:grid-cols-2">
                <div>
                  <p className="font-mono text-[10px] uppercase text-muted-foreground">Energy periods (TOU)</p>
                  <ul className="mt-1 space-y-1">
                    {(s.energy ?? []).map((p, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2 font-mono">
                        <span>
                          {p.label} · {fmtMonths(p.months)} · {fmtDays(p.daysOfWeek)} · {fmtHours(p.hourStart, p.hourEnd)}
                        </span>
                        <span className="text-foreground">${p.ratePerUnit.toFixed(4)}/{rateUnit}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    fixed ${s.fixedMonthly?.toFixed(2) ?? "0.00"}/mo{s.minBill != null ? ` · min bill $${s.minBill.toFixed(2)}/mo` : ""}
                  </p>
                </div>
                <div className="space-y-2">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">Demand charges</p>
                    {(s.demand ?? []).length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {(s.demand ?? []).map((d, i) => (
                          <li key={i} className="flex flex-wrap justify-between gap-2 font-mono">
                            <span>
                              {d.label} · {fmtMonths(d.months)} · {fmtHours(d.hourStart, d.hourEnd)}
                              {d.demandGroup ? ` · group ${d.demandGroup} (billed once)` : ""}
                            </span>
                            <span className="text-foreground">${d.ratePerKw.toFixed(2)}/kW</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 font-mono text-muted-foreground">none — energy-only rate</p>
                    )}
                  </div>
                  {s.ratchet && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      ratchet: billed demand ≥ {(s.ratchet.ratchetPct * 100).toFixed(0)}% of the {s.ratchet.applicablePeriod} peak over the past{" "}
                      {s.ratchet.lookbackMonths} months
                    </p>
                  )}
                  {s.cp && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      coincident-peak: avg of top {s.cp.topN} system-peak intervals ({fmtMonths(s.cp.peakSeasonMonths)}) × ${s.cp.ratePerKw.toFixed(2)}/kW-mo
                    </p>
                  )}
                  {s.exportRate && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      export: {s.exportRate.type.replace(/_/g, " ")} at ${s.exportRate.ratePerKwh.toFixed(4)}/kWh
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="py-2 text-muted-foreground">Structure unavailable.</p>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
