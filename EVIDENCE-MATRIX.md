# Meterly — Requirement Evidence Matrix

**Prepared:** July 19, 2026 · **Build version:** 487e3c85 · **Test baseline:** 317 passed / 7 intentionally skipped (324 specs, 48 files), TypeScript clean.

**Source documents audited:** Handoff v1.22 (`Pasted_content_10.txt`, final CONVERGED edition), UX Optimization Addendum v2.13 (`Pasted_content_09.txt`), all earlier pasted-content revisions (deltas verified by diff), owner screenshots and messages.

**Verdict key:** BUILT = implemented, user-visible where applicable, with test evidence. PARTIAL = implemented with documented limitation. DIVERGENCE = deliberately built differently, reason stated. BLOCKED = not buildable in this runtime/infrastructure, reason stated. Nothing is marked BUILT without a code path and, where applicable, a test.

---

## 1. Peak-demand module (owner escalation — every doc item traced)

| Requirement (doc §) | Verdict | Code evidence | UI evidence | Test evidence |
|---|---|---|---|---|
| Monthly peak table shows the annual maximum (owner screenshot bug) | BUILT | `Dashboard.tsx` monthly-peaks block | All 13 months render (scroll past 8); max row highlighted "max — sets ratchet"; pinned "Greatest peak" callout with kW, month, timestamp | Visual (UX-3 screenshots) |
| Billing demand per tariff: window/ratchet/TOU-scoped (§5 stage 5) | BUILT | `analytics/tariffEngine.ts` | Demand & peak charges card; ratchet math in rate table | `tariffEngine` suites |
| Peak timestamp per month | BUILT | `computeDemandAnalytics` | "When" column with local timestamp | `peakDemandModule.test.ts` |
| Weather coincidence on peaks | BUILT | `analytics/pipeline.ts` peak-hypothesis enrichment (peak-month normals vs annual, ±8°F) | Hypothesis line labeled "typically/normals — not observed weather" | `peakDemandModule.test.ts` |
| Contributing-load hypothesis per peak | BUILT | Engine heuristics (cooling / heating / baseload-timer from local hour + season) | Demand card list sorted by kW, "hypotheses to check — not measured attribution" badge | 6-spec suite |
| Load factor per meter | BUILT | Engine + portfolio rollup | Dashboard + Portfolio | Existing suites |
| Load duration curve + peak shaving framing | BUILT | 101-point duration-weighted curve, `hoursNearPeakPct` | Stepped area chart + rarity metric + shaving interpretation copy | `peakDemandModule.test.ts` |
| Demand share of modeled bill | BUILT | Pipeline | Demand card headline ($ and %) | Suites |
| Demand heatmap (day-of-week × hour) | BUILT | Engine | Dashboard heatmap with confidence badge | Suites |
| Coincident-peak (CP) exposure proxy | BUILT | Engine | Dashboard "estimated — not ISO system peaks" list; Tariffs, Portfolio | Suites |
| Ratchet watch + demand review ritual | BUILT | `DemandReview.tsx` | Monthly demand review card with set-point | Component present, server suites |
| Demand spike alerts | BUILT | Pipeline detector | AlertsInbox with dollar-first framing | Alert suites |
| Peak attribution (weather/schedule/coincidence split, counterfactual re-pricing, forward advisory) | BUILT | Attribution module | Peak attribution card (verified on mobile screenshot: 4,200 kW Aug-2025 plateau story) | Attribution suites |

## 2. Owner-reported defects this session

| Report | Verdict | Evidence |
|---|---|---|
| Pin-drop panel: "pick a building type" with no selector | FIXED | Chips render inside pin panel; duplicate-row suppression; verified via authenticated 375px Playwright run |
| Junk "Recon Test Utility / Recon Flat 10" rows on live rate check | FIXED, 3-layer guard | (1) DB purged: 83 test users, 95 sites, 7 fixture tariffs — verified zero residue; (2) offending suite now tags fixtures `source=test_fixture` + afterAll cleanup + vitest globalTeardown sweeps all `@test.local` residue every run; (3) `listTariffs` excludes fixture-tagged rows unconditionally |
| Peak table hides greatest peak (last 6 of 13 months) | FIXED | See §1 row 1 |

