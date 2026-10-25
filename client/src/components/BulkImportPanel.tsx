/**
 * BULK-1 (Oct 2026) — "Set up many sites at once".
 * Add any number of workbooks (sheets may be split across files in any order),
 * preview how sheets group into sites (one site per physical address, one
 * meter per service agreement), adjust, then import with live progress.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { COOKIE_NAME } from "@shared/const";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { fileToBase64, fmtNum } from "@/lib/wattwiseUi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Building2, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, Layers, Loader2, MapPin, Trash2, Upload as UploadIcon, XCircle } from "lucide-react";

const uploadClient = createTRPCProxyClient<AppRouter>({ links: [httpLink({url:"/api/trpc",transformer:superjson,
  headers() { try { const raw=sessionStorage.getItem("manus-cookie"); const pair=raw?.split(";").find(s=>s.trim().startsWith(`${COOKIE_NAME}=`)); const token=pair?.trim().slice(COOKIE_NAME.length+1); return token ? {Authorization:`Bearer ${token}`} : {}; } catch { return {}; } },
  fetch: (input,init) => fetch(input,{...init,credentials:"include"}),
})] });
const BUILDING_TYPES: Array<[string, string]> = [
  ["", "Leave unset (add later)"],
  ["school", "K-12 school"],
  ["office", "Office"],
  ["retail", "Retail"],
  ["warehouse", "Warehouse"],
  ["grocery", "Grocery"],
  ["restaurant", "Restaurant"],
  ["hotel", "Hotel"],
  ["hospital", "Hospital"],
  ["manufacturing", "Manufacturing"],
  ["multifamily", "Multifamily"],
];

type StagedFile = { fileId: number; filename: string; sheets: number; skippedSheets?: number; sizeBytes: number; duplicate?: boolean };
type PreviewResult = Awaited<ReturnType<ReturnType<typeof trpc.useUtils>["client"]["bulkImport"]["preview"]["mutate"]>>;

function fmtBytes(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function BulkImportPanel() {
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [staging, setStaging] = useState<string | null>(null);
  const [mode, setMode] = useState<"campus" | "building">("campus");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [overrides, setOverrides] = useState<Record<number, number | string | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [entityName, setEntityName] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [runAnalysis, setRunAnalysis] = useState(true);
  const editorLock = useRef(false);
  const [timeZone, setTimeZone] = useState("");
  const [timestampBasis, setTimestampBasis] = useState<"start"|"end">("start");
  const [clockConfirmed, setClockConfirmed] = useState(false);
  const [committedId, setCommittedId] = useState<number | null>(null);

  const stage = trpc.bulkImport.stageFile.useMutation();
  const remove = trpc.bulkImport.removeFile.useMutation();
  const previewM = trpc.bulkImport.preview.useMutation();
  const commitM = trpc.bulkImport.commit.useMutation();
  const sitesQ = trpc.sites.list.useQuery();
  const recent = trpc.bulkImport.list.useQuery(undefined, { staleTime: 10_000 });

  // resume a running import after navigation/reload
  useEffect(() => {
    if (committedId == null && batchId == null) {
      const live = recent.data?.find((b) => b.status === "committing");
      if (live) setCommittedId(live.id);
    }
  }, [recent.data, committedId, batchId]);

  const statusQ = trpc.bulkImport.status.useQuery(
    { batchId: committedId ?? 0 },
    {
      enabled: committedId != null,
      refetchInterval: (q) => {
        const s = q.state.data?.batch.status;
        return s === "committing" ? 1500 : false;
      },
    },
  );
  const busy = !!staging || stage.isPending || remove.isPending || previewM.isPending || commitM.isPending;
  const status = statusQ.data;
  const finished = status && status.batch.status !== "committing";
  const prevFinished = useRef(false);
  useEffect(() => {
    if (finished && !prevFinished.current) {
      prevFinished.current = true;
      void utils.sites.list.invalidate();
      void utils.uploads.list.invalidate();
      void utils.entities.invalidate();
      void utils.analysis.invalidate();
      void utils.recommendations.invalidate();
    }
    if (!finished) prevFinished.current = false;
  }, [finished, utils]);

  async function addFiles(list: FileList | null) {
    if (!list?.length || editorLock.current || busy) return;
    editorLock.current=true; setPreview(null); setClockConfirmed(false);
    let id=batchId; const added:StagedFile[]=[];
    try {
      for (const f of Array.from(list)) {
        if (!/\.xlsx$/i.test(f.name)) { toast.error(`${f.name}: bulk setup requires .xlsx.`); continue; }
        if (f.size>50*1024*1024) { toast.error(`${f.name}: maximum workbook size is 50 MiB`); continue; }
        try {
          setStaging(`Saving ${f.name}…`);
          const r=await uploadClient.bulkImport.stageFile.mutate({batchId:id,filename:f.name,contentBase64:await fileToBase64(f)});
          id=r.batchId; setBatchId(id);
          if(r.duplicate) toast.info(`${f.name} is already staged`);
          else added.push({fileId:r.fileId,filename:f.name,sheets:r.sheets,skippedSheets:r.skippedSheets,sizeBytes:f.size});
        } catch(e) { toast.error(e instanceof Error?e.message:"Could not stage workbook"); }
      }
      setFiles(previous=>[...previous,...added]);
      if(id!=null && (added.length || files.length)) await runPreview(id,mode,overrides,true);
    } finally {editorLock.current=false;setStaging(null);if(fileRef.current)fileRef.current.value="";}
  }
  async function runPreview(id:number,m:"campus"|"building",ov:Record<number,number|string|null>,insideLock=false,clockOverride?:{timeZone?:string;timestampBasis?:"start"|"end"}) {
    if(!insideLock && (editorLock.current || busy))return;
    if(!insideLock)editorLock.current=true;
    const version=preview?.planVersion;
    setPreview(null);setClockConfirmed(false);setStaging("Grouping and validating all sheets…");
    try {
      const r=await previewM.mutateAsync({batchId:id,groupingMode:m,planVersion:insideLock?undefined:version,timeZone:clockOverride?.timeZone??(timeZone||undefined),timestampBasis:clockOverride?.timestampBasis??timestampBasis,
        overrides:Object.entries(ov).map(([sheetId,target])=>({sheetId:Number(sheetId),siteId:typeof target==="number"?target:null,groupKey:typeof target==="string"?target:null}))});
      setPreview(r);
    }catch(e){toast.error(e instanceof Error?e.message:"Preview failed");}
    finally{setStaging(null);if(!insideLock)editorLock.current=false;}
  }
  async function removeStaged(fileId:number) {
    if(batchId==null || editorLock.current || busy)return;
    editorLock.current=true;setPreview(null);setStaging("Removing workbook…");
    try {
      await remove.mutateAsync({batchId,fileId});
      const next=files.filter(f=>f.fileId!==fileId);setFiles(next);
      // Drop overrides for removed sheets; status is the authoritative editor.
      const state=await utils.client.bulkImport.status.query({batchId});
      const retained=Object.fromEntries(Object.entries(overrides).filter(([id])=>state.sheets.some(s=>s.id===Number(id))));
      setOverrides(retained);
      if(next.length)await runPreview(batchId,mode,retained,true);
    }catch(e){toast.error(e instanceof Error?e.message:"Could not remove file");}
    finally{editorLock.current=false;setStaging(null);}
  }
  async function doCommit() {
    if(batchId==null || !preview || !clockConfirmed || editorLock.current || busy)return;
    editorLock.current=true;
    try {
      await commitM.mutateAsync({batchId,planVersion:preview.planVersion,clockConfirmed,entityName:entityName.trim()||null,buildingType:buildingType||null,runAnalysis});
      setCommittedId(batchId);toast.success("Import started; progress is saved after every sheet.");
    }catch(e){toast.error(e instanceof Error?e.message:"Import failed to start");}
    finally{editorLock.current=false;}
  }
  async function resume() {
    if(!status || commitM.isPending)return;
    try {await commitM.mutateAsync({batchId:status.batch.id,planVersion:status.batch.planVersion});await statusQ.refetch();}
    catch(e){toast.error(e instanceof Error?e.message:"Retry failed");}
  }
  async function openBatch(id:number) {
    if(busy || editorLock.current)return;
    editorLock.current=true;setStaging("Opening import…");
    try {
      const state=await utils.client.bulkImport.status.query({batchId:id});
      if(!["staging","previewed"].includes(state.batch.status)){setCommittedId(id);return;}
      setBatchId(id);setCommittedId(null);setMode(state.batch.groupingMode);
      setFiles(state.files.map(f=>({...f,fileId:f.id})));
      setOverrides(Object.fromEntries(state.sheets.map(s=>[s.id,s.overrideSiteId??s.overrideGroupKey??null])));
      const first=state.batch.plan?.sites[0]?.sourceClock;
      setTimeZone(first?.timeZone??"");setTimestampBasis(first?.timestampBasis??"start");setClockConfirmed(false);
      setPreview(state.batch.plan ? {batchId:id,planVersion:state.batch.planVersion,groupingMode:state.batch.groupingMode,...state.batch.plan,files:state.files} as PreviewResult : null);
    }catch(e){toast.error(e instanceof Error?e.message:"Could not reopen import");}
    finally{editorLock.current=false;setStaging(null);}
  }

  function reset() {
    setBatchId(null);
    setFiles([]);
    setPreview(null);
    setOverrides({});
    setCommittedId(null);
    setEntityName("");setClockConfirmed(false);setTimeZone("");setTimestampBasis("start");
    void recent.refetch();
  }

  const totals = preview?.totals;
  const limit = preview?.planLimit;
  const existingSites = sitesQ.data ?? [];
  const reviewCount = useMemo(() => preview?.sites.filter((s) => s.needsReview.length > 0).length ?? 0, [preview]);

  /* ---------- progress / result view ---------- */
  if (committedId != null) {
    if (statusQ.isError) return <Card><CardContent className="p-4"><p role="alert">Could not load import progress: {statusQ.error.message}</p><Button onClick={()=>void statusQ.refetch()}>Retry loading progress</Button><Button variant="ghost" onClick={reset}>Back to imports</Button></CardContent></Card>;
    const sum = status?.batch.summary;
    const pct = sum ? Math.round((sum.sheetsDone / Math.max(1, sum.sheetsTotal)) * 100) : 0;
    const phaseLabel: Record<string, string> = {
      importing: "Importing interval data",
      totals: "Building campus totals for multi-meter sites",
      analyzing: "Running analysis on each site",
      done: "Done",
    };
    const failed = status?.sheets.filter((s) => s.status === "failed") ?? [];
    return (
      <Card className="border-primary/30" data-testid="bulk-import-progress">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {finished ? (
              status?.batch.status === "complete" ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-600" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            )}
            {finished ? (status?.batch.status === "complete" ? "Portfolio import complete" : status?.batch.status === "partial" ? "Import finished with warnings — review sheets and post-processing" : "Import failed") : "Importing portfolio…"}
          </CardTitle>
          <CardDescription>
            {sum ? phaseLabel[sum.phase] : "Starting…"}
            {sum?.currentSite && !finished ? ` · ${sum.currentSite}` : ""}
            {sum?.currentSheet && !finished && sum.phase === "importing" ? ` · ${sum.currentSheet}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress aria-label="Workbook import progress" value={finished ? 100 : Math.min(100,pct)} />
          <p role="status" aria-live="polite" className="text-xs">{sum?phaseLabel[sum.phase]:"Loading import progress"}</p>
          {status?.batch.error && <p role="alert" className="text-sm text-destructive">{status.batch.error}</p>}
          {sum && (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Sites" value={`${sum.siteIds.length}`} hint={`${sum.sitesCreated} new · ${sum.sitesReused} existing`} />
              <Stat label="Service agreements" value={`${sum.sheetsImported + sum.sheetsDuplicate}/${sum.sheetsTotal}`} hint={sum.sheetsFailed ? `${sum.sheetsFailed} failed` : `${sum.metersCreated} new meters`} />
              <Stat label="Interval readings" value={fmtNum(sum.pointsWritten)} hint="UTC interval starts · de-duplicated" />
              <Stat label="Filed rates matched" value={`${sum.tariffsAssigned}`} hint={`${sum.campusTotals} campus totals · ${sum.analysesRun} analyses`} />
            </div>
          )}
          {failed.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-medium">Sheets whose interval transaction did not commit:</p>
              <ul className="mt-1 list-disc pl-4">
                {failed.map((s) => (
                  <li key={s.id}>
                    {s.sheetName}
                    {s.facility ? ` · ${s.facility}` : ""} — {s.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(status?.stalled || ["partial","failed"].includes(status?.batch.status??"")) && (
            <div className="flex items-center justify-between rounded-md border p-3 text-xs">
              <span>Retry failed sheets or incomplete downstream work. Completed sheet checkpoints are preserved; warnings may require source correction.</span>
              <Button size="sm" variant="outline" disabled={commitM.isPending} onClick={()=>void resume()}>
                Retry / Resume
              </Button>
            </div>
          )}
          {status?.sheets && <details className="text-xs"><summary className="cursor-pointer">All sheet outcomes and validation ({status.sheets.length})</summary><ul className="mt-2 space-y-2">{status.sheets.map(s=><li key={s.id}><strong>{s.sheetName}</strong>: {s.status} · {s.pointsWritten.toLocaleString()} readings written<p>{s.detail}</p></li>)}</ul></details>}
          {sum?.postProcessing && Object.entries(sum.postProcessing).filter(([,p])=>p.detail).map(([id,p])=><p key={id} role="alert" className="text-xs">{p.detail} <Link className="underline" href={`/app/explore?site=${id}`}>Review site</Link></p>)}
          {sum?.notes?.length ? <p className="text-xs text-muted-foreground">{sum.notes.join(" ")}</p> : null}
          {finished && (
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/app/portfolio${sum?.siteIds[0]?`?site=${sum.siteIds[0]}`:""}`}>Open portfolio</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/app/sites${sum?.siteIds[0]?`?site=${sum.siteIds[0]}`:""}`}>Review sites</Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={reset}>
                Import more files
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  /* ---------- staging + preview view ---------- */
  return (
    <Card data-testid="bulk-import-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-5 w-5 text-primary" /> Set up many sites at once
        </CardTitle>
        <CardDescription>
          Add every workbook your utility sent, even when the sheets are split across several files. We group sheets by service address: one site per campus and one meter per durable service point or agreement. Re-imports reuse identities; conflicting destinations require explicit correction. Bulk setup currently requires Founding or Pro.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div
          className="flex cursor-pointer flex-col items-center rounded-lg border border-dashed border-primary/40 p-6 text-center transition-colors hover:border-primary"
          onClick={() => !busy && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if(!busy) void addFiles(e.dataTransfer.files);
          }}
        >
          <FileSpreadsheet className="h-8 w-8 text-primary" />
          <p className="mt-2 text-sm font-medium">{files.length === 0 ? "Choose or drop workbooks" : "Add more workbooks"}</p>
          <p className="text-xs text-muted-foreground">.xlsx · one sheet per service agreement · up to 50 MiB each · 8 files / 150 MiB / 128 sheets per import</p>
          <Button size="sm" className="mt-3" disabled={busy} type="button">
            <UploadIcon className="mr-1 h-4 w-4" /> {staging ? "Working…" : "Choose files"}
          </Button>
          <input ref={fileRef} type="file" hidden multiple accept=".xlsx,.xls" data-testid="bulk-file-input" onChange={(e) => void addFiles(e.target.files)} />
        </div>
        {staging && (
          <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {staging}
          </p>
        )}

        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f) => (
              <div key={f.fileId} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-xs">
                <span className="truncate">
                  <FileSpreadsheet className="mr-1 inline h-3.5 w-3.5" /> {f.filename} · {f.sheets} sheet{f.sheets === 1 ? "" : "s"} · {fmtBytes(f.sizeBytes)}
                  {f.skippedSheets ? ` · ${f.skippedSheets} non-interval sheet(s) skipped` : ""}
                </span>
                <Button size="icon" variant="ghost" className="h-6 w-6" disabled={busy} onClick={() => void removeStaged(f.fileId)} aria-label={`Remove ${f.filename}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {!preview && files.length>0 && <Button variant="outline" disabled={busy} onClick={()=>batchId!=null&&void runPreview(batchId,mode,overrides)}>Preview again</Button>}
        {preview && totals && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="bulk-preview-totals">
              <Stat label="Files → sheets" value={`${totals.files} → ${totals.sheets}`} />
              <Stat label="Sites" value={`${totals.sites}`} hint={`${totals.newSites} new · ${totals.reusedSites} existing`} />
              <Stat label="Meters" value={`${totals.meters}`} hint={`${totals.multiMeterSites} multi-meter sites${totals.reusedMeters ? ` · ${totals.reusedMeters} already imported` : ""}`} />
              <Stat label="Filed rates matched" value={`${totals.tariffMatched}/${totals.meters}`} hint="from bill rate codes" />
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted-foreground">Group sheets by</span>
              <div className="inline-flex rounded-md border p-0.5">
                {(["campus", "building"] as const).map((m) => (
                  <button
                    key={m}
                    type="button" disabled={busy} aria-pressed={mode===m}
                    className={`rounded px-3 py-1 text-xs transition-colors ${mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                    onClick={() => {
                      setMode(m);
                      if (batchId != null) void runPreview(batchId, m, overrides);
                    }}
                  >
                    {m === "campus" ? "Campus (street address)" : "Building (address + unit)"}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                {mode === "campus" ? "Unit, building, and facility labels become meter details within one site." : "Each unit or facility label becomes its own site."}
              </span>
            </div>

            {reviewCount > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" /> {reviewCount} site{reviewCount === 1 ? "" : "s"} need a quick review. Expand {reviewCount === 1 ? "it" : "them"} below.
              </p>
            )}

            <div className="max-h-[480px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Site</TableHead>
                    <TableHead className="text-right">Meters</TableHead>
                    <TableHead>Rates</TableHead>
                    <TableHead>Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.sites.map((s) => {
                    const open = expanded[s.groupKey] ?? s.needsReview.length > 0;
                    const codes = Array.from(new Set(s.meters.map((m) => m.rateScheduleCode).filter(Boolean)));
                    return (
                      <Fragment key={s.groupKey}>
                        <TableRow className="cursor-pointer" onClick={() => setExpanded((e) => ({ ...e, [s.groupKey]: !open }))}>
                          <TableCell><button type="button" aria-expanded={open} aria-label={`${open?"Collapse":"Expand"} ${s.siteName}`} onClick={e=>{e.stopPropagation();setExpanded(x=>({...x,[s.groupKey]:!open}));}}>{open ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}</button></TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 font-medium">
                              <Building2 className="h-4 w-4 text-muted-foreground" /> {s.siteName}
                              {s.existingSiteId != null && <Badge variant="secondary">existing site</Badge>}
                              {s.needsReview.length > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
                            </div>
                            <div className="text-xs text-muted-foreground">{s.formattedAddress ?? s.address}</div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{s.meters.length}</TableCell>
                          <TableCell className="text-xs">{codes.join(", ") || "—"}</TableCell>
                          <TableCell className="text-xs">
                            {s.geocode === "precise" || s.geocode === "existing_site" ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <MapPin className="h-3.5 w-3.5" /> matched
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-700">
                                <XCircle className="h-3.5 w-3.5" /> no pin
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={4} className="space-y-2 py-3">
                              <p className="text-xs text-muted-foreground" data-testid="bulk-site-utility">
                                {s.billUtility
                                  ? `Utility: ${s.billUtility.utilityName} — from the bills' rate codes (${s.billUtility.codes.join(", ")}).`
                                  : "Utility: inferred from the location at import — confirm it on the site afterwards."}
                              </p>
                              {s.needsReview.map((r) => (
                                <p key={r} className="text-xs text-amber-800">
                                  {r}
                                </p>
                              ))}
                              <div className="space-y-1.5">
                                {s.meters.map((m) => (
                                  <div key={m.sheetId} className="grid grid-cols-1 items-center gap-2 text-xs sm:grid-cols-[1fr_1fr_220px]">
                                    <div>
                                      <span className="font-medium">{m.facility ?? m.sheetName}</span>
                                      <span className="text-muted-foreground">
                                        {" "}
                                        · SA {m.serviceAgreementId ?? "—"} · SP {m.servicePointId ?? "—"} · {m.filename.replace(/\.xlsx?$/i, "")}
                                      </span>
                                      {m.existingMeterId != null && <Badge variant="outline" className="ml-1">already imported</Badge>}
                                    </div>
                                    <div className="text-muted-foreground">
                                      {m.rateScheduleCode ?? "no rate code"}
                                      {m.tariff ? (m.tariff.match === "exact" ? " → filed schedule matched" : " → closest published schedule (confirm on a bill)") : " → best eligible filed rate"}
                                    </div>
                                    <Select disabled={busy}
                                      value={typeof overrides[m.sheetId]==="string"?`group:${overrides[m.sheetId]}`:overrides[m.sheetId] != null ? String(overrides[m.sheetId]) : "auto"}
                                      onValueChange={(v) => {
                                        const next = { ...overrides };
                                        if (v === "auto") next[m.sheetId]=null;
                                        else if(v.startsWith("group:"))next[m.sheetId]=v.slice(6);
                                        else next[m.sheetId] = Number(v);
                                        setOverrides(next);
                                        if (batchId != null) void runPreview(batchId, mode, next);
                                      }}
                                    >
                                      <SelectTrigger aria-label={`Destination site for ${m.sheetName}`} className="h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="auto">Group by address (default)</SelectItem>
                                        {preview.sites.filter(g=>g.groupKey!==s.groupKey&&g.existingSiteId==null).map(g=><SelectItem key={g.groupKey} value={`group:${g.groupKey}`}>Planned campus: {g.siteName}</SelectItem>)}
                                        {existingSites.map((es) => (
                                          <SelectItem key={es.id} value={String(es.id)}>
                                            Assign to: {es.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="rounded-md border p-3 space-y-3 text-sm">
              <p className="font-medium">Confirm the source clock before import</p>
              <p className="text-xs text-muted-foreground">Local wall-clock cells use the IANA timezone below, not the server clock. Explicit UTC offsets are retained. DST gaps/folds without offsets are rejected. KUSD 00:15…00:00 exports appear interval-ending: confirm that convention with the source owner.</p>
              <Label htmlFor="bulk-timezone">Source timezone (blank uses each site's existing meter or state)</Label>
              <Input id="bulk-timezone" disabled={busy} value={timeZone} placeholder="e.g. America/Phoenix" onChange={e=>{setTimeZone(e.target.value);setClockConfirmed(false);}} onBlur={()=>{if(batchId!=null&&!busy)void runPreview(batchId,mode,overrides);}} />
              <Select disabled={busy} value={timestampBasis} onValueChange={v=>{const basis=v as "start"|"end";setTimestampBasis(basis);if(batchId!=null)void runPreview(batchId,mode,overrides,false,{timestampBasis:basis});}}><SelectTrigger aria-label="Source interval timestamp convention"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="start">Timestamps label interval START</SelectItem><SelectItem value="end">Timestamps label interval END (subtract duration)</SelectItem></SelectContent></Select>
              <p className="text-xs">Preview clocks: {Array.from(new Set(preview.sites.map(s=>`${s.sourceClock.timeZone}, interval ${s.sourceClock.timestampBasis}`))).join("; ")}</p>
              <label className="flex items-center gap-2"><input type="checkbox" checked={clockConfirmed} disabled={busy} onChange={e=>setClockConfirmed(e.target.checked)}/> I confirm these source timezones and the start/end convention.</label>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="bulk-entity">Owner / organization (optional)</Label>
                <Input id="bulk-entity" className="mt-1" placeholder="e.g. Kingman Unified School District" value={entityName} onChange={(e) => setEntityName(e.target.value)} />
                <p className="mt-1 text-[11px] text-muted-foreground">Sites are grouped under this owner in Portfolio. One owner can hold many sites.</p>
              </div>
              <div>
                <Label htmlFor="bulk-building-type">Building type for new sites</Label>
                <Select value={buildingType || "none"} onValueChange={(v) => setBuildingType(v === "none" ? "" : v)}>
                  <SelectTrigger id="bulk-building-type" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILDING_TYPES.map(([v, l]) => (
                      <SelectItem key={v || "none"} value={v || "none"}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[11px] text-muted-foreground">Used for benchmarks and rate eligibility (for example, K–12 school rate schedules). You can edit each site later.</p>
              </div>
              <div className="flex flex-col justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={runAnalysis} onCheckedChange={setRunAnalysis} /> Analyze each site after import
                </label>
                {limit && !limit.ok ? (
                  <p className="text-xs text-destructive">
                    This import adds {limit.newSites} sites and your plan allows {limit.limit} ({limit.currentSites} in use).{" "}
                    <Link href="/app/account" className="underline">
                      See plans
                    </Link>
                  </p>
                ) : (
                  <Button className="mt-2" onClick={() => void doCommit()} disabled={busy || !clockConfirmed} data-testid="bulk-commit">
                    {commitM.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                    Import {totals.sites} site{totals.sites === 1 ? "" : "s"} · {totals.meters} meter{totals.meters === 1 ? "" : "s"}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}

        {!preview && recent.data && recent.data.length > 0 && files.length === 0 && (
          <div className="text-xs text-muted-foreground">
            Recent imports:{" "}
            {recent.data.slice(0, 3).map((b) => (
              <button key={b.id} type="button" className="mr-3 underline" disabled={busy} onClick={() => void openBatch(b.id)}>
                #{b.id} · {b.status}
                {b.summary ? ` · ${b.summary.siteIds.length} sites` : ""}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-card p-3 text-card-foreground">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
