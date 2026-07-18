/**
 * Progressive refinement chips (Jul 2026).
 * Shown on the dashboard only while a site still runs on quick-start
 * placeholders (attrSource === "quick_start_defaults"). Each chip names the
 * assumption in effect and exactly what refining it unlocks; supplying a value
 * calls sites.refine and re-runs the analysis. Entirely optional — dismissing
 * or ignoring the chips never blocks anything.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Building2, CalendarClock, FileUp, MapPin, Ruler, Sparkles } from "lucide-react";
import { Link } from "wouter";

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

interface Props {
  siteId: number;
  /** Current site row — used to show what the address cascade derived so each
   *  chip reads "derived: X — tap to change" instead of a bare label. */
  site?: {
    buildingType: string | null;
    sqft: number | null;
    vintage: number | null;
    climateZone: string | null;
    utilityName: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  /** Re-run analysis after a successful refine. */
  onRefined: () => void;
}

export default function RefineChips({ siteId, site, onRefined }: Props) {
  const utils = trpc.useUtils();
  const refine = trpc.sites.refine.useMutation();
  const confirmIdentity = trpc.sites.confirmIdentity.useMutation();
  const [sqft, setSqft] = useState("");
  const [vintage, setVintage] = useState("");
  const [loc, setLoc] = useState({ state: "", zip: "" });
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [identityAnswered, setIdentityAnswered] = useState(false);

  /* v2.11 identity-confirm moment: the profile is a QUESTION, never an
   * assertion — "Looks like a ~12,000 sqft office in Phoenix — right?" with
   * one-tap yes. A wrong guess phrased as a question costs nothing. Confirming
   * upgrades attrSource so the imputed/estimate chips resolve. */
  const identityPhrase = (() => {
    if (!site) return null;
    const parts: string[] = [];
    if (site.sqft) parts.push(`~${site.sqft.toLocaleString()} sqft`);
    if (site.buildingType) parts.push(site.buildingType.replace(/_/g, " "));
    const where = [site.state, site.zip].filter(Boolean).join(" ");
    if (parts.length === 0) return null;
    return `Looks like a ${parts.join(" ")}${where ? ` in ${where}` : ""}${site.vintage ? `, built around ${site.vintage}` : ""}`;
  })();

  async function tapYes() {
    try {
      await confirmIdentity.mutateAsync({ siteId });
      setIdentityAnswered(true);
      await Promise.all([utils.sites.list.invalidate(), utils.sites.get.invalidate({ siteId })]);
      toast.success("Profile confirmed — archetype match, operating-hours inference, and benchmark peers now run on a confirmed identity instead of a guess.");
      onRefined();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm");
    }
  }

  async function apply(patch: Record<string, unknown>, label: string) {
    try {
      const res = await refine.mutateAsync({ siteId, ...patch });
      await Promise.all([utils.sites.list.invalidate(), utils.sites.get.invalidate({ siteId })]);
      // v1.17 §5.0(c) recompute disclosure: the confirmation names exactly
      // which insights this attribute change recomputes — never a silent
      // number change ("pool confirmed → summer end-use split updated").
      const deps = (res as { recomputes?: Array<{ field: string; updates: string[] }> }).recomputes ?? [];
      const updates = Array.from(new Set(deps.flatMap((d) => d.updates)));
      toast.success(
        updates.length > 0
          ? `${label} saved — recomputing: ${updates.join(", ")}.`
          : `${label} saved — re-running analysis with your real value…`,
      );
      setOpenChip(null);
      onRefined();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  }

  const chipCls =
    "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-primary/10";

  return (
    <div className="mt-4 rounded-lg border border-dashed border-primary/40 bg-primary/[0.03] p-3">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          Quick-start placeholders in effect — add detail only if you want to
        </p>
      </div>
      {identityPhrase && !identityAnswered && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-background/60 px-3 py-2">
          <p className="text-sm">
            {identityPhrase} — <span className="font-semibold">right?</span>
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 px-3 text-xs" disabled={confirmIdentity.isPending} onClick={tapYes}>
              Yes, that's it
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={() => setOpenChip("type")}>
              Not quite — fix it
            </Button>
          </div>
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Everything derivable from your address was derived automatically
        {site?.climateZone ? ` — climate zone ${site.climateZone}` : ""}
        {site?.utilityName ? `, likely utility ${site.utilityName}` : ""}
        {site?.buildingType ? `, assumed ${site.buildingType.replace(/_/g, " ")}${site.sqft ? ` ~${site.sqft.toLocaleString()} sqft` : ""}` : ""}
        . Each value is a disclosed starting point, not a fact — tap any chip to override it, and it shows what the real
        value unlocks. Everything below is optional.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {/* building type */}
        <Popover open={openChip === "type"} onOpenChange={(o) => setOpenChip(o ? "type" : null)}>
          <PopoverTrigger asChild>
            <button type="button" className={chipCls} title="Unlocks: correct peer archetype load shape + EUI benchmark peer group">
              <Building2 className="h-3.5 w-3.5 text-primary" /> Building type
              <span className="text-muted-foreground">
                {site?.buildingType ? `derived: ${site.buildingType.replace(/_/g, " ")} — tap to change` : "→ real archetype & benchmark peers"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72" align="start">
            <Label className="text-xs">Building type</Label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
              Re-selects the peer archetype load shape and the EUI benchmark peer group.
            </p>
            <Select onValueChange={(v) => apply({ buildingType: v }, "Building type")}>
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
          </PopoverContent>
        </Popover>

        {/* square footage */}
        <Popover open={openChip === "sqft"} onOpenChange={(o) => setOpenChip(o ? "sqft" : null)}>
          <PopoverTrigger asChild>
            <button type="button" className={chipCls} title="Unlocks: correctly scaled baseline + meaningful EUI percentile">
              <Ruler className="h-3.5 w-3.5 text-primary" /> Floor area
              <span className="text-muted-foreground">
                {site?.sqft ? `prior: ~${site.sqft.toLocaleString()} sqft — tap to change` : "→ scaled baseline & real EUI"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64" align="start">
            <Label htmlFor="rc-sqft" className="text-xs">
              Square feet
            </Label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
              Scales the synthetic baseline and makes the benchmark percentile meaningful.
            </p>
            <div className="flex gap-2">
              <Input id="rc-sqft" type="number" placeholder="25000" value={sqft} onChange={(e) => setSqft(e.target.value)} />
              <Button size="sm" disabled={!(Number(sqft) > 0) || refine.isPending} onClick={() => apply({ sqft: Number(sqft) }, "Floor area")}>
                Save
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* vintage */}
        <Popover open={openChip === "vintage"} onOpenChange={(o) => setOpenChip(o ? "vintage" : null)}>
          <PopoverTrigger asChild>
            <button type="button" className={chipCls} title="Unlocks: correct archetype efficiency band">
              <CalendarClock className="h-3.5 w-3.5 text-primary" /> Year built
              <span className="text-muted-foreground">
                {site?.vintage ? `prior: ~${site.vintage} — tap to change` : "→ right efficiency band"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64" align="start">
            <Label htmlFor="rc-vintage" className="text-xs">
              Year built
            </Label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">Picks the correct archetype efficiency band.</p>
            <div className="flex gap-2">
              <Input id="rc-vintage" type="number" placeholder="1998" value={vintage} onChange={(e) => setVintage(e.target.value)} />
              <Button
                size="sm"
                disabled={!(Number(vintage) >= 1850 && Number(vintage) <= 2030) || refine.isPending}
                onClick={() => apply({ vintage: Number(vintage) }, "Year built")}
              >
                Save
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* location */}
        <Popover open={openChip === "loc"} onOpenChange={(o) => setOpenChip(o ? "loc" : null)}>
          <PopoverTrigger asChild>
            <button type="button" className={chipCls} title="Unlocks: climate zone, timezone, tariff sweep, eGRID subregion">
              <MapPin className="h-3.5 w-3.5 text-primary" /> State / ZIP
              <span className="text-muted-foreground">
                {site?.state || site?.zip
                  ? `derived: ${[site?.state, site?.zip].filter(Boolean).join(" ")}${site?.climateZone ? ` (zone ${site.climateZone})` : ""} — tap to change`
                  : "→ climate, tariffs & emissions"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64" align="start">
            <Label className="text-xs">Location</Label>
            <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
              Selects your climate zone, timezone, swept tariffs, and eGRID emissions subregion.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="AZ"
                className="w-16"
                maxLength={2}
                value={loc.state}
                onChange={(e) => setLoc({ ...loc, state: e.target.value.toUpperCase() })}
              />
              <Input placeholder="85004" value={loc.zip} onChange={(e) => setLoc({ ...loc, zip: e.target.value })} />
              <Button
                size="sm"
                disabled={(!loc.state && !loc.zip) || refine.isPending}
                onClick={() => apply({ ...(loc.state ? { state: loc.state } : {}), ...(loc.zip ? { zip: loc.zip } : {}) }, "Location")}
              >
                Save
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* interval data — biggest unlock, link out */}
        <Link href="/app/upload" className={chipCls} title="Unlocks: measured demand analytics, real tariff re-pricing, anomaly detection">
          <FileUp className="h-3.5 w-3.5 text-primary" /> Interval file
          <span className="text-muted-foreground">→ replaces every synthetic figure</span>
        </Link>
      </div>
    </div>
  );
}
