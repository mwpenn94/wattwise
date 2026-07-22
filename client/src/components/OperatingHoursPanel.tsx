/**
 * HRS-1: operating-hours panel — shows exactly what hours the model assumes
 * for a site and lets the user take over: multiple schedules with usage
 * splits (office wing vs 24/7 server room), overnight wraps, and seasonal
 * months. Until the user saves a schedule, the archetype default applies and
 * is clearly badged "Assumed".
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Clock, Plus, Trash2, Pencil } from "lucide-react";

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface ScheduleForm {
  id?: number;
  name: string;
  kind: "business" | "always_on" | "production" | "custom";
  days: number[];
  startHour: number;
  endHour: number;
  months: number[];
  usageSharePct: number;
}

const EMPTY: ScheduleForm = {
  name: "",
  kind: "business",
  days: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 18,
  months: [],
  usageSharePct: 100,
};

function fmtHour(h: number): string {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export default function OperatingHoursPanel({ siteId, open, onClose }: { siteId: number; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const effective = trpc.schedules.effective.useQuery({ siteId }, { enabled: open });
  const list = trpc.schedules.list.useQuery({ siteId }, { enabled: open });
  const [form, setForm] = useState<ScheduleForm | null>(null);

  const invalidate = async () => {
    await Promise.all([utils.schedules.effective.invalidate({ siteId }), utils.schedules.list.invalidate({ siteId })]);
  };
  const upsert = trpc.schedules.upsert.useMutation({
    onSuccess: async () => {
      toast.success("Schedule saved — analytics will use it on the next analysis run");
      setForm(null);
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.schedules.remove.useMutation({
    onSuccess: async () => {
      toast.success("Schedule removed");
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = list.data ?? [];
  const eff = effective.data;
  const shareSum = rows.reduce((a, r) => a + (r.usageSharePct ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Clock className="h-4 w-4" /> Operating hours
          </DialogTitle>
        </DialogHeader>

        {/* Effective summary — what the model is accounting for right now */}
        {eff && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{eff.occupiedHoursPerYear.toLocaleString()} occupied h/yr</span>
              <span className="text-muted-foreground">· {eff.unoccupiedHoursPerYear.toLocaleString()} unoccupied</span>
              <Badge variant={eff.userConfirmed ? "default" : "secondary"} className="ml-auto text-[10px]">
                {eff.userConfirmed ? "Your schedule" : "Assumed"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{eff.disclosure}</p>
            {!eff.userConfirmed && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Assumed from building type — add a schedule below so savings math uses your real hours.
              </p>
            )}
          </div>
        )}

        {/* Saved schedules */}
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    <Badge variant="outline" className="text-[10px]">{r.kind.replace("_", " ")}</Badge>
                    {rows.length > 1 && <span className="text-xs text-muted-foreground">{Math.round(r.usageSharePct)}% of usage</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {(Array.isArray(r.days) ? (r.days as number[]) : []).map((d) => DAY_LABELS[d]).join(" ")} · {fmtHour(r.startHour)}–{fmtHour(r.endHour)}
                    {Array.isArray(r.months) && (r.months as number[]).length > 0 && (r.months as number[]).length < 12
                      ? ` · ${(r.months as number[]).map((m) => MONTH_LABELS[m - 1]).join(", ")}`
                      : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="Edit schedule"
                  onClick={() =>
                    setForm({
                      id: r.id,
                      name: r.name,
                      kind: (r.kind as ScheduleForm["kind"]) ?? "custom",
                      days: Array.isArray(r.days) ? (r.days as number[]) : [],
                      startHour: r.startHour,
                      endHour: r.endHour,
                      months: Array.isArray(r.months) ? (r.months as number[]) : [],
                      usageSharePct: r.usageSharePct,
                    })
                  }
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-destructive"
                  aria-label="Delete schedule"
                  onClick={() => remove.mutate({ id: r.id, siteId })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {rows.length > 1 && Math.abs(shareSum - 100) > 1 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Usage shares sum to {Math.round(shareSum)}% — they'll be normalized proportionally in the math, but 100% keeps it exact.
              </p>
            )}
          </div>
        )}

        {/* Add / edit form */}
        {form ? (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={form.name} placeholder="e.g. Office hours, Server room, Summer shift" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Type</Label>
                <Select value={form.kind} onValueChange={(v) => {
                  const kind = v as ScheduleForm["kind"];
                  if (kind === "always_on") setForm({ ...form, kind, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 });
                  else setForm({ ...form, kind });
                }}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="business">Business hours</SelectItem>
                    <SelectItem value="always_on">Always on (24/7)</SelectItem>
                    <SelectItem value="production">Production shift</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Share of usage (%)</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.usageSharePct}
                  onChange={(e) => setForm({ ...form, usageSharePct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Days</Label>
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    className={`h-7 w-9 rounded-md border text-xs transition-colors ${form.days.includes(i) ? "border-primary bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
                    onClick={() => setForm({ ...form, days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Start</Label>
                <Select value={String(form.startHour)} onValueChange={(v) => setForm({ ...form, startHour: Number(v) })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, h) => (
                      <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">End</Label>
                <Select value={String(form.endHour)} onValueChange={(v) => setForm({ ...form, endHour: Number(v) })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                      <SelectItem key={h} value={String(h)}>{fmtHour(h)}{h <= form.startHour && h !== 24 ? " (next day)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Months (leave empty for all year)</Label>
              <div className="grid grid-cols-6 gap-1">
                {MONTH_LABELS.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    className={`h-7 rounded-md border text-[11px] transition-colors ${form.months.includes(i + 1) ? "border-primary bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
                    onClick={() =>
                      setForm({ ...form, months: form.months.includes(i + 1) ? form.months.filter((x) => x !== i + 1) : [...form.months, i + 1].sort((a, b) => a - b) })
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>Cancel</Button>
              <Button
                size="sm"
                disabled={upsert.isPending || form.name.trim().length === 0 || form.days.length === 0}
                onClick={() =>
                  upsert.mutate({
                    id: form.id,
                    siteId,
                    name: form.name.trim(),
                    kind: form.kind,
                    days: form.days,
                    startHour: form.startHour,
                    endHour: form.endHour,
                    months: form.months.length > 0 ? form.months : null,
                    usageSharePct: form.usageSharePct,
                  })
                }
              >
                {upsert.isPending ? "Saving…" : "Save schedule"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => setForm({ ...EMPTY, usageSharePct: rows.length > 0 ? 0 : 100 })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add schedule
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          Multiple schedules split the site's usage — e.g. an office wing (70%) plus a 24/7 server room (30%). After-hours savings and baselines use these
          windows; changes apply on the next analysis run.
        </p>
      </DialogContent>
    </Dialog>
  );
}