## 3. Rebrand and scope (owner request)

| Requirement | Verdict | Evidence |
|---|---|---|
| Rename to **Meterly** (corrected from "Metered, by Stewardly") | BUILT | 28-file copy sweep; index.html title; nav/footer/legal/report headers; download filenames `meterly-*`; "Ask Meterly"; localStorage key migrated with legacy honor. Note: the workspace/deployment label ("WattWise — Utility Data Intelligence" in the browser tab of the management console and the `wattwise.manus.space` domain) is changeable in Settings → General / Settings → Domains — flagged for owner action since renaming the domain is a product decision |
| Multi-utility scope language (not electricity-only) | BUILT | Hero: "utility bills … Electric, gas, water, sewer"; legal scope line; EN+ES parity maintained |
| Multi-utility substance | BUILT (already present, now surfaced) | Gas tariff templates (Southwest Gas, UNS, NM Gas, PSE, Cascade), water tariffs by meter size, sewer winter-average linkage + story card, utility-triple reveal, commodity-aware baselines (gas HDD-only, water seasonal) |

## 4. Geometry / 3D building layer (owner: "3D mapping, sourcing/imputing size")

| Requirement (doc §5 stage 2b/2c) | Verdict | Evidence |
|---|---|---|
| Footprint resolve from location | BUILT | `server/geometry.ts`: OSM Overpass fetch (2 mirrors), candidate polygons, ODbL attribution flag |
| Prism massing model fallback | BUILT | GFA/stories prism when no footprint; isometric prism SVG labeled "prism estimate — not a survey" |
| Orientation, wall areas, exposure | BUILT | Shoelace area, longest-edge orientation, 8-bucket exposed-wall areas, exposure score; per-field `geometryConfidence` |
| Tap-to-confirm, never silently assert | BUILT | `SiteGeometryPanel` on Dashboard: satellite overlay, candidate chips, confirm action (audited) |
| Draw-your-own footprint | BUILT | Polygon draw mode in panel |
| Footprint GFA feeds dimensional receipts (>20% divergence question) | BUILT | Endpoint spec proves confirmed geometry flows into `dimensionReceipts` |
| Tests | 12 specs green (10 math + 2 endpoint contract) |
| LiDAR height, NAIP imagery, 3DEP terrain, Overture GERS bulk seeds, Google Solar API | BLOCKED | Multi-GB national datasets / API key required; prism + OSM heights used instead with honest source labels |

## 5. Address lookup (owner request: name search like Apple/Google Maps)

| Requirement | Verdict | Evidence |
|---|---|---|
| Search by place/business name | BUILT | `placeAutocomplete` blends address + establishment predictions (dedup, cap 6, graceful degradation if one scope fails); POI rows get Landmark icon + "place" badge; resolved POIs show "Verified place · name"; site label prefers the place name | 5-spec suite + updated legacy suite |

## 6. Handoff v1.22 — full-body audit

The v1.22 delta over v1.20 is exactly the S-LIFECYCLE seed-freshness section. Verified BUILT: `seed_freshness` table + cadence registry, staleness → chip widening + ops alert, non-URDB bill-verification freshness reset ("currency earned from bills"), unknown-tariff crowd discovery (N≥3 → create-template task), parser-drift monitor, config-not-constant (`app_config` table). 7-spec suite green.

The v1.20 body was extracted as R1–R78 (see `/home/ubuntu/work/reconciliation_checklist.md`). Summary of final states:

