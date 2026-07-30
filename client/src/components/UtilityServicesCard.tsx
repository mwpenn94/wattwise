/**
 * SVC (owner reports Jul 19): per-site utility services control. Shows, for
 * each commodity, whether analysis treats service as present — WITH the
 * provenance of that answer (user-set, meter/equipment evidence, territory
 * imputation, or the commodity default). One tap corrects the record: an
 * all-electric site turns gas off; a well-water site turns water off; an
 * off-grid building turns electric off. "Auto" clears the override and
 * returns the commodity to evidence-based resolution.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Droplets, Flame, Wifi, Zap } from "lucide-react";
import TelecomServicesSection from "@/components/TelecomServicesSection";

const COMMODITIES = [
  { key: "electric" as const, label: "Electric", icon: Zap },
  { key: "gas" as const, label: "Natural gas", icon: Flame },
  { key: "water" as const, label: "Water", icon: Droplets },
];

const BASIS_LABEL: Record<string, string> = {
  user_override: "set by you",
  meter_evidence: "meter on site",
  equipment_evidence: "confirmed equipment",
  territory_imputed: "service-territory imputed",
  default: "default assumption",
};

export default function UtilityServicesCard({ siteId, readOnly }: { siteId: number; readOnly?: boolean }) {
  const utils = trpc.useUtils();
  const services = trpc.sites.services.useQuery({ siteId });
  /* UNI (owner Jul 29): connectivity is the fourth utility on this card —
     same surface, same weight as electric/gas/water, managed inline. */
  const telecom = trpc.telecom.analyze.useQuery({ siteId });
  const telecomCount = telecom.data?.services.length ?? 0;
  const [telecomOpen, setTelecomOpen] = useState(false);
  const telecomExpanded = telecomOpen || telecomCount === 0;
  const setServices = trpc.sites.setServices.useMutation({
    onSuccess: () => {
      utils.sites.services.invalidate({ siteId });
      toast.success("Utility services updated — the next analysis run will honor it");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-semibold">Utility services on this site</p>
        {services.isLoading && <Spinner className="h-3.5 w-3.5" />}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        We only analyze commodities this site actually has. Each answer shows where it came from — correct
        anything we got wrong and analysis follows immediately.
      </p>
      <div className="space-y-2">
        {COMMODITIES.map(({ key, label, icon: Icon }) => {
          const res = services.data?.[key];
          return (
            <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{label}</span>
              {res && (
                <Badge variant={res.analyze ? "default" : "secondary"} className="text-[10px]">
                  {res.analyze ? "analyzed" : "not analyzed"}
                </Badge>
              )}
              {res && (
                <span className="text-[10px] text-muted-foreground" title={res.reason}>
                  {BASIS_LABEL[res.basis] ?? res.basis}
                </span>
              )}
              {!readOnly && (
                <div className="ml-auto flex gap-1">
                  {(["active", "none", "unknown"] as const).map((v) => {
                    const selected =
                      res?.basis === "user_override" ? (res.analyze ? v === "active" : v === "none") : v === "unknown";
                    return (
                      <button
                        key={v}
                        type="button"
                        disabled={setServices.isPending}
                        onClick={() => setServices.mutate({ siteId, [key]: v })}
                        className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                          selected
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        }`}
                      >
                        {v === "active" ? "Has service" : v === "none" ? "No service" : "Auto"}
                      </button>
                    );
                  })}
                </div>
              )}
              {res && !res.analyze && (
                <p className="w-full text-[10px] text-muted-foreground/80">{res.reason}</p>
              )}
            </div>
          );
        })}

        {/* UNI: Connectivity — fourth utility row. Bill-entered subscription spend
            (no meter); analyzed against published pricing, promo dates, and usage,
            with findings ranked alongside the other utilities' opportunities. */}
        <div className="rounded-md border border-border/60 px-3 py-2">
          <button
            type="button"
            className="flex w-full flex-wrap items-center gap-2 text-left"
            onClick={() => setTelecomOpen((v) => !v)}
            aria-expanded={telecomExpanded}
          >
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Connectivity</span>
            {telecomCount > 0 ? (
              <Badge variant="default" className="text-[10px]">analyzed</Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px]">not tracked</Badge>
            )}
            <span className="text-[10px] text-muted-foreground">
              {telecomCount > 0
                ? `${telecomCount} service${telecomCount !== 1 ? "s" : ""} · $${Math.round(telecom.data?.monthlyTotalUsd ?? 0).toLocaleString()}/mo entered`
                : "internet · mobile · TV · landline (bill-entered, no meter)"}
            </span>
            <span className="ml-auto text-muted-foreground">
              {telecomExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
          </button>
          {telecomExpanded && (
            <div className="mt-2">
              <TelecomServicesSection siteId={siteId} showFindings={false} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
