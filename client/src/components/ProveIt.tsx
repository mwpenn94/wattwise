/**
 * §3e Prove-it loop UI.
 *
 * Two pieces:
 *  - MarkImplementedDialog: the "I did this" flow — date picker (defaults to
 *    today, never assumes), fired from an opportunity card.
 *  - ProveItSection: the verification ledger — each implementation with an
 *    honest status chip, monthly verdicts behind an expander, and a verified
 *    savings counter that ONLY counts band-clearing months.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { BadgeCheck, ChevronDown, Clock3, RefreshCw, Trash2, TrendingDown, TrendingUp, HelpCircle } from "lucide-react";

/* ---------- status chip ---------- */

const STATUS_META: Record<
  string,
  { label: string; cls: string; Icon: typeof Clock3 }
> = {
  awaiting_data: { label: "Awaiting data", cls: "bg-muted text-muted-foreground", Icon: Clock3 },
  on_track: { label: "On track", cls: "bg-primary/15 text-primary", Icon: TrendingDown },
  verified: { label: "Verified", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", Icon: BadgeCheck },
  underperforming: { label: "Not showing yet", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400", Icon: TrendingUp },
  inconclusive: { label: "Inconclusive", cls: "bg-muted text-muted-foreground", Icon: HelpCircle },
};

export function ProveItStatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] ?? STATUS_META.awaiting_data;
  const Icon = m.Icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.cls}`}>
      <Icon className="h-3 w-3" /> {m.label}
    </span>
  );
}

/* ---------- "I did this" dialog ---------- */

export function MarkImplementedDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  siteId: number;
  opportunity: { id?: number; measure: string; title: string; expectedSavingsUsd: number | null } | null;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const utils = trpc.useUtils();
  const mark = trpc.proveIt.mark.useMutation({
    onSuccess: async () => {
      await utils.proveIt.list.invalidate();
      props.onOpenChange(false);
      toast.success("Marked as implemented", {
        description: "The verification clock starts now — a first read arrives after one full calendar month of post-change data.",
      });
    },
    onError: (e) => toast.error(e.message),
  });

  if (!props.opportunity) return null;
  const o = props.opportunity;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">I did this</DialogTitle>
          <DialogDescription>
            Mark “{o.title}” as implemented. WattWise will compare your actual usage against the
            weather-adjusted counterfactual each month and tell you honestly whether the savings are showing up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Label htmlFor="impl-date">When did the change go in?</Label>
          <Input
            id="impl-date"
            type="date"
            value={date}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The implementation month itself is excluded (it’s mixed before/after). No verdict is made before one
            full calendar month of post-change data — and “verified” needs at least three.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={mark.isPending || !date}
            onClick={() =>
              mark.mutate({
                siteId: props.siteId,
                opportunityId: o.id,
                measure: o.measure,
                title: o.title,
                implementedAt: new Date(`${date}T12:00:00`).getTime(),
                expectedSavingsUsd: o.expectedSavingsUsd,
              })
            }
          >
            {mark.isPending ? "Saving…" : "Start verifying"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- verification ledger section ---------- */

interface MonthVerdictRow {
  month: string;
  expectedKwh: number;
  actualKwh: number;
  deltaKwh: number;
  deltaUsd: number;
  bandUsd: number;
  verdict: "saving" | "inconclusive" | "over_baseline";
  note: string;
}

export function ProveItSection({ siteId }: { siteId: number }) {
  const impls = trpc.proveIt.list.useQuery({ siteId });
  const utils = trpc.useUtils();
  const evaluate = trpc.proveIt.evaluate.useMutation({
    onSuccess: async (r) => {
      await utils.proveIt.list.invalidate();
      toast.success(r.headline);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.proveIt.remove.useMutation({
    onSuccess: async () => {
      await utils.proveIt.list.invalidate();
      toast.success("Removed");
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = impls.data ?? [];
  if (impls.isLoading || rows.length === 0) return null;

  const totalVerified = rows.reduce((s, r) => s + (r.verifiedSavingsUsd ?? 0), 0);

  return (
    <Card className="mt-4 border-border/70" data-testid="proveit-section">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 font-display text-base">
          <span className="flex items-center gap-2">
            <BadgeCheck className="h-4 w-4 text-primary" /> Prove it — implemented measures
          </span>
          {totalVerified > 0 && (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
              ${Math.round(totalVerified).toLocaleString()} verified so far
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Actual usage vs the weather-adjusted counterfactual, month by month. Only band-clearing months count as
          verified — changes inside the model’s uncertainty band are reported as inconclusive, never claimed.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((r) => {
          const verdicts = (r.verdicts ?? []) as MonthVerdictRow[];
          return (
            <div key={r.id} className="rounded-md border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{r.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Implemented {new Date(r.implementedAt).toLocaleDateString()}
                    {r.expectedSavingsUsd != null && <> · expected ~${Math.round(r.expectedSavingsUsd).toLocaleString()}/yr</>}
                    {r.lastEvaluatedAt != null && <> · last checked {new Date(r.lastEvaluatedAt).toLocaleDateString()}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ProveItStatusChip status={r.status} />
                  {(r.verifiedSavingsUsd ?? 0) > 0 && (
                    <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                      ${Math.round(r.verifiedSavingsUsd!).toLocaleString()}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={evaluate.isPending}
                    onClick={() => evaluate.mutate({ id: r.id })}
                  >
                    <RefreshCw className={`h-3 w-3 ${evaluate.isPending ? "animate-spin" : ""}`} /> Check now
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (window.confirm(`Remove “${r.title}” from verification? Its verdict history will be deleted.`)) {
                        remove.mutate({ id: r.id });
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {verdicts.length > 0 && (
                <Collapsible className="mt-2">
                  <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <ChevronDown className="h-3 w-3" /> {verdicts.length} month verdict{verdicts.length === 1 ? "" : "s"}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 space-y-1.5">
                      {verdicts.map((v) => (
                        <div key={v.month} className="rounded bg-muted/40 px-2.5 py-1.5 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="font-mono font-semibold">{v.month}</span>
                            <span
                              className={
                                v.verdict === "saving"
                                  ? "font-bold text-emerald-600 dark:text-emerald-400"
                                  : v.verdict === "over_baseline"
                                    ? "font-bold text-amber-600 dark:text-amber-400"
                                    : "font-semibold text-muted-foreground"
                              }
                            >
                              {v.verdict === "saving" ? `−$${Math.abs(v.deltaUsd).toLocaleString()} saved` : v.verdict === "over_baseline" ? `+$${Math.abs(v.deltaUsd).toLocaleString()} over` : "inside band"}
                            </span>
                          </div>
                          <p className="mt-0.5 text-muted-foreground">
                            expected {v.expectedKwh.toLocaleString()} kWh · actual {v.actualKwh.toLocaleString()} kWh · band ±${v.bandUsd.toLocaleString()}
                          </p>
                          <p className="mt-0.5 text-muted-foreground">{v.note}</p>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {r.status === "awaiting_data" && verdicts.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Awaiting the first full calendar month of post-change data — tap “Check now” after your next month of usage lands.
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
