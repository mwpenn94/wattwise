import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Building2, Plus, Zap } from "lucide-react";
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

export default function Sites() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const sites = trpc.sites.list.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", city: "", state: "AZ", zip: "", buildingType: "", sqft: "", vintage: "", utilityName: "" });

  const create = trpc.sites.create.useMutation({
    onSuccess: async () => {
      toast.success("Site created");
      setOpen(false);
      setForm({ name: "", city: "", state: "AZ", zip: "", buildingType: "", sqft: "", vintage: "", utilityName: "" });
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="container max-w-5xl py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">Buildings under analysis — real or hypothetical.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Add site
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">New site</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="s-name">Name *</Label>
                <Input id="s-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main office" />
              </div>
              <div>
                <Label htmlFor="s-city">City</Label>
                <Input id="s-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Phoenix" />
              </div>
              <div>
                <Label htmlFor="s-state">State</Label>
                <Input id="s-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase().slice(0, 2) })} placeholder="AZ" />
              </div>
              <div>
                <Label htmlFor="s-zip">ZIP</Label>
                <Input id="s-zip" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} placeholder="85004" />
              </div>
              <div>
                <Label>Building type</Label>
                <Select value={form.buildingType} onValueChange={(v) => setForm({ ...form, buildingType: v })}>
                  <SelectTrigger>
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
              <div>
                <Label htmlFor="s-sqft">Square feet</Label>
                <Input id="s-sqft" type="number" value={form.sqft} onChange={(e) => setForm({ ...form, sqft: e.target.value })} placeholder="25000" />
              </div>
              <div>
                <Label htmlFor="s-vintage">Year built</Label>
                <Input id="s-vintage" type="number" value={form.vintage} onChange={(e) => setForm({ ...form, vintage: e.target.value })} placeholder="1998" />
              </div>
              <div className="col-span-2">
                <Label htmlFor="s-util">Utility</Label>
                <Input id="s-util" value={form.utilityName} onChange={(e) => setForm({ ...form, utilityName: e.target.value })} placeholder="APS / SRP / TEP…" />
              </div>
            </div>
            <Button
              className="mt-2 w-full"
              disabled={!form.name || create.isPending}
              onClick={() =>
                create.mutate({
                  name: form.name,
                  city: form.city || undefined,
                  state: form.state || undefined,
                  zip: form.zip || undefined,
                  buildingType: form.buildingType || undefined,
                  sqft: form.sqft ? Number(form.sqft) : undefined,
                  vintage: form.vintage ? Number(form.vintage) : undefined,
                  utilityName: form.utilityName || undefined,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create site"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {sites.isLoading && (
          <>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </>
        )}
        {(sites.data ?? []).map((s) => (
          <Card key={s.id} className="cursor-pointer border-border/70 transition-transform hover:-translate-y-0.5" onClick={() => navigate(`/app?site=${s.id}`)}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <Building2 className="h-4 w-4 text-primary" /> {s.name}
              </CardTitle>
              {s.isHypothetical ? <ProvChip>hypothetical</ProvChip> : <ProvChip>actual</ProvChip>}
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {s.city && <span>{s.city}, {s.state}</span>}
                {s.buildingType && <Badge variant="secondary" className="text-[10px]">{s.buildingType.replace(/_/g, " ")}</Badge>}
                {s.sqft && <span>{s.sqft.toLocaleString()} sqft</span>}
                {s.climateZone && <span>CZ {s.climateZone}</span>}
              </div>
              <SiteMeters siteId={s.id} />
            </CardContent>
          </Card>
        ))}
        {!sites.isLoading && (sites.data ?? []).length === 0 && (
          <Card className="col-span-full border-dashed">
            <CardContent className="flex flex-col items-center py-10 text-center">
              <Building2 className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">No sites yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Add a site then upload interval data, or model a fully hypothetical building from the wizard.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function SiteMeters({ siteId }: { siteId: number }) {
  const meters = trpc.sites.meters.useQuery({ siteId });
  if (!meters.data || meters.data.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {meters.data.map((m) => (
        <span key={m.id} className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3 text-primary" /> {m.label} · {m.commodity}
        </span>
      ))}
    </div>
  );
}
