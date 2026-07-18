/**
 * §3l public verification page — /verify/:token.
 * Renders the snapshot printed on a report next to the CURRENT figures so a
 * forwarded PDF is never silently stale. Token is the capability; only
 * headline numbers are shown, never account details.
 */
import { useRoute, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, ShieldCheck } from "lucide-react";

function usd(n: unknown) {
  return typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";
}

const KIND_TITLE: Record<string, string> = {
  energy_plan: "My Energy Plan",
  verified_savings: "Verified Savings Statement",
  practitioner: "Practitioner Export",
};

export default function Verify() {
  const [, params] = useRoute("/verify/:token");
  const token = params?.token ?? "";
  const q = trpc.reports.verify.useQuery({ token }, { enabled: token.length >= 8 });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="container flex items-center justify-between h-14">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Zap className="h-5 w-5 text-primary" /> WattWise
          </Link>
          <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3.5 w-3.5" /> Report verification</Badge>
        </div>
      </header>
      <main className="container max-w-2xl py-10 space-y-6">
        {q.isLoading && <p className="text-muted-foreground">Checking token…</p>}
        {q.data && !q.data.found && (
          <Card>
            <CardHeader>
              <CardTitle>Unknown report token</CardTitle>
              <CardDescription>
                This verification link doesn't match any report. The link may be mistyped, or the report may have been
                deleted by its owner.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {q.data && q.data.found && (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{KIND_TITLE[q.data.kind] ?? "Report"}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Printed {new Date(q.data.printedAt).toLocaleDateString()} · site{" "}
                {(q.data.snapshot?.siteName as string) ?? (q.data.current?.siteName ?? "—")}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">As printed</CardTitle>
                  <CardDescription>{new Date(q.data.printedAt).toLocaleDateString()}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Modeled annual cost" value={usd(q.data.snapshot?.annualCostUsd)} />
                  <Row label="Planned savings (open measures)" value={`${usd(q.data.snapshot?.plannedTotalUsd)}/yr`} />
                  <Row label="Verified savings to date" value={usd(q.data.snapshot?.verifiedTotalUsd)} />
                  <Row label="Open measures" value={String(q.data.snapshot?.measureCount ?? "—")} />
                </CardContent>
              </Card>
              <Card className="border-primary/40">
                <CardHeader>
                  <CardTitle className="text-base">Current (live)</CardTitle>
                  <CardDescription>Updates with each new analysis</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {q.data.current ? (
                    <>
                      <Row label="Modeled annual cost" value={usd(q.data.current.annualCostUsd)} />
                      <Row label="Planned savings (open measures)" value={`${usd(q.data.current.plannedTotalUsd)}/yr`} />
                      <Row label="Verified savings to date" value={usd(q.data.current.verifiedTotalUsd)} />
                      <Row label="Open measures" value={String(q.data.current.measureCount)} />
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      Live figures unavailable — the underlying site may have been deleted.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground">{q.data.disclaimer}</p>
          </>
        )}
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
