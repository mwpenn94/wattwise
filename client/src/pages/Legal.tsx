/**
 * §5c-1b legal pages — compliance-material audit find.
 *
 * The spec (§8) grants consent, deletion, and export rights; these are the
 * documents those rights live in. One page, three anchored sections
 * (#privacy, #terms, #contact), footer-linked from every public and console
 * surface. Written in the product's own plain voice — the honesty rules in
 * the privacy policy are the same ones enforced in code (GPS never stored,
 * PII-free fingerprints, tenancy isolation).
 */
import { Link } from "wouter";
import { ArrowLeft, Zap } from "lucide-react";
import { useEffect } from "react";

const OWNER_CONTACT = "the site owner via the contact section below";

export default function Legal() {
  // Scroll to the anchor on load (wouter doesn't handle hash scroll).
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      document.querySelector(hash)?.scrollIntoView({ behavior: "instant", block: "start" });
    }
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <div className="min-h-screen bg-background">
        <header className="border-b border-border/60">
          <div className="container flex h-16 items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="h-5 w-5" />
              </div>
              <span className="font-display text-lg font-bold tracking-tight">Meterly</span>
            </Link>
            <Link href="/" className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to home
            </Link>
          </div>
        </header>

        <main className="container max-w-3xl py-12">
          <h1 className="font-display text-3xl font-extrabold tracking-tight">Privacy, terms &amp; contact</h1>
          <p className="mt-2 text-sm text-muted-foreground">Last updated July 18, 2026. Plain language on purpose — the same rules our code enforces.</p>

          {/* ---------------- privacy ---------------- */}
          <section id="privacy" className="mt-10 scroll-mt-20">
            <h2 className="font-display text-xl font-bold">Privacy policy</h2>
            <div className="mt-3 space-y-4 text-sm leading-relaxed text-muted-foreground">
              <p>
                <strong className="text-foreground">What we collect.</strong> When you use the free estimator, we process the address you type or the
                one-time location lookup you tap — we keep only the confirmed address you choose to analyze, never your raw GPS
                coordinate. If you create an account, we store your sites, the utility files you upload (bills, interval data),
                and the analysis results built from them. We record basic product events (page views, feature use) to improve the product.
              </p>
              <p>
                <strong className="text-foreground">What we never do.</strong> We never sell your data. We never share your usage data, bills, or
                addresses with third parties for marketing. A new occupant of an address you analyzed can never see your history —
                account isolation is enforced on every read path and covered by automated tests. When something goes wrong in the
                product, our error telemetry records the <em>situation</em> (file type, failure stage) with identifying details
                stripped by construction — never your name, address, or account.
              </p>
              <p>
                <strong className="text-foreground">Your rights.</strong> You can export your data (reports and uploads) and you can delete your
                sites, uploads, or entire account at any time from the console; deletion is permanent. If anything here is unclear
                or you want help exercising these rights, use the contact section below.
              </p>
              <p>
                <strong className="text-foreground">Cookies &amp; sessions.</strong> We use a session cookie to keep you signed in. The anonymous
                estimator does not require an account; estimator requests are rate-limited by connection to prevent abuse.
              </p>
            </div>
          </section>

          {/* ---------------- terms ---------------- */}
          <section id="terms" className="mt-12 scroll-mt-20">
            <h2 className="font-display text-xl font-bold">Terms of use</h2>
            <div className="mt-3 space-y-4 text-sm leading-relaxed text-muted-foreground">
              <p>
                <strong className="text-foreground">What Meterly is.</strong> Meterly turns your utility data — electric, gas, water, sewer — into modeled estimates, comparisons,
                and scenarios. Every number carries a confidence label (Estimated / Good / Measured) and a provenance trail showing
                how it was calculated.
              </p>
              <p>
                <strong className="text-foreground">What Meterly is not.</strong> Outputs are modeled estimates — not a professional energy audit,
                engineering study, or financial, tax, or legal advice. Savings projections carry stated confidence ranges and are
                not guarantees. Verify material decisions (equipment purchases, rate switches, solar contracts) with your utility
                and qualified professionals.
              </p>
              <p>
                <strong className="text-foreground">Your responsibilities.</strong> Upload only data you have the right to use. Don't attempt to
                access other users' data, probe the service, or resell outputs as measured performance. Beta tiers are provided
                as-is while billing is off; features marked beta may change.
              </p>
              <p>
                <strong className="text-foreground">Liability.</strong> To the maximum extent permitted by law, Meterly is provided "as is" and we
                are not liable for decisions made on modeled estimates. Nothing in these terms limits rights you hold under
                applicable consumer law.
              </p>
            </div>
          </section>

          {/* ---------------- contact ---------------- */}
          <section id="contact" className="mt-12 scroll-mt-20">
            <h2 className="font-display text-xl font-bold">Contact</h2>
            <div className="mt-3 space-y-4 text-sm leading-relaxed text-muted-foreground">
              <p>
                Questions about your data, these terms, or anything the product told you? Reach {OWNER_CONTACT}: signed-in users
                can use the feedback option in the console's Account &amp; usage page; anonymous visitors can write to the address
                published on the utility filings page of the site operator. Data-rights requests (export, deletion) are honored
                from the console directly and acknowledged within 30 days when made by message.
              </p>
            </div>
          </section>
        </main>

        <footer className="border-t border-border/60 py-8">
          <div className="container text-xs text-muted-foreground">
            <span className="font-mono">Meterly · modeled estimates, honestly labeled</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
