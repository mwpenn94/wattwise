/**
 * R1 (Oct 26) — printable Portfolio report (Print / Save as PDF).
 *
 * Same paper rules as the site report: always white, no browser URL/title
 * header or footer (global @page margin 0), no web address in the footer.
 * Summary first (four tiles), then the actions worth doing with their savings
 * ranges, then per-site detail; the reading notes come once, short, at the end.
 * Savings are always shown as ranges with their basis — never hidden.
 */
import { formatSavingsRangeUsd, type SavingsRangeUsd } from "@shared/savingsRange";

export interface PortfolioReportSite {
  siteId: number;
  name: string;
  analyzed: boolean;
  annualCostUsd: number | null;
  fullBillRangeUsd?: SavingsRangeUsd | null;
  euiKwhPerSqft: number | null;
  meterCount?: number | null;
  topOpportunityTitle: string | null;
  topOpportunityRange?: SavingsRangeUsd | null;
}
export interface PortfolioReportAction {
  siteId: number;
  siteName: string;
  title: string;
  savingsRangeUsd: SavingsRangeUsd | null;
  paybackBandYears: string | null;
  confidence: string;
  status: string;
}
export interface PortfolioReportData {
  scopeLabel: string;
  generatedAt: number;
  sites: PortfolioReportSite[];
  actions: PortfolioReportAction[];
  byMeasure: Array<{ measure: string; title: string; savingsRangeUsd: SavingsRangeUsd | null; sites: Array<{ siteId: number }> }>;
  openSavingsRangeUsd: SavingsRangeUsd | null;
  inPlanRangeUsd: SavingsRangeUsd | null;
  progress: { completed: number; totalIdentified: number };
}

const TOP_ACTIONS = 15;
function usd(n: number | null | undefined) {
  return n == null || !Number.isFinite(n) ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;
}
function range(r: SavingsRangeUsd | null | undefined) {
  return r ? formatSavingsRangeUsd(r) : "—";
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[15px] font-semibold border-b border-neutral-300 pb-1 mb-2">{children}</h2>;
}

