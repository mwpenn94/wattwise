/**
 * UNI (owner Jul 29) — telecom unified with the other utilities.
 *
 * This is the inline connectivity management surface rendered INSIDE the
 * "Utility services on this site" card, at the same level as Electric /
 * Natural gas / Water. Full service CRUD (add/edit/remove), bill-scan OCR
 * prefill, spend summary, and savings findings all live here — no separate
 * tab required.
 *
 * Honesty invariants preserved from the original Telecom page:
 *  - market comparisons are published ranges, never quotes
 *  - per-service savings capped at the largest finding (never additive)
 *  - subscription spend is entered-bill dollars, distinct from modeled utility $
 */
import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Wifi,
  Smartphone,
  Tv,
  Phone,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ScanLine,
} from "lucide-react";

type ServiceType = "internet" | "mobile" | "tv_bundle" | "phone_landline";

const TYPE_META: Record<ServiceType, { label: string; icon: typeof Wifi }> = {
  internet: { label: "Internet", icon: Wifi },
  mobile: { label: "Mobile", icon: Smartphone },
  tv_bundle: { label: "TV bundle", icon: Tv },
  phone_landline: { label: "Landline", icon: Phone },
};

interface FormState {
  id?: number;
  serviceType: ServiceType;
  provider: string;
  planName: string;
  monthlyCostUsd: string;
  promoEndsAt: string; // yyyy-mm-dd
  postPromoCostUsd: string;
  contractEndsAt: string;
  downloadMbps: string;
  isBusiness: boolean;
  lines: string;
  dataAllowanceGb: string;
  unlimitedData: boolean;
  actualDataUsedGb: string;
  actualDownloadNeedMbps: string;
}

const EMPTY_FORM: FormState = {
  serviceType: "internet",
  provider: "",
  planName: "",
  monthlyCostUsd: "",
  promoEndsAt: "",
  postPromoCostUsd: "",
  contractEndsAt: "",
  downloadMbps: "",
  isBusiness: false,
  lines: "",
  dataAllowanceGb: "",
  unlimitedData: true,
  actualDataUsedGb: "",
  actualDownloadNeedMbps: "",
};

