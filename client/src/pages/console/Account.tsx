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

export default function Account() {
  const { user } = useAuth();
  const usage = trpc.account.usage.useQuery();
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
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Free: 1 site, 3 uploads/mo, 3 scenario runs/mo, template-first bill parsing.
                  <br />
                  Plus: solar/battery modeling, more sites & runs.
                  <br />
                  Pro: everything, priority parsing.
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
