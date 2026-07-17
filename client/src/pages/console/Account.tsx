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
import { Download, Gauge, ShieldCheck } from "lucide-react";

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