const num = (s: string): number | null => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};
const dateMs = (s: string): number | null => {
  if (!s) return null;
  const t = new Date(`${s}T12:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
};
const msToDate = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

/* HOL-3 (owner Jul 29): this section manages the service registry ONLY —
   connectivity findings flow exclusively through the same Ranked
   opportunities feed as electric/gas/water. No separate findings widget. */
export default function TelecomServicesSection({ siteId }: { siteId: number }) {
  const services = trpc.telecom.list.useQuery({ siteId });
  const analysis = trpc.telecom.analyze.useQuery({ siteId });
  const utils = trpc.useUtils();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const refresh = async () => {
    await Promise.all([utils.telecom.list.invalidate(), utils.telecom.analyze.invalidate()]);
  };
  const upsert = trpc.telecom.upsert.useMutation({
    onSuccess: async () => {
      toast.success(form.id ? "Service updated" : "Service added");
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.telecom.remove.useMutation({
    onSuccess: async () => {
      toast.success("Service removed");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  /* Bill-scan OCR prefill — low-confidence fields left for the user to verify. */
  const ocr = trpc.telecom.ocr.useMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const onScanFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const mime = file.type as "image/png" | "image/jpeg" | "application/pdf";
    if (!["image/png", "image/jpeg", "application/pdf"].includes(mime)) {
      return void toast.error("Use a PNG/JPEG photo or screenshot of the bill");
    }
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    ocr.mutate(
      { siteId, filename: file.name, contentBase64: b64, mime },
      {
        onSuccess: (out) => {
          if (out.status === "manual_entry_required") return void toast.info(out.reason);
          const b = out.bill;
          setForm((f) => ({
            ...f,
            serviceType: (b.serviceType.value ?? f.serviceType) as ServiceType,
            provider: b.provider.value ?? f.provider,
            planName: b.planName.value ?? f.planName,
            monthlyCostUsd: b.monthlyCostUsd.value != null ? String(b.monthlyCostUsd.value) : f.monthlyCostUsd,
            promoEndsAt: b.promoEndsDate.value ?? f.promoEndsAt,
            postPromoCostUsd: b.postPromoCostUsd.value != null ? String(b.postPromoCostUsd.value) : f.postPromoCostUsd,
            contractEndsAt: b.contractEndsDate.value ?? f.contractEndsAt,
            downloadMbps: b.downloadMbps.value != null ? String(b.downloadMbps.value) : f.downloadMbps,
            lines: b.lines.value != null ? String(Math.round(b.lines.value)) : f.lines,
            dataAllowanceGb: b.dataAllowanceGb.value != null ? String(b.dataAllowanceGb.value) : f.dataAllowanceGb,
            unlimitedData: b.unlimitedData.value ?? f.unlimitedData,
            actualDataUsedGb: b.actualDataUsedGb.value != null ? String(b.actualDataUsedGb.value) : f.actualDataUsedGb,
          }));
          toast.success(
            out.needsReview
              ? "Bill scanned — low confidence on some fields, please verify before saving"
              : "Bill scanned — verify the prefilled fields and save",
          );
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const openEdit = (s: NonNullable<typeof services.data>[number]) => {
    setForm({
      id: s.id,
      serviceType: s.serviceType,
      provider: s.provider,
      planName: s.planName ?? "",
      monthlyCostUsd: String(s.monthlyCostUsd),
      promoEndsAt: msToDate(s.promoEndsAt),
      postPromoCostUsd: s.postPromoCostUsd != null ? String(s.postPromoCostUsd) : "",
      contractEndsAt: msToDate(s.contractEndsAt),
      downloadMbps: s.downloadMbps != null ? String(s.downloadMbps) : "",
      isBusiness: s.isBusiness,
      lines: s.lines != null ? String(s.lines) : "",
      dataAllowanceGb: s.dataAllowanceGb != null ? String(s.dataAllowanceGb) : "",
      unlimitedData: s.unlimitedData,
      actualDataUsedGb: s.actualDataUsedGb != null ? String(s.actualDataUsedGb) : "",
      actualDownloadNeedMbps: s.actualDownloadNeedMbps != null ? String(s.actualDownloadNeedMbps) : "",
    });
    setDialogOpen(true);
  };

  const submit = () => {
    const cost = num(form.monthlyCostUsd);
    if (!form.provider.trim()) return void toast.error("Provider is required");
    if (cost == null) return void toast.error("Monthly cost must be a positive number");
    upsert.mutate({
      id: form.id,
      siteId,
      serviceType: form.serviceType,
      provider: form.provider.trim(),
      planName: form.planName.trim() || null,
      monthlyCostUsd: cost,
      promoEndsAt: dateMs(form.promoEndsAt),
      postPromoCostUsd: num(form.postPromoCostUsd),
      contractEndsAt: dateMs(form.contractEndsAt),
      downloadMbps: form.serviceType === "internet" ? num(form.downloadMbps) : null,
      isBusiness: form.isBusiness,
      lines: form.serviceType === "mobile" ? (num(form.lines) ? Math.round(num(form.lines)!) : 1) : null,
      dataAllowanceGb: form.serviceType === "mobile" && !form.unlimitedData ? num(form.dataAllowanceGb) : null,
      unlimitedData: form.serviceType === "mobile" ? form.unlimitedData : false,
      actualDataUsedGb:
        form.serviceType === "mobile" && form.actualDataUsedGb.trim() !== ""
          ? Math.max(0, Number(form.actualDataUsedGb) || 0)
          : null,
      actualDownloadNeedMbps: form.serviceType === "internet" ? num(form.actualDownloadNeedMbps) : null,
    });
  };

  const a = analysis.data;
  const savingsLabel = useMemo(() => {
    if (!a || a.totalAnnualSavingsHi <= 0) return null;
    return a.totalAnnualSavingsLo > 0 && a.totalAnnualSavingsLo !== a.totalAnnualSavingsHi
      ? `$${a.totalAnnualSavingsLo.toLocaleString()}–$${a.totalAnnualSavingsHi.toLocaleString()}`
      : `up to $${a.totalAnnualSavingsHi.toLocaleString()}`;
  }, [a]);

  const list = services.data ?? [];

  return (
    <div>
      {/* spend + savings strip (compact, inline) */}
      {a && a.services.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-mono font-semibold text-foreground">${Math.round(a.monthlyTotalUsd).toLocaleString()}/mo</span>{" "}
            · ${Math.round(a.annualTotalUsd).toLocaleString()}/yr entered
          </span>
          {savingsLabel && (
            <span className="text-emerald-400">
              potential savings {savingsLabel}/yr
              <span className="text-muted-foreground"> (largest finding per service, ranges disclosed)</span>
            </span>
          )}
        </div>
      )}

      {/* services list */}
      {services.isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border/60 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            No connectivity services entered — add internet, mobile, TV, or landline from a recent bill (about a
            minute per service).
          </p>
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add service
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {list.map((s) => {
            const Meta = TYPE_META[s.serviceType];
            const Icon = Meta.icon;
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {Meta.label} — {s.provider}
                    {s.planName ? <span className="text-muted-foreground"> · {s.planName}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ${s.monthlyCostUsd.toFixed(0)}/mo
                    {s.serviceType === "internet" && s.downloadMbps != null
                      ? ` · ${s.downloadMbps.toFixed(0)} Mbps${s.isBusiness ? " · business" : ""}`
                      : ""}
                    {s.serviceType === "mobile"
                      ? ` · ${s.lines ?? 1} line${(s.lines ?? 1) !== 1 ? "s" : ""} · ${s.unlimitedData ? "unlimited" : `${s.dataAllowanceGb ?? "?"} GB`}`
                      : ""}
                    {s.promoEndsAt ? ` · promo ends ${new Date(s.promoEndsAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(s)} aria-label="Edit service">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => remove.mutate({ id: s.id })}
                    disabled={remove.isPending}
                    aria-label="Remove service"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={openAdd}>
              <Plus className="mr-1 h-3 w-3" /> Add another service
            </Button>
          </div>
        </div>
      )}

      {/* add/edit dialog — unchanged form from the original Telecom page */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit service" : "Add telecom service"}</DialogTitle>
            <DialogDescription>
              Enter what's on your bill. Optional fields (promo dates, actual usage) unlock more savings checks.
              Market comparisons are published ranges, not quotes; availability varies by address.
            </DialogDescription>
          </DialogHeader>
          {!form.id && (
            <div className="flex items-center justify-between rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground">Have the bill handy? Scan a photo/screenshot to prefill.</div>
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={ocr.isPending}>
                {ocr.isPending ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning…
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <ScanLine className="h-3.5 w-3.5" /> Scan a bill
                  </span>
                )}
              </Button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={onScanFile} />
            </div>
          )}
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Service type</label>
                <Select value={form.serviceType} onValueChange={(v) => set("serviceType", v as ServiceType)}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_META) as ServiceType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {TYPE_META[t].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Provider *</label>
                <Input className="mt-1" placeholder="e.g. Cox, Verizon" value={form.provider} onChange={(e) => set("provider", e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Plan name</label>
                <Input className="mt-1" placeholder="optional" value={form.planName} onChange={(e) => set("planName", e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Monthly cost ($) *</label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 89.99"
                  value={form.monthlyCostUsd}
                  onChange={(e) => set("monthlyCostUsd", e.target.value)}
                />
              </div>
            </div>

            {form.serviceType === "internet" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Download speed (Mbps)</label>
                  <Input className="mt-1" type="number" min="0" placeholder="e.g. 500" value={form.downloadMbps} onChange={(e) => set("downloadMbps", e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Speed you actually need (Mbps)</label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0"
                    placeholder="optional — unlocks right-sizing"
                    value={form.actualDownloadNeedMbps}
                    onChange={(e) => set("actualDownloadNeedMbps", e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Switch checked={form.isBusiness} onCheckedChange={(v) => set("isBusiness", v)} id="uni-biz" />
                  <label htmlFor="uni-biz" className="text-sm">
                    Business-class service
                  </label>
                </div>
              </div>
            )}

            {form.serviceType === "mobile" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Number of lines</label>
                  <Input className="mt-1" type="number" min="1" placeholder="e.g. 4" value={form.lines} onChange={(e) => set("lines", e.target.value)} />
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <Switch checked={form.unlimitedData} onCheckedChange={(v) => set("unlimitedData", v)} id="uni-unl" />
                  <label htmlFor="uni-unl" className="text-sm">
                    Unlimited data
                  </label>
                </div>
                {!form.unlimitedData && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Data allowance (GB/mo)</label>
                    <Input className="mt-1" type="number" min="0" placeholder="e.g. 15" value={form.dataAllowanceGb} onChange={(e) => set("dataAllowanceGb", e.target.value)} />
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Actual data used (GB/mo, all lines)</label>
                  <Input
                    className="mt-1"
                    type="number"
                    min="0"
                    placeholder="optional — unlocks right-sizing"
                    value={form.actualDataUsedGb}
                    onChange={(e) => set("actualDataUsedGb", e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Promo ends</label>
                <Input className="mt-1" type="date" value={form.promoEndsAt} onChange={(e) => set("promoEndsAt", e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Price after promo ($/mo)</label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="from your bill's fine print"
                  value={form.postPromoCostUsd}
                  onChange={(e) => set("postPromoCostUsd", e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Contract ends</label>
              <Input className="mt-1" type="date" value={form.contractEndsAt} onChange={(e) => set("contractEndsAt", e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={upsert.isPending}>
              {upsert.isPending ? "Saving…" : form.id ? "Save changes" : "Add service"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
