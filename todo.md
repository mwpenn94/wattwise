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
- [ ] UHOP expert-lens convergence passes on deliverable (code series — 100-streak gate; runner PAUSED Jul 17 per owner feedback prioritizing grounded intake over further review passes; 61 batches adjudicated, best organic streak 14; resume on owner request)
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
- [x] Batch-35: typed AnalysisTimeoutError classification (no message string-matching — DB-lock "timeout" strings no longer masquerade as compute timeouts); phantom $0-baseline savings guard (no basis → savings deltas zeroed, not inflated); CP omission disclosure names the actual cause (demand-not-computable from vacancy/net-export spans vs no seasonal peaks vs no interval data); four claims rejected with evidence — tenancy bypasses (ctx.user.id + assertSiteOwner), URL-encoded formula injection (spreadsheets don't URL-decode), touRate tie-break (intentional customer-favorable policy) (passes 1319/1325/1332)
- [x] Batch-36: ESPI parser counts + discloses skipped malformed readings (rowsSkipped no longer hardcoded 0, 2 new vitest specs); assigned-but-ineligible tariff disclosure states the rate IS still used (no substitute applied); efficiency reductions clamped at 100% with disclosure (negative-load inversion unreachable, tested); US-median 4A climate-zone fallback disclosed on archetype scenario bases for location-less sites; bill-OCR pre-flight budget check derives cost from the shared tile-scaled token estimator (no hardcoded 0.03); load-factor KPI sub-text names its measured-interval provenance — 13 claims rejected as immaterial/stale (passes 1374/1376/1383/1385/1397/1398)
- [x] Batch-37: case-insensitive solar-yield zone lookup (lowercase '4a' no longer silently falls to generic fallback while claiming a zone match); ESPI malformed/zero/negative durations skipped through the disclosed path (no NaN usage on Watts feeds, no silent 900s default for present-but-bad values); split-timezone ambiguity disclosure added to file-upload meter creation (parity with quick-start/bill-entry meters); tariff table shows "— (no current-cost baseline)" instead of phantom "$0/yr" savings when no basis exists; Wh-header 1000× claim rejected (already guarded by commodity === electric) — +2 vitest specs (passes 1493/1494/1504/1505/1518)
- [x] Batch-38: savingsVsCurrent is null — not a 0 sentinel — when no current-cost basis exists, so raw API/export consumers can distinguish "no baseline" from a genuine $0 delta; sort, rate-switch opportunity gating, and dashboard rendering updated for nullability (pass 1559)
- [x] Batch-39: tz disclosures added to sites.create (split-tz note + no-state Phoenix/4A fallback warning) and sites.refine (split-tz on state change); payback band honestly labeled a fixed heuristic spread (not model-derived uncertainty); CP charge scaled to months-with-data like every other breakdown component (Σ monthly ≡ annual restored, remainder disclosed with $ figure); short-span disclosure names suppressed usage-scaled opportunities (HVAC/LED/baseload); summer-ratchet semantics documented + unit-tested (determinant = summer peaks, floor bills year-round); THREE real battery dispatch bugs found via strengthened test — rate signal evaluated in server-local time instead of tariff tz (discharge landed 7h off billing on-peak), percentile thresholds silently disabling dispatch on skewed TOU signals (~5% on-peak hours), naive grid-charging creating new billing peaks (now peak-aware causal cap); 2 claims rejected with evidence (stale re-flag, unreachable dateCol fallback) (passes 1586–1660)
- [x] Batch-40: minimum-bill uplift as explicit CostBreakdown component (Σ components − export ≡ total restored when the floor triggers, disclosed, rendered as its own UI line); solar-heavy battery dispatch — peakSoFar uses the positive-part import peak so export-dominated profiles still grid-charge and never raise the billed import peak; load-factor KPI says "cost impact unknown" when the current rate could not be priced instead of falsely claiming "yours has none"; touRate pricing-never-consults-eligibility invariant documented (1746's feared arbitrary-rate override doesn't exist); +2 vitest specs — 57 passing; 3 claims rejected with evidence (recordMeterEvent masking, confidenceLabel wording, hourlyPoints refYear) (passes 1742/1743/1746/1748)
- [x] Batch-41: unified import-neutral battery charge headroom — export-only sites can absorb surplus but never gain a manufactured import peak (Batch-40 `: maxRate` special case removed, peak update unconditional-monotone); placeholder breakdowns for uncosted rows use `no_cp_charges` when the tariff has no CP component (no phantom "omitted" claim); no-state disclosure composes from values actually used (entered zone vs ZIP-inferred vs US-median); unrecognized-state Phoenix tz fallback now disclosed (TZ_BY_STATE hoisted); blended-rate fallback distinguishes `no_net_import` (export-dominated valid data) from `no_usage_data`; generateShape8760 overnight-safe occupancy (19→7 schedules no longer collapse to flat baseload — seeded daytime shapes unchanged); +2 vitest specs — 59 passing (passes 1754/1763/1769/1776/1782)
- [x] Batch-42: load_factor insight cost-framing conditioned on the PRICED rate (demand-billed → opportunity wording; unpriced → "could be costly, rate unknown"; energy-only → "not costing you extra today", severity info); dispatchBattery gains originalLoad param — demand setpoint tracks the PRE-solar baseline peak, not the solar-suppressed residual (runScenario passes baselineHourly); ineligible-assigned-rate disclosure carries the full validity consequence ("only as valid as that assignment... treat cost figures as unverified") + both resolution paths, policy rationale documented; tzAmbiguityNote covers EMPTY state — Phoenix-default warning now fires on quickCreate/refine/upload/bill paths (sites.create keeps richer combined branch, upload/bill insight titles made state-agnostic); listBills binds to sites.userId in the query (cross-tenant rows structurally unreturnable even if a meter row is repointed); +1 vitest — 60 passing (passes 1796/1809/1823/1826/1836)
- [x] Batch-43: scenario-path archetype basis routed through archetypeBaseline (same sqrt-of-size demand derating as the pipeline — parity) with a named calibration-range disclosure quoting the actual calibrated range vs site sqft; inferClimateZoneWithSource exposes provenance (zip_inferred/state_inferred/us_median_fallback) so a present-but-unresolvable ZIP is a disclosed fallback, not a silent 4A; tariff-table banner names the assigned-but-ineligible current-rate case instead of falsely claiming "no seeded rate matches"; 1 claim rejected as stale duplicate of Batch-34 (confidenceLabel multi-reason join verified); +1 vitest spec — 61 passing (passes 1842/1845/1868/1871)

## User-reported product gaps (Jul 16, 2026) — PRIORITY over convergence loop
- [x] Gap 1: Utility/tariff coverage — nationwide seeded (51 STATE_PROFILES; 4 representative tariffs/state: res flat, res TOU, comm flat, comm TOU+demand; ~219 tariffs, 20 zone weather stations, per-state eGRID subregions; SEED_VERSION 2026.07.5)
- [x] Gap 2: Address intake imputation — cascade.ts BUILDING_PRIORS (12 type-specific CBECS/RECS medians, flat 10k default gone) + state→utility + ZIP3→zone, per-field provenance persisted in intake insight metrics
- [x] Gap 3: Interval chart range — 30/90/365/All preset buttons on Dashboard interval card (All spans minTs→maxTs), dynamic title, peak-preserving decimation retained; monthly-peak analysis already spans the full history via the pipeline summary
- [x] Gap 4: Demand & peak charges first-class — dedicated Dashboard card (monthly peak table, demand+CP share of modeled bill with honest "could not be priced"/"no demand charges" branches, top-5 CP proxy events); Tariffs page updated to nationwide copy + state filter (defaults to site's state) + expandable per-rate structure detail (TOU windows, demand charges incl. demandGroup once-billed note, ratchet, CP, export rate, min-bill)
- [x] Gap 5: Navigation audit — all 9 console routes present in sidebar nav (incl. new Portfolio), public pages (/, /convergence) have escape links, NotFound has go-home buttons, no dangling "coming soon" placeholders remain, cross-links verified (dashboard→upload/wizard, scenarios→account, tariffs↔sites)
- [x] Gap 6: Self-serve tiers — account.setTier mutation (audited, explicit no-billing beta note) + setUserTier helper; Account page tier switcher w/ honest beta labeling; Home pricing CTAs now "Start Plus/Pro (beta)" → login → /app/account (dead "Coming soon" buttons removed); Scenarios free-tier copy links to Account page; free-tier blurb corrected to actual constants (2 sites, 12 uploads/mo); 4 vitest specs (76 passing)
- [x] Gap 7: Climate-zone coverage — STATE_ZONE covers all 50 states + DC; shared ZIP3_ZONE (~150 prefixes) for intra-state variation; inferClimateZoneWithSource provenance means any US-median fallback is disclosed, never silent
- [x] Gap 8: Address cascade — deriveFromAddress() wired into sites.quickCreate (persists derived utility/zone/priors + cascade provenance metrics), sites.create (fills omitted zone/utility + disclosure insight), sites.refine (location change re-derives zone with ZIP3 precision + utility suggestion unless user-owned); RefineChips render "derived: X — tap to change"; 6 cascade vitest specs (67 passing)
- [x] Gap 9: Entity→sites→meters model — entities table (household/company/property_owner/other) + sites.entityId (nullable, detach-on-delete never cascades); entities router (list/create/update/delete/assignSite/portfolio); Portfolio page with entity filter, per-site KPI table (analyzed:false → "not analyzed yet", never fabricated zeros), totals incl. explicitly-labeled non-coincident sum of peaks; Owners & organizations manager + per-site owner picker on Sites page; sidebar nav entry; 5 vitest specs (CRUD/tenancy/detach/rollup honesty) — 72 passing
- [x] Batch-45 convergence fixes (passes 1926-1959): sites.create disclosure zone-source alignment via inferClimateZoneWithSource (v2 provenance, also covers 1936); DSAR export includes qcFlags on interval points + superseded-rows note; recordMeterEvent throws on DB-unavailable (no unbilled compute); basisStructureHasDemandCharges persisted in summary metrics + Dashboard Load-factor sub-text branches on structure (never infers "no demand charges" from a $0 breakdown, also covers 1948); TariffTable none-eligible banner wording fix; intake intervalData line gated on !hasIntervals alone; per-field refinedFields tracking (schema migration 0004: sites.refinedFields json) so refining one core attr keeps the others' placeholder lines + re-emit text mirrors stored cascade priors; 2 findings rejected with evidence (1943 branch-order, 1945 stale premise) — 77 tests passing, evidence injected, runner restarted toward 100-streak
- [x] Batch-47 convergence fixes (passes 2111-2152): cpMethodology honest no-CP default; TOU-fallback disclosure gated on energy periods; widestCoverageRate lowest-rate tie-break; bounded plus/pro LLM budget (10× free, no unmetered bypass); b0<0 CalTRACK rejection removed (negative intercept physically possible); US-median-zone disclosure hoisted to measured scenario path; placeholder-buildingType sector-eligibility disclosure; applyRatchet edge specs (empty summer determinant, winter floor) — 8 fixed, 12 rejected with evidence
- [x] Batch-48 convergence fixes (passes 2153-2212): persist address-parsed state/zip/city on sites.create + disclose in derivedOnCreate; DSAR export note superseded-rows accuracy; cross-tenant WRITE isolation specs (refine + assignSite, both directions); anomaly-detection early exits carry only skip reason; dispatchBattery originalLoad-authoritative hardening; billOcr metering fail-loud policy documented in code — 6 fixed, 11 rejected with evidence; 86 tests passing, tsc clean
- [x] Batch-49 convergence fixes (passes 2461-2531): emissions eGRID `mapped` flag flows through summary to Dashboard KPI ("region unresolved — US-average factor applied" instead of citing AZNM as resolved); `cp_omitted_demand_not_computable` added to cpMethodology union so the machine-readable label matches the cause-specific disclosure; airDetectHeaderRow skips summary rows before scoring (preamble "Total = 1234" rows can no longer win header detection); 15 findings rejected with code evidence (peakSoFar family ×4, per-field gate repeats ×3, unreachable zod-validated paths, stale re-flags) — 86 tests passing, evidence injected, runner restarted

## Grounded intake — real data, not wild assumptions (user feedback, Jul 17)
- [x] Address autocomplete in quick-start intake: Google Places suggestions as the user types (fuzzy match, verified address/city/state/ZIP) — places.autocomplete tRPC + dropdown in QuickStart
- [x] Geocode-grounded location fields: state/zip/city from the selected Place, not free-text regex parsing — places.resolve + placeId path in quickCreate (source: place_verified)
- [x] Residential vs commercial detection: Place types give no reliable residential signal (street_address only) — solved with REQUIRED user confirmation chips instead of silent inference
- [x] Residential priors: single_family/multifamily chips map to BUILDING_PRIORS residential medians (~1,800 sqft house), never the office default
- [x] Utility resolution grounded in location: shown as an editable suggestion ("largest in {state} — a suggestion, not verified") with change/override persisted verbatim
- [x] Building-type confirmation step in the quick-start flow — required chip selection (Home / Apartment / Office / Retail / … 12 types); Analyze disabled until chosen; confirmation counts as user_entered refinement
- [x] Residential sector eligibility in tariff sweep — pre-existing (sectorClass keys off buildingType; residential seed tariffs exist); now reachable because homes are actually created as single_family
- [x] Tests: grounded intake — 6 places.test.ts specs (mocked proxy) + quickstart grounded spec (residential priors, confirmed provenance, utility override); live smoke script scripts/places-smoke.mjs verified against the real proxy

## Handoff v1.7 + UX Addendum v1.9 absorption (uploaded Jul 18)
- [x] Schema: meter_role enum (main/submeter/generation/ev/virtual_total) + parentMeterId on meters (migration 0005; meters.setRole with nesting validation)
- [x] Schema: site_groups table + site_group_members (siteGroups router: list/create/setMembership/delete)
- [x] Schema: site_geometry table (footprint GeoJSON, source, height, stories, roof, orientation, exposure, geometry_confidence) — table + helpers live; 3D renderer deferred
- [x] Aggregation physics: pipeline meter selection uses main-role electric meters only (submeter double-count guard); demand never summed
- [x] Public estimate-first onboarding: zero-signup address → instant estimated annual cost + peer percentile + top opportunity (server/estimate.ts + PublicEstimator in hero; IP rate-limited; live-tested)
- [x] Map tap-to-confirm moment on the estimate page (pin confirm step in PublicEstimator; 3D building moment deferred — no 3D renderer yet)
- [x] Accuracy ladder component (Estimate → Good → Great → Measured) visible on the public estimate result
- [x] InsightCard grammar component: headline $ → why → confidence chip → action → provenance expander; Dashboard opportunities + additional insights converted
- [x] Bill Builder: composer.ts engine (composition-not-addition, overlap honesty, weakest-chip confidence, rate re-sweep) + BillBuilder UI with presets and plan bar on Scenarios page
- [x] Pricing page rules: concrete prices ($12/mo, from $29/site/mo), Recommended badge, persona descriptors, value-first free list, jargon fix, setTier WTP audit signal
- [x] Tests for new schema helpers, estimate endpoint, composition engine (composer.test.ts 8 specs; suite 103 passing)

## Remaining v1.7/v1.9 scope (full absorption — Jul 18 continuation)
- [x] §3b Peak Attribution Module: weather split, schedule split, coincidence residual, spike/plateau triage, counterfactual re-pricing, sufficiency gates; attribution card on Dashboard
- [x] §3e Prove-It loop: measure_implementations table (migration 0006), "I did this" action on opportunity cards, monthly verdict ledger w/ honesty gates (no verdict <1 month, early read <3, CVRMSE band, inconclusive-inside-band), cumulative verified-savings counter, miss-handling copy (11 vitest specs)
- [x] §3k Anti-dashboard home feed: /app is now a 3-story feed (this month's verdict, one new insight, next move), verified-else-projected greeting number w/ chip, full analytics moved to /app/explore (Explore nav), Ask WattWise (Plus-gated, budget-checked) NL → engine dispatch cards w/ keyword fallback + provenance disclosure (9 vitest specs)
- [x] §3g Persona fork: residential/commercial detected from building type (client/src/lib/persona.ts, never asked) — home/facility vocabulary, hero rotation via CSS order (residential: rate check first; commercial: demand story first) on Explore
- [x] §3h Processing proof-of-work: pipeline narrate() persists real per-stage lines into analyses.stagesCompleted as each stage completes (weather station match, N interval readings + peak/LF, CalTRACK fit + CVRMSE, N rates re-priced, benchmark, eGRID factor, N insights, N opportunities); analysis.progress polling proc; AnalysisProgress live log on Explore + QuickStart — fallbacks named inline, nothing staged
- [x] Empty-of-data home feed runs on estimates with ladder invite (advisor, not zeros) — QuickStart + accuracy-ladder copy on the no-sites home
- [x] Add-to-plan continuity: opportunity cards → /app/scenarios?site=N&measure=X; Scenarios reads params, preselects site and maps measure vocab to scenario kind (measureToKind); Bill Builder renders on the same page
- [x] §3i-2 Portfolio: exception-first ranked view ($ opportunity + anomaly bump, top 3 expanded, rest collapsed), roll-up KPI header (cost · verified savings · usage-weighted portfolio load factor w/ disclosure · emissions), meter chips w/ role badges, consolidation finding in pipeline (2+ metered main electric meters peaking at different hours → coincident vs sum-of-peaks, analysis-only label, 0.5 kW materiality floor), league table (kWh/sqft/yr w/ basis chips, unrankable sites named not zeroed), site_groups group-by filter — 6 vitest specs
- [x] Per-commodity utility registries (electric/gas/water) via tariffs.utilitiesForState from the seeded snapshot — "Rates loaded" honesty copy (never "your utility is") at QuickStart address-confirm + Sites meter view
- [x] §3l Reports: My Energy Plan (Plus, print w/ cover number + per-measure what/why/payback + "what we'll verify"), Verified Savings Statement (Pro, verified headline + plain-language weather-adjustment box + verdict table), Practitioner export (Pro, CSV w/ CVRMSE/R²/months + chips), Est./Good/Measured chips in print, footer disclaimer + /verify/<token> link backed by report_artifacts (migration 0007); public Verify page shows printed snapshot vs live figures side-by-side — 9 vitest specs
- [x] §3f Lifecycle: digest settings on Account (opt-in, quiet by default, bill-cycle anchor day 1–28, "dollar figure or it doesn't send" rule stated; delivery infra honestly labeled post-beta)
- [x] §3j honest labeling: Account "How your data updates" card names the active rung (manual upload today; never claims automated; Green Button named as explicit future)
- [x] Verification deliverable: VERIFICATION-WALKTHROUGH.md — per-claim URL + click path + code/test pointers for all 30 shipped claims across §3e/3k/3g/3h/3i-2/3l/3f/3j + CRUD/nav, plus an explicit not-claimed section

## Core usability — CRUD + navigation (owner feedback Jul 18, PRIORITY)
- [x] Audit: CRUD coverage matrix for sites, meters, tariffs, scenarios, site groups, uploads, implementations
- [x] Sites: edit (rename, address/attrs), delete with cascade + confirm, from both Sites list and site context
- [x] Meters: create on a site, edit (name, role, parent, timezone, utility), delete with cascade + confirm — visible in UI
- [x] Scenarios: delete/rename saved runs
- [x] Site groups: manage UI (create/delete, assign sites) on Portfolio page
- [x] Uploads: delete an upload / clear bad data path
- [x] Nav: console ↔ public site escape routes (logo → home, back links everywhere)
- [x] Nav: site selector consistency across console pages; no dead-end pages
- [x] Nav: breadcrumbs or back affordance on detail views; mobile nav check (375×812 pass on Home/Explore/Reports/Portfolio — sidebar collapses to header toggle, no dead-ends)
- [x] Click-through validation of every CRUD flow and nav path (desktop + mobile screenshot pass Jul 18; Scenarios deep-link hardened — unowned ?site= now falls back to first owned site instead of a blank selector)

## Docs-vs-build audit gaps (owner challenge Jul 18 — confirmed by full re-read)
- [x] §1 Demo building: "Try a sample Tucson office" zero-commitment path on the public estimator (estimate.sample, labeled isSample, no auth — gapfixes.test.ts)
- [x] §1b Use-my-location (tap-triggered geolocation → reverseGeocode → estimate) + graceful deny fallback on the estimator
- [x] §3i Pre-purchase feed honesty: Pro tier card states "Data updates via bill/interval uploads today — utility feeds are on the roadmap, not sold as live"
- [x] §3m plan_baskets persistence: save/load/delete composed plans (migration 0008, Plus-gated saveBasket, tenancy + cascade specs in gapfixes.test.ts, BillBuilder save/load UI w/ re-price-on-load disclosure)
- [x] §5b rule 1: personalized tier cards — authed Plus card shows the user's open-$ total + biggest site; Pro card shows their site count (anon users see standard copy)
- [x] §2.57 Sewer-on-winter-water linkage: water meters w/ ≥3 winter months (Dec–Feb) get a priced sewer opportunity — winter-average × municipal sewer volumetric template, "your Dec–Feb water use sets your sewer bill all year" story copy, honest gates (no winter data → no claim) — 2 vitest specs; also fixed latent varchar(32) weatherBasis crash on degenerate fits (widened to 64, migration 0010)
- [x] §3i-2 Utility-exposure rollup on Portfolio: spend concentration by provider w/ bars, unanalyzed sites counted-not-priced, single-provider concentration note pointing at the rate check
- [x] §3i-2 Bulk site screening: paste up to 40 addresses on Portfolio → Pro-gated entities.bulkScreen → batch estimates ranked by opportunity $, per-line failures named (never silently dropped), estimate chips throughout — 5 vitest specs
- [x] §3i-2 Portfolio basket: apply a measure across selected sites, per-site composition rolled up, weakest-chip inheritance (scenariosApi.portfolioCompose + Portfolio.tsx card; portfolioBasket.test.ts 4 specs)
- [x] §3i Alerts framework: alerts table (migration 0009) w/ $25 materiality floor + per-(site,kind) open-row batching; generated at analysis time (sustained anomaly × annual cost, top rate opportunity); alerts router + AlertsInbox bell in console layout; digest now backed by a REAL per-user Heartbeat cron (setDigestPrefs creates/removes the job, /api/scheduled/digest handler w/ taskUid-only lookup + orphan→2xx), buildDigest enforces dollar-figure-or-silence, digestPreview "if it ran today" on Account — 9 vitest specs
- [x] §3i Demand review ritual: DemandReview card on Explore for demand-charge sites only — 90th-percentile set-point (proven-target copy), billed-vs-actual monthly table w/ ratchet-applied flags (amber when billed > actual), attribution recap line, exactly ONE priced demand action w/ add-to-plan deep link, honest no-action copy; demandReview block persisted in pipeline summary metrics
- [x] §3 Hero 5 Energy Wrapped: shareable year-in-review card (EnergyWrapped.tsx, launched from HomeFeed)
- [x] §4 EN/ES language toggle (AZ/NM market)
- [x] §3 Hero 4 bill-scan overlay verification: uploaded bill image renders beside the review form (object URL, revoked on save/skip; PDFs skip preview honestly), per-field extraction-confidence chips (green ≥0.8 / amber ≥0.5 / red) on all five fields; manual-entry fields ungraded
- [x] §1b Portfolio map: saved sites pinned, colored by opportunity size
- [x] Honest-gaps ledger: in-app + report disclosure of what is NOT built (Data Concierge rungs 1-4, continuous feeds, 3D extrusion, LiDAR/Solar API, GHL delivery, per-site roles) and why
- [x] Coverage report deliverable: gap-by-gap docs-vs-build matrix with evidence

## New docs received Jul 18 (handoff v1.15 + addendum v2.7 — supersede the v1.7/v1.9 we built against)
- [x] §5b pricing rules: concrete prices not ranges, "Most popular" label, persona descriptors per tier, value-first Free list, jargon check
- [x] §3i-2 identity-confirm moment + living building profile (chip panel w/ source tiers, confirm/correct)
- [ ] Session A0 note: cold_context_review_runner.py requires ANTHROPIC_API_KEY — not available in this environment; per §7 halt-and-report (doc itself is marked CONVERGED by owner's log; build proceeds)
- [ ] v1.15 large-scope items requiring owner prioritization (each is a multi-session build): attribute inference registry + PV gate (v1.9c), dimensional attribution (v1.10), estimated-read/tariff-vintage/baseline-lifecycle (v1.11), second-order inference/equipment health (v1.12), vertical packs + production_series (v1.13), incentives/DSIRE + escalation + split incentives (v1.14), WA compliance layer (v1.15), bill reconciliation self-calibration, cohort insights, geometry/3D layer (v1.4), Overture seeding (v1.8)

## Owner bug report (Jul 18, mobile screenshots)
- [x] BUG: Ranked opportunity cards never name the actual recommendation — body leads with disclaimers/provenance while the measure headline ("Switch to <specific rate>", "Optimize cooling setpoints/schedule") is missing; fix cards to lead with an explicit action title wherever opportunities render (Explore, HomeFeed, Portfolio)

## Owner update Jul 18 (later): handoff v1.17 + addendum v2.8 attached
- [x] Opportunity-card bug fix wave: gapfixes honesty specs green, sewer spec aligned to provenance-disclosure contract, full suite 172 passing (needs checkpoint)
- [x] §5b pricing rules final pass: "Most popular" badge, concrete prices, persona descriptors, value-first Free list, jargon sweep of marketing copy
- [x] v1.17 §5.0(a) capability matrix — codify insight-class × data-state unlock table as a shared module (single source of truth)
- [x] v2.8 §1 ladder-as-contract: accuracy ladder rungs generated FROM the capability matrix; each rung names the specific insights the next upload unlocks BEFORE upload
- [x] v1.17 §5.0(c) recompute-disclosure groundwork: attribute confirmations state which insights recomputed/sharpened
- [x] §3i-2 building profile "what we know about your building" chip panel with per-tier source chips (confirm/correct affordance)
- [x] EN/ES groundwork: i18n scaffold + language toggle (EN complete, ES partial honestly labeled)
- [x] Final coverage report vs v1.17/v2.8: shipped / newly shipped / infeasible-on-runtime / large-scope-needs-prioritization

## Owner update Jul 18 (v1.20 handoff / v2.11 addendum deltas)
- [x] Tenure modes (own/rent/condo-HOA): site-level tenure field; renter mode suppresses owner-capex opportunities, leads with in-control measures; "worth raising with your landlord" list (v1.18 §5 stage 5)
- [x] Tariff applicability conditions: closed-to-new/grandfathered flags + technology-conditioned plans both directions (solar-only plans hidden from non-solar; solar sites see only lawful plans) (v1.18 §5 stage 7)
- [x] Away mode / occupancy calendar: away toggle → quiet watchdog card; away-period usage alert against vacant baseline; leak-first water framing (v1.19 §5 stage 4, v2.10 §1b)
- [x] Occupant privacy boundary: new occupant never sees prior occupant data; modeling continuity ≠ data visibility (v1.19 §5 stage 3b)
- [x] A11y footprint confirm: ordered address/description candidate list as keyboard/screen-reader equivalent of tap-to-confirm (v1.18/v2.9 §1b)
- [x] Persona-QA groundwork: persona fingerprint on dead-end events (PII-free) + at least one CI persona suite (renter zero-capex assertion) (v1.20 block E, AC18a)
- [x] Finish in-flight: building-profile identity confirm chip panel
- [x] Finish in-flight: EN/ES groundwork (string layer + missing-string check)