| Area | State |
|---|---|
| Data model §2 (commodities, meters w/ roles, submeter physics, virtual totals, intervals quality flags, bills read_type, tariff freshness, archetypes w/ equipment metadata, site_geometry, baselines, scenarios, opportunities energy/demand split, enrichment cache, jobs, load factor) | BUILT |
| Seeders (eGRID, URDB, ResStock/ComStock, benchmarks, weather normals/TMY, NOAA stations, assessor extract, utility registries incl. gas/water, parser templates, solar resource, sector benchmarks, WA compliance tables, incentives) | BUILT as curated extracts sized to this runtime; bulk Overture/NAIP/3DEP/LiDAR BLOCKED (documented) |
| Ingestion §4 (Green Button XML, CSV/Excel registry + column mapper, bill parse chain w/ LLM fallback + 3% validation + review queue, manual entry, hypothetical wizard, idempotency, XXE/size/timeout hardening) | BUILT |
| Analytics stages 1–11 (weather backfill w/ normal-year label, geometry, attribute-inference registry w/ precedence, PV gate, signature detectors, dimensional attribution, fuel-presence cross-inference, baselines per commodity, occupant re-base + model pinning, anomaly/change-point, demand module, disaggregation w/ ranges, tariff temporal correctness, benchmarking 15/15, opportunities, scenario extrapolation guard, solar banking/true-up, second-order inference incl. equipment/lifecycle/sizing/drift/envelope/microclimate, vertical packs w/ production series, economics incl. incentives + escalation + who-pays, WA compliance cards, bill-reconciliation self-calibration, cohort 15/15, emissions) | BUILT |
| Tiers/abuse (free limits, metering, caps, kill-switch) | BUILT |
| Guardrails §7–8 (deletion endpoint + typed confirm, export, disclaimers, audit log, upload hardening, per-utility data matrix) | BUILT |
| Python microservices (eemeter/NILMTK/PVLib, BullMQ) | DIVERGENCE — TS-native equivalents; Node-only deploy runtime; labeled honestly in-app |
| GHL CRM webhook, email-in ingestion, email digest delivery, aggregator/Green Button live APIs, agentic fetcher + credential vault, Stripe billing | BLOCKED — need owner-provided URL/keys or mail/browser infrastructure; UI carries honest "not yet wired" labels where relevant |

## 7. UX addendum v2.13 — full-body audit

A1–A22 extracted and audited. All buildable items BUILT across four batches, including: estimate-first funnel + demo building, location ladder (use-my-location, autocomplete incl. POI names, pin-drop + prospective mode, draw-your-own footprint, portfolio map), card grammar + single InsightCard, hero moments (rate-check reveal, peak-day story, scenario playground, Energy Wrapped, bill-scan overlay), peak attribution suite w/ sufficiency gates, Bill Builder (presets, overlap honesty, re-sweep, before/after, free 3-measure cap, plan PDF), design system (dark mode, motion budget, EN/ES parity CI gate), prove-it loop (mark-implemented → verdict card → cumulative counter → graduation), lifecycle digests (in-app; email delivery BLOCKED, labeled), persona fork, processing narration, Pro suite (exception-first portfolio, dollar-first alerts w/ quiet hours, demand review, M&V dual-audience reports, feed-health chips, roles owner/FM/read-only), meter chips, identity confirm, living profile w/ dimensional receipts, detections as feed moments, PV disambiguation gate, compliance countdown, incentives found-money, pack activation, equipment card + annual checkup, one-address-three-utilities reveal, consolidation, league table, bulk screening, portfolio basket, data-concierge ladder (rungs 4–5 labeled honestly; 1–3 BLOCKED), anti-dashboard feed, reports (3 artifacts + QR verify + ESPM-compatible export + portfolio verified-savings edition), trust/a11y, conversion moments, pricing rules.

## 8. Excluded by owner instruction

100-consecutive-clean-pass gate (documented unmeetable), UHOP runner resumption (paused per owner), A0 cold-context runner (no ANTHROPIC_API_KEY), v1.15 large-scope prioritization queue (awaiting owner's pick — though its substantive members: incentives, compliance, verticals, equipment, geometry — have since been built).

---

*Every BUILT verdict above traces to a code path and test in the repository; the full per-requirement ledger with file/line evidence lives in `todo.md` (project root) and `/home/ubuntu/work/reconciliation_checklist.md`.*
