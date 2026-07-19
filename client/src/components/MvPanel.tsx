/**
 * M&V — verified savings (IPMVP Option C). Pick the meter and the measure's
 * in-service date; the server fits a CalTRACK baseline on pre-install months
 * and projects it over the reporting period. The avoided-usage rows are the
 * evidence custom rebate programs ($/kWh, $/therm saved) pay on.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { BadgeCheck, ShieldAlert, Copy, Download } from "lucide-react";
import { fmtNum, fmtUsd } from "@/lib/wattwiseUi";

export default function MvPanel({ siteId }: { siteId: number }) {
  const meters = trpc.sites.meters.useQuery({ siteId });
  const [meterId, setMeterId] = useState<string>("");
  const [installDate, setInstallDate] = useState<string>("");
  const assess = trpc.mv.assess.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const r = assess.data;

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <BadgeCheck className="h-4 w-4 text-primary" />
          M&amp;V — verified savings
        </CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Weather-normalized baseline on pre-install months, projected over the post-install period (IPMVP Option C /
          CalTRACK monthly). Custom rebate programs pay on these verified figures, not modeled forecasts.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <Label className="text-xs">Meter</Label>
            <Select value={meterId} onValueChange={setMeterId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select meter…" />
              </SelectTrigger>
              <SelectContent>
                {(meters.data ?? []).map((m: { id: number; label: string | null; commodity: string }) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.label ?? `Meter ${m.id}`} · {m.commodity}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="mv-date" className="text-xs">
              Measure in-service date
            </Label>
            <Input id="mv-date" type="date" className="mt-1" value={installDate} onChange={(e) => setInstallDate(e.target.value)} />
          </div>
          <Button
            disabled={assess.isPending || !meterId || !installDate}
            onClick={() =>
              assess.mutate({
                siteId,
                meterId: Number(meterId),
                installedAt: new Date(`${installDate}T00:00:00`).getTime(),
              })
            }
          >
            {assess.isPending ? "Fitting baseline…" : "Verify savings"}
          </Button>
        </div>

        {r && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="mr-auto flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => {
                    const summary = [
                      `M&V verified savings (IPMVP Option C / CalTRACK monthly)`,
                      `Meter: ${meters.data?.find((m: { id: number }) => m.id === Number(meterId))?.label ?? meterId} (${r.unit})`,
                      `Measure in-service date: ${r.installDate}`,
                      `Baseline: ${r.baselineMonths} months pre-install · Reporting: ${r.reportingMonths} months`,
                      `Model fit: R² ${r.model.rSquared?.toFixed(2) ?? "n/a"}, CV(RMSE) ${r.model.cvrmse != null ? Math.round(r.model.cvrmse * 100) + "%" : "n/a"} — ${r.model.meetsAshraeGate ? "meets" : "below"} ASHRAE Guideline 14 gate`,
                      `Verified avoided usage: ${fmtNum(r.totalAvoidedUnits)} ${r.unit} (± ${fmtNum(r.uncertaintyUnits)} ${r.unit})`,
                      r.avoidedCostUsd != null ? `Avoided cost: ${fmtUsd(r.avoidedCostUsd)}${r.ratePerUnit != null ? ` @ $${r.ratePerUnit}/${r.unit.replace(/s$/, "")}` : ""}` : null,
                      ``,
                      ...r.disclosures.map((d) => `Note: ${d}`),
                    ]
                      .filter((l): l is string => l != null)
                      .join("\n");
                    navigator.clipboard.writeText(summary).then(
                      () => toast.success("M&V summary copied — paste into program paperwork"),
                      () => toast.error("Copy failed — your browser blocked clipboard access"),
                    );
                  }}
                >
                  <Copy className="h-3 w-3" /> Copy summary
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={() => {
                    const esc = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
                    const lines = [
                      ["month", `predicted_baseline_${r.unit}`, `measured_${r.unit}`, `avoided_${r.unit}`].map(esc).join(","),
                      ...r.rows.map((row) => [row.month, row.predicted, row.measured, row.avoided].map(esc).join(",")),
                      "",
                      [esc("total_avoided"), esc(r.totalAvoidedUnits), esc("uncertainty_units"), esc(r.uncertaintyUnits)].join(","),
                      [esc("r_squared"), esc(r.model.rSquared ?? ""), esc("cvrmse"), esc(r.model.cvrmse ?? "")].join(","),
                      [esc("method"), esc("IPMVP Option C / CalTRACK monthly"), esc("ashrae_g14_gate"), esc(r.model.meetsAshraeGate ? "pass" : "below")].join(","),
                    ];
                    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `mv-verified-savings-meter${meterId}-${r.installDate}.csv`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  <Download className="h-3 w-3" /> CSV
                </Button>
              </div>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {r.baselineMonths} baseline mo · {r.reportingMonths} reporting mo
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                R² {r.model.rSquared != null ? r.model.rSquared.toFixed(2) : "—"} · CV(RMSE){" "}
                {r.model.cvrmse != null ? `${Math.round(r.model.cvrmse * 100)}%` : "—"}
              </Badge>
              {r.model.meetsAshraeGate ? (
                <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15">meets ASHRAE G14 gate</Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600">
                  <ShieldAlert className="h-3 w-3" /> below program gate
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <p className="font-mono text-[10px] uppercase text-muted-foreground">Verified avoided usage</p>
                <p className="font-display text-lg font-bold">
                  {fmtNum(r.totalAvoidedUnits)} <span className="text-xs font-normal" translate="no">{r.unit}</span>
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">± {fmtNum(r.uncertaintyUnits)} {r.unit} (model CV)</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase text-muted-foreground">Avoided cost</p>
                <p className="font-display text-lg font-bold">{r.avoidedCostUsd != null ? fmtUsd(r.avoidedCostUsd) : "—"}</p>
                {r.ratePerUnit != null && (
                  <p className="font-mono text-[10px] text-muted-foreground" translate="no">
                    @ ${r.ratePerUnit}/{r.unit === "gallons" ? "gal" : r.unit.replace(/s$/, "")}
                  </p>
                )}
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase text-muted-foreground">Install date</p>
                <p className="font-display text-lg font-bold">{r.installDate}</p>
                <p className="font-mono text-[10px] text-muted-foreground">{r.model.confidenceLabel}</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[10px] uppercase text-muted-foreground">
                    <th className="py-1.5 pr-3">Month</th>
                    <th className="py-1.5 pr-3">Predicted baseline</th>
                    <th className="py-1.5 pr-3">Measured</th>
                    <th className="py-1.5">Avoided</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row) => (
                    <tr key={row.month} className="border-b border-border/50 font-mono">
                      <td className="py-1.5 pr-3">{row.month}</td>
                      <td className="py-1.5 pr-3">{fmtNum(row.predicted)}</td>
                      <td className="py-1.5 pr-3">{fmtNum(row.measured)}</td>
                      <td className={`py-1.5 font-semibold ${row.avoided >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                        {row.avoided >= 0 ? "" : "−"}
                        {fmtNum(Math.abs(row.avoided))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="space-y-1 border-t border-border pt-2">
              {r.disclosures.map((d, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                  • {d}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
