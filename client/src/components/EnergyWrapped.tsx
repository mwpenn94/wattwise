/**
 * §3 Hero 5 — Energy Wrapped: shareable year-in-review card.
 * Every stat carries its basis chip; omitted stats are named, not hidden.
 * "Share" = copy a text summary (no external service, no fabricated imagery).
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sparkles, Copy, Check } from "lucide-react";
import { toast } from "sonner";

export default function EnergyWrapped({ siteId }: { siteId: number }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapped = trpc.reports.wrapped.useQuery({ siteId }, { enabled: open });
  const d = wrapped.data;

  const copyText = async () => {
    if (!d) return;
    const lines = [
      `⚡ My ${d.year} Energy Wrapped — ${d.siteName}`,
      ...d.stats.map((s) => `${s.label}: ${s.value} (${s.chip})`),
      `via WattWise — every figure labeled with its basis`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Copied — paste it anywhere");
    } catch {
      toast.error("Couldn't copy — select the text manually");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="bg-background">
          <Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" /> Energy Wrapped
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Your year, wrapped</DialogTitle>
        </DialogHeader>
        {wrapped.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Assembling your year…</p>
        ) : !d ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Run an analysis first — Wrapped is built from your real results, so there&apos;s nothing to show yet.
          </p>
        ) : (
          <div className="space-y-3">
            <Card className="border-primary/40 bg-gradient-to-b from-primary/10 to-transparent">
              <CardHeader className="pb-1">
                <CardTitle className="font-display text-sm uppercase tracking-widest text-primary">
                  {d.siteName} · {d.year}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {d.stats.map((s) => (
                  <div key={s.key} className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                      <p className="font-display text-xl font-bold">{s.value}</p>
                      <p className="text-[11px] text-muted-foreground">{s.sub}</p>
                    </div>
                    <Badge variant="outline" className="mt-1 shrink-0 text-[10px]">
                      {s.chip}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
            {d.omitted.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Not shown (data missing, not zeroed): {d.omitted.map((o) => `${o.label} — ${o.reason}`).join("; ")}.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">{d.disclaimer}</p>
            <Button className="w-full" onClick={copyText}>
              {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
              {copied ? "Copied" : "Copy shareable summary"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
