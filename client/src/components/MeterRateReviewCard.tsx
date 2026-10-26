import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fmtUsd } from "@/lib/wattwiseUi";
import { formatSavingsRangeUsd } from "@shared/savingsRange";
import type { MeterRateReview, PerMeterRateReviewRow, RateReviewOption, RateReviewVerdict } from "../../../server/analytics/multiMeter";
export type MeterRateReviewData = MeterRateReview;

/**
 * Oct 25 (owner-approved restore): every account shows its current schedule
 * next to every schedule it may take, with the cost over the same uploaded
 * period and the difference; schedules it cannot take are listed with the
 * filed reason. A plain verdict says whether a switch is worth requesting.
 * Notes shared by every account appear once at the bottom.
 */
const VERDICT_LABEL: Record<RateReviewVerdict, string> = {
  switch_candidate: "Switch candidate",
  within_threshold: "Within 2% — not worth switching",
  lowest: "Already lowest",
  no_alternatives: "No other schedule available",
};
const VERDICT_CLASS: Record<RateReviewVerdict, string> = {
  switch_candidate: "border-emerald-600/50 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300",
  within_threshold: "border-sky-600/40 bg-sky-600/10 text-sky-800 dark:text-sky-300",
  lowest: "border-border bg-muted text-foreground",
  no_alternatives: "border-border bg-muted text-muted-foreground",
};

function fmtDate(ts: number, tz: string) {
  return new Date(ts).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });
}
function periodText(m: PerMeterRateReviewRow) {
  // toTs is end-exclusive; show the last covered day.
  return `${fmtDate(m.period.fromTs, m.period.timezone)} – ${fmtDate(m.period.toTs - 1, m.period.timezone)} (${m.period.calendarMonths} months)`;
}
function diffText(o: RateReviewOption) {
  if (o.isCurrent) return "current";
  const pct = o.differencePct == null ? "" : ` (${(Math.abs(o.differencePct) * 100).toFixed(1)}%)`;
  if (Math.abs(o.differenceUsd) < 0.5) return "same";
  return o.differenceUsd > 0 ? `${fmtUsd(o.differenceUsd)} less${pct}` : `${fmtUsd(-o.differenceUsd)} more${pct}`;
}
/** Analyses saved before Oct 25 carry only the best alternative. */
function legacyOptions(m: PerMeterRateReviewRow): RateReviewOption[] {
  const current: RateReviewOption = { id: m.tariffId, name: m.tariffName.split(" — ")[0], isCurrent: true, observedCost: m.currentObservedCost, differenceUsd: 0, differencePct: 0, components: { energy: 0, demand: 0, fixed: 0, riders: 0 }, conditions: [], indicative: false, freshness: "current" };
  if (!m.bestAlternative) return [current];
  const d = m.currentObservedCost - m.bestAlternative.observedCost;
  return [{ id: m.bestAlternative.id, name: m.bestAlternative.name.split(" — ")[0], isCurrent: false, observedCost: m.bestAlternative.observedCost, differenceUsd: d, differencePct: m.currentObservedCost > 0 ? d / m.currentObservedCost : null, components: { energy: 0, demand: 0, fixed: 0, riders: 0 }, conditions: [], indicative: Boolean(m.bestAlternative.indicative), freshness: m.bestAlternative.freshness }, current];
}

