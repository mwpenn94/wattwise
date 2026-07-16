# WattWise Project TODO

## Session A0 — Handoff convergence gate (UHOP v4)
- [x] Adapt cold_context_review_runner to sandbox LLM proxy (protocol semantics preserved)
- [x] Cycle 4: 5 confirmed-material findings integrated into HANDOFF.md
- [x] Cycle 5: 25 findings → 12 items integrated (v1.5)
- [x] Cycle 6/7: 38 + 2 findings adjudicated; spec fixes folded into code + doc (v1.6)
- [ ] Reach 100 consecutive clean cold-context passes on HANDOFF.md (running in background; confirmed findings integrate + reset per protocol)

## A1 — Schema + seeders
- [x] Canonical 20-table schema with provenance fields (sites, meters, intervals, bills, tariffs, archetype_profiles, baselines, insights, opportunities, scenarios, analyses, emission_factors, benchmarks, seeder_runs, metering, audit_log, weather_stations, uploads, convergence_log, users)
- [x] Idempotent versioned seeders: eGRID emission factors (31 rows incl. AZNM/CAMX/RMPA/ERCT)
- [x] Seeder: URDB-style tariff snapshot — 13 tariffs (APS/SRP/TEP/UNS + gas/water) w/ TOU, demand, ratchet, CP topN=4, export rates, freshness flags
- [x] Seeder: archetype load profiles (36 shapes, 8760 normalized + end-use fractions; prototype-archetype fallback)
- [x] Seeder: EUI benchmark tables (19 building types)
- [x] Seeder: weather normals (5 AZ stations, monthly HDD/CDD + TMY-shape hourly)
- [x] Seeder run registry: versioned, idempotent, provenance-logged
- [x] User data-export endpoint (account.exportData)

## A2 — Ingestion engine
- [x] Excel interval parser (multi-sheet, header scoring to row 25, yyyymmdd dates, raw float precision, footer exclusion) — BUILD-010.3 verbatim port
- [x] CSV interval parser (BUILD-010.3 logic reuse)
- [x] ESPI XML Green Button parser (XXE-safe)
- [x] Bill image pipeline: LLM vision + confidence + manual-entry degradation; PDF → manual entry
- [x] Dedupe invariant: (meter, ts, duration) unique + precedence + overlap-window resolution
- [x] Unit normalization (kWh/kW, therms, gallons) — commodity-agnostic
- [x] Timezone handling (America/Phoenix default; no-DST correctness for AZ)
- [x] Upload security: size caps, magic-byte validation, formula scrub, XXE-safe, parse timeout
- [x] Verified real interval files parse (Cantex 35k+ rows ±0.5% footer check, Lake Havasu, American Woodmark, hourly CSV)

## A3 — Manual intake + hypothetical wizard
- [x] Multi-step wizard: building type, size, vintage, climate zone, utility, occupancy
- [x] archetype_synthetic baseline generation from archetype profiles
- [x] prototype-archetype fallback labeling (exact string)
- [x] Actual + hypothetical flow through identical scenario code path

## A4 — Analytics engine
- [x] Normalize & QC (gap flags, provenance, qcFlags on intervals)
- [x] Weather match + normals ("normal-year basis" exact label, tested)
- [x] Baseline: CalTRACK-style HDD/CDD balance-point grid-search regression + archetype_synthetic
- [x] Demand analytics: monthly peaks, ratchet sub-module, load factor, heatmap, peak timestamps
- [x] Disaggregation gated by disaggregation_method enum (archetype_prior_only default; never nilmtk on ≥1-min)
- [x] Tariff optimization: eligibility filter + eligibilityNote, ratchet-aware re-pricing, CP proxy w/ "estimated — not ISO system peaks" verbatim (tested)
- [x] Benchmarking: EUI percentile vs seeded medians
- [x] Opportunity engine: ranked measures, $/yr, payback band, confidence
- [x] Scenario engine: solar, battery (sequential dispatch disclosed), efficiency, EV, tariff switch — one code path
- [x] Emissions: eGRID subregion factors + scenario CO₂e deltas
- [x] Anomaly detection: residuals >10% + sustained change-point detection (detectResidualAnomalies; honesty-gated on valid fit + ≥6 months; 5 vitest specs)

