import { useAuth } from "@/_core/hooks/useAuth";
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
    body: "Re-price your real 8760 against seeded AZ tariffs — TOU, demand, ratchets, export rates — ranked with eligibility disclosures.",
  },
  {
    icon: Activity,
    title: "Weather-normalized baselines",
    body: "CalTRACK-grade degree-day regressions with fitted balance points, reported on a normal-year basis with fit statistics.",
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
    body: "eGRID subregion emission factors and ENERGY STAR peer percentiles, with sources and vintages cited inline.",
  },
  {
    icon: ShieldCheck,
    title: "Honest by construction",
    body: "Every number carries provenance, confidence, and methodology labels. Estimates are never dressed up as measurements.",
  },
];

export default function Home() {
  const { user, isAuthenticated } = useAuth();

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
                  <Button size="lg" className="font-semibold" onClick={() => startLogin()}>
                    Analyze my building <ArrowRight className="ml-2 h-4 w-4" />
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

            {/* stylized load curve */}
            <div className="rise-in rise-in-2 relative hidden lg:block">
              <div className="rounded-lg border border-border bg-card/80 p-5 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    demand profile · 15-min
                  </span>
                  <span className="prov-chip">measured</span>
                </div>
                <svg viewBox="0 0 400 160" className="w-full">
                  <defs>
                    <linearGradient id="loadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.78 0.15 70)" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="oklch(0.78 0.15 70)" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,140 C30,138 45,120 70,110 C95,100 110,60 140,48 C160,40 175,30 200,26 C225,22 240,45 265,55 C290,65 305,95 330,105 C355,115 380,132 400,136 L400,160 L0,160 Z"
                    fill="url(#loadFill)"
                  />
                  <path
                    d="M0,140 C30,138 45,120 70,110 C95,100 110,60 140,48 C160,40 175,30 200,26 C225,22 240,45 265,55 C290,65 305,95 330,105 C355,115 380,132 400,136"
                    fill="none"
                    stroke="oklch(0.78 0.15 70)"
                    strokeWidth="2"
                  />
                  <circle cx="200" cy="26" r="4" fill="oklch(0.78 0.15 70)" />
                  <text x="208" y="22" fontSize="9" fill="currentColor" className="font-mono opacity-70">
                    peak 412 kW · Jul 14 4:15p
                  </text>
                </svg>
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">load factor</p>
                    <p className="font-display text-xl font-bold stat-glow">0.46</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">demand share</p>
                    <p className="font-display text-xl font-bold stat-glow">38%</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">rate check</p>
                    <p className="font-display text-xl font-bold text-emerald-400">−$9.2k/yr</p>
                  </div>
                </div>
              </div>
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
                price: "$0",
                items: ["2 sites", "Uploads + hypothetical wizard", "Weather-normalized analysis", "EUI + peer benchmark", "Rate check + demand snapshot", "3 scenario runs/month", "Solar resource-class indicator"],
                cta: "Start free",
                highlight: false,
              },
              {
                name: "Plus",
                price: "$9–19/mo",
                items: ["Full tariff sweep", "End-use disaggregation", "Solar + battery modeling", "Unlimited scenarios", "Narrative reports", "PDF export"],
                cta: "Coming soon",
                highlight: true,
              },
              {
                name: "Pro",
                price: "$29–99/site/mo",
                items: ["Continuous monitoring", "Anomaly + demand-spike alerts", "Demand-charge management", "Portfolio dashboard", "M&V-grade reporting"],
                cta: "Coming soon",
                highlight: false,
              },
            ].map((t) => (
              <Card key={t.name} className={`relative ${t.highlight ? "border-primary/60 shadow-lg shadow-primary/10" : "border-border/70"}`}>
                <CardContent className="pt-6">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-display text-lg font-bold">{t.name}</h3>
                    <span className="font-mono text-sm text-primary">{t.price}</span>
                  </div>
                  <ul className="mt-4 space-y-2">
                    {t.items.map((i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
                        {i}
                      </li>
                    ))}
                  </ul>
                  {t.name === "Free" ? (
                    <Button className="mt-6 w-full" onClick={() => (isAuthenticated ? (window.location.href = "/app") : startLogin())}>
                      {t.cta}
                    </Button>
                  ) : (
                    <Button className="mt-6 w-full" variant="outline" disabled>
                      {t.cta}
                    </Button>
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
