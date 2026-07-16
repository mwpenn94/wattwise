/**
 * Progressive participation quick-start (Jul 2026).
 * One input — a free-text address OR a bill photo — produces an immediate
 * quick-win archetype analysis with every placeholder assumption disclosed.
 * Bill path: OCR output prefills an inline review form; on save it persists a
 * REAL bill record (lazily creating a bill-entry meter) before analysis runs.
 * Until the bill is saved, figures are honestly disclosed as placeholder-based.
 * Multi-step forms (wizard / full site dialog) remain strictly optional.
 */
import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { MapPin, Receipt, Sparkles } from "lucide-react";
import { Link, useLocation } from "wouter";
import { fileToBase64 } from "@/lib/wattwiseUi";

interface BillDraft {
  siteId: number;
  reason: string;
  source: "parsed_image" | "manual";
  periodStart: string;
  periodEnd: string;
  totalUsage: string;
  totalCost: string;
  billedDemandKw: string;
}

export default function QuickStart({ compact = false }: { compact?: boolean }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating" | "analyzing" | "saving">("idle");
  const [billDraft, setBillDraft] = useState<BillDraft | null>(null);
  const billRef = useRef<HTMLInputElement>(null);

  const quickCreate = trpc.sites.quickCreate.useMutation();
  const analyze = trpc.analysis.run.useMutation();
  const billOcr = trpc.uploads.billOcr.useMutation();
  const billSave = trpc.bills.createForSite.useMutation();

  const busy = phase !== "idle";

  async function finishToDashboard(siteId: number) {
    await analyze.mutateAsync({ siteId });
    await Promise.all([utils.insights.invalidate(), utils.sites.list.invalidate()]);
    navigate(`/app?site=${siteId}`);
  }

  async function startFromAddress() {
    if (address.trim().length < 3) {
      toast.error("Enter at least a city/state or ZIP — e.g. “Phoenix, AZ 85004”.");
      return;
    }
    setPhase("creating");
    try {
      const res = await quickCreate.mutateAsync({ address: address.trim() });
      await utils.sites.list.invalidate();
      setPhase("analyzing");
      toast.success(
        res.parse.state
          ? `Site created for ${res.parse.city ? `${res.parse.city}, ` : ""}${res.parse.state}${res.parse.zip ? ` ${res.parse.zip}` : ""} — running quick analysis…`
          : "Site created (location not recognized — US-median assumptions disclosed) — running quick analysis…",
      );
      await finishToDashboard(res.id);
      toast.success("Quick-win analysis ready — placeholders are disclosed; refine anything, anytime.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Quick start failed");
    } finally {
      setPhase("idle");
    }
  }

  async function startFromBill(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    setPhase("creating");
    try {
      // Site first, from whatever address text was typed (may be empty →
      // placeholder name + US-median assumptions, all disclosed).
      const res = await quickCreate.mutateAsync({
        address: address.trim().length >= 3 ? address.trim() : "Bill upload (address not provided)",
      });
      await utils.sites.list.invalidate();
      const mime = f.type === "application/pdf" ? "application/pdf" : f.type === "image/png" ? "image/png" : "image/jpeg";
      const b64 = await fileToBase64(f);
      const ocr = await billOcr.mutateAsync({ siteId: res.id, filename: f.name, contentBase64: b64, mime });
      if (ocr.status === "manual_entry_required") {
        setBillDraft({
          siteId: res.id,
          reason: `${ocr.reason} Enter the bill fields below — saving them attaches a real bill to your new site.`,
          source: "manual",
          periodStart: "",
          periodEnd: "",
          totalUsage: "",
          totalCost: "",
          billedDemandKw: "",
        });
        toast.warning("Automatic bill parsing unavailable — review the form below (your site was still created).");
      } else {
        const b = ocr.bill;
        setBillDraft({
          siteId: res.id,
          reason: ocr.needsReview
            ? `Low-confidence extraction (${(b.overallConfidence * 100).toFixed(0)}%) — verify every value against the bill before saving.`
            : `Extracted at ${(b.overallConfidence * 100).toFixed(0)}% confidence — confirm the values, then save.`,
          source: "parsed_image",
          periodStart: b.periodStart.value ?? "",
          periodEnd: b.periodEnd.value ?? "",
          totalUsage: b.totalUsage.value != null ? String(b.totalUsage.value) : "",
          totalCost: b.totalCostUsd.value != null ? String(b.totalCostUsd.value) : "",
          billedDemandKw: b.billedDemandKw.value != null ? String(b.billedDemandKw.value) : "",
        });
        toast.success("Bill read — confirm the extracted values below to attach it to your site.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Quick start failed");
    } finally {
      setPhase("idle");
      if (billRef.current) billRef.current.value = "";
    }
  }

  async function saveBillAndAnalyze() {
    if (!billDraft) return;
    setPhase("saving");
    try {
      await billSave.mutateAsync({
        siteId: billDraft.siteId,
        periodStart: billDraft.periodStart,
        periodEnd: billDraft.periodEnd,
        totalUsage: Number(billDraft.totalUsage),
        usageUnit: "kWh",
        totalCostUsd: Number(billDraft.totalCost),
        billedDemandKw: billDraft.billedDemandKw ? Number(billDraft.billedDemandKw) : undefined,
        source: billDraft.source,
      });
      toast.success("Bill saved — running quick analysis…");
      const siteId = billDraft.siteId;
      setBillDraft(null);
      setPhase("analyzing");
      await finishToDashboard(siteId);
      toast.success("Quick-win analysis ready — building attributes still use disclosed placeholders until you refine them.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bill save failed");
    } finally {
      setPhase("idle");
    }
  }

  async function skipBillAndAnalyze() {
    if (!billDraft) return;
    const siteId = billDraft.siteId;
    setBillDraft(null);
    setPhase("analyzing");
    try {
      toast.info("Continuing without the bill — this first analysis is placeholder-based until you add data.");
      await finishToDashboard(siteId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setPhase("idle");
    }
  }

  const draftValid =
    billDraft != null &&
    billDraft.periodStart.length > 0 &&
    billDraft.periodEnd.length > 0 &&
    Number(billDraft.totalUsage) > 0 &&
    Number(billDraft.totalCost) > 0;

  return (
    <Card className={compact ? "border-primary/30" : "mx-auto max-w-xl border-primary/30"}>
      <CardContent className="py-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="font-display text-sm font-semibold">Quick start — one input, instant analysis</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Just an address (or even a ZIP) is enough. We run a first-pass archetype analysis immediately and disclose
          every placeholder assumption — refine details later only if you want to.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <MapPin className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="500 N Central Ave, Phoenix, AZ 85004"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && !billDraft && startFromAddress()}
              disabled={busy}
              aria-label="Building address"
            />
          </div>
          <Button onClick={startFromAddress} disabled={busy || billDraft != null}>
            {phase === "creating" ? "Creating…" : phase === "analyzing" ? "Analyzing…" : "Analyze"}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => billRef.current?.click()}
            disabled={busy || billDraft != null}
          >
            <Receipt className="h-3.5 w-3.5" /> or start from a bill photo
          </button>
          <span aria-hidden>·</span>
          <Link href="/app/wizard" className="underline-offset-2 hover:underline">
            prefer the guided step-by-step form?
          </Link>
        </div>
        <input ref={billRef} type="file" hidden accept=".png,.jpg,.jpeg,.pdf" onChange={(e) => startFromBill(e.target.files)} />

        {billDraft && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/[0.04] p-3">
            <p className="text-xs font-medium">Confirm your bill</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{billDraft.reason}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div>
                <Label htmlFor="qs-b-start" className="text-[11px]">
                  Period start
                </Label>
                <Input
                  id="qs-b-start"
                  type="date"
                  value={billDraft.periodStart}
                  onChange={(e) => setBillDraft({ ...billDraft, periodStart: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-end" className="text-[11px]">
                  Period end
                </Label>
                <Input id="qs-b-end" type="date" value={billDraft.periodEnd} onChange={(e) => setBillDraft({ ...billDraft, periodEnd: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="qs-b-usage" className="text-[11px]">
                  Usage (kWh)
                </Label>
                <Input
                  id="qs-b-usage"
                  type="number"
                  value={billDraft.totalUsage}
                  onChange={(e) => setBillDraft({ ...billDraft, totalUsage: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-cost" className="text-[11px]">
                  Total cost ($)
                </Label>
                <Input
                  id="qs-b-cost"
                  type="number"
                  value={billDraft.totalCost}
                  onChange={(e) => setBillDraft({ ...billDraft, totalCost: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-demand" className="text-[11px]">
                  Billed demand (kW)
                </Label>
                <Input
                  id="qs-b-demand"
                  type="number"
                  placeholder="optional"
                  value={billDraft.billedDemandKw}
                  onChange={(e) => setBillDraft({ ...billDraft, billedDemandKw: e.target.value })}
                />
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={saveBillAndAnalyze} disabled={!draftValid || busy}>
                {phase === "saving" ? "Saving…" : "Save bill & analyze"}
              </Button>
              <Button size="sm" variant="ghost" onClick={skipBillAndAnalyze} disabled={busy}>
                Skip bill — analyze with placeholders
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
