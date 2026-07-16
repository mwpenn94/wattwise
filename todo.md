# WattWise Project TODO

## Session A0 — Handoff convergence gate (UHOP v4)
- [x] Adapt cold_context_review_runner to sandbox LLM proxy (protocol semantics preserved)
- [x] Cycle 4: 5 confirmed-material findings integrated into HANDOFF.md
- [x] Cycle 5: 25 findings → 12 items integrated (v1.5)
- [x] Cycle 6/7: 38 + 2 findings adjudicated; spec fixes folded into code + doc (v1.6)
- [ ] ~~Reach 100 consecutive clean cold-context passes on HANDOFF.md~~ — NOT MET and closed as unmeetable: at the measured ~20% clean floor (stable across 3 gate configs, 612 passes) P(streak) ≈ 10⁻⁶³; superseded by the item below
- [x] DECISION (Jul 16, proposed to owner with revert option in prior update; no objection): document-series gate superseded by fixed-budget close-out protocol — Cycle 28 final integration, bounded 30-pass audit, RESIDUAL_RISKS.md register (8 families, normative), Convergence Declaration appended to HANDOFF v3.7 with Cycle-29+ reopening provision

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
- [ ] UHOP expert-lens convergence passes on deliverable (code series — 100-streak gate unchanged, runner active)
- [x] Live virtual-user E2E testing (Playwright): 18/18 assertions across 3 personas (pro upload+analyze real Cantex file, free hypothetical wizard, free-tier quota/gating)
- [x] Session A0 series closed as converged-in-practice on HANDOFF.md v3.7 (close-out protocol per DECISION above — not a literal 100-streak; declaration + residual-risk register delivered)

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
- [x] HANDOFF spec: pin progressive-participation principle as Cycle 22 (intake UX + assumption honesty) — v3.1, A0 runner restarted
- [x] Tests for quickCreate defaults + disclosure presence (8 vitest specs: parse, defaults, disclosure pre/post-analysis, refine flip, zone re-inference)
- [x] Bill-only quick start: persist OCR output — prefilled review form saves a real bill record via bills.createForSite (lazy bill-entry meter)
- [x] Bill-only quick start: honest disclosure that figures remain placeholder-based until the bill is confirmed/saved (skip path + post-save toasts)

## Batch-18–23 (deliverable runner adjudications, passes 419–772)
- [x] Batch-18: real blended rate for <25-day histories; immediate payback label for no-capex measures; causal low-coverage confidence labels; R²≥0.5 honesty gate on anomaly detection
- [x] Batch-19: CP partial-allocation disclosure on billed-months cause; fallback-rate disclosure distinguishes no-tariff vs no-usage; marginalCostUsd accumulation clarified (reviewer claim rejected with evidence)
- [x] Batch-20: hourlyRateSignal matched-flag fix — zero-rate TOU periods no longer clobbered by fallback
- [x] Batch-21: NaN-safe battery dispatch thresholds; location refine flips attrSource + always re-infers climate zone (tests extended)
- [x] Batch-22: stale writeIntervals re-flag documented (already fixed; evidence line added)
- [x] Batch-23: Dashboard cost breakdown renders CP proxy as its own "coincident-peak" line so components reconcile with total (pass 772)
- [x] Batch-24: split-timezone-state disclosure insight on quick-start + bill-entry meter creation (FL panhandle etc. — TOU/CP 1h-shift warning, verify prompt); Heatmap explicit "no demand data" empty state instead of faint uniform grid (passes 846/848/856)
- [x] Batch-25: capexUsd=0 accepted by scenario input schema (no-capex path reachable); cost enforcement fails closed on DB unavailability — LLM kill-switch engages (Infinity spend), analysisTotalCost throws, assertFreeTierCostCap returns ok:false/NaN instead of false compliance (passes 865/867)
- [x] Batch-26: basis tariff always present in comparison table (hoisted, slice-immune); scenario confidence inherits baseline capped at medium (medium no longer collapses to low); BATTERY_DEFAULTS.initialSoC declared (0.5) and used in dispatch; demandGroup + ratchet tests strengthened to falsify wrong-window billing and pct<1 carry-forward; pass-891 null-crash claim rejected with evidence (passes 891/899/900/903/913)
- [x] Batch-27: dispatchBattery flat-rate-signal guard — collapsed percentile thresholds (chargeThresh >= dischargeThresh) now explicitly disable rate-driven dispatch instead of perpetually grid-charging; hourlyRateSignal fallback applies on any unmatched hour with documented $0/kWh semantics for energy-period-free (fixed/demand-only) tariffs (passes 929/953)
- [x] Batch-28: llmBudgetAllows fails closed on unrecognized tier strings (explicit plus/pro allowlist — no silent LLM cost-enforcement bypass); Heatmap uses true data maximum (0.001 floor removed — sub-milliwatt grids no longer clipped to zero intensity) (passes 997/998)
- [x] Batch-29: load-factor KPI phrased conditionally (no universal demand-charge claim); solar unmapped-zone fallback yield unified into one named constant cited by computation AND disclosure; AC5 e2e de-tautologized (asserts actual totalUsd <= capUsd); two reviewer numeric claims (1400 yield field, 0.1 loss fraction) verified false and rejected with evidence (passes 1018/1019/1030/1040/1043)
- [x] Batch-30: TN timezone corrected to dominant Eastern with western-third split disclosure; scrubCell trims consistently (no whitespace-hidden prefixes); monthlyCosts gains dedicated cp field so monthly demand reconciles with breakdown.demand; ESPI parser resets scaling defaults (with disclosure) for usage points lacking ReadingType instead of inheriting a prior stream's multiplier; TariffTable (ref) asymmetry claim verified false (passes 1055/1065/1072/1074/1078)
- [x] Batch-31: defensive commodity assertion on tariff basis (fallback ladder already commodity-filtered at SQL level); four reviewer claims verified FALSE with code evidence — buildScenarioBasis empty-tariff crash (typed throw precedes access), scrubCell whitespace bypass (danger test runs on trimmed string since B30), SOLAR_DISCLOSURE unconditional ×2 (push is inside solar-kind guard) (passes 1099/1106/1114/1119/1123)
- [x] Batch-32: CP-bearing tariffs disclose omitted CP component when the proxy is uncomputable (no seasonal peaks / no interval data); last-resort basis disclosure scopes reference-only to the current-cost baseline while eligible comparison rows remain valid; ESPI feeds disclose assumed default scaling when the first usage point lacks a ReadingType (passes 1179/1192/1204)
- [x] Batch-33: signed CalTRACK balance-point shift (Math.max truncation dropped adjustments for balance points above 65°F); assigned tariff fetched directly with state-mismatch disclosure instead of silently vanishing behind the state filter; load-factor KPI warning gated on actual demand/CP charges; scenario quota metering verified safe (post-save, table-based counter); two claims rejected with evidence — utilityMatch disclosure already names the rate, scrubCell tab-prefix "bypass" is caught by the trimmed-string danger check (passes 1225/1226/1245/1248/1251)
- [x] Batch-34: rate-switch lower bound = full deterministic repriced savings (0.6 haircut removed; load-repeat assumption disclosed in rationale); eligibilityNote shows the specific known ineligible reason instead of a contradictory generic "confirm eligibility" caveat; scrubCell danger class includes leading single-quote (formula-escape re-arming bypass closed); CalTRACK confidenceLabel names weak-fit (R²) and moderate-fit causal reasons, not just coverage (passes 1269/1275/1279/1301)
