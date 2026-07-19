import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { CheckCircle2, FileSpreadsheet, FileUp, Receipt, Trash2, XCircle } from "lucide-react";
import { fileToBase64 } from "@/lib/wattwiseUi";
import { DisclaimerBanner } from "@/components/Honesty";
import { Link } from "wouter";

type Fmt = "xlsx" | "csv" | "espi_xml" | "zip" | "auto";

// Extension is only a HINT — the server re-verifies content via magic bytes
// and routes accordingly, so extensionless Green Button files ("HourlyIntervalData")
// and mislabeled exports still ingest via "auto".
function detectFormat(name: string): Fmt {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return "xlsx";
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".xml")) return "espi_xml";
  if (n.endsWith(".zip")) return "zip";
  return "auto";
}

export default function Upload() {
  const utils = trpc.useUtils();
  const sites = trpc.sites.list.useQuery();
  const uploads = trpc.uploads.list.useQuery();
  const [siteId, setSiteId] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const billRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [billManual, setBillManual] = useState<null | { reason: string }>(null);
  const [manualBill, setManualBill] = useState({ periodStart: "", periodEnd: "", totalUsage: "", totalCost: "", billedDemandKw: "" });

  const ingest = trpc.uploads.ingest.useMutation();
  const billOcr = trpc.uploads.billOcr.useMutation();
  const delUpload = trpc.uploads.delete.useMutation({
    onSuccess: async (res) => {
      toast.success(`Upload deleted — ${res.removedIntervals.toLocaleString()} readings removed`);
      await utils.uploads.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const billCreate = trpc.bills.create.useMutation();

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!siteId) {
      toast.error("Pick a site first");
      return;
    }
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const fmt = detectFormat(f.name);
        const b64 = await fileToBase64(f);
        const res = await ingest.mutateAsync({ siteId: Number(siteId), filename: f.name, format: fmt, contentBase64: b64 });
        if (res.duplicate) toast.info(`${f.name}: already ingested (duplicate checksum) — skipped`);
        else toast.success(`${f.name}: ${res.totalPoints.toLocaleString()} interval points across ${res.meters.length} meter(s)`);
      }
      await utils.uploads.list.invalidate();
      await utils.sites.meters.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onBill(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!siteId) {
      toast.error("Pick a site first");
      return;
    }
    const f = files[0];
    const mime = f.type === "application/pdf" ? "application/pdf" : f.type === "image/png" ? "image/png" : "image/jpeg";
    setBusy(true);
    try {
      const b64 = await fileToBase64(f);
      const res = await billOcr.mutateAsync({ siteId: Number(siteId), filename: f.name, contentBase64: b64, mime });
      if (res.status === "manual_entry_required") {
        setBillManual({ reason: res.reason });
        toast.warning("Automatic bill parsing unavailable — enter the bill manually below.");
      } else {
        const b = res.bill;
        toast.success(`Bill parsed (confidence ${(b.overallConfidence * 100).toFixed(0)}%) — review the extracted values`);
        setManualBill({
          periodStart: b.periodStart.value ?? "",
          periodEnd: b.periodEnd.value ?? "",
          totalUsage: b.totalUsage.value != null ? String(b.totalUsage.value) : "",
          totalCost: b.totalCostUsd.value != null ? String(b.totalCostUsd.value) : "",
          billedDemandKw: b.billedDemandKw.value != null ? String(b.billedDemandKw.value) : "",
        });
        setBillManual({
          reason: res.needsReview
            ? "Low-confidence fields — verify every value against the paper bill before saving."
            : "Review extracted values before saving.",
        });
      }
    } catch (e) {
      setBillManual({ reason: e instanceof Error ? e.message : "Parsing failed" });
      toast.warning("Bill parsing failed — manual entry enabled.");
    } finally {
      setBusy(false);
      if (billRef.current) billRef.current.value = "";
    }
  }

  async function saveManualBill() {
    try {
      // bills key on a meter; use (or lazily rely on server default) first electric meter of the site
      const meters = await utils.sites.meters.fetch({ siteId: Number(siteId) });
      const meter = meters.find((m) => m.commodity === "electric") ?? meters[0];
      if (!meter) {
        toast.error("This site has no meter yet — upload an interval file first, or create the site via the wizard.");
        return;
      }
      await billCreate.mutateAsync({
        meterId: meter.id,
        periodStart: manualBill.periodStart,
        periodEnd: manualBill.periodEnd,
        totalUsage: Number(manualBill.totalUsage),
        usageUnit: "kWh",
        totalCostUsd: Number(manualBill.totalCost),
        billedDemandKw: manualBill.billedDemandKw ? Number(manualBill.billedDemandKw) : undefined,
      });
      toast.success("Bill saved");
      setBillManual(null);
      setManualBill({ periodStart: "", periodEnd: "", totalUsage: "", totalCost: "", billedDemandKw: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    }
  }

  return (
    <div className="container max-w-5xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Upload data</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Interval files (Excel, CSV, Green Button XML, or the zip bundle straight from your utility's download portal) and utility bills. Every point is stored with provenance.
      </p>
      <div className="mt-4">
        <DisclaimerBanner />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-[240px_1fr]">
        <div>
          <Label>Target site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
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
          {(sites.data ?? []).length === 0 && !sites.isLoading && (
            <p className="mt-2 text-xs text-muted-foreground">
              No sites yet — <Link href="/app/sites" className="text-primary underline">create one</Link> first.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card
            className="cursor-pointer border-dashed border-primary/40 transition-colors hover:border-primary"
            onClick={() => fileRef.current?.click()}
          >
            <CardContent className="flex flex-col items-center py-8 text-center">
              <FileSpreadsheet className="h-8 w-8 text-primary" />
              <p className="mt-3 font-medium">Interval files</p>
              <p className="mt-1 text-xs text-muted-foreground">.xlsx multi-sheet · .csv · Green Button .xml · .zip bundles</p>
              <Button size="sm" className="mt-4" disabled={busy || !siteId}>
                <FileUp className="mr-1 h-4 w-4" /> {busy ? "Parsing…" : "Choose files"}
              </Button>
              <input ref={fileRef} type="file" hidden multiple accept=".xlsx,.xls,.csv,.xml,.zip" onChange={(e) => onFiles(e.target.files)} />
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer border-dashed border-border transition-colors hover:border-primary"
            onClick={() => billRef.current?.click()}
          >
            <CardContent className="flex flex-col items-center py-8 text-center">
              <Receipt className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">Bill image / PDF</p>
              <p className="mt-1 text-xs text-muted-foreground">OCR + AI extraction; falls back to manual entry</p>
              <Button size="sm" variant="outline" className="mt-4" disabled={busy || !siteId}>
                <FileUp className="mr-1 h-4 w-4" /> {busy ? "Reading…" : "Choose bill"}
              </Button>
              <input ref={billRef} type="file" hidden accept=".png,.jpg,.jpeg,.pdf" onChange={(e) => onBill(e.target.files)} />
            </CardContent>
          </Card>
        </div>
      </div>

      {billManual && (
        <Card className="mt-6 border-amber-500/40">
          <CardHeader>
            <CardTitle className="font-display text-base">Bill entry</CardTitle>
            <p className="text-xs text-muted-foreground">{billManual.reason}</p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-5">
            <div>
              <Label htmlFor="b-start">Period start</Label>
              <Input id="b-start" type="date" value={manualBill.periodStart} onChange={(e) => setManualBill({ ...manualBill, periodStart: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-end">Period end</Label>
              <Input id="b-end" type="date" value={manualBill.periodEnd} onChange={(e) => setManualBill({ ...manualBill, periodEnd: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-usage">Usage (kWh)</Label>
              <Input id="b-usage" type="number" value={manualBill.totalUsage} onChange={(e) => setManualBill({ ...manualBill, totalUsage: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-cost">Total cost ($)</Label>
              <Input id="b-cost" type="number" value={manualBill.totalCost} onChange={(e) => setManualBill({ ...manualBill, totalCost: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-demand">Billed demand (kW)</Label>
              <Input id="b-demand" type="number" value={manualBill.billedDemandKw} onChange={(e) => setManualBill({ ...manualBill, billedDemandKw: e.target.value })} />
            </div>
            <div className="sm:col-span-5 flex gap-2">
              <Button onClick={saveManualBill} disabled={!manualBill.periodStart || !manualBill.periodEnd || !manualBill.totalUsage || !manualBill.totalCost || billCreate.isPending}>
                Save bill
              </Button>
              <Button variant="ghost" onClick={() => setBillManual(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mt-8 border-border/70">
        <CardHeader>
          <CardTitle className="font-display text-base">Upload history</CardTitle>
        </CardHeader>
        <CardContent>
          {uploads.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-xs">File</TableHead>
                  <TableHead className="font-mono text-xs">Parser</TableHead>
                  <TableHead className="font-mono text-xs">Rows</TableHead>
                  <TableHead className="font-mono text-xs">Validation</TableHead>
                  <TableHead className="font-mono text-xs">Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(uploads.data ?? []).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="max-w-56 truncate font-mono text-xs">{u.filename}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{u.parser}@{u.parserVersion}</TableCell>
                    <TableCell className="font-mono text-xs">{u.rowsIngested ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {u.status === "parsed" ? (
                        (u.parseConfidence ?? 0) >= 1 ? (
                          <span className="flex items-center gap-1 text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> footer totals matched</span>
                        ) : (
                          <span className="text-amber-500">partial validation</span>
                        )
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {u.status === "parsed" ? (
                        <span className="text-emerald-500">parsed</span>
                      ) : u.status === "failed" ? (
                        <span className="flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5" /> {u.error?.slice(0, 60)}</span>
                      ) : (
                        u.status
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title="Delete upload (removes its ingested readings and bills)"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete “${u.filename}”? Every interval reading and bill ingested from this file will be removed, and affected analyses should be re-run. This cannot be undone.`,
                            )
                          ) {
                            delUpload.mutate({ uploadId: u.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
                {(uploads.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      Nothing uploaded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
