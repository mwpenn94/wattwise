/**
 * UNF-1 (Oct 26) — app-wide "your import is unfinished" notice.
 *
 * Imports run in short, resumable steps driven by the Upload page (the
 * production server has 512 MiB and no background workers), so an import only
 * advances while that page is open. A user who left mid-import used to get no
 * hint anywhere else that sites were still waiting for property facts and
 * analysis. This notice appears on every console page except Upload (which
 * resumes a bulk import itself) and offers one clear next step.
 *
 * - Bulk import ("Many sites"): Continue import → /app/upload?mode=bulk.
 * - Paused single-site file: Review on Upload, where Upload history offers
 *   continue or remove (a file can be superseded by a later bulk import, so
 *   we never push "continue" for it from here).
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CirclePause, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

const HIDE_KEY = "meterly-unfinished-import-hidden";

export type UnfinishedBatch = {
  batchId: number;
  filenames: string[];
  phase: "importing" | "totals" | "enriching" | "analyzing" | "done";
  sheetsDone: number;
  sheetsTotal: number;
  sites: number;
  analysesRun: number;
  runAnalysis: boolean;
  running: boolean;
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Plain progress, e.g. "All 20 sheets are in; property facts and analysis for 11 sites still to run." */
export function unfinishedImportProgress(b: Pick<UnfinishedBatch, "phase" | "sheetsDone" | "sheetsTotal" | "sites" | "runAnalysis">): string {
  if (b.phase === "importing" || b.sheetsDone < b.sheetsTotal) {
    return `${b.sheetsDone.toLocaleString()} of ${plural(b.sheetsTotal, "sheet")} imported so far.`;
  }
  const sites = b.sites > 0 ? ` for ${plural(b.sites, "site")}` : "";
  const remaining =
    b.phase === "totals"
      ? b.runAnalysis ? "campus totals, property facts and analysis" : "campus totals and property facts"
      : b.phase === "enriching"
        ? b.runAnalysis ? "property facts and analysis" : "property facts"
        : "analysis";
  return `All ${plural(b.sheetsTotal, "sheet")} are in; ${remaining}${sites} still to run.`;
}

function fileLabel(names: string[]) {
  if (!names.length) return "Your import";
  if (names.length === 1) return `“${names[0]}”`;
  return `“${names[0]}” and ${plural(names.length - 1, "other file")}`;
}

function readHidden(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(HIDE_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function UnfinishedImportNotice() {
  const [location, setLocation] = useLocation();
  const onUpload = location.startsWith("/app/upload");
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const q = trpc.bulkImport.unfinished.useQuery(undefined, {
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    // while another tab drives it, keep the numbers moving
    refetchInterval: (query) => ((query.state.data?.batches ?? []).some((b) => b.running) ? 15_000 : false),
  });
  // The layout stays mounted across pages: re-check whenever the user leaves
  // (or arrives at) Upload, where imports finish or files get removed.
  const { refetch } = q;
  useEffect(() => {
    if (!onUpload) void refetch();
  }, [onUpload, refetch]);
  if (onUpload || !q.data) return null;
  const batch = q.data.batches.find((b) => !hidden.includes(`b${b.batchId}`));
  const files = q.data.files.filter((f) => !hidden.includes(`f${f.uploadId}`));
  if (!batch && files.length === 0) return null;
  const hide = () => {
    const next = [...hidden, ...(batch ? [`b${batch.batchId}`] : []), ...files.map((f) => `f${f.uploadId}`)];
    setHidden(next);
    try {
      sessionStorage.setItem(HIDE_KEY, JSON.stringify(next));
    } catch {
      /* private mode: hide for this page view only */
    }
  };
  const fileSentence =
    files.length === 0
      ? null
      : files.length === 1
        ? files[0].awaitingChoice
          ? `“${files[0].filename}” is waiting for your choice about its addresses; nothing from it is imported yet. Its site can’t be analyzed until you choose or remove it.`
          : `“${files[0].filename}” was not finished (${files[0].sheetsTotal > 0 ? `${files[0].sheetsDone} of ${plural(files[0].sheetsTotal, "sheet")}` : "not started"}). Its site can’t be analyzed until you continue or remove it.`
        : `${plural(files.length, "file")} were not finished. Their sites can’t be analyzed until you continue or remove each one.`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="unfinished-import-notice"
      className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-sm text-foreground md:mr-16 print:hidden"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {batch?.running ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
        ) : (
          <CirclePause className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        )}
        <div className="min-w-0 space-y-1">
          {batch && (
            <p data-testid="unfinished-import-batch">
              <span className="font-semibold">{batch.running ? "Your import is finishing its current step." : "Your import is paused."}</span>{" "}
              <span className="break-words">
                {fileLabel(batch.filenames)}: {unfinishedImportProgress(batch)}
              </span>{" "}
              <span className="text-muted-foreground">
                {batch.running
                  ? "It keeps going only while an Upload page is open; otherwise it pauses safely after this step."
                  : "Imports continue only while the Upload page is open; nothing is lost while paused."}
              </span>
            </p>
          )}
          {fileSentence && (
            <p data-testid="unfinished-import-files" className="break-words">
              {!batch && <span className="font-semibold">Unfinished upload. </span>}
              {fileSentence}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {batch ? (
          <Button size="sm" data-testid="unfinished-import-continue" onClick={() => setLocation("/app/upload?mode=bulk")}>
            {batch.running ? "View progress" : "Continue import"}
          </Button>
        ) : (
          <Button size="sm" variant="outline" data-testid="unfinished-import-review" onClick={() => setLocation("/app/upload?mode=single")}>
            Review on Upload
          </Button>
        )}
        <Button size="sm" variant="ghost" data-testid="unfinished-import-hide" onClick={hide} aria-label="Hide this notice until the next visit">
          Later
        </Button>
      </div>
    </div>
  );
}
