import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fmtUsd } from "@/lib/wattwiseUi";
import { formatSavingsRangeUsd } from "@shared/savingsRange";
import type { MeterRateReview } from "../../../server/analytics/multiMeter";
export type MeterRateReviewData = MeterRateReview;

export default function MeterRateReviewCard({ review }: { review: MeterRateReviewData | null | undefined }) {
  if (!review || !review.perMeter.length) return null;
  // Old analysis payloads have no trustworthy period/provider provenance.
  if (review.perMeter.some(m => !m.period || !m.utilityName)) return <Card className="mt-4"><CardContent className="pt-4 text-sm">Re-run analysis to review account-specific rates, coverage and disclosures. Legacy savings estimates are withheld.</CardContent></Card>;
  return <Card className="mt-4 border-border/70">
    <CardHeader className="pb-2">
      <CardTitle className="font-display text-base">Service agreement rate review</CardTitle>
      <p className="text-xs text-muted-foreground">Modeled subtotals over uploaded periods, not annual bills. Each account retains its own schedule, blocks, riders and billed demand—not the coincident campus total.</p>
    </CardHeader>
    <CardContent>
      <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow><TableHead>Service agreement / coverage</TableHead><TableHead>Current schedule</TableHead><TableHead className="text-right">Observed-period subtotal</TableHead><TableHead>Candidate alternative — confirmation required</TableHead><TableHead className="text-right">Same-period savings range</TableHead></TableRow></TableHeader>
        <TableBody>{review.perMeter.map(meter => <TableRow key={meter.meterId}>
          <TableCell className="text-xs"><span className="font-medium">{meter.label}</span><p>{new Date(meter.period.fromTs).toLocaleDateString("en-US", {timeZone:meter.period.timezone})} – {new Date(meter.period.toTs).toLocaleDateString("en-US", {timeZone:meter.period.timezone})} (end exclusive)</p><p className="text-muted-foreground">{meter.period.calendarMonths} touched months · {meter.period.timezone}{meter.period.partialMonths.length ? ` · partial: ${meter.period.partialMonths.join(", ")}` : ""}</p><p className="mt-1 text-muted-foreground">{meter.period.basis}</p></TableCell>
          <TableCell className="text-xs"><p>{meter.utilityName} · {meter.tariffName}</p>{meter.rateCodeResolution?.match === "family_inferred" && <Badge variant="outline">Inferred, unconfirmed</Badge>}<details className="mt-1"><summary className="cursor-pointer">Account basis and caveats</summary>{meter.disclosures.map((d,i) => <p key={i} className="mt-1 text-muted-foreground">{d}</p>)}</details></TableCell>
          <TableCell className="text-right font-mono text-xs">{fmtUsd(meter.currentObservedCost)}</TableCell>
          <TableCell className="text-xs">{meter.bestAlternative ? <><p>{meter.bestAlternative.name}</p>{meter.bestAlternative.freshness === "urdb_stale" && <Badge variant="outline">Stale</Badge>}{meter.bestAlternative.disclosures.map((d,i)=><p key={i} className="mt-1 text-muted-foreground">{d}</p>)}</> : <span className="text-muted-foreground">No supported material alternative; eligibility/billing confirmation may be needed.</span>}</TableCell>
          <TableCell className="text-right text-xs"><span className="font-mono font-medium">{formatSavingsRangeUsd(meter.bestAlternative?.savingsRangeUsd)}</span>{meter.bestAlternative && <p className="mt-1 text-muted-foreground">{meter.bestAlternative.basis}</p>}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div>
      <div className="mt-3 space-y-1 border-t pt-2 text-xs"><p>Sum of account observed-period subtotals: {fmtUsd(review.totalCurrentObservedCost)}</p><p className="font-medium">Standalone account rate-review range: {formatSavingsRangeUsd(review.totalSavingsRangeUsd)}</p><p>{review.betterCount} of {review.reviewedCount} accounts have a supported material candidate.</p><p className="text-muted-foreground">{review.savingsBasis}</p></div>
      {review.disclosures.map((d,i)=><p key={i} className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{d}</p>)}
    </CardContent>
  </Card>;
}
