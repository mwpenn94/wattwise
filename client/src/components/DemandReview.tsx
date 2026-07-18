/**
 * §3i demand review ritual — the per-billing-cycle demand review for
 * commercial (demand-charge) sites. One card, four moves:
 *   1. Set-point: a kW target the building already hits in ~90% of months.
 *   2. Billed vs actual by month — the ratchet watch (billed > actual months
 *      are the ratchet's tail, named explicitly).
 *   3. Attribution recap — what made the peak happen (links the §3b card).
 *   4. Exactly ONE priced action — the top demand-category opportunity, with
 *      its add-to-plan deep link. One action per cycle is the ritual's rule.
 * Renders nothing when the site has no demand data or no demand charges —
 * a residential rate-check site never sees a demand ritual.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Gauge, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export interface DemandReviewData {
  months: Array<{
    month: string;
    actualPeakKw: number;
    billedDemandKw: number;
    ratchetApplied: boolean;
    peakTimestamp: number;
  }>;
  setPointKw: number;
  demandRateUsdPerKwMo: number | null;
  anyRatchet: boolean;
}

export default function DemandReview({
  data,
  siteId,
  attributionSummary,
  topDemandAction,
}: {
  data: DemandReviewData;
  siteId: number;
  /** one-line recap from the §3b peak-attribution insight, when present */
  attributionSummary: string | null;
  /** top demand-category opportunity (title + $/yr + measure key), when present */
  topDemandAction: { title: string; estUsdPerYr: number | null; measure: string } | null;
}) {
  const recent = data.months.slice(-12);
  const overBilled = recent.filter((m) => m.billedDemandKw > m.actualPeakKw + 0.05);
  const monthsOverSetPoint = recent.filter((m) => m.actualPeakKw > data.setPointKw + 0.05).length;

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <Gauge className="h-4 w-4 text-primary" /> Demand review — this cycle's ritual
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border/70 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Set-point to defend</p>
            <p className="font-display text-xl font-bold">{data.setPointKw.toFixed(1)} kW</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              Your building stayed under this in ~90% of measured months — it's a proven target, not a promise.
              {monthsOverSetPoint > 0 && ` ${monthsOverSetPoint} of the last ${recent.length} months went over.`}
            </p>
          </div>
          <div className="rounded-md border border-border/70 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Ratchet watch</p>
            {data.anyRatchet ? (
              <>
                <p className="font-display text-xl font-bold">{overBilled.length} mo</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                  billed above the actual peak — that's the ratchet's tail. A one-month reduction won't cut the bill
                  until the ratchet window rolls off.
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-xl font-bold">none</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                  No ratchet clause applied in the measured window — each month's billed demand followed its own peak.
                </p>
              </>
            )}
          </div>
          <div className="rounded-md border border-border/70 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Why the peak happened</p>
            <p className="mt-0.5 text-[11px] leading-relaxed">
              {attributionSummary ?? "No attribution available this cycle — run analysis with interval data to split weather vs schedule."}
            </p>
          </div>
        </div>

        {/* billed vs actual, most recent months */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/70 text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Month</th>
                <th className="py-1 pr-2 font-medium">Actual peak</th>
                <th className="py-1 pr-2 font-medium">Billed demand</th>
                <th className="py-1 font-medium">Ratchet</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.month} className="border-b border-border/40 last:border-b-0">
                  <td className="py-1 pr-2 font-mono">{m.month}</td>
                  <td className="py-1 pr-2">{m.actualPeakKw.toFixed(1)} kW</td>
                  <td className={`py-1 pr-2 ${m.billedDemandKw > m.actualPeakKw + 0.05 ? "font-medium text-amber-600 dark:text-amber-400" : ""}`}>
                    {m.billedDemandKw.toFixed(1)} kW
                  </td>
                  <td className="py-1">
                    {m.ratchetApplied ? (
                      <Badge variant="outline" className="border-amber-500/50 px-1 py-0 text-[9px] text-amber-600 dark:text-amber-400">
                        applied
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* exactly one priced action per cycle */}
        <div className="mt-3 rounded-md border border-primary/30 bg-primary/[0.04] p-2.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">This cycle's one action</p>
          {topDemandAction ? (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">{topDemandAction.title}</span>
                {topDemandAction.estUsdPerYr != null && topDemandAction.estUsdPerYr > 0 && (
                  <span className="text-muted-foreground"> — est. ${Math.round(topDemandAction.estUsdPerYr).toLocaleString()}/yr</span>
                )}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={`/app/scenarios?site=${siteId}&measure=${encodeURIComponent(topDemandAction.measure)}`}>
                  Add to plan <ArrowRight className="ml-1 h-3 w-3" />
                </Link>
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              No priced demand action this cycle — nothing material was found, and we won't invent one. Defend the
              set-point and re-review next cycle.
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            One action per cycle, on purpose — demand management compounds through consistency, not a checklist dump.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
