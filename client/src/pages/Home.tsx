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

const FEATURES = [
  {
    icon: FileSpreadsheet,
    title: "Interval file ingestion",
    body: "Excel multi-sheet, CSV, and Green Button XML — parsed with footer-total validation and provenance tracking on every point.",
  },
  {
    icon: Gauge,
    title: "Demand analytics",
    body: "Monthly peaks with timestamps, load factor, ratchet exposure, demand heatmaps, and coincident-peak proxies with honest labels.",
  },
  {
    icon: BarChart3,
    title: "Tariff optimization",
    body: "Re-price your full year of usage, hour by hour, against seeded AZ rate plans — time-of-use, demand, ratchets, export rates — ranked with eligibility disclosures.",
  },
  {
    icon: Activity,
    title: "Weather-normalized baselines",
    body: "Industry-standard weather models separate what the weather did from what you did — reported on a normal-year basis with fit quality stated. (CalTRACK methods, named in the provenance.)",
  },
  {
    icon: Sun,
    title: "What-if scenarios",
    body: "Solar, battery, efficiency, EV charging — every scenario re-prices the full year and reports payback bands with confidence ranges.",
  },
  {
    icon: Building2,
    title: "Hypothetical buildings",
    body: "No data? Model a building from type, size, vintage, and climate zone using peer archetype load shapes — clearly labeled as synthetic.",
  },
  {
    icon: Leaf,
    title: "Emissions & benchmarking",
    body: "Regional grid emission factors and peer-building percentiles, with sources and vintages cited inline.",
  },
  {
    icon: ShieldCheck,
    title: "Honest by construction",
    body: "Every number carries provenance, confidence, and methodology labels. Estimates are never dressed up as measurements.",
  },
];

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  // §5b personalized upgrade moment: when signed in, the pricing section
  // speaks with the user's own numbers instead of generic copy. Query is
  // auth-gated; anonymous visitors see the standard cards untouched.
  const portfolio = trpc.entities.portfolio.useQuery(undefined, { enabled: isAuthenticated, staleTime: 60_000, retry: false });
  const personalOppUsd = portfolio.data?.totals.openOpportunityUsd ?? 0;
  const personalTopSite = portfolio.data?.sites.reduce<{ name: string; usd: number } | null>((acc, s) => {
    const usd = s.topOpportunityUsd ?? 0;
    return acc == null || usd > acc.usd ? { name: s.name, usd } : acc;
  }, null);

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
              <span className="font-display text-lg font-bold tracking-tight">WattWise</span>
              <span className="ml-2 hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:inline">
                utility data intelligence
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/convergence" className="font-mono text-xs text-muted-foreground hover:text-foreground">
                Methodology log
              </Link>
              {isAuthenticated ? (
                <Link href="/app">
                  <Button size="sm">
                    Open console <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </Link>
              ) : (
                <Button size="sm" onClick={() => startLogin()}>
                  Sign in
                </Button>
              )}
            </div>
          </div>
        </header>

        {/* hero */}
        <section className="container py-20 md:py-28">
          <div className="grid items-center gap-12 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="rise-in mb-4 font-mono text-xs uppercase tracking-[0.25em] text-primary">
                interval data · tariffs · scenarios
              </p>
              <h1 className="rise-in rise-in-1 max-w-2xl font-display text-4xl font-extrabold leading-[1.08] tracking-tight md:text-6xl">
                Your meter already knows where the money is going.
              </h1>
              <p className="rise-in rise-in-2 mt-6 max-w-xl text-lg text-muted-foreground">
                WattWise ingests your interval files and bills, rebuilds your rate from first principles, and shows you — with
                honest confidence ranges — what a rate switch, solar array, battery, or retrofit would actually change.
              </p>
              <div className="rise-in rise-in-3 mt-8 flex flex-wrap gap-3">
                {isAuthenticated ? (
                  <Link href="/app">
                    <Button size="lg" className="font-semibold">
                      Go to your dashboard <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="lg"
                    className="font-semibold"
                    onClick={() => document.querySelector<HTMLInputElement>('input[aria-label="Address for estimate"]')?.focus()}
                  >
                    Estimate my costs — free, no sign-up <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
                <Link href="/convergence">
                  <Button size="lg" variant="outline">
                    How we validate results
                  </Button>
                </Link>
              </div>
              <p className="rise-in rise-in-4 mt-6 max-w-lg text-xs text-muted-foreground/80">{MODELED_ESTIMATES_DISCLAIMER}</p>
            </div>

            {/* estimate-first onboarding — the product IS the hero (UX v1.9) */}
            <div className="rise-in rise-in-2 relative">
              <PublicEstimator />
            </div>
          </div>
        </section>

        {/* features */}
        <section className="border-t border-border/60 bg-card/40 py-16">
          <div className="container">
            <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
              One pipeline, actual <span className="text-primary">or hypothetical</span>.
            </h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Measured intervals and archetype-synthesized buildings flow through the identical analytics path — the only
              difference is the provenance label on the output.
            </p>
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
        <section className="container py-16">
          <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">Tiers</h2>
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
                  {/* §5b personalized upgrade copy — the user's own numbers, only when they exist */}
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
                  {t.name !== "Free" && (
                    <p className="mt-2 text-center text-[10px] text-muted-foreground">
                      Beta: no billing yet — switch plans free on the Account page.
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <footer className="border-t border-border/60 py-8">
          <div className="container flex flex-col items-center justify-between gap-3 text-xs text-muted-foreground md:flex-row">
            <span className="font-mono">WattWise · modeled estimates, honestly labeled</span>
            <div className="flex gap-4">
              <Link href="/convergence" className="hover:text-foreground">
                Convergence log
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
