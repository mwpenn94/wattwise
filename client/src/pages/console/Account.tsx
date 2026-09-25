/**
 * Account & usage — tier display, month-to-date LLM/compute spend metering
 * (handoff §9 unit economics), and one-click full data export (user-owned data).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Download, Gauge, ShieldCheck, BellRing, Database, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";

const TIERS: Array<{ id: "free" | "plus" | "pro"; name: string; blurb: string }> = [
  { id: "free", name: "Free", blurb: "2 sites · 12 uploads/mo · 3 scenario runs/mo · template-first bill parsing" },
  { id: "plus", name: "Plus", blurb: "Solar/battery modeling · more sites & runs · LLM bill parsing" },
  { id: "pro", name: "Pro", blurb: "Everything in Plus · priority parsing · portfolio at scale" },
];

export default function Account() {
  const { user } = useAuth();
  const usage = trpc.account.usage.useQuery();
  const billing = trpc.account.billing.useQuery();
  const exportData = trpc.account.exportData.useMutation({
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meterly-export-${new Date().toISOString().slice(0, 10)}.json`;
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
            {billing.isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <Badge className="font-mono uppercase">{billing.data?.plan ?? usage.data?.tier ?? "free"}</Badge>
                <div className="mt-3 space-y-2">
                  {TIERS.map((t) => {
                    const current = (billing.data?.entitlementTier ?? usage.data?.tier ?? "free") === t.id;
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
                          disabled
                        >
                          {current ? "Current" : "Price to be set"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {billing.data?.plan === "founding"
                    ? "Founding access is no-charge and preserves your current full access until commercial pricing is decided."
                    : billing.data?.setupMessage ?? "Plan limits are enforced server-side."}
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
              <ShieldCheck className="h-4 w-4 text-primary" /> Billing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">
              {billing.data?.stripeReady ? "Test billing is connected" : "Test billing setup required"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {billing.data?.stripeReady
                ? "Hosted Checkout and Customer Portal are available when plan prices are configured."
                : "No live account is used. A Stripe test-mode account, webhook secret, and plan price IDs are required before checkout can be enabled."}
            </p>
            <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
              Your data is never deleted when a plan changes. Downgrades preserve existing data and restrict only new work beyond plan limits.
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
            estimator. Meterly does not yet pull from your utility automatically; when automated feeds (Green Button
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
            Download everything Meterly stores about your account — sites, meters, intervals, bills, analyses, scenarios,
            insights, and audit trail — as a single JSON file.
          </p>
          <Button className="mt-4" onClick={() => exportData.mutate()} disabled={exportData.isPending}>
            {exportData.isPending ? "Preparing…" : "Export all my data"}
          </Button>
        </CardContent>
      </Card>

      {/* GAP-K guardrail §8.2: full data deletion — typed confirm phrase, honest
          statement of what remains (auth identity + one tombstone audit entry). */}
      <DeleteAccountCard />
    </div>
  );
}

function DeleteAccountCard() {
  const [, navigate] = useLocation();
  const [phrase, setPhrase] = useState("");
  const [armed, setArmed] = useState(false);
  const utils = trpc.useUtils();
  const del = trpc.account.deleteAllData.useMutation({
    onSuccess: async (r) => {
      toast.success(`Deleted — ${r.sitesDeleted} site${r.sitesDeleted === 1 ? "" : "s"} and all associated data removed.`);
      await utils.invalidate();
      navigate("/");
    },
    onError: (e) => toast.error(e.message),
  });
  const ready = phrase.trim().toLowerCase() === "delete my account";
  return (
    <Card className="mt-4 border-destructive/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base text-destructive">
          <Trash2 className="h-4 w-4" /> Delete all my data
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Permanently removes every site, meter, reading, bill, analysis, insight, scenario, upload, report, and your
          audit history. What remains afterwards: your sign-in identity (so the login still works, pointing at an empty
          account) and a single audit entry recording the deletion. <strong>This cannot be undone</strong> — export your
          data first if you might want it later.
        </p>
        {!armed ? (
          <Button variant="outline" className="mt-4 border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => setArmed(true)}>
            I want to delete my data…
          </Button>
        ) : (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/[0.04] p-3">
            <p className="text-xs font-medium">
              Type <span className="font-mono">delete my account</span> to confirm:
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder="delete my account"
                aria-label="Deletion confirmation phrase"
                className="sm:max-w-xs"
              />
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={!ready || del.isPending}
                  onClick={() => del.mutate({ confirmPhrase: "delete my account" })}
                >
                  {del.isPending ? "Deleting…" : "Permanently delete everything"}
                </Button>
                <Button variant="ghost" onClick={() => { setArmed(false); setPhrase(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
