/**
 * Property facts (Oct 24 2026) — replaces the rejected outbound-link
 * "Property records" card. Everything the app can learn about this address
 * from free, public sources is fetched automatically and shown here in plain
 * language. Every figure names its source; the floor-area estimate states how
 * it was calculated. Users never have to visit another website.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertTriangle, Building2, CheckCircle2, ChevronDown, Landmark, Loader2, Pencil, RefreshCw } from "lucide-react";

type Props = {
  siteId: number;
  canEdit: boolean;
  /** re-run analysis after floor area changes (EUI, benchmark, league) */
  onFloorAreaChanged: () => void;
  /** pipeline plausibility guard: EUI on this floor area is implausibly low */
  plausibilityNote?: string | null;
};

const SOURCE_SHORT: Record<string, string> = {
  mohave_assessor_gis: "Mohave County Assessor",
  fema_usa_structures: "FEMA USA Structures",
};

function SourceChip({ sourceId, kind }: { sourceId: string; kind: "record" | "estimate" }) {
  return (
    <span className="prov-chip whitespace-nowrap" title={kind === "estimate" ? "Calculated from public records" : "Published public record"}>
      {SOURCE_SHORT[sourceId] ?? sourceId}
    </span>
  );
}

export default function PropertyFactsCard({ siteId, canEdit, onFloorAreaChanged, plausibilityNote }: Props) {
  const utils = trpc.useUtils();
  const facts = trpc.sites.propertyFacts.useQuery({ siteId }, { staleTime: 5 * 60 * 1000, retry: 1 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const invalidateSite = async () => {
    await Promise.all([
      utils.sites.propertyFacts.invalidate({ siteId }),
      utils.sites.list.invalidate(),
      utils.sites.get.invalidate({ siteId }),
    ]);
  };
  const apply = trpc.sites.applyPropertyEstimate.useMutation({
    onSuccess: async (r) => {
      await invalidateSite();
      toast.success(`Floor area set to ${Math.round(r.sqft ?? 0).toLocaleString()} sqft`, {
        description: "Labeled as a public-record estimate. Re-running analysis so the benchmark and per-sqft figures use it.",
      });
      onFloorAreaChanged();
    },
    onError: (e) => toast.error(e.message),
  });
  const refine = trpc.sites.refine.useMutation({
    onSuccess: async () => {
      await invalidateSite();
      setEditing(false);
      toast.success("Floor area saved", { description: "Your value is used from now on. Re-running analysis." });
      onFloorAreaChanged();
    },
    onError: (e) => toast.error(e.message),
  });
  const refresh = trpc.sites.refreshPropertyFacts.useMutation({
    onSuccess: async () => {
      await utils.sites.propertyFacts.invalidate({ siteId });
    },
    onError: (e) => toast.error(e.message),
  });

  if (facts.isLoading) {
    return (
      <Card className="mt-4 border-border/70" data-testid="property-facts-card" aria-busy="true">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Building2 className="h-4 w-4 text-primary" aria-hidden="true" /> Property facts
          </CardTitle>
          <p className="text-xs text-muted-foreground">Looking up public property records for this address…</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </CardContent>
      </Card>
    );
  }
  if (facts.isError || !facts.data) {
    return (
      <Card className="mt-4 border-border/70" data-testid="property-facts-card">
        <CardContent className="flex items-center justify-between gap-3 py-4 text-sm">
          <span className="text-muted-foreground">Property facts couldn't be loaded right now.</span>
          <Button size="sm" variant="outline" onClick={() => void facts.refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }
  const v = facts.data;
  const fa = v.floorArea;
  const est = fa.estimateSqft;
  const busy = apply.isPending || refine.isPending;
  const saveTyped = () => {
    const n = Number(draft.replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 50_000_000) {
      toast.error("Enter a floor area in square feet, for example 85000.");
      return;
    }
    refine.mutate({ siteId, sqft: n });
  };
  const floorAreaPanel = (() => {
    if (v.status === "pending") return null;
    if (editing) {
      return (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveTyped();
          }}
        >
          <label htmlFor={`pf-sqft-${siteId}`} className="text-sm">Floor area</label>
          <Input
            id={`pf-sqft-${siteId}`}
            inputMode="numeric"
            className="h-8 w-36"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={est ? String(est) : "e.g. 85000"}
            autoFocus
          />
          <span className="text-sm text-muted-foreground">sqft</span>
          <Button type="submit" size="sm" disabled={busy}>{refine.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      );
    }
    const editButton = canEdit ? (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => {
          setDraft(fa.siteSqft ? String(Math.round(fa.siteSqft)) : est ? String(est) : "");
          setEditing(true);
        }}
      >
        <Pencil className="mr-1 h-3 w-3" aria-hidden="true" /> {fa.siteSqft ? "Edit" : "Enter your own"}
      </Button>
    ) : null;
    switch (fa.state) {
      case "estimate_in_use":
        return (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-estimate-in-use">
            <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            <span>Your analysis uses this estimate. If you know the actual floor area, enter it for more precise results.</span>
            {editButton}
            {plausibilityNote && (
              <p className="flex w-full items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200" data-testid="pf-eui-check">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span><strong>Energy use per square foot looks unusually low.</strong> {plausibilityNote}</span>
              </p>
            )}
          </div>
        );
      case "estimate_available":
        return (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-estimate-available">
            <span>{fa.autoApplyBlocker ? `Not filled in automatically: ${fa.autoApplyBlocker}` : "This site has no floor area yet."}</span>
            {canEdit && (
              <Button size="sm" disabled={busy} onClick={() => apply.mutate({ siteId, locationRevision: v.locationRevision })} data-testid="pf-use-estimate">
                {apply.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Use {est?.toLocaleString()} sqft
              </Button>
            )}
            {editButton}
          </div>
        );
      case "placeholder_in_use":
        return (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-placeholder">
            <span>
              Your analysis uses a typical-size placeholder ({Math.round(fa.siteSqft ?? 0).toLocaleString()} sqft), not this building's floor area.
              {est != null ? ` Public records suggest about ${est.toLocaleString()} sqft.` : ""}
            </span>
            {canEdit && est != null && (
              <Button size="sm" disabled={busy} onClick={() => apply.mutate({ siteId, locationRevision: v.locationRevision })} data-testid="pf-use-estimate">
                {apply.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Use {est.toLocaleString()} sqft
              </Button>
            )}
            {editButton}
          </div>
        );
      case "your_value":
      case "your_value_differs":
        return (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-your-value">
            <span>
              Your site uses <strong>{Math.round(fa.siteSqft ?? 0).toLocaleString()} sqft</strong> (the value on the site profile).
              {fa.differencePct != null && fa.state === "your_value_differs"
                ? ` Public records suggest about ${est?.toLocaleString()} sqft — ${Math.abs(fa.differencePct)}% ${fa.differencePct > 0 ? "less" : "more"}.`
                : fa.differencePct != null
                  ? " Public records agree within 10%."
                  : ""}
            </span>
            {canEdit && fa.state === "your_value_differs" && est != null && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => apply.mutate({ siteId, locationRevision: v.locationRevision })}>
                Use {est.toLocaleString()} sqft instead
              </Button>
            )}
            {editButton}
          </div>
        );
      default:
        return (
          <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="pf-no-estimate">
            <span className="text-muted-foreground">
              {fa.noEstimateReason ?? "Public records don't give a usable floor area for this address."}
              {fa.siteSqft == null ? " Floor area unlocks per-square-foot benchmarking." : ""}
            </span>
            {editButton}
          </div>
        );
    }
  })();
  const record = v.rows.filter((r) => r.kind === "record");
  return (
    <Card className="mt-4 border-border/70" data-testid="property-facts-card">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Building2 className="h-4 w-4 text-primary" aria-hidden="true" /> Property facts
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Looked up automatically from free public records for this address. Each fact shows its source.
            </p>
          </div>
          {canEdit && v.status !== "pending" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              aria-label="Check public records again"
              title="Check public records again"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate({ siteId })}
            >
              <RefreshCw className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {v.status === "pending" ? (
          <p className="text-sm text-muted-foreground">Looking up public records for this address…</p>
        ) : (
          <>
            <div>
              <p className="font-display text-lg font-semibold leading-snug" data-testid="pf-headline">{v.headline}</p>
              {est != null && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Estimate from building footprints in public records, not a measured or assessor-recorded floor area.
                </p>
              )}
            </div>
            {floorAreaPanel}
            {v.cautions.length > 0 && (
              <ul className="space-y-1.5" aria-label="Things to know">
                {v.cautions.map((c) => (
                  <li key={c} className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            )}
            {record.length > 0 && (
              <dl className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="pf-facts">
                {record.map((r) => (
                  <div key={r.key} className="grid gap-1 px-3 py-2 sm:grid-cols-[9.5rem_1fr_auto] sm:items-start sm:gap-3">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{r.label}</dt>
                    <dd className="min-w-0 text-sm">
                      <span className="break-words">{r.value}</span>
                      {r.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{r.detail}</span>}
                    </dd>
                    <dd className="sm:text-right"><SourceChip sourceId={r.sourceId} kind={r.kind} /></dd>
                  </div>
                ))}
              </dl>
            )}
            {v.status === "unavailable" && (
              <p className="text-xs text-muted-foreground">Public property records couldn't be reached. We'll try again automatically next time you open this site.</p>
            )}
            {(fa.method || v.sources.length > 0) && (
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
                  How this was calculated and where it comes from
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">
                  {fa.method && <p><strong className="text-foreground">Floor-area estimate:</strong> {fa.method}</p>}
                  <ul className="space-y-1">
                    {v.sources.map((s) => (
                      <li key={s.id} className="flex gap-2">
                        <Landmark className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          <span className="text-foreground">{s.label}</span> — {s.publisher}. {s.terms}{" "}
                          <a href={s.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">Source</a>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {v.sourceErrors.length > 0 && <p>Not reachable on the last check: {v.sourceErrors.join(", ")}.</p>}
                  {v.fetchedAt && <p>Checked {new Date(v.fetchedAt).toLocaleDateString()}.</p>}
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
