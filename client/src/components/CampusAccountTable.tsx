/**
 * OPEN-3 (Oct 26): per-account breakdown for campus scenarios and plans. Each
 * separately billed account is shown with its current and scenario cost on its
 * own rate schedule; the totals above it are the sum of these rows.
 */
import { fmtUsd } from "@/lib/wattwiseUi";

type CampusLine = {
  meterId: number;
  label: string;
  tariffName: string;
  baselineAnnualCost: number;
  scenarioAnnualCost: number;
  deltaCost: number;
  measureApplied: boolean;
};
export function CampusAccountTable({ results }: { results: unknown }) {
  const campus = (results as { campus?: { accounts?: CampusLine[]; accountCount?: number } } | null)?.campus;
  const rows = campus?.accounts ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 overflow-x-auto" data-testid="campus-account-table">
      <p className="font-mono text-[10px] uppercase text-muted-foreground">By account ({rows.length} separately billed)</p>
      <table className="mt-1.5 w-full min-w-[520px] text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1.5 pr-2 font-medium">Account</th>
            <th className="py-1.5 pr-2 font-medium">Rate schedule</th>
            <th className="py-1.5 pr-2 text-right font-medium">Current /yr</th>
            <th className="py-1.5 pr-2 text-right font-medium">Scenario /yr</th>
            <th className="py-1.5 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.meterId} className="border-b border-border/60">
              <td className="py-1.5 pr-2">{a.label}</td>
              <td className="py-1.5 pr-2 text-muted-foreground">{a.tariffName}</td>
              <td className="py-1.5 pr-2 text-right font-mono">{fmtUsd(a.baselineAnnualCost)}</td>
              <td className="py-1.5 pr-2 text-right font-mono">{fmtUsd(a.scenarioAnnualCost)}</td>
              <td className={`py-1.5 text-right font-mono ${a.deltaCost < 0 ? "text-emerald-700 dark:text-emerald-500" : a.deltaCost > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                {a.measureApplied ? `${a.deltaCost < 0 ? "−" : a.deltaCost > 0 ? "+" : ""}${fmtUsd(Math.abs(a.deltaCost))}` : "no change"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
