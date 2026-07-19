/**
 * §3l Reports — three artifacts, one engine.
 * My Energy Plan (Plus, print) · Verified Savings Statement (Pro) ·
 * Practitioner Export (Pro, CSV). Every printed number carries a confidence
 * chip (Est./Good/Measured); the footer carries the modeled-estimates
 * disclaimer and a live verification link so forwarded PDFs are never
 * silently stale.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, BadgeCheck, FlaskConical, Printer, Download, Link2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import MvPanel from "@/components/MvPanel";

type Kind = "energy_plan" | "verified_savings" | "practitioner";

const KIND_META: Record<Kind, { title: string; tier: "plus" | "pro"; desc: string; icon: typeof FileText }> = {
  energy_plan: {
    title: "My Energy Plan",
    tier: "plus",
    desc: "Your open measures as a decision document — cover number, what/why per measure, payback and confidence, and what we'll verify after you act.",
    icon: FileText,
  },
  verified_savings: {
    title: "Verified Savings Statement",
    tier: "pro",
    desc: "Cumulative verified savings headline, plain-language weather-adjustment note, and a per-measure verdict table from the prove-it ledger.",
    icon: BadgeCheck,
  },
  practitioner: {
    title: "Practitioner Export",
    tier: "pro",
    desc: "CalTRACK terms — CVRMSE, R², months used — plus a CSV of measures and verdicts with confidence chips for engineering review.",
    icon: FlaskConical,
  },
};

function Chip({ chip }: { chip: string }) {
  const cls =
    chip === "Measured"
      ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
      : chip === "Good"
        ? "bg-sky-500/15 text-sky-500 border-sky-500/30"
        : "bg-amber-500/15 text-amber-500 border-amber-500/30";
  return <Badge variant="outline" className={`ml-1 px-1.5 py-0 text-[10px] ${cls}`}>{chip}</Badge>;
}

function usd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

export default function Reports() {
  const { user } = useAuth();
  // Effective tier comes from the server (account.usage applies the admin→pro
  // owner rule via tierOf); reading the raw user row's tier column rendered
  // every report button disabled for the admin owner (tier=free in the row).
  const usageQ = trpc.account.usage.useQuery(undefined, { enabled: !!user });
  const tier = usageQ.data?.tier ?? (user as { tier?: string } | null)?.tier ?? "free";
  const sitesQ = trpc.sites.list.useQuery();
  const [siteId, setSiteId] = useState<number | null>(null);
  const activeSiteId = siteId ?? sitesQ.data?.[0]?.id ?? null;
  const [printKind, setPrintKind] = useState<Kind | null>(null);
  const [printPayload, setPrintPayload] = useState<{ token: string; data: ReportData } | null>(null);

  const generate = trpc.reports.generate.useMutation({
    onSuccess: (res, vars) => {
      if (vars.kind === "practitioner" && res.csv) {
        const blob = new Blob([res.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `meterly-practitioner-${res.data.site.name.replace(/\W+/g, "-")}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Practitioner CSV downloaded", { description: `Verify link: /verify/${res.token}` });
      } else {
        setPrintKind(vars.kind);
        setPrintPayload({ token: res.token, data: res.data as ReportData });
        setTimeout(() => window.print(), 350);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  type ReportData = NonNullable<typeof generate.data>["data"];

  const canUse = (k: Kind) => (KIND_META[k].tier === "plus" ? tier === "plus" || tier === "pro" : tier === "pro");

  const verifyOrigin = useMemo(() => window.location.origin, []);

  return (
    <div className="space-y-6 print:space-y-4">
      {/* screen controls — hidden in print */}
      <div className="print:hidden space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Three artifacts, one engine. Every printed number carries a confidence chip; every footer carries a live
            verification link — a forwarded PDF is never silently stale.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Site</span>
          <Select value={activeSiteId != null ? String(activeSiteId) : undefined} onValueChange={(v) => setSiteId(Number(v))}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Choose a site" /></SelectTrigger>
            <SelectContent>
              {(sitesQ.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {(Object.keys(KIND_META) as Kind[]).map((k) => {
            const meta = KIND_META[k];
            const Icon = meta.icon;
            const allowed = canUse(k);
            return (
              <Card key={k} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <Icon className="h-5 w-5 text-primary" />
                    <Badge variant="outline" className="uppercase text-[10px]">{meta.tier}+</Badge>
                  </div>
                  <CardTitle className="text-base mt-2">{meta.title}</CardTitle>
                  <CardDescription>{meta.desc}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto">
                  <Button
                    className="w-full"
                    disabled={!allowed || activeSiteId == null || generate.isPending}
                    onClick={() => activeSiteId != null && generate.mutate({ siteId: activeSiteId, kind: k })}
                  >
                    {k === "practitioner" ? <Download className="h-4 w-4 mr-2" /> : <Printer className="h-4 w-4 mr-2" />}
                    {k === "practitioner" ? "Download CSV" : "Generate & print"}
                  </Button>
                  {!allowed && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Requires {meta.tier === "plus" ? "Plus" : "Pro"} — switch tiers free during the beta on{" "}
                      <a href="/app/account" className="underline">Account &amp; usage</a>.
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Reports render from your latest saved analysis — run an analysis first if figures look missing. The
          practitioner CSV includes baseline fit statistics (CVRMSE, R², months used) when a weather-normalized
          baseline exists.
        </p>
        {activeSiteId != null && <MvPanel siteId={activeSiteId} />}
      </div>

      {/* print view */}
      {printKind && printPayload && (
        <div className="hidden print:block text-black">
          <PrintReport kind={printKind} token={printPayload.token} data={printPayload.data} origin={verifyOrigin} />
        </div>
      )}
      {printKind && printPayload && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle className="text-base">Last generated: {KIND_META[printKind].title}</CardTitle>
            <CardDescription className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5" />
              Verification link:{" "}
              <a className="underline" href={`/verify/${printPayload.token}`} target="_blank" rel="noreferrer">
                {verifyOrigin}/verify/{printPayload.token}
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-2" /> Print again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ---------------- print layout ---------------- */

interface PrintData {
  site: { id: number; name: string; state: string | null; buildingType: string | null; sqft: number | null };
  generatedAt: number;
  annualCostUsd: number | null;
  annualCostChip: string;
  measures: Array<{
    title: string;
    measure: string;
    what: string;
    annualSavingsUsd: number | null;
    paybackLabel: string | null;
    costClass: string | null;
    confidence: string | null;
    chip: string;
    unitSavings: { value: number; unit: string } | null;
    demandSavingsKw: number | null;
    rebates: Array<{ name: string; valueUsd: number; source: string; url?: string | null; basis?: string }>;
  }>;
  plannedTotalUsd: number;
  rebatesSummary?: {
    totalUsd: number;
    totalAnnualUsd: number;
    programs: Array<{
      name: string;
      source: string;
      url: string | null;
      kind: string;
      valueUsd: number;
      annualUsd: number;
      basis: string;
      measures: string[];
      expiresAt: number | null;
    }>;
    dataAsOf: { sourceVersion: string; lastVerifiedAt: number | null } | null;
  } | null;
  verdicts: Array<{ measure: string; implementedAt: number; status: string; verifiedSavingsUsd: number; months: number; chip: string }>;
  verifiedTotalUsd: number;
  baseline: { method: string | null; cvrmse: number | null; r2: number | null; confidence: string | null; monthsUsed: number | null } | null;
  disclaimer: string;
}

function PrintReport({ kind, token, data, origin }: { kind: Kind; token: string; data: PrintData; origin: string }) {
  const printed = new Date(data.generatedAt).toLocaleDateString();
  return (
    <div className="max-w-[720px] mx-auto space-y-6 py-4">
      <header className="border-b pb-4">
        <div className="text-xs uppercase tracking-widest text-neutral-500">Meterly · {KIND_META[kind].title}</div>
        <h1 className="text-2xl font-semibold mt-1">{data.site.name}</h1>
        <p className="text-sm text-neutral-600">
          {data.site.buildingType ?? "building"} · {data.site.sqft != null ? `${data.site.sqft.toLocaleString()} sqft` : "size not set"} ·{" "}
          {data.site.state ?? ""} · printed {printed}
        </p>
      </header>

      {kind === "energy_plan" && (
        <>
          <section>
            <div className="text-sm text-neutral-500">If you implement the {data.measures.length} open measures below</div>
            <div className="text-4xl font-bold">
              {usd(data.plannedTotalUsd)}/yr <Chip chip="Est." />
            </div>
            <div className="text-sm text-neutral-600 mt-1">
              against a modeled current cost of {usd(data.annualCostUsd)}/yr <Chip chip={data.annualCostChip} />
            </div>
          </section>
          {data.measures.map((m) => (
            <section key={m.measure} className="border rounded-md p-4 break-inside-avoid">
              <div className="flex items-baseline justify-between">
                <h2 className="font-semibold">{m.title}</h2>
                <div className="font-semibold">
                  {usd(m.annualSavingsUsd)}/yr <Chip chip={m.chip} />
                </div>
              </div>
              <p className="text-sm text-neutral-700 mt-1">{m.what}</p>
              <p className="text-xs text-neutral-500 mt-2">
                Payback: {m.paybackLabel ?? "n/a"} · {m.costClass ?? "cost class n/a"} · confidence {m.confidence ?? "n/a"}
                {m.unitSavings ? ` · ≈${Math.round(m.unitSavings.value).toLocaleString()} ${m.unitSavings.unit}/yr` : ""}
                {m.demandSavingsKw != null && m.demandSavingsKw > 0 ? ` · ${m.demandSavingsKw.toFixed(1)} kW demand` : ""}
              </p>
              {m.rebates.length > 0 && (
                <p className="text-xs text-emerald-700 mt-1">
                  Rebates: {m.rebates.map((r) => `${r.name}${r.valueUsd > 0 ? ` — $${Math.round(r.valueUsd).toLocaleString()}` : ""} (${r.source})`).join("; ")}
                </p>
              )}
            </section>
          ))}
          {data.rebatesSummary && data.rebatesSummary.programs.length > 0 && (
            <section className="border rounded-md p-4 break-inside-avoid">
              <div className="flex items-baseline justify-between">
                <h2 className="font-semibold">Rebates &amp; incentives you can capture</h2>
                <div className="font-semibold text-emerald-700">
                  {data.rebatesSummary.totalUsd > 0 ? `${usd(data.rebatesSummary.totalUsd)} one-time` : ""}
                  {data.rebatesSummary.totalUsd > 0 && data.rebatesSummary.totalAnnualUsd > 0 ? " + " : ""}
                  {data.rebatesSummary.totalAnnualUsd > 0 ? `${usd(data.rebatesSummary.totalAnnualUsd)}/yr ongoing` : ""}
                </div>
              </div>
              <table className="w-full text-xs border-collapse mt-3">
                <thead>
                  <tr className="border-b text-left text-neutral-500">
                    <th className="py-1 pr-2">Program</th>
                    <th className="py-1 pr-2">Applies to</th>
                    <th className="py-1 pr-2">Basis</th>
                    <th className="py-1 pr-2 text-right">Value</th>
                    <th className="py-1">How to apply</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rebatesSummary.programs.map((p) => (
                    <tr key={`${p.source}-${p.name}`} className="border-b align-top">
                      <td className="py-1.5 pr-2 font-medium">{p.name}<div className="text-neutral-500 font-normal">{p.source}</div></td>
                      <td className="py-1.5 pr-2">{p.measures.join(", ")}</td>
                      <td className="py-1.5 pr-2">
                        {p.basis === "performance_paid" ? "pays yearly for participation" : p.basis === "per_unit_rate" ? "paid per unit saved" : p.basis === "percent_of_cost" ? "% of project cost" : "fixed amount"}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-medium">
                        {p.annualUsd > 0 ? `${usd(p.annualUsd)}/yr` : usd(p.valueUsd)}
                      </td>
                      <td className="py-1.5">
                        {p.url ? (
                          <a className="underline break-all" href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</a>
                        ) : (
                          <span className="text-neutral-500">contact {p.source}</span>
                        )}
                        {p.expiresAt != null && <div className="text-neutral-500">expires {new Date(p.expiresAt).toLocaleDateString()}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-neutral-500 mt-2">
                Program terms{" "}
                {data.rebatesSummary.dataAsOf?.lastVerifiedAt != null
                  ? `last re-verified ${new Date(data.rebatesSummary.dataAsOf.lastVerifiedAt).toLocaleDateString()} (${data.rebatesSummary.dataAsOf.sourceVersion})`
                  : "from our seeded snapshot — not yet re-verified"}
                . Amounts are computed against modeled savings; confirm current terms with the program before committing.
              </p>
            </section>
          )}
          <section className="text-sm text-neutral-700">
            <strong>What we'll verify:</strong> after you implement a measure, mark it "I did this" in Meterly. Each
            month with a full bill cycle of data, we compare actual usage against the weather-adjusted baseline and
            report verified savings — or tell you plainly when the change is inside the model's noise band.
          </section>
        </>
      )}

      {kind === "verified_savings" && (
        <>
          <section>
            <div className="text-sm text-neutral-500">Cumulative verified savings to date</div>
            <div className="text-4xl font-bold">
              {usd(data.verifiedTotalUsd)} <Chip chip="Measured" />
            </div>
          </section>
          <section className="border rounded-md p-4 text-sm text-neutral-700">
            <strong>How weather adjustment works:</strong> we fit your building's usage against heating and cooling
            degree days before the change, then predict what each month <em>would</em> have cost with no change under
            actual weather. Savings = predicted minus actual. When the difference is smaller than the model's error
            band, we say "inconclusive" rather than claim it.
          </section>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="py-1 pr-2">Measure</th>
                <th className="py-1 pr-2">Implemented</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Months</th>
                <th className="py-1 text-right">Verified $</th>
              </tr>
            </thead>
            <tbody>
              {data.verdicts.length === 0 && (
                <tr><td colSpan={5} className="py-2 text-neutral-500">No implementations marked yet — nothing is claimed that isn't measured.</td></tr>
              )}
              {data.verdicts.map((v) => (
                <tr key={v.measure + v.implementedAt} className="border-b">
                  <td className="py-1 pr-2">{v.measure.replace(/_/g, " ")}</td>
                  <td className="py-1 pr-2">{new Date(v.implementedAt).toLocaleDateString()}</td>
                  <td className="py-1 pr-2">{v.status.replace(/_/g, " ")}</td>
                  <td className="py-1 pr-2">{v.months}</td>
                  <td className="py-1 text-right">{usd(v.verifiedSavingsUsd)} <Chip chip={v.chip} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-neutral-500">
            Verified figures carry the baseline model's uncertainty: monthly deltas smaller than the fit's error band
            are reported as inconclusive and excluded from the headline.
          </p>
        </>
      )}

      {kind === "practitioner" && (
        <>
          <section>
            <h2 className="font-semibold">Baseline model (CalTRACK-style monthly)</h2>
            {data.baseline ? (
              <table className="w-full text-sm border-collapse mt-2">
                <tbody>
                  <tr className="border-b"><td className="py-1 text-neutral-500">Method</td><td className="py-1">{data.baseline.method ?? "n/a"}</td></tr>
                  <tr className="border-b"><td className="py-1 text-neutral-500">CVRMSE</td><td className="py-1">{data.baseline.cvrmse != null ? `${(data.baseline.cvrmse * 100).toFixed(1)}%` : "n/a"}</td></tr>
                  <tr className="border-b"><td className="py-1 text-neutral-500">R²</td><td className="py-1">{data.baseline.r2 != null ? data.baseline.r2.toFixed(3) : "n/a"}</td></tr>
                  <tr className="border-b"><td className="py-1 text-neutral-500">Months used</td><td className="py-1">{data.baseline.monthsUsed ?? "n/a"}</td></tr>
                  <tr><td className="py-1 text-neutral-500">Confidence</td><td className="py-1">{data.baseline.confidence ?? "n/a"}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-neutral-600 mt-1">No weather-normalized baseline exists for this site yet.</p>
            )}
          </section>
          <p className="text-sm text-neutral-700">The companion CSV carries measures, implementations, and verdicts with confidence chips.</p>
        </>
      )}

      <footer className="border-t pt-3 text-xs text-neutral-500 space-y-1">
        <p>{data.disclaimer}</p>
        <p>
          Verify this report against live data: <span className="font-mono">{origin}/verify/{token}</span> — figures on
          that page update with each new analysis; this printout reflects {printed}.
        </p>
        <p>Chips: Est. = modeled estimate · Good = high-confidence model · Measured = verified against actual usage.</p>
      </footer>
    </div>
  );
}
