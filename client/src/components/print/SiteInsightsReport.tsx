/**
 * PRINT (Jul 19) — Site Insights Report: a print-grade rendering of the full
 * Explore analysis. Replaces the raw Ctrl+P screen dump the owner flagged
 * (sidebar chrome, clipped scroll tables, blank canvas heatmap, cards sliced
 * across pages). Everything here is static: SVG charts instead of interactive
 * canvases, full tables instead of scroll containers, break-inside-avoid on
 * every section, and a provenance/confidence chip on every number. The footer
 * carries the live verification link so a forwarded PDF is never silently
 * stale.
 */
import React from "react";

/* ---------- data contracts (mirrors Explore/Dashboard.tsx summary shapes) ---------- */

export interface InsightsPrintDemand {
  peakKw: number;
  peakTimestamp: number;
  avgKw: number;
  loadFactor: number;
  heatmap: number[][];
  monthlyPeaks: Array<{ month: string; peakKw: number; peakTs: number }>;
  loadDurationCurve?: Array<{ pctOfHours: number; kw: number }>;
  hoursNearPeakPct?: number;
  peakHypotheses?: Array<{ month: string; ts: number; kw: number; hypothesis: string; basis: string }>;
}

export interface InsightsPrintData {
  site: { name: string; buildingType: string | null; sqft: number | null; state: string | null; zip?: string | null; utilityName?: string | null };
  generatedAt: number;
  demand: InsightsPrintDemand | null;
  benchmark: { siteEui?: number | null; percentileBand?: string | null; source?: string | null } | null;
  emissions: { annualCo2eLb?: number; subregion?: string; factorYear?: number; mapped?: boolean } | null;
  currentCost: { breakdown?: { energy: number; demand: number; fixed: number; total: number; cp?: number | null; minBillAdjustment?: number } } | null;
  /* HOL-6 (owner Jul 29): connectivity joins the report's cost picture like the
     other utilities — entered subscription dollars with their own provenance
     chip so modeled vs entered bases never blend. */
  telecom?: { serviceCount: number; monthlyUsd: number; annualUsd: number } | null;
  baseline: { method?: string; rSquared?: number | null; cvrmse?: number | null; confidenceLabel?: string } | null;
  tariffComparisons: Array<{
    tariffName: string;
    utilityName: string;
    freshness: string;
    eligible: boolean;
    ineligibleReason?: string | null;
    annualCost: { total: number };
    savingsVsCurrent: number | null;
    eligibilityNote?: string;
  }> | null;
  chart: Array<{ ts: number; kw: number }>;
  chartWindowLabel: string;
  insights: Array<{ kind: string; title: string; body: string; confidence?: string | null }>;
  opportunities: Array<{
    title: string;
    description: string | null;
    estCostSavingsPerYr: number | null;
    estEnergySavingsPerYr: number | null;
    energyUnit: string | null;
    paybackBandYears: string | null;
    confidence: string | null;
    audience: string;
  }>;
  disclaimer: string;
}

/* ---------- small primitives ---------- */

function usd(n: number | null | undefined) {
  return n == null || !Number.isFinite(n) ? "—" : `$${Math.round(n).toLocaleString()}`;
}
function num(n: number | null | undefined, d = 1) {
  return n == null || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });
}

