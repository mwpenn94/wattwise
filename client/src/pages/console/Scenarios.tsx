/**
 * What-if scenarios — solar / battery / efficiency / EV. Re-prices the full
 * year on the active tariff; results carry payback bands, confidence, and
 * disclosure text (handoff §7).
 */
import { useMemo, useState } from "react";
import { useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Battery, Lightbulb, MoreVertical, Pencil, PlugZap, Sun, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtUsd, fmtNum } from "@/lib/wattwiseUi";
import { ConfidenceBadge, DisclaimerBanner, ProvChip } from "@/components/Honesty";
import BillBuilder from "@/components/BillBuilder";
import type { ScenarioResults } from "@shared/wattwise";

const KINDS = [
  { kind: "solar", label: "Rooftop solar", icon: Sun, plus: true },
  { kind: "battery", label: "Battery storage", icon: Battery, plus: true },
  { kind: "solar_battery", label: "Solar + battery", icon: PlugZap, plus: true },
  { kind: "efficiency", label: "Efficiency retrofit", icon: Lightbulb, plus: false },
  { kind: "ev_load", label: "EV charging", icon: PlugZap, plus: false },
] as const;

/**
 * Deep-link vocabulary → scenario kind. Opportunity cards and Ask Meterly
 * link here as /app/scenarios?site=N&measure=X so the right measure arrives
 * preselected (§3k "add to plan" continuity — no re-picking what you clicked).
 */
export function measureToKind(measure: string): (typeof KINDS)[number]["kind"] | null {
  const m = measure.toLowerCase();
  if ((m.includes("solar") || m.includes("pv")) && m.includes("batter")) return "solar_battery";
  if (m.includes("batter") || m.includes("peak_shave") || m.includes("demand")) return "battery";
  if (m.includes("solar") || m.includes("pv")) return "solar";
  if (m.startsWith("ev") || m.includes("_ev") || m.includes("charg")) return "ev_load";
  if (m.includes("led") || m.includes("light") || m.includes("hvac") || m.includes("cool") || m.includes("heat") || m.includes("setpoint") || m.includes("efficien") || m.includes("insulat") || m.includes("retrofit") || m.includes("schedule")) return "efficiency";
  return null;
}