function AccountRow({ meter, showPeriod }: { meter: PerMeterRateReviewRow; showPeriod: boolean }) {
  const legacy = !meter.options;
  const options = meter.options ?? legacyOptions(meter);
  const verdict: RateReviewVerdict = meter.verdict ?? (meter.bestAlternative ? "switch_candidate" : "lowest");
  const notes = meter.accountNotes ?? [];
  const hasBreakdown = options.some((o) => o.components.energy || o.components.demand || o.components.fixed);
  return (
    <details className="group rounded-md border border-border/70 bg-card" open={verdict === "switch_candidate"} data-testid="rate-review-account">
      <summary className="flex cursor-pointer list-none flex-wrap items-start gap-x-3 gap-y-1 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{meter.label}</span>
          <span className="block text-xs text-muted-foreground">
            On {meter.tariffName.split(" — ")[0]} · {fmtUsd(meter.currentObservedCost)}
            {showPeriod ? ` · ${periodText(meter)}` : ""} · peak {Math.round(meter.peakKw).toLocaleString()} kW
          </span>
          {meter.verdictText && <span className="mt-1 block text-xs">{meter.verdictText}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className={VERDICT_CLASS[verdict]} data-testid="rate-verdict">{VERDICT_LABEL[verdict]}</Badge>
          {meter.bestAlternative && <span className="font-mono text-xs font-medium">{formatSavingsRangeUsd(meter.bestAlternative.savingsRangeUsd)}</span>}
          <span aria-hidden className="text-xs text-muted-foreground transition-transform group-open:rotate-90">›</span>
        </span>
      </summary>
      <div className="border-t border-border/60 px-3 pb-3 pt-2">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead className="text-right">Cost, same period</TableHead>
                <TableHead className="text-right">vs. current</TableHead>
                {hasBreakdown && <TableHead className="hidden text-right md:table-cell">Energy</TableHead>}
                {hasBreakdown && <TableHead className="hidden text-right md:table-cell">Demand</TableHead>}
                {hasBreakdown && <TableHead className="hidden text-right md:table-cell">Fixed + riders</TableHead>}
                <TableHead>Before switching</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {options.map((o) => (
                <TableRow key={`${o.id}-${o.isCurrent}`} className={o.isCurrent ? "bg-muted/50" : undefined}>
                  <TableCell className="text-xs">
                    <span className="font-medium">{o.name}</span>
                    {o.isCurrent && <Badge variant="outline" className="ml-1">Current</Badge>}
                    {o.isCurrent && meter.rateCodeResolution?.match === "family_inferred" && <Badge variant="outline" className="ml-1">Inferred from bill code</Badge>}
                    {!o.isCurrent && o.indicative && <Badge data-testid="rate-indicative" variant="outline" className="ml-1 border-amber-500/40 text-amber-800 dark:text-amber-300">Indicative</Badge>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtUsd(o.observedCost)}</TableCell>
                  <TableCell className={`text-right font-mono text-xs ${!o.isCurrent && o.differenceUsd > 0.5 ? "text-emerald-700 dark:text-emerald-300" : ""}`}>{diffText(o)}</TableCell>
                  {hasBreakdown && <TableCell className="hidden text-right font-mono text-xs md:table-cell">{fmtUsd(o.components.energy)}</TableCell>}
                  {hasBreakdown && <TableCell className="hidden text-right font-mono text-xs md:table-cell">{fmtUsd(o.components.demand)}</TableCell>}
                  {hasBreakdown && <TableCell className="hidden text-right font-mono text-xs md:table-cell">{fmtUsd(o.components.fixed + o.components.riders)}</TableCell>}
                  <TableCell className="text-xs text-muted-foreground">{o.isCurrent ? "—" : o.conditions.length ? o.conditions.join("; ") : "Request the change from the utility"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {meter.excluded && meter.excluded.length > 0 && (
          <div className="mt-2 text-xs">
            <p className="font-medium">Not available or not a fit</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {meter.excluded.map((e) => <li key={e.id}><span className="text-foreground">{e.name}</span> — {e.reason}</li>)}
            </ul>
          </div>
        )}
        {legacy && <p className="mt-2 text-xs text-muted-foreground">Re-run analysis to see every schedule this account can take.</p>}
        {meter.bestAlternative && <p className="mt-2 text-xs text-muted-foreground">{meter.bestAlternative.basis}</p>}
        {notes.length > 0 && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Notes for this account ({notes.length})</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </details>
        )}
      </div>
    </details>
  );
}

export default function MeterRateReviewCard({ review }: { review: MeterRateReviewData | null | undefined }) {
  if (!review || !review.perMeter.length) return null;
  // Old analysis payloads have no trustworthy period/provider provenance.
  if (review.perMeter.some((m) => !m.period || !m.utilityName)) return <Card className="mt-4"><CardContent className="pt-4 text-sm">Re-run analysis to see the account-by-account rate comparison for this site.</CardContent></Card>;
  const first = review.perMeter[0];
  const samePeriod = review.perMeter.every((m) => m.period.fromTs === first.period.fromTs && m.period.toTs === first.period.toTs);
  const counts = review.verdictCounts;
  const shared = review.sharedNotes ?? review.disclosures;
  // The review's first two disclosures are its fixed method statements.
  const generic = review.sharedNotes ? review.disclosures.slice(0, 2).filter((d) => !shared.includes(d)) : [];
  const order: Record<RateReviewVerdict, number> = { switch_candidate: 0, within_threshold: 1, lowest: 2, no_alternatives: 3 };
  const rows = [...review.perMeter].sort((a, b) => order[a.verdict ?? "lowest"] - order[b.verdict ?? "lowest"]);
  return (
    <Card className="mt-4 border-border/70" data-testid="meter-rate-review">
      <CardHeader className="pb-2">
        <CardTitle className="font-display text-base">Rate comparison by account</CardTitle>
        <p className="text-xs text-muted-foreground">
          Each account is priced on its own readings and its own schedule. Every schedule is priced over the same period
          {samePeriod ? ` (${periodText(first)})` : ""}, so the differences are like-for-like. A switch is worth requesting when it saves more than ${review.materiality?.minUsd ?? 50} and {((review.materiality?.minPct ?? 0.02) * 100).toFixed(0)}%.
        </p>
        {counts && (
          <p className="pt-1 text-xs" data-testid="rate-verdict-counts">
            <span className="font-medium">{counts.switch_candidate}</span> switch candidate{counts.switch_candidate === 1 ? "" : "s"} ·{" "}
            <span className="font-medium">{counts.within_threshold}</span> within 2% ·{" "}
            <span className="font-medium">{counts.lowest}</span> already lowest
            {counts.no_alternatives ? <> · <span className="font-medium">{counts.no_alternatives}</span> with no other schedule</> : null}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((m) => <AccountRow key={m.meterId} meter={m} showPeriod={!samePeriod} />)}
        <div className="space-y-1 border-t pt-2 text-xs">
          <p>All accounts on their current schedules: {fmtUsd(review.totalCurrentObservedCost)}</p>
          <p className="font-medium">Combined screening range for switch candidates: {review.totalSavingsRangeUsd ? formatSavingsRangeUsd(review.totalSavingsRangeUsd) : "none above the threshold"}</p>
          <p className="text-muted-foreground">{review.savingsBasis}</p>
        </div>
        {shared.length + generic.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">How these figures are calculated ({shared.length + generic.length} notes)</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
              {[...generic, ...shared].map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