function PChip({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return (
    <span className="inline-block align-middle ml-1 px-1.5 py-px rounded border border-neutral-400 text-[9px] uppercase tracking-wide text-neutral-600">
      {label}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[15px] font-semibold border-b border-neutral-300 pb-1 mb-3">{children}</h2>;
}

/* ---------- static SVG charts ---------- */

/** Interval demand line — static SVG, no slider handles or scroll chrome. */
function DemandLineSvg({ points, width = 660, height = 150 }: { points: Array<{ ts: number; kw: number }>; width?: number; height?: number }) {
  if (points.length < 2) return <div className="text-xs text-neutral-500">Not enough interval data for a chart.</div>;
  const kws = points.map((p) => p.kw);
  const maxKw = Math.max(...kws) * 1.05 || 1;
  const minTs = points[0].ts;
  const maxTs = points[points.length - 1].ts;
  const span = Math.max(1, maxTs - minTs);
  const px = (ts: number) => ((ts - minTs) / span) * (width - 46) + 40;
  const py = (kw: number) => height - 18 - (kw / maxKw) * (height - 30);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.ts).toFixed(1)},${py(p.kw).toFixed(1)}`).join(" ");
  const gridY = [0.25, 0.5, 0.75, 1].map((f) => ({ y: py(maxKw * f), label: num(maxKw * f, maxKw < 10 ? 1 : 0) }));
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const ts = minTs + (span * i) / (tickCount - 1);
    return { x: px(ts), label: new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
  });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Demand over time">
      {gridY.map((g) => (
        <g key={g.y}>
          <line x1={40} y1={g.y} x2={width - 6} y2={g.y} stroke="#ddd" strokeWidth={0.6} />
          <text x={36} y={g.y + 3} fontSize={8} fill="#777" textAnchor="end">{g.label}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <text key={t.x} x={t.x} y={height - 5} fontSize={8} fill="#777" textAnchor="middle">{t.label}</text>
      ))}
      <path d={d} fill="none" stroke="#d97706" strokeWidth={1.2} />
      <text x={8} y={12} fontSize={8} fill="#555">kW</text>
    </svg>
  );
}

/** Load duration curve — static SVG. */
function LoadDurationSvg({ curve, width = 320, height = 130 }: { curve: Array<{ pctOfHours: number; kw: number }>; width?: number; height?: number }) {
  if (curve.length < 2) return null;
  const maxKw = Math.max(...curve.map((c) => c.kw)) * 1.05 || 1;
  const px = (pct: number) => (pct / 100) * (width - 50) + 42;
  const py = (kw: number) => height - 18 - (kw / maxKw) * (height - 28);
  const d = curve.map((c, i) => `${i === 0 ? "M" : "L"}${px(c.pctOfHours).toFixed(1)},${py(c.kw).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Load duration curve">
      {[0, 25, 50, 75, 100].map((p) => (
        <text key={p} x={px(p)} y={height - 5} fontSize={8} fill="#777" textAnchor="middle">{p}%</text>
      ))}
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={42} y1={py(maxKw * f)} x2={width - 8} y2={py(maxKw * f)} stroke="#ddd" strokeWidth={0.6} />
          <text x={38} y={py(maxKw * f) + 3} fontSize={8} fill="#777" textAnchor="end">{num(maxKw * f, 0)}</text>
        </g>
      ))}
      <path d={d} fill="none" stroke="#d97706" strokeWidth={1.2} />
      <text x={6} y={12} fontSize={8} fill="#555">kW</text>
      <text x={width / 2} y={height + 0} fontSize={8} fill="#555" textAnchor="middle" />
    </svg>
  );
}

/** Color for a normalized 0..1 heat value — same warm amber ramp as the
 *  on-screen heatmap so the printed report matches what the user sees.
 *  (PDF-BUG-1: the old grayscale ramp made printed heatmaps unreadable and
 *  looked like a black-and-white export bug. print-color-adjust: exact is set
 *  both inline and in the .print-report CSS, so color survives print-to-PDF.) */
function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  if (c <= 0.02) return "rgb(250,250,249)"; // near-zero → warm off-white
  // off-white → amber → deep orange-red, matching the screen ramp
  const stops: Array<[number, [number, number, number]]> = [
    [0, [254, 243, 199]], // amber-100
    [0.35, [252, 211, 77]], // amber-300
    [0.65, [245, 158, 11]], // amber-500
    [0.85, [217, 119, 6]], // amber-600
    [1, [154, 52, 18]], // orange-900
  ];
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (c >= stops[i][0] && c <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const f = hi[0] === lo[0] ? 0 : (c - lo[0]) / (hi[0] - lo[0]);
  const rgb = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * f));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** Weekday × hour heatmap as pure divs (the on-screen canvas prints blank). */
