import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { CheckCircle2, FileSpreadsheet, FileUp, Loader2, Receipt, Trash2, XCircle } from "lucide-react";
import { fileToBase64 } from "@/lib/wattwiseUi";
import { isTransient, plainError, sleep, uploadClient, uploadRaw } from "@/lib/uploadClient";
import { Progress } from "@/components/ui/progress";
import { DisclaimerBanner } from "@/components/Honesty";
import { useActiveSite, useSiteRequestGuard } from "@/hooks/useActiveSite";
import { BulkImportPanel } from "@/components/BulkImportPanel";
import { Link } from "wouter";
import { usageConversion } from "@shared/commodity";

type Fmt = "xlsx" | "csv" | "espi_xml" | "zip" | "auto";
type Commodity = "electric" | "gas" | "water";
const USAGE_UNIT: Record<Commodity, string> = { electric: "kWh", gas: "therms", water: "gallons" };
const COMMODITY_LABEL: Record<Commodity, string> = { electric: "Electric", gas: "Natural gas", water: "Water" };
/** UCONV-1: units a bill may state; the server stores usage in the first
 * (model) unit and converts the others (CCF → therms or gallons, kgal → gallons). */
const BILL_UNITS: Record<Commodity, string[]> = { electric: ["kWh"], gas: ["therms", "CCF"], water: ["gallons", "kgal", "CCF"] };
/** Map an OCR-read unit to one of BILL_UNITS for the chosen utility. */
function billUnitFromOcr(unit: string, c: Commodity): string {
  const u = unit.toLowerCase();
  if (c === "gas" && /ccf|hcf/.test(u)) return "CCF";
  if (c === "water" && /kgal|thousand/.test(u)) return "kgal";
  if (c === "water" && /ccf|hcf/.test(u)) return "CCF";
  return BILL_UNITS[c][0];
}

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
  const { activeSiteId, sites, setActiveSite } = useActiveSite();
  const captureSiteRequest = useSiteRequestGuard(activeSiteId);
  const uploads = trpc.uploads.list.useQuery();
  const siteId = activeSiteId != null ? String(activeSiteId) : "";
  const fileRef = useRef<HTMLInputElement>(null);
  const billRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // R2 #2: the source timestamp convention is explicit, never silently assumed.
  const [clockBasis, setClockBasis] = useState<"auto" | "start" | "end">("auto");
  const [mode, setMode] = useState<"single" | "bulk">(() => (new URLSearchParams(window.location.search).get("mode") === "bulk" ? "bulk" : "single"));
  // UNF-1: an unfinished bulk import continues only while its panel is open, so
  // open Many-sites once when one exists (unless the link asked for a mode).
  const unfinishedBulk = trpc.bulkImport.unfinished.useQuery(undefined, { staleTime: 10_000 });
  const autoOpenedBulk = useRef(new URLSearchParams(window.location.search).has("mode"));
  useEffect(() => {
    if (autoOpenedBulk.current || !unfinishedBulk.data) return;
    autoOpenedBulk.current = true;
    if (unfinishedBulk.data.batches.length > 0) setMode("bulk");
  }, [unfinishedBulk.data]);
  // TEL-1: links from "Utility services on this site" carry ?commodity=gas|water|electric;
  // that utility is preselected for interval files and bills (changeable here).
  const [commodity, setCommodity] = useState<"auto" | Commodity>(() => {
    const c = new URLSearchParams(window.location.search).get("commodity");
    return c === "electric" || c === "gas" || c === "water" ? c : "auto";
  });
  const [billCommodity, setBillCommodityRaw] = useState<Commodity>(() => (commodity === "auto" ? "electric" : commodity));
  const [billUnit, setBillUnit] = useState<string>(() => BILL_UNITS[commodity === "auto" ? "electric" : commodity][0]);
  const setBillCommodity = (c: Commodity, unit?: string) => {
    setBillCommodityRaw(c);
    setBillUnit(unit && BILL_UNITS[c].includes(unit) ? unit : BILL_UNITS[c][0]);
  };
  const [billManual, setBillManual] = useState<null | { reason: string }>(null);
  const [manualBill, setManualBill] = useState({ periodStart: "", periodEnd: "", totalUsage: "", totalCost: "", billedDemandKw: "" });
  // Oct 25: large workbooks import sheet-by-sheet in short server requests.
  const [importing, setImporting] = useState<null | { filename: string; sheetsDone: number; sheetsTotal: number; note?: string }>(null);
  const [choice, setChoice] = useState<null | { uploadId: number; filename: string; addresses: number; examples: string[]; sheets: number }>(null);

  useEffect(() => {
    setBusy(false);
    setBillManual(null);
    setManualBill({ periodStart: "", periodEnd: "", totalUsage: "", totalCost: "", billedDemandKw: "" });
    setImporting(null);
    setChoice(null);
  }, [activeSiteId]);

  const billOcr = trpc.uploads.billOcr.useMutation();
  const delUpload = trpc.uploads.delete.useMutation({
    onSuccess: async (res) => {
      toast.success(`Upload deleted — ${res.removedIntervals.toLocaleString()} readings removed`);
      await utils.uploads.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const billCreate = trpc.bills.create.useMutation();
  const createMeter = trpc.sites.createMeter.useMutation();

  type IngestResult = Awaited<ReturnType<typeof uploadClient.uploads.ingest.mutate>>;
  /** Keep calling the server until the sliced import finishes (or needs a choice). */
  async function driveIngest(filename: string, first: () => Promise<IngestResult>, isCurrent: () => boolean): Promise<IngestResult | null> {
    let res: IngestResult | null = null;
    let errors = 0;
    let call: () => Promise<IngestResult> = first;
    for (;;) {
      try {
        res = await call();
        errors = 0;
      } catch (e) {
        // Only an already-created upload can be continued; a first call that
        // never reached the server is retried as a whole (same bytes resume).
        if (!isTransient(e) || ++errors > 6) throw e;
        setImporting((p) => ({ filename, sheetsDone: p?.sheetsDone ?? 0, sheetsTotal: p?.sheetsTotal ?? 0, note: `Server busy — retrying (${errors}/6)…` }));
        await sleep(Math.min(20_000, 1500 * errors * errors));
        continue;
      }
      if (!isCurrent()) return null;
      if (res.progress) setImporting({ filename, sheetsDone: res.progress.sheetsDone, sheetsTotal: res.progress.sheetsTotal, note: res.busy ? "Waiting for the previous step to finish…" : undefined });
      if (res.needsChoice || !res.more) return res;
      const uploadId = res.uploadId;
      if (res.busy) await sleep(3000);
      call = () => uploadClient.uploads.ingestContinue.mutate({ uploadId });
    }
  }
  function reportResult(filename: string, res: IngestResult) {
    if (res.duplicate) toast.info(`${filename}: already ingested (duplicate checksum) — skipped`);
    else {
      // Oct 25 (cost audit): say which start/end convention was applied.
      const notes = (res.validations ?? []).flatMap((v) => (v as { notes?: string[] }).notes ?? []);
      const detected = notes.find((n) => n.startsWith("Timestamps were detected as the ") || n.startsWith("Could not tell from the readings"));
      toast.success(`${filename}: ${res.totalPoints.toLocaleString()} interval points across ${res.meters.length} meter(s)`, detected ? { description: detected } : undefined);
    }
  }

  async function onFiles(files: FileList | null) {
    if (busy || !files || files.length === 0) return;
    if (!siteId) {
      toast.error("Pick a site first");
      return;
    }
    const isCurrent = captureSiteRequest();
    setBusy(true);
    setChoice(null);
    try {
      for (const f of Array.from(files)) {
        const fmt = detectFormat(f.name);
        if (f.size > 50 * 1024 * 1024) { toast.error(`${f.name}: the limit is 50 MiB per file.`); continue; }
        setImporting({ filename: f.name, sheetsDone: 0, sheetsTotal: 0 });
        try {
          // Raw bytes stream to storage (no base64 copy in the browser or server).
          setImporting({ filename: f.name, sheetsDone: 0, sheetsTotal: 0, note: "Uploading file…" });
          const { sourceRef } = await uploadRaw(
            f,
            (n, max) => setImporting({ filename: f.name, sheetsDone: 0, sheetsTotal: 0, note: `Connection interrupted — retrying (${n}/${max}); saved parts are kept…` }),
            (sent, total) => setImporting({ filename: f.name, sheetsDone: 0, sheetsTotal: 0, note: total > 0 && sent < total ? `Uploading file… ${Math.floor((100 * sent) / total)}%` : "Uploading file…" }),
          );
          if (!isCurrent()) return;
          setImporting({ filename: f.name, sheetsDone: 0, sheetsTotal: 0, note: "Reading workbook…" });
          const res = await driveIngest(f.name, () => uploadClient.uploads.ingest.mutate({ siteId: Number(siteId), filename: f.name, format: fmt, sourceRef, timestampBasis: clockBasis, askOnMultiAddress: true, ...(commodity !== "auto" ? { commodityHint: commodity } : {}) }), isCurrent);
          if (!res || !isCurrent()) return;
          if (res.needsChoice) {
            setChoice({ uploadId: res.uploadId, filename: f.name, ...res.needsChoice });
            break; // wait for the user's decision before any further files
          }
          reportResult(f.name, res);
        } catch (e) {
          if (!isCurrent()) return;
          toast.error(`${f.name}: ${plainError(e, "Upload failed")}`);
        }
      }
      await utils.uploads.list.invalidate();
      await utils.sites.meters.invalidate();
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setImporting(null);
        if (fileRef.current) fileRef.current.value = "";
      }
    }
  }

  /** Continue an unfinished import (after a reload, or after the multi-address choice). */
  async function continueUpload(uploadId: number, filename: string, confirmMultiAddress = false) {
    if (busy) return;
    const isCurrent = captureSiteRequest();
    setBusy(true);
    setChoice(null);
    setImporting({ filename, sheetsDone: 0, sheetsTotal: 0 });
    try {
      const res = await driveIngest(filename, () => uploadClient.uploads.ingestContinue.mutate({ uploadId, confirmMultiAddress }), isCurrent);
      if (!res || !isCurrent()) return;
      if (res.needsChoice) setChoice({ uploadId, filename, ...res.needsChoice });
      else reportResult(filename, res);
    } catch (e) {
      if (isCurrent()) toast.error(`${filename}: ${plainError(e, "Upload failed")}`);
    } finally {
      await utils.uploads.list.invalidate();
      await utils.sites.meters.invalidate();
      if (isCurrent()) { setBusy(false); setImporting(null); }
    }
  }
  /** "Set up separate sites" — discard the pending single-site copy and open bulk setup. */
  async function chooseSeparateSites(uploadId: number, filename: string) {
    setChoice(null);
    try { await uploadClient.uploads.delete.mutate({ uploadId }); } catch { /* already gone */ }
    await utils.uploads.list.invalidate();
    setMode("bulk");
    toast.info(`Add “${filename}” here — each service address becomes its own site.`);
  }

  async function onBill(files: FileList | null) {
    if (busy || !files || files.length === 0) return;
    if (!siteId) {
      toast.error("Pick a site first");
      return;
    }
    const isCurrent = captureSiteRequest();
    const f = files[0];
    const mime = f.type === "application/pdf" ? "application/pdf" : f.type === "image/png" ? "image/png" : "image/jpeg";
    setBusy(true);
    try {
      const b64 = await fileToBase64(f);
      if (!isCurrent()) return;
      const res = await billOcr.mutateAsync({ siteId: Number(siteId), filename: f.name, contentBase64: b64, mime });
      if (!isCurrent()) return;
      if (res.status === "manual_entry_required") {
        setBillCommodity(commodity === "auto" ? "electric" : commodity);
        setBillManual({ reason: res.reason });
        toast.warning("Automatic bill parsing unavailable — enter the bill manually below.");
      } else {
        const b = res.bill;
        const unit = (b.usageUnit?.value ?? "").toLowerCase();
        const billC: Commodity = commodity !== "auto" ? commodity : /therm|ccf|mcf|dth/.test(unit) ? "gas" : /gal|kgal/.test(unit) ? "water" : "electric";
        setBillCommodity(billC, billUnitFromOcr(unit, billC));
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
      if (!isCurrent()) return;
      setBillCommodity(commodity === "auto" ? "electric" : commodity);
      setBillManual({ reason: e instanceof Error ? e.message : "Parsing failed" });
      toast.warning("Bill parsing failed — manual entry enabled.");
    } finally {
      if (isCurrent()) {
        setBusy(false);
        if (billRef.current) billRef.current.value = "";
      }
    }
  }

  async function saveManualBill() {
    if (busy || !siteId) return;
    const isCurrent = captureSiteRequest();
    setBusy(true);
    try {
      // TEL-1: a bill keys on a meter of the bill's utility (main first, never a
      // derived campus total); a site with no meter for that utility gets one.
      const meters = await utils.sites.meters.fetch({ siteId: Number(siteId) });
      if (!isCurrent()) return;
      const ofKind = meters.filter((m) => m.commodity === billCommodity && m.meterRole !== "virtual_total");
      let meterId = (ofKind.find((m) => m.meterRole === "main") ?? ofKind.find((m) => !["submeter", "generation", "ev"].includes(m.meterRole)) ?? ofKind[0])?.id;
      if (meterId == null) {
        meterId = (await createMeter.mutateAsync({ siteId: Number(siteId), commodity: billCommodity, label: `${COMMODITY_LABEL[billCommodity]} (from bills)` })).id;
        if (!isCurrent()) return;
      }
      await billCreate.mutateAsync({
        meterId,
        periodStart: manualBill.periodStart,
        periodEnd: manualBill.periodEnd,
        totalUsage: Number(manualBill.totalUsage),
        usageUnit: BILL_UNITS[billCommodity].includes(billUnit) ? billUnit : USAGE_UNIT[billCommodity],
        totalCostUsd: Number(manualBill.totalCost),
        billedDemandKw: billCommodity === "electric" && manualBill.billedDemandKw ? Number(manualBill.billedDemandKw) : undefined,
      });
      await utils.sites.meters.invalidate();
      if (!isCurrent()) return;
      toast.success("Bill saved");
      setBillManual(null);
      setManualBill({ periodStart: "", periodEnd: "", totalUsage: "", totalCost: "", billedDemandKw: "" });
    } catch (e) {
      if (!isCurrent()) return;
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      if (isCurrent()) setBusy(false);
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
      <div className="mt-6 inline-flex rounded-md border p-0.5" role="group" aria-label="Upload mode">
        {([["single", "One site"], ["bulk", "Many sites (bulk setup)"]] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            data-testid={`upload-mode-${m}`}
            className={`rounded px-3 py-1.5 text-sm transition-colors ${mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "bulk" ? (
        <div className="mt-4">
          <BulkImportPanel />
        </div>
      ) : (
      <>

      <div className="mt-6 grid gap-4 md:grid-cols-[240px_1fr]">
        <div>
          <Label>Target site</Label>
          <Select disabled={busy} value={siteId} onValueChange={(value) => setActiveSite(Number(value))}>
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
          <Label htmlFor="single-commodity" className="mt-3 block">Utility</Label>
          <Select disabled={busy} value={commodity} onValueChange={(v) => setCommodity(v === "electric" || v === "gas" || v === "water" ? v : "auto")}>
            <SelectTrigger id="single-commodity" className="mt-1" aria-label="Utility for this upload" data-testid="upload-commodity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Detect from the file</SelectItem>
              <SelectItem value="electric">Electric</SelectItem>
              <SelectItem value="gas">Natural gas</SelectItem>
              <SelectItem value="water">Water</SelectItem>
            </SelectContent>
          </Select>
          <Label htmlFor="single-clock-basis" className="mt-3 block">Interval timestamps mark the</Label>
          <Select disabled={busy} value={clockBasis} onValueChange={(v) => setClockBasis(v === "end" ? "end" : v === "start" ? "start" : "auto")}>
            <SelectTrigger id="single-clock-basis" className="mt-1" aria-label="Source interval timestamp convention (single upload)">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Detect from the readings (recommended)</SelectItem>
              <SelectItem value="start">Interval START</SelectItem>
              <SelectItem value="end">Interval END (common in utility exports)</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground">Local clock is the site's meter timezone. Detection reads the first and last readings — a file that runs 00:15 … 00:00 is END-labeled; 00:00 … 23:45 is START-labeled. The result is shown with each upload. Choose explicitly only if your utility says otherwise.</p>
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

      {importing && (
        <Card className="mt-6 border-primary/40" role="status" aria-live="polite" data-testid="single-import-progress">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              Importing {importing.filename}
              {importing.sheetsTotal > 0 && <span className="font-normal text-muted-foreground">— sheet {Math.min(importing.sheetsDone + 1, importing.sheetsTotal)} of {importing.sheetsTotal}</span>}
            </div>
            <Progress className="mt-3" value={importing.sheetsTotal > 0 ? (100 * importing.sheetsDone) / importing.sheetsTotal : 5} aria-label="Import progress" />
            <p className="mt-2 text-xs text-muted-foreground">
              {importing.note ?? "Large workbooks import one sheet at a time. Keep this page open — if the connection drops, choose the same file again and it picks up where it left off."}
            </p>
          </CardContent>
        </Card>
      )}

      {choice && (
        <Card className="mt-6 border-amber-500/50" role="alertdialog" aria-labelledby="multi-address-title" data-testid="multi-address-choice">
          <CardHeader>
            <CardTitle id="multi-address-title" className="font-display text-base">This workbook covers {choice.addresses} service addresses</CardTitle>
            <p className="text-sm text-muted-foreground">
              {choice.filename} has {choice.sheets} sheets listing {choice.addresses} different addresses
              {choice.examples.length > 0 ? ` (for example ${choice.examples.join("; ")})` : ""}. Usually each address is its own building or campus. Nothing has been imported yet.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button data-testid="choice-separate-sites" onClick={() => void chooseSeparateSites(choice.uploadId, choice.filename)}>
              Set up a separate site for each address
            </Button>
            <Button variant="outline" data-testid="choice-this-site" onClick={() => void continueUpload(choice.uploadId, choice.filename, true)}>
              Add every sheet to {sites.data?.find((s) => String(s.id) === siteId)?.name ?? "this site"}
            </Button>
          </CardContent>
        </Card>
      )}

      {billManual && (
        <Card className="mt-6 border-amber-500/40">
          <CardHeader>
            <CardTitle className="font-display text-base">Bill entry</CardTitle>
            <p className="text-xs text-muted-foreground">{billManual.reason}</p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-5">
            <div className="sm:col-span-5 sm:max-w-56">
              <Label htmlFor="b-commodity">Utility</Label>
              <Select value={billCommodity} onValueChange={(v) => setBillCommodity(v === "gas" || v === "water" ? v : "electric")}>
                <SelectTrigger id="b-commodity" className="mt-1" data-testid="bill-commodity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="electric">Electric</SelectItem>
                  <SelectItem value="gas">Natural gas</SelectItem>
                  <SelectItem value="water">Water</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="b-start">Period start</Label>
              <Input id="b-start" type="date" value={manualBill.periodStart} onChange={(e) => setManualBill({ ...manualBill, periodStart: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-end">Period end</Label>
              <Input id="b-end" type="date" value={manualBill.periodEnd} onChange={(e) => setManualBill({ ...manualBill, periodEnd: e.target.value })} />
            </div>
            <div className={BILL_UNITS[billCommodity].length > 1 ? "sm:col-span-2" : undefined}>
              <Label htmlFor="b-usage">Usage ({BILL_UNITS[billCommodity].length > 1 ? billUnit : USAGE_UNIT[billCommodity]})</Label>
              <div className="mt-1 flex gap-1.5">
                <Input id="b-usage" type="number" className="mt-0 min-w-0" value={manualBill.totalUsage} onChange={(e) => setManualBill({ ...manualBill, totalUsage: e.target.value })} />
                {BILL_UNITS[billCommodity].length > 1 && (
                  <Select value={billUnit} onValueChange={setBillUnit}>
                    <SelectTrigger className="w-28 shrink-0" aria-label="Usage unit on the bill" data-testid="bill-unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BILL_UNITS[billCommodity].map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {(() => {
                const conv = usageConversion(billCommodity, billUnit);
                const n = Number(manualBill.totalUsage);
                if (conv.factor === 1 || !manualBill.totalUsage || !Number.isFinite(n)) return null;
                return (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="bill-unit-conversion">
                    Saved as {(n * conv.factor).toLocaleString(undefined, { maximumFractionDigits: 1 })} {conv.toUnit}
                    {billCommodity === "gas" ? " (U.S. average 1.037 therms per CCF; your bill may state its own factor)" : ""}.
                  </p>
                );
              })()}
            </div>
            <div>
              <Label htmlFor="b-cost">Total cost ($)</Label>
              <Input id="b-cost" type="number" value={manualBill.totalCost} onChange={(e) => setManualBill({ ...manualBill, totalCost: e.target.value })} />
            </div>
            {billCommodity === "electric" && (
              <div>
                <Label htmlFor="b-demand">Billed demand (kW)</Label>
                <Input id="b-demand" type="number" value={manualBill.billedDemandKw} onChange={(e) => setManualBill({ ...manualBill, billedDemandKw: e.target.value })} />
              </div>
            )}
            <div className="sm:col-span-5 flex gap-2">
              <Button onClick={saveManualBill} disabled={busy || !manualBill.periodStart || !manualBill.periodEnd || !manualBill.totalUsage || !manualBill.totalCost || billCreate.isPending}>
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
                          <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> footer totals matched</span>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-500">partial validation</span>
                        )
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {u.status === "parsed" ? (
                        <span className="text-emerald-700 dark:text-emerald-500">parsed</span>
                      ) : u.status === "failed" ? (
                        <span className="flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5" /> {u.error?.slice(0, 60)}</span>
                      ) : u.status === "pending" && u.progress ? (
                        u.progress.active || busy ? (
                          <span className="text-muted-foreground">importing {u.progress.sheetsDone}/{u.progress.sheetsTotal} sheets…</span>
                        ) : (
                          <button
                            type="button"
                            className="text-primary underline underline-offset-2"
                            data-testid={`continue-upload-${u.id}`}
                            onClick={() => (u.progress?.awaitingChoice && u.progress.choice
                              ? setChoice({ uploadId: u.id, filename: u.filename, ...u.progress.choice })
                              : void continueUpload(u.id, u.filename))}
                          >
                            {u.progress.awaitingChoice ? "Needs your choice — review" : `Paused at ${u.progress.sheetsDone}/${u.progress.sheetsTotal} sheets — continue`}
                          </button>
                        )
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
      </>
      )}
    </div>
  );
}