export default function Scenarios() {
  const sites = trpc.sites.list.useQuery();
  const search = useSearch();
  const deepLink = useMemo(() => {
    const p = new URLSearchParams(search);
    return { site: p.get("site"), measure: p.get("measure") };
  }, [search]);
  const [siteId, setSiteId] = useState<string>(deepLink.site ?? "");
  // A deep-linked ?site= may reference a site the viewer doesn't own (stale or
  // copied URL) — fall back to the first owned site instead of a blank selector.
  const requestedSiteId = siteId ? Number(siteId) : null;
  const activeSiteId =
    requestedSiteId != null && (sites.data == null || sites.data.some((s) => s.id === requestedSiteId))
      ? requestedSiteId
      : (sites.data?.[0]?.id ?? null);
  const scenarios = trpc.scenariosApi.list.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const utils = trpc.useUtils();

  const [kind, setKind] = useState<(typeof KINDS)[number]["kind"]>(() => (deepLink.measure ? measureToKind(deepLink.measure) ?? "efficiency" : "efficiency"));
  const [params, setParams] = useState({ solarKwDc: "10", batteryKwh: "20", batteryKw: "10", reduction: "15", evAnnualKwh: "3500", capexUsd: "" });

  const run = trpc.scenariosApi.run.useMutation({
    onSuccess: async () => {
      toast.success("Scenario complete");
      await utils.scenariosApi.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  function runScenario() {
    if (activeSiteId == null) {
      toast.error("Select a site");
      return;
    }
    run.mutate({
      siteId: activeSiteId,
      name: `${KINDS.find((k) => k.kind === kind)?.label} — ${new Date().toLocaleDateString()}`,
      kind,
      solarKwDc: ["solar", "solar_battery"].includes(kind) ? Number(params.solarKwDc) : undefined,
      batteryKwh: ["battery", "solar_battery"].includes(kind) ? Number(params.batteryKwh) : undefined,
      batteryKw: ["battery", "solar_battery"].includes(kind) ? Number(params.batteryKw) : undefined,
      efficiencyReductions: kind === "efficiency" ? { all: Number(params.reduction) / 100 } : undefined,
      evAnnualKwh: kind === "ev_load" ? Number(params.evAnnualKwh) : undefined,
      capexUsd: params.capexUsd ? Number(params.capexUsd) : undefined,
    });
  }

  return (
    <div className="container max-w-5xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Scenarios</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every scenario re-prices the full year against the site's tariff — never a flat ¢/kWh shortcut.
      </p>
      <div className="mt-4">
        <DisclaimerBanner />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit border-border/70">
          <CardHeader>
            <CardTitle className="font-display text-base">New scenario</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Site</Label>
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
            </div>
            <div>
              <Label>Measure</Label>
              <div className="mt-1 grid grid-cols-1 gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    onClick={() => setKind(k.kind)}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      kind === k.kind ? "border-primary bg-primary/10" : "border-border hover:border-primary/50"
                    }`}
                  >
                    <k.icon className="h-4 w-4 text-primary" />
                    <span className="flex-1">{k.label}</span>
                    {k.plus && (
                      <Badge variant="outline" className="text-[9px] font-mono uppercase">
                        plus
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {["solar", "solar_battery"].includes(kind) && (
              <div>
                <Label htmlFor="p-solar">System size (kW DC)</Label>
                <Input id="p-solar" className="mt-1" type="number" value={params.solarKwDc} onChange={(e) => setParams({ ...params, solarKwDc: e.target.value })} />
              </div>
            )}
            {["battery", "solar_battery"].includes(kind) && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="p-bkwh">Battery (kWh)</Label>
                  <Input id="p-bkwh" className="mt-1" type="number" value={params.batteryKwh} onChange={(e) => setParams({ ...params, batteryKwh: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="p-bkw">Power (kW)</Label>
                  <Input id="p-bkw" className="mt-1" type="number" value={params.batteryKw} onChange={(e) => setParams({ ...params, batteryKw: e.target.value })} />
                </div>
              </div>
            )}
            {kind === "efficiency" && (
              <div>
                <Label htmlFor="p-red">Usage reduction (%)</Label>
                <Input id="p-red" className="mt-1" type="number" min={1} max={90} value={params.reduction} onChange={(e) => setParams({ ...params, reduction: e.target.value })} />
              </div>
            )}
            {kind === "ev_load" && (
              <div>
                <Label htmlFor="p-ev">EV charging (kWh/yr)</Label>
                <Input id="p-ev" className="mt-1" type="number" value={params.evAnnualKwh} onChange={(e) => setParams({ ...params, evAnnualKwh: e.target.value })} />
              </div>
            )}
            <div>
              <Label htmlFor="p-capex">Capex ($, optional — enables payback)</Label>
              <Input id="p-capex" className="mt-1" type="number" value={params.capexUsd} onChange={(e) => setParams({ ...params, capexUsd: e.target.value })} placeholder="e.g. 25000" />
            </div>
            <Button className="w-full" disabled={run.isPending || activeSiteId == null} onClick={runScenario}>
              {run.isPending ? "Simulating…" : "Run scenario"}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Free tier: 3 runs/month, efficiency & EV only. Solar/battery modeling requires Plus — during the beta you
              can switch plans free on the{" "}
              <a href="/app/account" className="text-primary underline">
                Account page
              </a>
              .
            </p>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {activeSiteId != null && <BillBuilder siteId={activeSiteId} />}
          {scenarios.isLoading && <Skeleton className="h-40" />}
          {(scenarios.data ?? []).map((s) => {
            const r = s.results as unknown as ScenarioResults | null;
            return (
              <Card key={s.id} className="border-border/70">
                <CardHeader className="flex flex-row items-start justify-between pb-2">
                  <div>
                    <CardTitle className="font-display text-base">{s.name}</CardTitle>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <ProvChip>{s.loadBasis === "measured_intervals" ? "measured basis" : "archetype basis"}</ProvChip>
                      {s.extrapolated && <ProvChip>extrapolated</ProvChip>}
                      {r && <ConfidenceBadge level={r.confidence} label={r.confidenceLabel} />}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs text-muted-foreground">{new Date(s.createdAt).toLocaleDateString()}</span>
                    <ScenarioActions scenarioId={s.id} name={s.name} siteId={activeSiteId!} />
                  </div>
                </CardHeader>
                <CardContent>
                  {r ? (
                    <>
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <div>
                          <p className="font-mono text-[10px] uppercase text-muted-foreground">Δ annual cost</p>
                          <p className={`font-display text-lg font-bold ${r.siteTotalDeltaCost < 0 ? "text-emerald-500" : "text-destructive"}`}>
                            {r.siteTotalDeltaCost < 0 ? "−" : "+"}
                            {fmtUsd(Math.abs(r.siteTotalDeltaCost))}
                          </p>
                        </div>
                        <div>
                          <p className="font-mono text-[10px] uppercase text-muted-foreground">Δ CO₂e</p>
                          <p className="font-display text-lg font-bold">
                            {fmtNum(Math.abs(r.siteTotalDeltaCo2eLb))} lb {r.siteTotalDeltaCo2eLb < 0 ? "less" : "more"}
                          </p>
                        </div>
                        <div>
                          <p className="font-mono text-[10px] uppercase text-muted-foreground">Payback</p>
                          <p className="font-display text-lg font-bold">{r.paybackBand ?? "—"}</p>
                        </div>
                        <div>
                          <p className="font-mono text-[10px] uppercase text-muted-foreground">Basis cost → scenario</p>
                          <p className="font-mono text-sm">
                            {fmtUsd(r.baselineAnnualCost ?? null)} → {fmtUsd(r.scenarioAnnualCost ?? null)}
                          </p>
                        </div>
                      </div>
                      {r.disclosures.length > 0 && (
                        <ul className="mt-4 space-y-1 border-t border-border pt-3">
                          {r.disclosures.map((d, i) => (
                            <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                              • {d}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">No results stored.</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
          {!scenarios.isLoading && (scenarios.data ?? []).length === 0 && (
            <Card className="border-dashed">
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No scenarios yet — configure one on the left.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rename / delete controls per saved scenario. */
function ScenarioActions({ scenarioId, name, siteId }: { scenarioId: number; name: string; siteId: number }) {
  const utils = trpc.useUtils();
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState(name);
  const rename = trpc.scenariosApi.rename.useMutation({
    onSuccess: async () => {
      toast.success("Scenario renamed");
      setRenameOpen(false);
      await utils.scenariosApi.list.invalidate({ siteId });
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.scenariosApi.delete.useMutation({
    onSuccess: async () => {
      toast.success("Scenario deleted");
      await utils.scenariosApi.list.invalidate({ siteId });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Scenario actions">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setNewName(name);
              setRenameOpen(true);
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => {
              if (window.confirm(`Delete scenario “${name}”? This cannot be undone.`)) del.mutate({ scenarioId });
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Rename scenario</DialogTitle>
          </DialogHeader>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button disabled={!newName.trim() || rename.isPending} onClick={() => rename.mutate({ scenarioId, name: newName.trim() })}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
