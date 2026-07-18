/**
 * §3i alerts inbox — dollar-first, quiet-by-default. Renders as a compact
 * bell + panel. Alerts only exist above the $25/yr materiality floor and are
 * batched one-open-row per (site, kind), so this list is short by design.
 * In-app is the delivery channel today (email honestly labeled post-beta).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bell, Check, X } from "lucide-react";
import { toast } from "sonner";

const KIND_LABEL: Record<string, string> = {
  anomaly: "Anomaly",
  demand_spike: "Demand",
  rate_opportunity: "Rate",
  verdict: "Verdict",
  digest: "Digest",
};

export default function AlertsInbox() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const alerts = trpc.alerts.list.useQuery({ status: "open" });
  const setStatus = trpc.alerts.setStatus.useMutation({
    onSuccess: () => utils.alerts.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const openAlerts = alerts.data ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Alerts">
          <Bell className="h-4 w-4" />
          {openAlerts.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
              {openAlerts.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b border-border/70 px-3 py-2">
          <p className="text-sm font-medium">Alerts</p>
          <p className="text-[10px] text-muted-foreground">
            Dollar-first and quiet by default — anything here carries a material figure.
          </p>
        </div>
        {openAlerts.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No open alerts. Silence means nothing material changed — that's the contract.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {openAlerts.map((a) => (
              <li key={a.id} className="border-b border-border/50 px-3 py-2 last:border-b-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="px-1 py-0 text-[9px] uppercase">
                        {KIND_LABEL[a.kind] ?? a.kind}
                      </Badge>
                      {a.confidence && (
                        <span className="text-[9px] text-muted-foreground">{a.confidence}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-medium leading-snug">{a.title}</p>
                    {a.body && <p className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-muted-foreground">{a.body}</p>}
                    <p className="mt-0.5 text-[9px] text-muted-foreground">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title="Mark read"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: a.id, status: "read" })}
                    >
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      title="Dismiss"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: a.id, status: "dismissed" })}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
