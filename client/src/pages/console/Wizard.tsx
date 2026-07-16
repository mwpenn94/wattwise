/**
 * Manual intake / fully hypothetical building wizard.
 * Multi-step guided form; generates an archetype_synthetic baseline through
 * the identical analytics pipeline used for measured data (handoff §3).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Sparkles } from "lucide-react";
import { useLocation } from "wouter";
import { ProvChip } from "@/components/Honesty";

const BUILDING_TYPES = [
  ["single_family", "Single-family home"],
  ["multifamily", "Multifamily"],
  ["office", "Office"],
  ["retail", "Retail"],
  ["warehouse", "Warehouse"],
  ["school", "K-12 school"],
  ["grocery", "Grocery"],
  ["restaurant", "Restaurant"],
  ["hotel", "Hotel"],
  ["hospital", "Hospital"],
  ["manufacturing", "Manufacturing"],
] as const;

const CLIMATE_ZONES = ["1A", "2A", "2B", "3A", "3B", "3C", "4A", "4B", "4C", "5A", "5B", "6A", "6B", "7"] as const;
const UTILITIES = ["APS", "SRP", "TEP", "Other"] as const;

type Step = 0 | 1 | 2 | 3;

export default function Wizard() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState({
    name: "",
    buildingType: "",
    sqft: "",
    vintage: "",
    climateZone: "2B",
    state: "AZ",
    zip: "",
    utilityName: "APS",
    occupancyStart: "8",
    occupancyEnd: "18",
    occupancyDays: "weekdays",
  });
  const [done, setDone] = useState<{ siteId: number } | null>(null);

  const create = trpc.sites.create.useMutation();
  const analyze = trpc.analysis.run.useMutation();

  const canNext =
    step === 0
      ? form.name.length > 0 && !!form.buildingType
      : step === 1
        ? Number(form.sqft) > 0 && Number(form.vintage) >= 1850
        : true;

  async function finish() {
    try {
      const site = await create.mutateAsync({
        name: form.name,
        buildingType: form.buildingType,
        sqft: Number(form.sqft),
        vintage: Number(form.vintage),
        climateZone: form.climateZone,
        state: form.state,
        zip: form.zip || undefined,
        utilityName: form.utilityName === "Other" ? undefined : form.utilityName,
        isHypothetical: true,
        occupancyHours: {
          start: Number(form.occupancyStart),
          end: Number(form.occupancyEnd),
          days: form.occupancyDays,
        },
      });
      toast.success("Hypothetical site created — running archetype analysis…");
      await utils.sites.list.invalidate();
      await analyze.mutateAsync({ siteId: site.id });
      setDone({ siteId: site.id });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  if (done) {
    return (
      <div className="container max-w-2xl py-16 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
        <h1 className="mt-4 font-display text-2xl font-bold">Archetype analysis complete</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Your hypothetical building was synthesized from peer-archetype load shapes and pushed through the same analytics
          pipeline as measured data. Every output is labeled <ProvChip>archetype_synthetic</ProvChip> so it can never be
          mistaken for measurement.
        </p>
        <Button className="mt-6" onClick={() => navigate(`/app?site=${done.siteId}`)}>
          View dashboard <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl py-8">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="font-display text-2xl font-bold tracking-tight">Hypothetical building</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        No meter data needed — model a building from type, size, vintage, and climate. Results are honestly labeled as
        archetype-based estimates.
      </p>

      <Progress value={((step + 1) / 4) * 100} className="mt-6 h-1.5" />
      <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        step {step + 1} / 4 — {["identity", "size & vintage", "location & utility", "occupancy"][step]}
      </p>

      <Card className="mt-4 border-border/70">
        <CardContent className="space-y-4 pt-6">
          {step === 0 && (
            <>
              <div>
                <Label htmlFor="w-name">What should we call this building? *</Label>
                <Input id="w-name" className="mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Prospective retail site" />
              </div>
              <div>
                <Label>Building type *</Label>
                <Select value={form.buildingType} onValueChange={(v) => setForm({ ...form, buildingType: v })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILDING_TYPES.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <Label htmlFor="w-sqft">Conditioned floor area (sqft) *</Label>
                <Input id="w-sqft" className="mt-1" type="number" value={form.sqft} onChange={(e) => setForm({ ...form, sqft: e.target.value })} placeholder="25000" />
              </div>
              <div>
                <Label htmlFor="w-vintage">Year built (or expected) *</Label>
                <Input id="w-vintage" className="mt-1" type="number" value={form.vintage} onChange={(e) => setForm({ ...form, vintage: e.target.value })} placeholder="2005" />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="w-state">State</Label>
                  <Input id="w-state" className="mt-1" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase().slice(0, 2) })} />
                </div>
                <div>
                  <Label htmlFor="w-zip">ZIP (optional)</Label>
                  <Input id="w-zip" className="mt-1" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} placeholder="85004" />
                </div>
              </div>
              <div>
                <Label>ASHRAE climate zone</Label>
                <Select value={form.climateZone} onValueChange={(v) => setForm({ ...form, climateZone: v })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLIMATE_ZONES.map((z) => (
                      <SelectItem key={z} value={z}>
                        {z}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Phoenix = 2B, Tucson = 2B, Flagstaff = 5B.</p>
              </div>
              <div>
                <Label>Utility</Label>
                <Select value={form.utilityName} onValueChange={(v) => setForm({ ...form, utilityName: v })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UTILITIES.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="w-os">Occupied from (hour)</Label>
                  <Input id="w-os" className="mt-1" type="number" min={0} max={23} value={form.occupancyStart} onChange={(e) => setForm({ ...form, occupancyStart: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="w-oe">Occupied to (hour)</Label>
                  <Input id="w-oe" className="mt-1" type="number" min={0} max={23} value={form.occupancyEnd} onChange={(e) => setForm({ ...form, occupancyEnd: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Occupied days</Label>
                <Select value={form.occupancyDays} onValueChange={(v) => setForm({ ...form, occupancyDays: v })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekdays">Weekdays</SelectItem>
                    <SelectItem value="all_week">Every day</SelectItem>
                    <SelectItem value="weekends">Weekends only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                <Building2 className="mb-1 h-4 w-4 text-primary" />
                On finish we synthesize an hourly load profile from peer-archetype shapes for a {form.sqft || "—"} sqft{" "}
                {form.buildingType.replace(/_/g, " ") || "building"} in climate zone {form.climateZone}, then run the full
                analysis pipeline (baseline, rate check, benchmark, emissions). Outputs carry the{" "}
                <span className="font-mono">archetype_synthetic</span> provenance label.
              </div>
            </>
          )}

          <div className="flex justify-between pt-2">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => (s - 1) as Step)}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            {step < 3 ? (
              <Button disabled={!canNext} onClick={() => setStep((s) => (s + 1) as Step)}>
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button disabled={create.isPending || analyze.isPending} onClick={finish}>
                {create.isPending || analyze.isPending ? "Synthesizing…" : "Create & analyze"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
