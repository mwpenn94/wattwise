# School Portfolio Bulk Validation and Relationship-Aware Meterly Design

**Date:** 2026-10-24  
**Status:** Approved direction for implementation  
**Scope:** Isolated virtual-user demonstration using two attached Excel workbooks plus reliability fixes and end-to-end validation

## Goal

Enable Meterly to ingest multiple workbooks and sheets into a realistic school portfolio while preserving the dynamic relationship between owners, portfolios, physical sites, meters, interval uploads, and future service relationships. Use the isolated dataset to validate the product experience and fix the reliability issues needed for today’s business-development presentation.

## Findings from the supplied workbooks

The two workbooks contain 38 worksheets/service points. Each sheet has roughly 35,048–35,049 rows, five columns, and 15-minute interval readings covering approximately 2025-10-01 through 2026-10-01. The records include account number, service agreement ID, service point ID, rate schedule, address, date, time, delivered kWh, and kW demand.

Several physical addresses have multiple service points or named facilities. Examples include 4182 N Bank St, 16500 N Pierce Ferry Rd, 3115 Macdonald Ave, 400 Grandview Ave, and 500 Maple St. This dataset is specifically useful for exercising many meters per site rather than treating every sheet as a separate site.

## Approved import model

Create one isolated virtual user and one portfolio-like tenant context for the demonstration. Normalize each sheet’s address into a physical-site grouping key. Create one site per normalized physical address. Create one meter per workbook worksheet/service point under its grouped site. Preserve facility descriptors such as Unit A, Daycare, Pump Station, Ballfield Lighting, Aux Gym, and Shop as meter/facility metadata; do not silently split them into separate physical sites.

Create an auditable import manifest before ingestion. The manifest maps every source file and sheet to the proposed site, meter, account, service agreement, service point, rate schedule, address text, normalized address, timezone/state inference, and any ambiguity. The importer must be idempotent by source batch and service-point identity, so retrying the same files does not duplicate sites, meters, or interval readings.

The initial demo import must not write into existing production users or alter existing customer data. It should use a dedicated virtual user/test tenant or an explicit disposable import batch. Every created record must be traceable to the batch and original workbook/sheet.

## Relationship architecture

The canonical graph is:

`owner/user → portfolio or tenant → sites → meters → uploads → interval readings`

The implementation must not assume one site per meter, one meter per site, or one owner per site. Existing user ownership checks remain enforced. If portfolio membership tables are not yet sufficient for explicit portfolio tenancy, the first implementation may use a demo-user site collection while adding a clear import-batch and source-lineage layer; a later portfolio-membership migration should remain additive.

For billing and partner workflows, do not introduce pricing changes in this delivery. Record the required future dimensions—owner/tenant, customer account, portfolio, site, meter count, data volume, analysis runs, monitoring cadence, and user role—as a concept document and implementation seam only.

## Must-ship today

### Bulk setup and validation fixture

Build or extend a bulk workbook intake path that accepts multiple files, enumerates all sheets, previews the mapping, groups by normalized address, detects duplicate service points, and imports each sheet as a meter. Use the 38-sheet school dataset as the primary fixture. Validate row counts, interval continuity, dates, units, demand fields, service-point uniqueness, and import idempotency.

### Building footprint reliability

Trace the full geometry path from site selection through geocoding, footprint resolution, persistence, and display. Make successful geometry resolution deterministic for a selected site, preserve user-drawn geometry precedence, avoid stale cache contamination, surface an explicit retry/fallback state, and add regression coverage for intermittent provider failure, mirror failure, stale selection, and successful persistence.

### Site selection persistence

Create one canonical active-site state for the console shell. Parse an explicit site query parameter on initial load, preserve it during navigation, and invalidate/reload site-scoped queries when it changes. Do not default back to the first site after view switches. Use stable URL state as the primary source and local storage only as a secondary recovery mechanism.

### Rate localization and evidence

Use the resolved site state/ZIP/territory to select utility territory and current rate currency. Validate that each imported school meter is assigned the correct commodity, utility, state, and rate schedule where available. Display rate basis, effective date, source, and uncertainty. Do not silently use a national fallback when a more local territory is resolvable. Any fallback must be visibly disclosed.

### Progressive recommendations

Treat recommendations as stateful work items rather than a static list. A completed, dismissed, snoozed, or in-progress recommendation must affect the next ranked set. Completion should preserve evidence and measured/verified status where applicable, and the pipeline should re-rank remaining opportunities using the current site and portfolio state. Add regression tests for completing the top recommendation and receiving the next appropriate recommendation.

### Portfolio-level prioritization

Extend the existing portfolio basket/action model so users can select all or a subset of sites, view aggregate opportunity ranges, rank by confidence/impact/readiness, and prioritize a measure across selected sites. Preserve per-site provenance and do not add savings ranges as if they were independently additive when the system’s existing caps/disclosures prohibit that.

### End-to-end demo validation

Run the virtual-user workflow from workbook import through site switching, geometry, localized rates, analysis, ranked recommendations, recommendation completion, portfolio selection, portfolio action prioritization, exports, and print output. Capture a defect ledger with severity, reproduction, fix, and validation result.

## Concept-only items for this delivery

### Countyoffice.org insights

Document an integration seam beginning with public/free county data: county identification from the site address, source URL, retrieval date, data category, and provenance. Treat paid plans as a later provider adapter with explicit licensing and cost controls. Do not make an unaudited external-data claim part of today’s demo.

### Contractor monitoring and reporting

Document a delegated-service model in which a contractor/partner organization owns or manages customer tenants, schedules monitoring, produces reports, and bills the customer without requiring the customer to navigate Meterly. Keep customer data boundaries, consent, report recipients, and audit events explicit. Do not build the full partner portal today unless a narrow read-only report proof is needed for the presentation.

### Relationship-aware billing

Document usage dimensions for future pricing: customer/tenant, owner count, user roles, portfolio count, site count, meter count, interval volume, bill/OCR volume, analysis runs, monitoring frequency, report generation, and support tier. The model should support a base platform fee plus transparent usage bands or meter/site add-ons, with no commitment until cost telemetry is available.

### Billing by user type

Document personas such as owner/admin, facility manager, analyst, contractor/partner, read-only customer, and service account. Define permissions and billable value separately; do not assume every login should be priced identically.

## Error handling and safety

Imports must fail per sheet with an actionable error rather than partially claiming success. A failed sheet must not create an orphan meter or partial interval analysis. Retry-safe operations must use source hashes and service-point/batch keys. Geometry failures must remain visible as unresolved rather than being replaced with invented footprints. Rate failures must retain provenance and disclose fallback. All demo data must be removable by batch or virtual user.

## Acceptance criteria

The virtual-user portfolio contains all 38 source sheets exactly once, with no duplicate service-point meters after a repeated import. Each meter retains source provenance and interval counts. Grouped sites expose multiple meters where the source addresses warrant it. Switching among sites and console views preserves the selected site. Footprint resolution persists and remains visible after reload or a provider retry. Localized rate evidence is displayed for the selected site. Recommendation completion changes the next ranked recommendation. Portfolio actions can be filtered to a subset of sites and preserve per-site basis. No production user or existing site is modified. `pnpm check`, the full test suite, and targeted browser/E2E checks pass.