## A5 — Tier gating + unit economics
- [x] Tier gating (free/plus/pro) on procedures; free site quota enforced (tested)
- [x] Metering table for LLM/compute spend per account
- [x] Free-tier LLM budget kill-switch → template-only degradation (tested)
- [x] Per-analysis compute timeout (60s pipeline guard)
- [x] ≤ $0.20 marginal cost instrumented + enforced in code (AC5 test passes)

## A6 — Insights UI
- [x] DashboardLayout sidebar navigation
- [x] Interval chart with peak-preserving decimation (BUILD-010.3)
- [x] Demand heatmap (hour × day)
- [x] Cost breakdown panel
- [x] Tariff comparison table
- [x] Scenario builder + results view
- [x] Opportunity list with confidence labels
- [x] Benchmarking percentile card
- [x] Emissions summary
- [x] Modeled-estimates disclaimer + provenance labels throughout
- [x] UHOP convergence log page (public + in-console)
- [x] Landing page with upload/wizard entry points
- [x] Mobile responsiveness verification (375x812: landing, dashboard, wizard, scenarios, convergence all render; sidebar collapses)

## Validation
- [x] Vitest suite: 42 tests / 6 files (parsers on real files, ratchet math, tariff pricing, dedupe path, tier gating, metering, tenancy isolation)
- [x] Fixed real bug found by tests: `usage` reserved word in interval upsert (TiDB)
- [x] AC1: AZ commercial Excel upload → full insight suite incl. demand + rate check (pipeline E2E test)
- [x] AC2: hypothetical AZ office → rate comparison (eligible rows) + benchmark percentile + solar scenario asserted (server/acceptance.test.ts)
- [x] AC3: water meter through full pipeline — caught+fixed 3 commodity bugs (electric eGRID factors, electric tariff sweep, electric benchmark applied to water)
- [x] AC4: parity test — measured vs hypothetical share runScenario code path; identical result keys + normal-year disclosure in both (server/acceptance.test.ts)
- [x] AC5: free-tier marginal cost ≤ $0.20 in metering table (tested)
- [x] AC6: seeders idempotent/versioned/provenance-logged
- [x] AC7: UHOP convergence log present and current
- [x] AC8: 15-min disaggregation labeled archetype_prior_only/regression_split, never nilmtk
- [ ] UHOP expert-lens convergence passes on deliverable
- [x] Live virtual-user E2E testing (Playwright): 18/18 assertions across 3 personas (pro upload+analyze real Cantex file, free hypothetical wizard, free-tier quota/gating)
- [ ] Session A0 series converged on HANDOFF.md

## Batch-17 (deliverable runner passes 296-308)
- [x] billOcr: separate malformed-LLM-output failure path from LLM-unavailable path (pass 296)
- [x] Dashboard Benchmark KPI sub: drop redundant "vs national median EUI" suffix (pass 298)
- [x] TariffTable: show reference costs (muted) for ineligible rows instead of "—" (pass 308)
- [x] governance.test.ts: deterministic site-quota test (cap-aware, precise over-cap assertion) (pass 300)

## Progressive / flexible participation (user request, Jul 16)
- [x] Quick-start entry: user can begin with JUST an address (state/zip parsed, sensible defaults) or JUST a bill photo/file — no multi-form gate
- [x] Quick-win result: immediate partial analysis after minimal input, with assumption disclosures
- [x] Progressive refinement prompts: optional "add detail" chips showing what each unlocks — full forms remain for users who prefer them
- [x] Backend: sites.quickCreate accepting free-text address; defaults + assumption disclosures recorded
- [ ] HANDOFF spec: pin progressive-participation principle as Cycle 22 (intake UX + assumption honesty)
- [x] Tests for quickCreate defaults + disclosure presence (8 vitest specs: parse, defaults, disclosure pre/post-analysis, refine flip, zone re-inference)
- [x] Bill-only quick start: persist OCR output — prefilled review form saves a real bill record via bills.createForSite (lazy bill-entry meter)
- [x] Bill-only quick start: honest disclosure that figures remain placeholder-based until the bill is confirmed/saved (skip path + post-save toasts)