export default function PortfolioReport({ data }: { data: PortfolioReportData }) {
  const printed = new Date(data.generatedAt).toLocaleString();
  const analyzed = data.sites.filter((s) => s.analyzed);
  const costSites = data.sites.filter((s) => s.annualCostUsd != null);
  const annualCost = costSites.reduce((a, s) => a + (s.annualCostUsd ?? 0), 0);
  const billSites = data.sites.filter((s) => s.fullBillRangeUsd);
  const fullBill = billSites.length
    ? billSites.reduce((a, s) => ({ low: a.low + s.fullBillRangeUsd!.low, high: a.high + s.fullBillRangeUsd!.high }), { low: 0, high: 0 })
    : null;
  const meterCount = data.sites.reduce((a, s) => a + (s.meterCount ?? 0), 0);
  const openCount = data.actions.length;
  const kpis: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Modeled utility cost",
      value: costSites.length ? usd(annualCost) : "—",
      sub: `${analyzed.length} of ${data.sites.length} sites analyzed · tariff subtotal for the period covered`,
    },
    {
      label: "Estimated full bill",
      value: fullBill ? `${usd(fullBill.low)}–${usd(fullBill.high)}` : "—",
      sub: fullBill ? `adds LFCR and taxes · ${billSites.length} site${billSites.length === 1 ? "" : "s"} · estimate, not bill-confirmed` : "not available for these sites",
    },
    {
      label: "Open savings / yr",
      value: range(data.openSavingsRangeUsd),
      sub: `${openCount} open action${openCount === 1 ? "" : "s"}${data.inPlanRangeUsd ? ` · ${range(data.inPlanRangeUsd)} already in plan` : ""}`,
    },
    {
      label: "Sites and meters",
      value: `${data.sites.length} site${data.sites.length === 1 ? "" : "s"}`,
      sub: `${meterCount} meter${meterCount === 1 ? "" : "s"} · ${data.progress.completed}/${data.progress.totalIdentified} actions completed`,
    },
  ];
  const topActions = data.actions.slice(0, TOP_ACTIONS);
  const byMeasure = data.byMeasure.filter((m) => m.savingsRangeUsd);
  const sites = [...data.sites].sort((a, b) => (b.annualCostUsd ?? -1) - (a.annualCostUsd ?? -1));
  return (
    <div className="print-report max-w-[720px] mx-auto text-black text-[12px] leading-normal" data-testid="portfolio-report">
      <header className="border-b-2 border-black pb-3 mb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500 text-white" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M4 17V7l4-2 4 2 4-2 4 2v10l-4 2-4-2-4 2-4-2Z" />
                <path d="M8 9v6m4-4v6m4-8v6" />
              </svg>
            </span>
            <div>
              <div className="text-[12px] font-bold tracking-[0.12em]">METERLY</div>
              <div className="text-[9px] uppercase tracking-[0.18em] text-neutral-500">Utility data intelligence</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em]">Portfolio report</div>
            <div className="text-[10px] text-neutral-500">Prepared {printed}</div>
          </div>
        </div>
        <h1 className="text-[22px] font-bold mt-1">{data.scopeLabel}</h1>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-2">
        {kpis.map((k) => (
          <div key={k.label} className="border border-neutral-300 rounded p-2.5 break-inside-avoid">
            <div className="text-[9px] uppercase tracking-wide text-neutral-500">{k.label}</div>
            <div className="text-[18px] font-bold leading-tight">{k.value}</div>
            <div className="text-[9.5px] text-neutral-600 mt-0.5">{k.sub}</div>
          </div>
        ))}
      </section>

      <section className="mb-4 print-flow">
        <SectionTitle>Top actions</SectionTitle>
        {topActions.length === 0 ? (
          <p className="text-[11px] text-neutral-600">No open actions in this scope.</p>
        ) : (
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-400 text-left text-[9px] uppercase tracking-wide text-neutral-500">
                <th className="py-1 pr-2">Site</th>
                <th className="py-1 pr-2">Action</th>
                <th className="py-1 pr-2 text-right">Savings / yr</th>
                <th className="py-1 pr-2">Payback</th>
                <th className="py-1">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {topActions.map((a) => (
                <tr key={`${a.siteId}:${a.title}`} className="border-b border-neutral-200 align-top">
                  <td className="py-1 pr-2">{a.siteName}</td>
                  <td className="py-1 pr-2">
                    {a.title}
                    {a.status === "planned" || a.status === "in_progress" ? <span className="ml-1 text-[9px] text-neutral-500">(in plan)</span> : null}
                  </td>
                  <td className="py-1 pr-2 text-right font-semibold whitespace-nowrap">{range(a.savingsRangeUsd)}</td>
                  <td className="py-1 pr-2">{a.paybackBandYears ?? "—"}</td>
                  <td className="py-1 capitalize">{a.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.actions.length > TOP_ACTIONS && (
          <p className="text-[9.5px] text-neutral-500 mt-1">
            Showing the top {TOP_ACTIONS} of {data.actions.length} open actions; the rest are listed by type below and on each site&apos;s page.
          </p>
        )}
      </section>

      {byMeasure.length > 0 && (
        <section className="mb-4 print-flow">
          <SectionTitle>Savings by action type</SectionTitle>
          <table className="w-full text-[10.5px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-400 text-left text-[9px] uppercase tracking-wide text-neutral-500">
                <th className="py-1 pr-2">Action</th>
                <th className="py-1 pr-2 text-right">Sites</th>
                <th className="py-1 text-right">Savings / yr, all sites</th>
              </tr>
            </thead>
            <tbody>
              {byMeasure.map((m) => (
                <tr key={m.measure} className="border-b border-neutral-200">
                  <td className="py-1 pr-2">{m.title}</td>
                  <td className="py-1 pr-2 text-right">{m.sites.length}</td>
                  <td className="py-1 text-right font-semibold whitespace-nowrap">{range(m.savingsRangeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="mb-4 print-flow">
        <SectionTitle>Sites at a glance</SectionTitle>
        <table className="w-full text-[10.5px] border-collapse">
          <thead>
            <tr className="border-b border-neutral-400 text-left text-[9px] uppercase tracking-wide text-neutral-500">
              <th className="py-1 pr-2">Site</th>
              <th className="py-1 pr-2 text-right">Modeled cost</th>
              <th className="py-1 pr-2 text-right">Est. full bill</th>
              <th className="py-1 pr-2 text-right">kWh/sqft/yr</th>
              <th className="py-1">Next action</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr key={s.siteId} className="border-b border-neutral-200 align-top">
                <td className="py-1 pr-2">{s.name}</td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">{s.analyzed ? usd(s.annualCostUsd) : "not analyzed"}</td>
                <td className="py-1 pr-2 text-right whitespace-nowrap">{s.fullBillRangeUsd ? `${usd(s.fullBillRangeUsd.low)}–${usd(s.fullBillRangeUsd.high)}` : "—"}</td>
                <td className="py-1 pr-2 text-right">{s.euiKwhPerSqft != null ? s.euiKwhPerSqft.toFixed(1) : "—"}</td>
                <td className="py-1">
                  {s.topOpportunityTitle ? (
                    <>
                      {s.topOpportunityTitle}
                      {s.topOpportunityRange ? <span className="ml-1 font-semibold whitespace-nowrap">{range(s.topOpportunityRange)}/yr</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-2 break-inside-avoid">
        <SectionTitle>How to read these numbers</SectionTitle>
        <ul className="list-disc pl-4 text-[10px] text-neutral-700 space-y-0.5">
          <li>Costs are modeled from each site&apos;s interval data and the utility&apos;s filed rates. The full bill adds LFCR and taxes as a range until a bill confirms it.</li>
          <li>Savings are yearly ranges. Actions at different sites add up. At one site, actions on the same utility overlap, so the combined low end is the best single action and the high end is the sum.</li>
          <li>Estimates for remaining actions are recalculated after you mark an action complete.</li>
          <li>Measured (verified) savings appear only after enough post-change data is collected.</li>
        </ul>
      </section>

      <footer className="border-t border-neutral-400 pt-2 mt-4 text-[9px] text-neutral-500 break-inside-avoid">
        <p>All figures are modeled estimates from your uploaded data and public rate and weather references. They are not a professional energy audit, engineering study, or financial or tax advice.</p>
        <p className="mt-1">Generated {printed} · Meterly — Utility Data Intelligence</p>
      </footer>
    </div>
  );
}
