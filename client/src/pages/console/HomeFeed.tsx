/**
 * §3k Anti-dashboard home feed.
 *
 * Doctrine, mechanically: home is a story feed, not a metrics wall — at most
 * THREE items, ranked: (1) this month's verdict (§3e), (2) one new insight,
 * (3) one suggested action. The greeting number is YOURS: cumulative
 * verified savings, or projected (chip-labeled) when nothing is verified yet.
 * Charts live inside stories only; the full analytics live one tap away on
 * the Explore page — never the default. Ask WattWise (Plus) is a question
 * box that answers in the card grammar by dispatching to existing engines.
 * Empty of data ≠ empty of value: pre-upload the feed runs on the ladder
 * invite, an advisor's plan instead of zeros.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ArrowRight, BadgeCheck, Compass, Lightbulb, MessageCircleQuestion, Plane, Send, ShieldCheck, Sparkles } from "lucide-react";
import { InsightCard, chipFromConfidence, type InsightConfidence } from "@/components/InsightCard";
import EnergyWrapped from "@/components/EnergyWrapped";
import { MarkImplementedDialog, ProveItStatusChip } from "@/components/ProveIt";
import QuickStart from "@/components/QuickStart";
import { useAuth } from "@/_core/hooks/useAuth";
import { Link, useLocation } from "wouter";

export default function HomeFeed() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const sites = trpc.sites.list.useQuery();
  const [siteSel, setSiteSel] = useState<string>("");
  const activeSiteId = siteSel ? Number(siteSel) : (sites.data?.[0]?.id ?? null);

  const verified = trpc.proveIt.verifiedTotal.useQuery(undefined, { enabled: (sites.data ?? []).length > 0 });
  const impls = trpc.proveIt.list.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const insights = trpc.insights.list.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const opps = trpc.insights.opportunities.useQuery({ siteId: activeSiteId! }, { enabled: activeSiteId != null });
  const usage = trpc.account.usage.useQuery();
  const alerts = trpc.alerts.list.useQuery({ status: "open" }, { enabled: (sites.data ?? []).length > 0 });

  const [markTarget, setMarkTarget] = useState<{ id?: number; measure: string; title: string; expectedSavingsUsd: number | null } | null>(null);

  /* ---------- v1.19 away mode: one toggle flips the product's voice ---------- */
  const utils = trpc.useUtils();
  const activeSite = (sites.data ?? []).find((s) => s.id === activeSiteId) ?? null;
  const isAway = Boolean((activeSite as { awayMode?: boolean } | null)?.awayMode);
  const setAway = trpc.sites.setAway.useMutation({
    onSuccess: async (_d, vars) => {
      toast.success(vars.awayMode ? "Away mode on — WattWise will stay quiet unless something needs you" : "Welcome back — full feed restored");
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const awayAlert = (alerts.data ?? []).find(
    (a) => a.siteId === activeSiteId && a.kind === "away_watchdog" && a.status === "open",
  ) ?? null;

  /* ---------- greeting number: verified first, projected fallback ---------- */
  const projectedTotal = useMemo(
    () => (opps.data ?? []).reduce((s, o) => s + (o.estCostSavingsPerYr ?? 0), 0),
    [opps.data],
  );
  const verifiedTotal = verified.data?.totalUsd ?? 0;
  const greetingUsd = verifiedTotal > 0 ? verifiedTotal : projectedTotal;
  const greetingKind: "verified" | "projected" | null = verifiedTotal > 0 ? "verified" : projectedTotal > 0 ? "projected" : null;
  const firstName = (user?.name ?? "").split(" ")[0] || "there";

  /* ---------- the three stories ---------- */
  const latestImpl = (impls.data ?? [])[0] ?? null;
  const narrative = (insights.data ?? []).filter((i) => i.kind !== "summary");
  // "one new insight" — prefer anomaly > peak_attribution > anything else
  const insightStory =
    narrative.find((i) => i.kind === "anomaly") ??
    narrative.find((i) => i.kind === "peak_attribution") ??
    narrative.find((i) => !["intake_assumptions", "data_coverage"].includes(i.kind)) ??
    narrative[0] ??
    null;
  const topOpp = (opps.data ?? [])[0] ?? null;
  const hasAnalysis = narrative.length > 0 || (opps.data ?? []).length > 0;

  if (sites.isLoading) {
    return (
      <div className="container max-w-3xl py-8">
        <Skeleton className="h-16 w-80" />
        <Skeleton className="mt-6 h-40 w-full" />
        <Skeleton className="mt-3 h-40 w-full" />
      </div>
    );
  }

  /* ---------- empty of data ≠ empty of value ---------- */
  if ((sites.data ?? []).length === 0) {
    return (
      <div className="container max-w-3xl py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight">Hi {firstName} —</h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          You don't have data here yet, but that doesn't mean there's nothing to show. Start with just an address or a
          bill photo and WattWise will produce an estimated plan immediately — every added detail moves you up the
          accuracy ladder: <span className="font-semibold text-foreground">Estimate → Good → Great → Measured</span>.
        </p>
        <div className="mt-6">
          <QuickStart />
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/app/sites">
            <Button variant="outline">Full site form</Button>
          </Link>
          <Link href="/app/wizard">
            <Button variant="outline">Hypothetical building</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl py-8">
      {/* ---------- greeting: the number that greets you is yours ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Hi {firstName} —</p>
          {greetingKind ? (
            <p className="mt-1 font-display text-3xl font-bold tracking-tight">
              <span className={greetingKind === "verified" ? "text-emerald-500" : "text-primary"}>
                ${Math.round(greetingUsd).toLocaleString()}
              </span>{" "}
              <span className="text-lg font-semibold text-muted-foreground">
                {greetingKind === "verified" ? "verified savings so far" : "per year identified for you"}
              </span>
              <span
                className={`ml-2 inline-block rounded-full border px-2 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wider ${
                  greetingKind === "verified"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                    : "border-primary/40 bg-primary/10 text-primary"
                }`}
              >
                {greetingKind === "verified" ? "measured" : "projected"}
              </span>
            </p>
          ) : (
            <p className="mt-1 font-display text-3xl font-bold tracking-tight">Let's find your first dollar.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(sites.data ?? []).length > 1 && (
            <Select value={activeSiteId != null ? String(activeSiteId) : ""} onValueChange={setSiteSel}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Site…" />
              </SelectTrigger>
              <SelectContent>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {activeSiteId != null && <EnergyWrapped siteId={activeSiteId} />}
          <Link href={`/app/explore${activeSiteId != null ? `?site=${activeSiteId}` : ""}`}>
            <Button variant="outline" className="gap-1.5">
              <Compass className="h-4 w-4" /> Explore
            </Button>
          </Link>
        </div>
      </div>

      {/* ---------- v1.19 away toggle: small, persistent, honest ---------- */}
      {activeSiteId != null && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant={isAway ? "default" : "outline"}
            className="h-7 gap-1.5 text-xs"
            disabled={setAway.isPending}
            onClick={() => setAway.mutate({ siteId: activeSiteId, awayMode: !isAway })}
          >
            <Plane className="h-3.5 w-3.5" /> {isAway ? "Away mode on" : "I'm away"}
          </Button>
          {isAway && (
            <span className="text-[11px] text-muted-foreground">Feed is quiet — only empty-home excess will reach you.</span>
          )}
        </div>
      )}

      {/* ---------- Ask WattWise ---------- */}
      <AskWattwise siteId={activeSiteId} tier={usage.data?.tier ?? "free"} />

      {/* ---------- away mode: the watchdog card replaces the feed's voice ---------- */}
      {isAway && (
        <div className="mt-6">
          <StoryLabel icon={<ShieldCheck className="h-3.5 w-3.5" />} text="Away watchdog" />
          {awayAlert ? (
            <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
              <p className="text-sm font-semibold">{awayAlert.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{awayAlert.body}</p>
              {awayAlert.dollarImpactUsd > 0 && (
                <p className="mt-2 font-display text-lg font-bold text-amber-500">
                  ~${Math.round(awayAlert.dollarImpactUsd).toLocaleString()} of excess so far
                </p>
              )}
            </div>
          ) : (
            <div className="mt-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
              <p className="text-sm font-semibold">All quiet at {activeSite?.name ?? "your site"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                No usage above your empty-home baseline in the data on file. Checked as of your last upload — upload a
                fresh interval file any time for a new sweep. Water gets leak-first framing: any sustained flow at an
                empty home raises a hand immediately.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------- the three stories (quieted while away) ---------- */}
      <div className={isAway ? "mt-6 space-y-4 opacity-60" : "mt-6 space-y-4"}>
        {!hasAnalysis && (
          <Card className="border-dashed">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-6">
              <div>
                <p className="text-sm font-semibold">No analysis yet for this site</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  One run produces your baseline, rate check, and ranked opportunities — under a minute.
                </p>
              </div>
              <Link href={`/app/explore?site=${activeSiteId}`}>
                <Button className="gap-1.5">
                  Run it on Explore <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {/* Story 1 — this month's verdict (§3e) */}
        {latestImpl && (
          <section>
            <StoryLabel icon={<BadgeCheck className="h-3.5 w-3.5" />} text="This month's verdict" />
            <div className="mt-1.5 rounded-md border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{latestImpl.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Implemented {new Date(latestImpl.implementedAt).toLocaleDateString()} · verified against the
                    weather-adjusted counterfactual
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ProveItStatusChip status={latestImpl.status} />
                  {(latestImpl.verifiedSavingsUsd ?? 0) > 0 && (
                    <span className="font-display text-lg font-bold text-emerald-500">
                      ${Math.round(latestImpl.verifiedSavingsUsd!).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <Link href={`/app/explore?site=${activeSiteId}`}>
                <Button size="sm" variant="ghost" className="mt-2 h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground">
                  Full ledger on Explore <ArrowRight className="h-3 w-3" />
                </Button>
              </Link>
            </div>
          </section>
        )}

        {/* Story 2 — one new insight */}
        {insightStory && (
          <section>
            <StoryLabel icon={<Sparkles className="h-3.5 w-3.5" />} text="One thing your data said" />
            <div className="mt-1.5">
              <InsightCard
                dollars={null}
                headlineFallback={insightStory.title}
                why={insightStory.body ?? insightStory.title}
                confidence={chipFromConfidence(insightStory.confidence)}
                extraChips={[insightStory.kind.replace(/_/g, " ")]}
                action={{
                  label: "See it in context",
                  onClick: () => navigate(`/app/explore?site=${activeSiteId}`),
                }}
                provenance={["From your latest stored analysis — the Explore page holds the full picture with every chart and its takeaway."]}
              />
            </div>
          </section>
        )}

        {/* Story 3 — one suggested action */}
        {topOpp && (
          <section>
            <StoryLabel icon={<Lightbulb className="h-3.5 w-3.5" />} text="Your next move" />
            <div className="mt-1.5">
              <InsightCard
                rank={topOpp.rank}
                title={topOpp.title}
                dollars={topOpp.estCostSavingsPerYr}
                framing="Save"
                headlineFallback={`No dollar figure yet (needs a priced rate)`}
                why={topOpp.description ?? ""}
                confidence={chipFromConfidence(topOpp.confidence)}
                extraChips={topOpp.paybackBandYears ? [`payback ${topOpp.paybackBandYears}`] : []}
                action={{
                  label: "Model this in Scenarios",
                  onClick: () => navigate(`/app/scenarios?site=${activeSiteId}&measure=${topOpp.measure}`),
                }}
                secondaryAction={{
                  label: "I did this",
                  onClick: () =>
                    setMarkTarget({ id: topOpp.id, measure: topOpp.measure, title: topOpp.title, expectedSavingsUsd: topOpp.estCostSavingsPerYr ?? null }),
                }}
                provenance={["Your #1 ranked opportunity by estimated annual dollar impact — the full ranked list lives on Explore."]}
              />
            </div>
          </section>
        )}
      </div>

      {activeSiteId != null && (
        <MarkImplementedDialog open={markTarget != null} onOpenChange={(v) => !v && setMarkTarget(null)} siteId={activeSiteId} opportunity={markTarget} />
      )}
    </div>
  );
}

function StoryLabel(props: { icon: React.ReactNode; text: string }) {
  return (
    <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
      {props.icon} {props.text}
    </p>
  );
}

/* ---------- Ask WattWise (Plus, agentic entrance to engines) ---------- */

function AskWattwise({ siteId, tier }: { siteId: number | null; tier: string }) {
  const [q, setQ] = useState("");
  const [, navigate] = useLocation();
  const ask = trpc.ask.question.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const card = ask.data?.card ?? null;
  const isPlus = tier === "plus" || tier === "pro";

  return (
    <div className="mt-5">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isPlus) {
            toast.info("Ask WattWise is a Plus feature", {
              description: "Upgrade on the Account page — during the beta, switching tiers is free.",
              action: { label: "Account", onClick: () => navigate("/app/account") },
            });
            return;
          }
          if (siteId == null || q.trim().length < 3) return;
          ask.mutate({ siteId, question: q.trim() });
        }}
      >
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isPlus ? "Ask WattWise — “Why was July high?” · “What if I add a battery?”" : "Ask WattWise (Plus) — “Why was July high?”"}
            className="pl-9"
            maxLength={500}
          />
        </div>
        <Button type="submit" disabled={ask.isPending || (isPlus && (siteId == null || q.trim().length < 3))} className="gap-1.5">
          <Send className="h-4 w-4" /> {ask.isPending ? "Routing…" : "Ask"}
        </Button>
      </form>
      {!isPlus && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Answers come from your real analysis engines — attribution, scenarios, rate sweep — never generated text.{" "}
          <Link href="/app/account" className="underline hover:text-foreground">
            Plus feature
          </Link>
          .
        </p>
      )}
      {card && (
        <div className="mt-3">
          <InsightCard
            dollars={card.dollars}
            framing={(card.framing as "Save" | null) ?? undefined}
            headlineFallback={card.headlineFallback}
            why={card.why}
            confidence={card.confidence as InsightConfidence}
            extraChips={card.extraChips}
            action={card.action ? { label: card.action.label, onClick: () => navigate(card.action!.href.replace("/app", "/app")) } : undefined}
            provenance={card.provenance}
          />
        </div>
      )}
    </div>
  );
}