function HeatmapPrint({ grid }: { grid: number[][] }) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const max = Math.max(...grid.flat(), 0.001);
  const cellStyle = (t: number): React.CSSProperties =>
    ({ backgroundColor: heatColor(t), height: 10, printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }) as React.CSSProperties;
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "34px repeat(24, 1fr)", gap: 1 }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-center text-[7px] text-neutral-500">{h % 3 === 0 ? h : ""}</div>
        ))}
        {grid.map((row, d) => (
          <React.Fragment key={d}>
            <div className="text-[8px] text-neutral-600 pr-1 leading-3">{DAYS[d] ?? d}</div>
            {row.map((v, h) => (
              <div key={h} style={cellStyle(v / max)} />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="flex items-center gap-1 mt-1 text-[8px] text-neutral-500">
        <span>low</span>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <div key={t} style={{ ...cellStyle(t), width: 14, height: 8 }} />
        ))}
        <span>high · hour of day across weekdays</span>
      </div>
    </div>
  );
}

/* ---------- the report ---------- */

export default function SiteInsightsReport({ data, token, origin }: { data: InsightsPrintData; token: string; origin: string }) {
  const printed = new Date(data.generatedAt).toLocaleString();
  const d = data.demand;
  const cost = data.currentCost?.breakdown ?? null;
  const occupantOpps = data.opportunities.filter((o) => o.audience !== "landlord");
  const landlordOpps = data.opportunities.filter((o) => o.audience === "landlord");
  const kpis: Array<{ label: string; value: string; sub?: string; chip?: string | null }> = [
    { label: "Peak demand", value: d ? `${num(d.peakKw)} kW` : "—", sub: d ? new Date(d.peakTimestamp).toLocaleDateString() : undefined },
    { label: "Load factor", value: d ? `${Math.round(d.loadFactor * 100)}%` : "—", sub: d ? `avg ${num(d.avgKw)} kW` : undefined },
    {
      label: "Modeled annual cost",
      value: cost ? usd(cost.total) : "—",
      sub: cost ? `energy ${usd(cost.energy)} · demand ${usd(cost.demand)} · fixed ${usd(cost.fixed)}` : undefined,
      chip: data.baseline?.confidenceLabel ?? "Est.",
    },
    ...(data.telecom && data.telecom.serviceCount > 0
      ? [
          {
            label: "Connectivity",
            value: `${usd(data.telecom.annualUsd)}/yr`,
            sub: `${data.telecom.serviceCount} service${data.telecom.serviceCount !== 1 ? "s" : ""} · ${usd(data.telecom.monthlyUsd)}/mo${cost ? ` · all services ${usd(cost.total + data.telecom.annualUsd)}` : ""}`,
            chip: "Entered",
          },
        ]
      : []),
    {
      label: "Benchmark",
      value: data.benchmark?.percentileBand ? String(data.benchmark.percentileBand).split("(")[0].trim() : "—",
      sub: data.benchmark?.siteEui != null ? `EUI ${num(data.benchmark.siteEui)} kWh/sqft` : undefined,
    },
    {
      label: "Emissions",
      value: data.emissions?.annualCo2eLb != null ? `${num(data.emissions.annualCo2eLb, 0)} lb CO₂e/yr` : "—",
      sub: data.emissions?.mapped === false ? "national avg factor" : data.emissions?.subregion ? `${data.emissions.subregion} · eGRID` : undefined,
    },
  ];
  return (
    <div className="print-report max-w-[700px] mx-auto text-black text-[12px] leading-normal">
      {/* header */}
      <header className="border-b-2 border-black pb-3 mb-4">
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Meterly · Site Insights Report</div>
          <div className="text-[10px] text-neutral-500">{printed}</div>
        </div>
        <h1 className="text-[22px] font-bold mt-1">{data.site.name}</h1>
        <p className="text-[11px] text-neutral-600">
          {[data.site.buildingType, data.site.sqft != null ? `${data.site.sqft.toLocaleString()} sqft` : null, data.site.state, data.site.zip, data.site.utilityName]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      {/* KPI band */}
      <section className="break-inside-avoid mb-4">
        <div className={`grid gap-2 ${kpis.length > 5 ? "grid-cols-6" : "grid-cols-5"}`}>
          {kpis.map((k) => (
            <div key={k.label} className="border border-neutral-300 rounded p-2">
              <div className="text-[9px] uppercase tracking-wide text-neutral-500">{k.label}</div>
              <div className="text-[13px] font-semibold mt-0.5">
                {k.value}
                {k.chip ? <PChip label={k.chip} /> : null}
              </div>
              {k.sub && <div className="text-[9px] text-neutral-500 mt-0.5">{k.sub}</div>}
            </div>
          ))}
        </div>
        {data.baseline && (
          <p className="text-[9px] text-neutral-500 mt-1">
            Baseline: {data.baseline.method ?? "n/a"}
            {data.baseline.rSquared != null ? ` · R² ${data.baseline.rSquared.toFixed(2)}` : ""}
            {data.baseline.cvrmse != null ? ` · CVRMSE ${(data.baseline.cvrmse * 100).toFixed(0)}%` : ""}
            {data.baseline.confidenceLabel ? ` · confidence ${data.baseline.confidenceLabel}` : ""}
          </p>
        )}
      </section>

      {/* demand chart */}
      <section className="break-inside-avoid mb-4">
        <SectionTitle>Demand over time ({data.chartWindowLabel})</SectionTitle>
        <DemandLineSvg points={data.chart} />
      </section>

      {/* load duration + heatmap side by side */}
      {d && (
        <section className="break-inside-avoid mb-4">
          <SectionTitle>Load shape</SectionTitle>
          <div className="flex gap-4">
            {d.loadDurationCurve && d.loadDurationCurve.length > 1 && (
              <div>
                <div className="text-[10px] font-medium mb-1">
                  Load duration curve
                  {d.hoursNearPeakPct != null ? <span className="text-neutral-500 font-normal"> · {d.hoursNearPeakPct.toFixed(1)}% of hours within 10% of peak</span> : null}
                </div>
                <LoadDurationSvg curve={d.loadDurationCurve} />
                <div className="text-[8px] text-neutral-500">% of hours at or above a given kW</div>
              </div>
            )}
            <div className="flex-1">
              <div className="text-[10px] font-medium mb-1">Weekly demand heatmap</div>
              <HeatmapPrint grid={d.heatmap} />
            </div>
          </div>
        </section>
      )}

      {/* monthly peaks — full table, no scroll clipping */}
      {d && d.monthlyPeaks.length > 0 && (
        <section className="mb-4">
          <SectionTitle>Monthly peaks</SectionTitle>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-b border-neutral-400 text-left text-neutral-500">
                <th className="py-1 pr-2">Month</th>
                <th className="py-1 pr-2 text-right">Peak kW</th>
                <th className="py-1 pr-2">When</th>
                <th className="py-1">Likely driver</th>
              </tr>
            </thead>
            <tbody>
              {d.monthlyPeaks.map((mp) => {
                const hypo = d.peakHypotheses?.find((h) => h.month === mp.month);
                return (
                  <tr key={mp.month} className="border-b border-neutral-200 align-top break-inside-avoid">
                    <td className="py-1 pr-2 font-medium">{mp.month}</td>
                    <td className="py-1 pr-2 text-right">{num(mp.peakKw)}</td>
                    <td className="py-1 pr-2">{new Date(mp.peakTs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })}</td>
                    <td className="py-1 text-neutral-600">{hypo ? `${hypo.hypothesis} (${hypo.basis})` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* rate comparison — full table */}
      {data.tariffComparisons && data.tariffComparisons.length > 0 && (
        <section className="mb-4">
          <SectionTitle>Rate comparison</SectionTitle>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="border-b border-neutral-400 text-left text-neutral-500">
                <th className="py-1 pr-2">Rate plan</th>
                <th className="py-1 pr-2">Utility</th>
                <th className="py-1 pr-2 text-right">Modeled annual</th>
                <th className="py-1 pr-2 text-right">vs. current</th>
                <th className="py-1 pr-2">Eligible</th>
                <th className="py-1">Rate basis</th>
              </tr>
            </thead>
            <tbody>
              {data.tariffComparisons.map((t) => (
                <tr key={`${t.utilityName}-${t.tariffName}`} className="border-b border-neutral-200 align-top break-inside-avoid">
                  <td className="py-1 pr-2 font-medium">{t.tariffName}</td>
                  <td className="py-1 pr-2">{t.utilityName}</td>
                  <td className="py-1 pr-2 text-right">{usd(t.annualCost.total)}</td>
                  <td className="py-1 pr-2 text-right">
                    {t.savingsVsCurrent == null ? "—" : t.savingsVsCurrent > 0 ? `save ${usd(t.savingsVsCurrent)}` : t.savingsVsCurrent < 0 ? `+${usd(-t.savingsVsCurrent)}` : "even"}
                  </td>
                  <td className="py-1 pr-2">{t.eligible ? "yes" : t.ineligibleReason ?? "no"}</td>
                  <td className="py-1 text-neutral-600">{t.freshness}{t.eligibilityNote ? ` · ${t.eligibilityNote}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* opportunities */}
      {occupantOpps.length > 0 && (
        <section className="mb-4">
          <SectionTitle>Savings opportunities</SectionTitle>
          {occupantOpps.map((o) => (
            <div key={o.title} className="border border-neutral-300 rounded p-2.5 mb-2 break-inside-avoid">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold text-[11px]">{o.title}</div>
                <div className="font-semibold text-[11px]">
                  {o.estCostSavingsPerYr != null ? `${usd(o.estCostSavingsPerYr)}/yr` : "—"}
                  <PChip label={o.confidence} />
                </div>
              </div>
              {o.description && <p className="text-[10px] text-neutral-700 mt-0.5">{o.description}</p>}
              <p className="text-[9px] text-neutral-500 mt-1">
                {o.paybackBandYears ? `Payback: ${o.paybackBandYears}` : "Payback: n/a"}
                {o.estEnergySavingsPerYr != null ? ` · ≈${Math.round(o.estEnergySavingsPerYr).toLocaleString()} ${o.energyUnit ?? "kWh"}/yr` : ""}
              </p>
            </div>
          ))}
        </section>
      )}
      {landlordOpps.length > 0 && (
        <section className="mb-4">
          <SectionTitle>Worth raising with the property owner</SectionTitle>
          {landlordOpps.map((o) => (
            <div key={o.title} className="border border-dashed border-neutral-400 rounded p-2.5 mb-2 break-inside-avoid">
              <div className="flex items-baseline justify-between">
                <div className="font-semibold text-[11px]">{o.title}</div>
                <div className="font-semibold text-[11px]">
                  {o.estCostSavingsPerYr != null ? `${usd(o.estCostSavingsPerYr)}/yr` : "—"}
                  <PChip label={o.confidence} />
                </div>
              </div>
              {o.description && <p className="text-[10px] text-neutral-700 mt-0.5">{o.description}</p>}
            </div>
          ))}
        </section>
      )}

      {/* narrative insights */}
      {data.insights.length > 0 && (
        <section className="mb-4">
          <SectionTitle>What the data says</SectionTitle>
          {data.insights.map((i) => (
            <div key={`${i.kind}-${i.title}`} className="mb-2 break-inside-avoid">
              <div className="font-semibold text-[11px]">
                {i.title}
                <PChip label={i.confidence} />
              </div>
              <p className="text-[10px] text-neutral-700">{i.body}</p>
            </div>
          ))}
        </section>
      )}

      {/* footer */}
      <footer className="border-t border-neutral-400 pt-2 mt-6 text-[9px] text-neutral-500 break-inside-avoid">
        <p>{data.disclaimer}</p>
        <p className="mt-1">
          Verify this report is current: {origin}/verify/{token} · Generated {printed} · Meterly — Utility Data Intelligence
        </p>
      </footer>
    </div>
  );
}
