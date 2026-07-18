# WattWise — Per-Claim Verification Walkthrough

**Checkpoint:** 667970f1 (live via auto-publish) · **Live site:** https://wattwise.manus.space (also wattwise-4azy495z.manus.space) · **Date:** Jul 18, 2026
**Test suite at checkpoint:** 147 passed / 7 skipped across 21 files (`pnpm test`) · TypeScript clean (`npx tsc --noEmit`)

This document lists every claim shipped in the v1.9 UX addendum wave, with the exact URL, the click path, what you should observe, and where the code and tests live. Nothing here relies on my say-so — each row is independently checkable in under a minute.

How to read the tables: **URL** is on the live site (log in first at `/app`); **Verify by** is the observable behavior; **Code** is the file to inspect; **Tests** names the vitest file covering the honesty rules.

---

## 1. Prove-It Loop (§3e)

| # | Claim | URL / Path | Verify by | Code | Tests |
|---|-------|-----------|-----------|------|-------|
| 1.1 | Every ranked opportunity has an "I did this" action | `/app/explore` → Ranked opportunities | Each card shows a secondary "I did this" button next to "Model this in Scenarios" | `client/src/pages/console/Dashboard.tsx`, `client/src/components/InsightCard.tsx` | — |
| 1.2 | Marking opens a dialog asking only for the implementation date | Click "I did this" | Dialog with date picker + honest copy about what verification needs | `client/src/components/ProveIt.tsx` | — |
| 1.3 | Verification compares actuals to the weather-adjusted counterfactual, month by month | Dashboard → "Verification ledger" section after marking | Each implementation lists monthly verdict rows (expected vs actual kWh, delta $) | `server/proveIt.ts` | `server/proveIt.test.ts` (11 specs) |
| 1.4 | Honesty gates: no verdict before 1 full month; "early read" label under 3 months; changes inside the model's noise band (CVRMSE) are called **inconclusive**, never claimed as savings | Mark a measure with today's date → ledger shows "too early — no verdict yet" | Copy states the gate that applied | `server/proveIt.ts` (`evaluateImplementation`) | same file — gates each have a spec |
| 1.5 | Cumulative verified-savings counter only counts verified months | Dashboard ledger header + Home greeting chip switches from PROJECTED to VERIFIED when ≥ $1 verified | `server/dbHelpers.ts` (`sumVerifiedSavings`) | `server/proveIt.test.ts` |

## 2. Anti-Dashboard Home Feed + Ask WattWise (§3k)

| # | Claim | URL / Path | Verify by | Code | Tests |
|---|-------|-----------|-----------|------|-------|
| 2.1 | `/app` is a 3-story feed, not a chart wall | `/app` | Greeting number → "One thing your data said" → "Your next move" — no KPI grid | `client/src/pages/console/HomeFeed.tsx` | — |
| 2.2 | Greeting shows verified $ when it exists, else projected $, chip disclosing which | `/app` header | `$…/yr identified for you` + PROJECTED or VERIFIED chip | same | — |
| 2.3 | Full analytics moved to `/app/explore` (nav: Home / Explore) | Sidebar | Home and Explore are separate entries; Explore holds KPIs, heatmap, rate check, opportunities | `client/src/pages/AppShell.tsx`, `DashboardLayout.tsx` | — |
| 2.4 | Ask WattWise is Plus-gated, budget-checked, and dispatches to real engines only | `/app` ask box (switch to Plus free on `/app/account`) | Ask "Why was July high?" → answer card cites the stored engine row; free tier gets upgrade prompt, not an answer | `server/askWattwise.ts`, ask router in `server/routers.ts` | `server/askWattwise.test.ts` (9 specs) |
| 2.5 | LLM outage degrades to keyword routing — never a fabricated answer | (code-level) | keyword fallback path returns same card types | `server/askWattwise.ts` | same |
| 2.6 | Empty account still advises (estimates + ladder), never a zeros dashboard | Log in with no sites → `/app` | QuickStart + accuracy-ladder copy instead of empty widgets | `HomeFeed.tsx` | — |

## 3. Persona Fork + Processing Proof-of-Work (§3g, §3h)

| # | Claim | URL / Path | Verify by | Code | Tests |
|---|-------|-----------|-----------|------|-------|
| 3.1 | Persona detected from building type, never asked | Any residential site vs office site on `/app/explore` | Copy says "your home" vs "your facility"; subtitle names the voice | `client/src/lib/persona.ts` | — |
| 3.2 | Hero rotation: residential sees rate check first, commercial sees demand story first | Compare Explore for an apartment vs an office site | Section order flips (CSS order, one codebase) | `Dashboard.tsx` | — |
| 3.3 | Analysis narrates real pipeline stages live — no theatrical delays | Run analysis on any site | Live log lines appear as stages finish: weather station match, N readings, CalTRACK fit + CVRMSE, N rates re-priced, benchmark, eGRID factor, N insights/opportunities | `server/analytics/pipeline.ts` (`narrate()`), `AnalysisProgress.tsx` | pipeline specs still pass |
| 3.4 | Fallbacks are named inline during processing (e.g. archetype basis) | Run analysis on a no-data site | Narration names the fallback used | same | — |
| 3.5 | Add-to-plan continuity: opportunity → Scenarios with measure preselected | Click "Model this in Scenarios" on any opportunity | Lands on `/app/scenarios?site=N&measure=X` with site + measure preselected; unowned/stale `?site=` falls back to your first site (never a blank selector) | `Scenarios.tsx` (`measureToKind`) | — |

