/**
 * Tariff library — seeded AZ utility rates (URDB snapshot) with honest
 * freshness + eligibility disclosure, and assignment to site meters.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Receipt } from "lucide-react";
import { ProvChip } from "@/components/Honesty";

export default function Tariffs() {
  const tariffs = trpc.tariffs.list.useQuery({});
  const sites = trpc.sites.list.useQuery();
  const [siteId, setSiteId] = useState<string>("");
  const activeSiteId = siteId ? Number(siteId) : (sites.data?.[0]?.id ?? null);
  const meters = trpc.sites.meters.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const utils = trpc.useUtils();
  const assign = trpc.sites.setMeterTariff.useMutation({
    onSuccess: async () => {
      toast.success("Tariff assigned to meter");
      await utils.sites.meters.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const eligibilityNote = tariffs.data?.[0]?.eligibilityNote;

  return (
    <div className="container max-w-5xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Tariff library</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Seeded Arizona rates (APS, SRP, TEP) from a URDB-style snapshot. Assign a rate to a meter, then re-run analysis for
        an exact-rules bill simulation.
      </p>
      {eligibilityNote && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
          {eligibilityNote}
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-[240px_1fr]">
        <div>
          <label className="text-sm font-medium">Assign to site</label>
          <Select value={activeSiteId != null ? String(activeSiteId) : ""} onValueChange={setSiteId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select site…" />
            </SelectTrigger>
            <SelectContent>
              {(sites.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(meters.data ?? []).length === 0 && activeSiteId != null && (
            <p className="mt-2 text-xs text-muted-foreground">No meters on this site yet — upload interval data first.</p>
          )}
        </div>
      </div>

      <Card className="mt-6 border-border/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Receipt className="h-4 w-4 text-primary" /> Available rates
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tariffs.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-xs">Utility</TableHead>
                  <TableHead className="font-mono text-xs">Rate</TableHead>
                  <TableHead className="font-mono text-xs">Sector</TableHead>
                  <TableHead className="font-mono text-xs">Features</TableHead>
                  <TableHead className="font-mono text-xs">Freshness</TableHead>
                  <TableHead className="font-mono text-xs">Assign</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tariffs.data ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-sm">{t.utilityName}</TableCell>
                    <TableCell className="max-w-64 text-sm">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {t.sector}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {t.hasRatchet && <ProvChip>ratchet</ProvChip>}
                        {t.hasCp && <ProvChip>CP charge</ProvChip>}
                        {t.peakKwMin != null && <ProvChip>≥{t.peakKwMin} kW</ProvChip>}
                        {t.peakKwMax != null && <ProvChip>≤{t.peakKwMax} kW</ProvChip>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-[10px] text-muted-foreground">{t.freshness}</span>
                    </TableCell>
                    <TableCell>
                      {(meters.data ?? []).length > 0 ? (
                        <Select
                          onValueChange={(mid) => assign.mutate({ meterId: Number(mid), tariffId: t.id })}
                        >
                          <SelectTrigger className="h-8 w-36 text-xs">
                            <SelectValue placeholder="Pick meter…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(meters.data ?? []).map((m) => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {m.label} {m.currentTariffId === t.id ? "✓" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Button size="sm" variant="ghost" disabled>
                          No meters
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
