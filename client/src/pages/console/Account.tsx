/**
 * Account & usage — tier display, month-to-date LLM/compute spend metering
 * (handoff §9 unit economics), and one-click full data export (user-owned data).
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Download, Gauge, ShieldCheck, BellRing, Database } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const TIERS: Array<{ id: "free" | "plus" | "pro"; name: string; blurb: string }> = [
  { id: "free", name: "Free", blurb: "2 sites · 12 uploads/mo · 3 scenario runs/mo · template-first bill parsing" },
  { id: "plus", name: "Plus", blurb: "Solar/battery modeling · more sites & runs · LLM bill parsing" },
  { id: "pro", name: "Pro", blurb: "Everything in Plus · priority parsing · portfolio at scale" },
];

export default function Account() {
  const { user } = useAuth();
  const usage = trpc.account.usage.useQuery();
  const utils = trpc.useUtils();
  // Gap-6: self-serve tier switching during beta — the pricing page used to
  // say "Coming soon" while requireTier gates were already live server-side,
  // leaving Plus/Pro features unreachable by anyone.
  const setTier = trpc.account.setTier.useMutation({
    onSuccess: async (r) => {
      toast.success(`Plan changed to ${r.tier} (beta — no billing)`);
      await utils.account.usage.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const exportData = trpc.account.exportData.useMutation({
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `wattwise-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="container max-w-3xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Account & usage</h1>
      <p className="mt-1 text-sm text-muted-foreground">Tier, metered spend, and your data.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card className="border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <ShieldCheck className="h-4 w-4 text-primary" /> Plan
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usage.isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <Badge className="font-mono uppercase">{usage.data?.tier ?? "free"}</Badge>
                <div className="mt-3 space-y-2">
                  {TIERS.map((t) => {
                    const current = (usage.data?.tier ?? "free") === t.id;
                    return (
                      <div
                        key={t.id}
                        className={`flex items-center justify-between gap-2 rounded-md border p-2 ${current ? "border-primary/60 bg-primary/5" : "border-border/70"}`}
                      >
                        <div>
                          <p className="text-xs font-medium">{t.name}</p>
                          <p className="text-[10px] leading-relaxed text-muted-foreground">{t.blurb}</p>
                        </div>
                        <Button
                          size="sm"
                          variant={current ? "secondary" : "outline"}
                          disabled={current || setTier.isPending}
                          onClick={() => setTier.mutate({ tier: t.id })}
                        >
                          {current ? "Current" : "Switch"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  Beta period: switching plans is free and collects no payment. Tier limits are enforced immediately and
                  every change is recorded in your audit trail. Pricing applies when billing launches, with notice.
                </p>
              </>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Signed in as <span className="font-mono">{user?.name ?? "—"}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-display text-base">
              <Gauge className="h-4 w-4 text-primary" /> Month-to-date metered spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            {usage.isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <p className="font-display text-2xl font-bold">
                  ${(usage.data?.monthToDateLlmUsd ?? 0).toFixed(4)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  LLM extraction spend this month. Free tier has a hard budget kill-switch: when reached, bill parsing
                  degrades to template-only + manual entry (never silent failure). Each analysis is instrumented against a
                  ≤ $0.20 marginal-cost cap.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* §3j honest labeling: name the active data rung — never claim "automated" */}
      <Card className="mt-4 border-border/70">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Database className="h-4 w-4 text-primary" /> How your data updates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            <Badge variant="outline" className="mr-2">manual upload</Badge>
            Your data updates via <strong>manual upload</strong> — interval files, bill photos, or the hypothetical
            estimator. WattWise does not yet pull from your utility automatically; when automated feeds (Green Button
            Connect, utility APIs) become available for your providers, this card will say so explicitly. We never label a
            manual rung “automated.”
          </p>
        </CardContent>
      </Card>

      {/* §3f lifecycle: monthly digest — quiet by default, bill-cycle anchored */}
      <DigestCard />

      <Card className="mt-4 border-border/70">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Download className="h-4 w-4 text-primary" /> Your data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Download everything WattWise stores about your account — sites, meters, intervals, bills, analyses, scenarios,
            insights, and audit trail — as a single JSON file.
          </p>
          <Button className="mt-4" onClick={() => exportData.mutate()} disabled={exportData.isPending}>
            {exportData.isPending ? "Preparing…" : "Export all my data"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** §3f digest settings — one monthly digest anchored to the bill cycle, opt-in
 * (quiet by default). The dollar-figure send rule is enforced by the digest
 * builder, and stated here so the contract is visible. */
function DigestCard() {
  const prefs = trpc.account.digestPrefs.useQuery();
  const utils = trpc.useUtils();
  const save = trpc.account.setDigestPrefs.useMutation({
    onSuccess: async (r) => {
      await utils.account.digestPrefs.invalidate();
      if (r.cronState === "scheduled") toast.success("Digest scheduled — it runs on your bill-cycle day");
      else if (r.cronState === "removed") toast.success("Digest turned off — the schedule was removed");
      else if (r.cronState === "error") toast.warning("Setting saved, but the schedule couldn't be updated — try toggling again");
      else toast.success("Digest settings saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const preview = trpc.account.digestPreview.useQuery(undefined, { enabled: prefs.data?.digestOptIn === true });
  const optIn = prefs.data?.digestOptIn ?? false;
  const day = prefs.data?.digestAnchorDay ?? 1;

  return (
    <Card className="mt-4 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <BellRing className="h-4 w-4 text-primary" /> Monthly digest
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">One digest per month — that's the whole promise</p>
            <p className="mt-1 text-xs text-muted-foreground">
              One verdict, one new insight, one nudge — timed to your bill cycle so it lands when your bill does. Every
              digest contains a dollar figure or it doesn't send. Off by default; nothing else emails you.
            </p>
          </div>
          <Switch
            checked={optIn}
            disabled={prefs.isLoading || save.isPending}
            onCheckedChange={(v) => save.mutate({ optIn: v, anchorDay: day })}
          />
        </div>
        {optIn && (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Bill-cycle day</span>
            <Select value={String(day)} onValueChange={(v) => save.mutate({ optIn: true, anchorDay: Number(v) })}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">of each month (set it to the day your bill usually arrives)</span>
          </div>
        )}
        {optIn && preview.data && (
          <div className="mt-3 rounded-md border border-border/70 bg-muted/40 p-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">If it ran today</p>
            {"headline" in preview.data && preview.data.headline ? (
              <p className="mt-1 text-xs">{preview.data.headline}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Nothing would send — no material dollar figure exists yet. That's the rule working, not a bug.
              </p>
            )}
          </div>
        )}
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          The digest runs on a real monthly schedule and lands in your in-app alerts inbox. Every digest contains a
          dollar figure or it doesn't send at all. Email delivery ships after the beta — in-app is the channel today,
          and this card will say so when that changes. Event alerts beyond the digest (bill anomaly, rate opportunity)
          follow the same rule: a dollar figure or silence.
        </p>
      </CardContent>
    </Card>
  );
}
