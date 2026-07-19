import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Building2,
  FileSpreadsheet,
  Gauge,
  Leaf,
  ShieldCheck,
  Sun,
  Zap,
} from "lucide-react";
import { MODELED_ESTIMATES_DISCLAIMER } from "@shared/wattwise";
import { PublicEstimator } from "@/components/PublicEstimator";
import { useLang } from "@/lib/i18n";

/* §5c-3 consumer-voice pass: cards are outcome-first, verbs first, no spec
 * vocabulary. Methodology talk lives in "How we validate results" where it
 * belongs — jargon only inside the provenance/methodology layer. */
const FEATURES = [
  {
    icon: FileSpreadsheet,
    title: "Drop in your utility files",
    body: "Spreadsheets, CSVs, or Green Button downloads — we check every file against its own printed totals and tell you exactly what we could and couldn't read.",
  },
  {
    icon: Gauge,
    title: "See the half-hour that set your bill",
    body: "Find the exact moment your demand peaked, what it cost you, and whether it's a one-off spike you can clip or a pattern worth fixing.",
  },
  {
    icon: BarChart3,
    title: "Re-price your year on every plan",
    body: "We run your whole year, hour by hour, through every rate plan you're allowed to take — and rank them by what you'd actually pay.",
  },
  {
    icon: Activity,
    title: "Know what the weather did vs. what you did",
    body: "A hot July isn't your fault. We separate weather from behavior so changes you make get credited fairly — and false wins don't.",
  },
  {
    icon: Sun,
    title: "Test solar, batteries, and schedules",
    body: "Move the sliders — solar size, battery, shifted schedules — and watch your annual cost respond, with honest payback ranges.",
  },
  {
    icon: Building2,
    title: "Model a building you don't have data for",
    body: "Considering a lease or purchase? Get a full analysis from just the building's type, size, and location — clearly labeled as an estimate.",
  },
  {
    icon: Leaf,
    title: "See how you compare",
    body: "Your emissions and costs next to buildings like yours — with the sources for every comparison a tap away.",
  },
  {
    icon: ShieldCheck,
    title: "Every number shows its work",
    body: "Estimates are labeled estimates, measurements are labeled measurements, and every figure can show you how it was calculated.",
  },
];

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const { lang, t, setLang } = useLang();
  // §5b personalized upgrade moment: when signed in, the pricing section
  // speaks with the user's own numbers instead of generic copy. Query is
  // auth-gated; anonymous visitors see the standard cards untouched.
  const portfolio = trpc.entities.portfolio.useQuery(undefined, { enabled: isAuthenticated, staleTime: 60_000, retry: false });
  const personalOppUsd = portfolio.data?.totals.openOpportunityUsd ?? 0;
  const personalTopSite = portfolio.data?.sites.reduce<{ name: string; usd: number } | null>((acc, s) => {
    const usd = s.topOpportunityUsd ?? 0;
    return acc == null || usd > acc.usd ? { name: s.name, usd } : acc;
  }, null);

  // §5c-1 "since your last visit" — built from the user's own portfolio, in
  // priority order: anomalies (act now) > away watchdog (reassure) > open
  // dollars (motivate) > verified savings (celebrate) > honest fallback.
  const sinceLastVisit = (() => {
    const d = portfolio.data;
    if (!d) return "Your sites, opportunities, and alerts are waiting in the dashboard.";
    const anomalySites = d.sites.filter((s) => s.hasAnomaly);
    if (anomalySites.length > 0) {
      return anomalySites.length === 1
        ? `Heads up: ${anomalySites[0].name} has an open anomaly worth a look.`
        : `Heads up: ${anomalySites.length} of your sites have open anomalies worth a look.`;
    }
    const awaySites = d.sites.filter((s) => s.awayMode);
    if (awaySites.length > 0) {
      return awaySites.length === 1
        ? `All quiet at ${awaySites[0].name} — the away watchdog hasn't seen anything unusual.`
        : `All quiet — the away watchdog is standing guard on ${awaySites.length} sites with nothing unusual to report.`;
    }
    const open = d.totals.openOpportunityUsd ?? 0;
    if (open > 0) return `You still have ~$${Math.round(open).toLocaleString()}/yr in open opportunities across your sites.`;
    const verified = d.totals.verifiedSavingsUsd ?? 0;
    if (verified > 0) return `Your implemented changes have $${Math.round(verified).toLocaleString()} in verified savings so far.`;
    return d.totals.siteCount > 0
      ? "No new alerts since your last visit — your analysis is up to date."
      : "Add your first site to start turning utility data into dollars.";
  })();

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <div className="min-h-screen bg-background grid-texture">
        {/* nav */}
        <header className="border-b border-border/60">
          <div className="container flex h-16 items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="h-5 w-5" />
              </div>
              <span translate="no" className="font-display text-lg font-bold tracking-tight">Meterly</span>
              <span className="ml-2 hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:inline">
                utility data intelligence
              </span>
            </div>
            {/* §5c-4 chrome cleanup + §5c-5 mobile fix + §5c-6 nav anchors:
                builder instruments (console CTA, convergence link) are gone from
                the logged-out chrome; anchors make How-it-works/Pricing reachable
                without blind scrolling; items get real touch targets and no-wrap
                so "ES · Español" can't collide at phone width. */}
            <nav className="flex items-center gap-1 sm:gap-2">
              <a href="#how-it-works" className="hidden whitespace-nowrap rounded-md px-2 py-2 font-mono text-xs text-muted-foreground hover:text-foreground md:inline-block">
                {t("nav.howItWorks")}
              </a>
              <a href="#pricing" className="hidden whitespace-nowrap rounded-md px-2 py-2 font-mono text-xs text-muted-foreground hover:text-foreground md:inline-block">
                {t("nav.pricing")}
              </a>
              {/* EN/ES groundwork: explicit choice, persisted; public funnel translates,
                  console honestly stays EN for now (disclosed in the switcher note). */}
              <button
                type="button"
                className="whitespace-nowrap rounded-md px-2 py-2 font-mono text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setLang(lang === "en" ? "es" : "en")}
                aria-label={t("lang.label")}
                title={t("lang.consoleNote")}
              >
                {lang === "en" ? "ES" : "EN"}
                <span className="hidden sm:inline">{lang === "en" ? " · Español" : " · English"}</span>
              </button>
              {isAuthenticated ? (
                <Link href="/app">
                  <Button size="sm">
                    Your dashboard <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              ) : (
                <Button size="sm" variant="outline" onClick={() => startLogin()}>
                  {t("cta.signIn")}
                </Button>
              )}
            </nav>
          </div>
        </header>

        {/* hero */}
        {/* §5c-1 auth-state-aware hero: NEW visitors get the estimate box AS the
            hero — headline, then the box, everything else below; the 60-second
            clock starts at first paint. RETURNING users get their dashboard CTA
            plus a "since your last visit" line built from their own portfolio. */}
        {isAuthenticated ? (
          <section className="container py-20 md:py-28">
            <div className="grid items-center gap-12 lg:grid-cols-[1.2fr_1fr]">
              <div>
                <p className="rise-in mb-4 font-mono text-xs uppercase tracking-[0.25em] text-primary">
                  interval data · tariffs · scenarios
                </p>
                <h1 className="rise-in rise-in-1 max-w-2xl font-display text-4xl font-extrabold leading-[1.08] tracking-tight md:text-6xl">
                  Welcome back{user?.name ? `, ${user.name.split(" ")[0]}` : ""}.
                </h1>
                <p className="rise-in rise-in-2 mt-6 max-w-xl text-lg text-muted-foreground">{sinceLastVisit}</p>
                <div className="rise-in rise-in-3 mt-8 flex flex-wrap gap-3">
                  <Link href="/app">
                    <Button size="lg" className="font-semibold">
                      Go to your dashboard <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                  <Link href="/convergence">
                    <Button size="lg" variant="outline">
                      How we validate results
                    </Button>
                  </Link>
                </div>
                <p className="rise-in rise-in-4 mt-6 max-w-lg text-xs text-muted-foreground/80">
                  {lang === "es" ? t("estimator.disclaimer") : MODELED_ESTIMATES_DISCLAIMER}
                </p>
              </div>
              <div className="rise-in rise-in-2 relative">
                <PublicEstimator />
              </div>
            </div>
          </section>
        ) : (
          <section className="container py-14 md:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <p className="rise-in mb-4 font-mono text-xs uppercase tracking-[0.25em] text-primary">
                interval data · tariffs · scenarios
              </p>
              <h1 className="rise-in rise-in-1 font-display text-4xl font-extrabold leading-[1.08] tracking-tight md:text-6xl">
                {lang === "es" ? t("hero.tagline") : "Your meter already knows where the money is going."}
              </h1>
              <p className="rise-in rise-in-2 mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
                {lang === "es"
                  ? t("hero.sub")
                  : "Type an address, get a real dollar estimate in under a minute — free, no sign-up. Every detail you add sharpens it."}
              </p>
            </div>
            {/* the estimate box IS the hero — nothing between it and the headline */}
            <div className="rise-in rise-in-2 relative mx-auto mt-8 max-w-xl">
              <PublicEstimator />
            </div>
            {/* §5c-2 one real card beats six descriptions — a dollar above the fold */}
            <SampleInsightCard />
            <p className="rise-in rise-in-4 mx-auto mt-6 max-w-lg text-center text-xs text-muted-foreground/80">
              {lang === "es" ? t("estimator.disclaimer") : MODELED_ESTIMATES_DISCLAIMER}
            </p>
          </section>
        )}

        {/* features */}
        <section id="how-it-works" className="scroll-mt-16 border-t border-border/60 bg-card/40 py-16">
          <div className="container">
            <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
              {t("howit.title.pre")}
              <span className="text-primary">{t("howit.title.em")}</span>.
            </h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">{t("howit.sub")}</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((f) => (
                <Card key={f.title} className="border-border/70 bg-card/80 transition-transform duration-200 hover:-translate-y-0.5">
                  <CardContent className="pt-5">
                    <f.icon className="h-5 w-5 text-primary" />
                    <h3 className="mt-3 font-display text-sm font-semibold">{f.title}</h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* tiers */}
        <section id="pricing" className="container scroll-mt-16 py-16">
          <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">{t("tiers.title")}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              {
                name: "Free",
                persona: "For the curious — see what your building costs and why",
                price: "$0",
                // §5b rule 5: value first, limits last. Rule 6: no jargon ("Solar
                // resource-class indicator" → "Solar potential rating").
                items: ["Instant estimate for any address", "Weather-normalized analysis", "Peer-building benchmark", "Rate check + demand snapshot", "Solar potential rating", "3 scenario runs/month", "Up to 2 sites"],
                cta: "Start free",
                highlight: false,
                badge: null as string | null,
              },
              {
                name: "Plus",
                persona: "For homeowners and owners acting on their plan",
                // §5b rule 2: a number, not a range.
                price: "$12/mo",
                items: ["Full tariff sweep across every eligible plan", "End-use disaggregation", "Solar + battery modeling", "Unlimited scenarios + Bill Builder full basket", "Narrative reports", "PDF export"],
                cta: "Start Plus (beta)",
                highlight: true,
                badge: "Most popular" as string | null,
              },
              {
                name: "Pro",
                persona: "For facilities teams and portfolios",
                // §5b rule 2: "from $X" is allowed only with the driver stated — site count.
                price: "$29/site/mo",
                // §3i pre-purchase feed honesty: name the data mechanism before
                // checkout — analysis re-runs on each upload; no live utility feed yet.
                items: ["Portfolio view across every site", "Anomaly + demand-spike findings on each upload", "Demand-charge management", "M&V-grade reporting + practitioner export", "Data updates via bill/interval uploads today — utility feeds are on the roadmap, not sold as live"],
                cta: "Start Pro (beta)",
                highlight: false,
                badge: null as string | null,
              },
            ].map((t) => (
              <Card key={t.name} className={`relative ${t.highlight ? "border-primary/60 shadow-lg shadow-primary/10" : "border-border/70"}`}>
                {t.badge && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-primary px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                    {t.badge}
                  </span>
                )}
                <CardContent className="pt-6">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-display text-lg font-bold">{t.name}</h3>
                    <span className="font-mono text-sm text-primary">{t.price}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.persona}</p>
                  {/* §5b + §5c-6 personalized copy — the user's own numbers on
                      every tier they're eligible to reason about, only when real */}
                  {isAuthenticated && t.name === "Free" && (portfolio.data?.totals.siteCount ?? 0) > 0 && (
                    <p className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground">
                      You're on Free with {portfolio.data!.totals.siteCount}{" "}
                      {portfolio.data!.totals.siteCount === 1 ? "site" : "sites"} analyzed — everything below stays yours.
                    </p>
                  )}
                  {isAuthenticated && t.name === "Plus" && personalOppUsd > 0 && (
                    <p className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px] text-foreground">
                      Your analysis found <strong>~${Math.round(personalOppUsd).toLocaleString()}/yr</strong> in open opportunities
                      {personalTopSite && personalTopSite.usd > 0 ? <> — the biggest at {personalTopSite.name}</> : null}. Plus unlocks the full basket and reports for it.
                    </p>
                  )}
                  {isAuthenticated && t.name === "Pro" && (portfolio.data?.totals.siteCount ?? 0) > 1 && (
                    <p className="mt-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-foreground">
                      You have {portfolio.data!.totals.siteCount} sites — Pro ranks them by open dollars and anomalies in one view.
                    </p>
                  )}
                  <ul className="mt-4 space-y-2">
                    {t.items.map((i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                        {i}
                      </li>
                    ))}
                  </ul>
                  {/* Gap-6: Plus/Pro were dead "Coming soon" buttons while the
                      server-side tier gates were already live — now every tier
                      is self-serve during the beta via Account & usage. */}
                  {t.name === "Free" ? (
                    <Button className="mt-6 w-full" onClick={() => (isAuthenticated ? (window.location.href = "/app") : startLogin())}>
                      {t.cta}
                    </Button>
                  ) : (
                    <Button
                      className="mt-6 w-full"
                      variant="outline"
                      onClick={() => (isAuthenticated ? (window.location.href = "/app/account") : startLogin())}
                    >
                      {t.cta}
                    </Button>
                  )}
                  {/* §5c-6 contrast: was text-[10px] muted (sub-AA on near-black);
                      annual-toggle note deferred until billing exists — no fake toggle. */}
                  {t.name !== "Free" && (
                    <p className="mt-2 text-center text-[11px] text-foreground/75">
                      Beta: no billing yet — switch plans free on the Account page.
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* §5c-1b legal footer + §5c-4 chrome cleanup: privacy/terms/contact on
            every page; "Convergence log" renamed to plain Methodology; the
            Console link stays auth-only. */}
        <footer className="border-t border-border/60 py-8">
          <div className="container flex flex-col items-center justify-between gap-3 text-xs text-muted-foreground md:flex-row">
            <span className="font-mono"><span translate="no">Meterly</span> · modeled estimates, honestly labeled</span>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Link href="/legal#privacy" className="hover:text-foreground">
                {t("footer.privacy")}
              </Link>
              <Link href="/legal#terms" className="hover:text-foreground">
                {t("footer.terms")}
              </Link>
              <Link href="/legal#contact" className="hover:text-foreground">
                {t("footer.contact")}
              </Link>
              <Link href="/convergence" className="hover:text-foreground">
                {t("footer.methodology")}
              </Link>
              {isAuthenticated && (
                <Link href="/app" className="hover:text-foreground">
                  Console
                </Link>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* §5c-2 live sample insight card — one REAL card from the real pipeline, not a
 * mock. Hydrated from a server-cached query so it costs nothing per visitor,
 * puts an actual dollar figure above the fold, and is honestly labeled a demo
 * building with its confidence rung. Hidden entirely on error — never a broken
 * or fabricated card. */
function SampleInsightCard() {
  const sample = trpc.estimate.sampleCard.useQuery(undefined, { staleTime: 6 * 60 * 60 * 1000, retry: 1 });
  if (sample.isError) return null;
  return (
    <div className="rise-in rise-in-3 mx-auto mt-6 max-w-xl">
      <Card className="border-border/70 bg-card/80 text-left">
        <CardContent className="pt-5">
          {sample.isLoading || !sample.data ? (
            <div className="space-y-3" aria-hidden>
              <div className="h-3 w-40 animate-pulse rounded bg-muted" />
              <div className="h-7 w-56 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Live example · what an insight looks like
                </p>
                <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-primary">
                  Estimated
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{sample.data.label}</p>
              <p className="mt-1 font-display text-2xl font-extrabold tracking-tight">
                ~${Math.round(sample.data.estimatedAnnualCostUsd).toLocaleString()}
                <span className="text-base font-semibold text-muted-foreground">/yr estimated energy cost</span>
              </p>
              {sample.data.topOpportunity && (
                <p className="mt-2 text-sm text-foreground">
                  Biggest opportunity: <strong>{sample.data.topOpportunity.title}</strong> — worth about{" "}
                  <strong>${Math.round(sample.data.topOpportunity.estimatedSavingsUsd).toLocaleString()}/yr</strong>
                  <span className="text-muted-foreground"> ({sample.data.topOpportunity.basis})</span>
                </p>
              )}
              {sample.data.percentileBand && (
                <p className="mt-1 text-xs text-muted-foreground">Peer comparison: {sample.data.percentileBand}</p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                This is a real analysis of a demo office in Tucson — type your address above to see yours.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