## 4. Portfolio + Utility Registries (§3i-2)

| # | Claim | URL / Path | Verify by | Code | Tests |
|---|-------|-----------|-----------|------|-------|
| 4.1 | Exception-first portfolio: ranked by open $ + anomaly, top 3 expanded | `/app/portfolio` | "Needs attention first" block; rest collapsed behind "Show N more" | `Portfolio.tsx`, `entities.portfolio` proc | `server/portfolio.test.ts` (6 specs) |
| 4.2 | Roll-up KPI header: cost, verified savings, portfolio load factor (usage-weighted + disclosed), emissions | `/app/portfolio` header | LF card discloses "usage-weighted mean … not a coincident-meter figure" | same | — |
| 4.3 | League table normalizes kWh/sqft/yr with basis chips; unrankable sites are named, not zero-ranked | `/app/portfolio` league table | "Not rankable (Test) — missing square footage…" footnote | same | — |
| 4.4 | Consolidation finding for multi-main-meter sites: coincident vs sum-of-peaks, analysis-only label | Site with 2+ metered main electric meters → run analysis | Insight appears only when peaks land in different hours and the gap ≥ 0.5 kW | `pipeline.ts` | `portfolio.test.ts` |
| 4.5 | Per-commodity registries with honesty copy — "Rates loaded: …", never "your utility is" | QuickStart address confirm; `/app/sites` meter view | Registry line lists electric/gas/water providers from the seeded snapshot + "confirm your actual provider on your bill" | `tariffs.utilitiesForState`, `QuickStart.tsx`, `Sites.tsx` | `portfolio.test.ts` |

## 5. Reports, Verify Page, Digest, Data-Rung (§3l, §3f, §3j)

| # | Claim | URL / Path | Verify by | Code | Tests |
|---|-------|-----------|-----------|------|-------|
| 5.1 | Three artifacts, one data engine | `/app/reports` | My Energy Plan (Plus), Verified Savings Statement (Pro), Practitioner CSV (Pro) | `server/reports.ts` | `server/reports.test.ts` (9 specs) |
| 5.2 | Every printed number carries an Est./Good/Measured confidence chip | Generate & print any report | Chips render in the print view | same | same |
| 5.3 | Footer verify link — a forwarded PDF is never silently stale | Print view footer → `/verify/<token>` | Public page shows the printed snapshot next to current live figures; unknown token gets an honest error | `client/src/pages/Verify.tsx`, `report_artifacts` table (migration 0007) | same |
| 5.4 | Verified Savings Statement explains weather adjustment in plain language and only prints verified months | Generate it (Pro) | Plain-language adjustment box + verdict table from the prove-it ledger | `server/reports.ts` | same |
| 5.5 | Digest is opt-in, quiet by default, bill-cycle anchored, "$ figure or it doesn't send" | `/app/account` → Monthly digest card | Toggle off by default; anchor day 1–28; rule stated; delivery labeled post-beta | Account.tsx, digest procs | — |
| 5.6 | Data-rung labeling: the app names how your data updates today (manual upload), never implies automation | `/app/account` → "How your data updates" | Manual upload named as the active rung; Green Button named as explicit future | `Account.tsx` | — |

## 6. Core CRUD + Navigation (owner feedback, Jul 18)

| # | Claim | URL / Path | Verify by |
|---|-------|-----------|-----------|
| 6.1 | Sites: rename/edit attributes/delete (cascade + confirm) | `/app/sites` → ⋮ menu on any card | Edit and Delete both present; delete asks for confirmation and removes children |
| 6.2 | Meters: create/edit/delete on a site, with role + submeter rules | `/app/sites` → open a site → Meters | Add meter, edit role/parent/timezone, delete with confirm |
| 6.3 | Scenarios: rename/delete saved runs | `/app/scenarios` → ⋮ on a saved run | Rename dialog + delete |
| 6.4 | Site groups: create/delete/assign | `/app/portfolio` → Site groups block | New group, assign sites, group-by filter |
| 6.5 | Uploads: delete an upload / clear bad data | `/app/upload` → history list | Delete action per upload |
| 6.6 | No dead ends: console ↔ public escape routes, consistent site selector, mobile nav | Any page, incl. 375×812 | Logo → home; sidebar collapses to header toggle on mobile; every detail view has a way back |

## 7. What is *not* claimed

For symmetry with the honesty rules baked into the product, these are the known limits, stated plainly:

- **Digest delivery infrastructure** is not live — settings exist and are honestly labeled "post-beta"; no email is sent today.
- **Ask WattWise** answers only from stored engine rows for the selected site; it does not do open-ended chat and says so when asked something out of scope.
- **Verified savings** requires at least one full post-implementation month; fresh accounts will correctly show $0 verified.
- **UHOP deliverable-series review runner** remains paused per your Jul 17 instruction (61 batches adjudicated; resumable on request). Two closed-as-unmeetable/paused gate items remain visible in todo.md history rather than deleted.

---

*Every table row above maps to a `- [x]` line in `todo.md` (project root), which carries the fuller implementation notes and the vitest spec counts.*
