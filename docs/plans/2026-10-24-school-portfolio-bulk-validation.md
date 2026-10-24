# School Portfolio Bulk Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import the two school workbooks into an isolated virtual-user portfolio, preserve many-meters-to-one-site relationships, fix the reported reliability defects, and validate the complete portfolio workflow today.

**Architecture:** Add a batch-oriented workbook intake and manifest layer around the existing upload/ingest pipeline. Normalize source addresses into physical sites, create one meter per worksheet, and preserve source lineage and idempotency. Stabilize active-site state at the console shell, harden geometry persistence/fallbacks, make recommendations and portfolio actions state-aware, and validate through targeted server tests plus browser-level checks against the isolated demo tenant.

**Tech Stack:** React 19, TypeScript, tRPC 11, Drizzle/MySQL, existing interval parsers and geometry resolver, Vitest, Playwright/webapp-testing where available, Python/openpyxl for fixture inventory only.

---

### Task 1: Freeze baseline and create the school import fixture manifest

**Files:**
- Create: `scripts/school_portfolio_manifest.py`
- Create: `fixtures/school-portfolio-2026-10-24.manifest.json`
- Create: `docs/plans/2026-10-24-school-portfolio-bulk-validation-design.md`
- Test: `server/schoolImportManifest.test.ts`

**Step 1: Write the failing manifest tests**

Cover 38 sheets, stable source hash, service-point uniqueness, address normalization, date bounds, and deterministic grouping for repeated runs.

**Step 2: Run the focused test**

Run: `pnpm vitest run server/schoolImportManifest.test.ts`
Expected: FAIL because the manifest builder does not yet exist.

**Step 3: Implement the inventory-only manifest builder**

Use Python/openpyxl to read workbook metadata and emit JSON without importing into Meterly. Preserve workbook filename, sheet name, source IDs, address text, rate schedule, row/column dimensions, and date range.

**Step 4: Run the focused test and inspect the manifest**

Run: `pnpm vitest run server/schoolImportManifest.test.ts` and validate the generated JSON contains all 38 sheets.

**Step 5: Commit**

```bash
git add scripts/school_portfolio_manifest.py fixtures/school-portfolio-2026-10-24.manifest.json server/schoolImportManifest.test.ts docs/plans/2026-10-24-school-portfolio-bulk-validation-design.md
git commit -m "test: inventory school portfolio workbook fixture"
```

### Task 2: Add source-lineage and import-batch primitives

**Files:**
- Modify: `drizzle/schema.ts`
- Create: `drizzle/<generated-school-import-migration>.sql`
- Modify: `server/dbHelpers.ts`
- Test: `server/schoolImportBatch.test.ts`

**Step 1: Write failing tests**

Test batch creation, source-file/sheet lineage, service-point uniqueness, idempotent re-import, and batch-level cleanup for the isolated demo user.

**Step 2: Generate and inspect the additive migration**

Run: `pnpm drizzle-kit generate`. Keep only batch, source-file/sheet, and any narrowly required lineage/index statements. Do not include unrelated schema drift.

**Step 3: Implement helpers**

Add `createImportBatch`, `upsertImportSource`, `findMeterBySourceIdentity`, and `deleteImportBatch` helpers. Use a unique key composed of tenant/user, utility/service-point identity, and source lineage. Keep existing ownership boundaries.

**Step 4: Apply migration to the isolated project database**

Use the WebDev SQL tool after reviewing generated SQL. Do not touch existing user rows.

**Step 5: Run tests and commit**

Run: `pnpm vitest run server/schoolImportBatch.test.ts`.

```bash
git add drizzle/schema.ts drizzle/*.sql server/dbHelpers.ts server/schoolImportBatch.test.ts
git commit -m "feat: add idempotent school import lineage"
```

### Task 3: Implement multi-file, multi-sheet bulk intake

**Files:**
- Modify: `server/routers.ts`
- Create: `server/schoolBulkImport.ts`
- Modify: `client/src/pages/console/Upload.tsx`
- Create: `client/src/components/BulkWorkbookImport.tsx`
- Test: `server/schoolBulkImport.test.ts`

**Step 1: Write failing parser/import tests**

Cover multiple workbook inputs, all sheets, malformed sheet isolation, normalized address grouping, one meter per sheet, interval counts, duplicate re-import, and no partial orphan records.

**Step 2: Implement server bulk-import service**

Accept the isolated user/tenant, file references, and explicit demo mode. Enumerate workbook sheets through the existing parser boundary. Validate required metadata and interval columns. Resolve/group sites by normalized address. Create meters under grouped sites and route interval points through the existing `writeIntervals` path. Keep exact source IDs and facility labels.

**Step 3: Add preview/confirmation UI**

Show file count, sheet count, proposed site count, meters per site, warnings, and duplicate status before import. Require an explicit confirmation for the demo batch. Show per-sheet progress and failures.

**Step 4: Run focused tests**

Run: `pnpm vitest run server/schoolBulkImport.test.ts server/ingest.parsers.test.ts server/ingestFormats.test.ts`.

**Step 5: Import the attached files into the isolated virtual user**

Use the actual uploaded workbook paths and record the resulting batch ID in the validation ledger. Repeat the same import once to prove idempotency.

### Task 4: Stabilize active-site selection across Explore and console views

**Files:**
- Modify: `client/src/pages/AppShell.tsx`
- Modify: `client/src/pages/console/Explore.tsx` or current Explore page file
- Modify: `client/src/components/DashboardLayout.tsx`
- Modify: `client/src/pages/console/HomeFeed.tsx`
- Test: `client/src` browser test or `server/siteSelection.test.ts` plus Playwright flow

**Step 1: Reproduce the defect**

Select a non-first site, navigate Explore → Portfolio → Sites → Explore, and capture the returned site ID.

**Step 2: Add a failing browser regression**

Assert that the selected site remains selected after navigation and that the URL carries the canonical site query parameter.

**Step 3: Implement one canonical active-site source**

Use the URL site parameter as the authoritative state, update it when the user selects a site, preserve it in internal links, and use the first site only when no explicit site is present. Invalidate site-scoped queries when the ID changes.

**Step 4: Run the browser regression at desktop and 375px widths**

Expected: selected site and site-scoped content remain stable.

### Task 5: Fix building-footprint reliability and persistence

**Files:**
- Modify: `server/geometry.ts`
- Modify: `server/geometryResolver.ts` or current resolver file
- Modify: `server/routers.ts`
- Modify: relevant Explore geometry component
- Test: `server/geometryEndpoints.test.ts`, `server/geometryGuard.test.ts`, `server/geometryPersistentCache.test.ts`

**Step 1: Add failing tests**

Cover successful resolver result persistence, provider/mirror failure with retry, stale selected-site rejection, user-drawn geometry precedence, and reload persistence.

**Step 2: Trace and harden the request identity**

Ensure every geometry request includes the current site ID and user ID, rejects stale responses for a different selected site, and never writes degraded geometry as authoritative.

**Step 3: Preserve deterministic fallback behavior**

Keep existing provider race/cache behavior, but surface unresolved state and retry action. Do not replace missing geometry with invented dimensions.

**Step 4: Run targeted geometry tests and browser flow**

Run the geometry test files and verify a selected school site resolves, reloads, and remains tied to that site.

### Task 6: Validate localized rates and rate provenance for imported meters

**Files:**
- Modify: `server/routers.ts` or existing rate pipeline only if a defect is found
- Modify: relevant rate/provenance UI
- Test: `server/rateCurrency.test.ts`, `server/serviceTerritory.test.ts`, `server/nationalRates.test.ts`

**Step 1: Add fixture assertions**

For Kingman/Dolan Springs schools, assert state/territory resolution, commodity/rate schedule labeling, effective date, source, and fallback disclosure.

**Step 2: Run existing rate tests before editing production logic**

Run: `pnpm vitest run server/rateCurrency.test.ts server/serviceTerritory.test.ts server/nationalRates.test.ts`.

**Step 3: Fix only demonstrated localization defects**

Prefer territory catalog and official filed-rate data. Preserve the rate-currency audit trail and never hard-code a demo-only rate.

**Step 4: Validate UI evidence**

Confirm each selected site shows the rate source/effective basis and that modeled figures disclose uncertainty when appropriate.

### Task 7: Make recommendations progressive and state-aware

**Files:**
- Modify: `server/routers.ts` or the current insights/opportunity module
- Modify: `client/src/pages/console/HomeFeed.tsx`
- Modify: recommendation/action components
- Test: `server/commodityOpportunities.test.ts`, `server/portfolioBasket.test.ts`, new recommendation progression test

**Step 1: Write failing tests**

Create a site with ranked recommendations, complete the top action, re-run the pipeline, and assert the next eligible action is surfaced while the completed one is retained as completed evidence.

**Step 2: Implement explicit action state transitions**

Use existing audit/action/implementation tables where possible. Add only the smallest status fields/procedure needed for complete, dismiss, snooze, and in-progress states.

**Step 3: Re-rank with current state**

Exclude completed/dismissed items from the active queue according to policy, recalculate dependencies, and preserve savings ranges and provenance.

**Step 4: Run focused tests and browser validation**

Confirm the next recommendation changes after completion for both a single site and selected portfolio sites.

### Task 8: Extend portfolio action prioritization to selected site subsets

**Files:**
- Modify: `server/routers.ts`
- Modify: `client/src/pages/console/Portfolio.tsx`
- Modify: existing portfolio basket components
- Test: `server/portfolioBasket.test.ts`, `server/portfolio.test.ts`

**Step 1: Add failing subset-selection tests**

Assert all-sites and selected-site-set aggregation, per-site provenance, duplicate-measure handling, and non-additive range disclosure.

**Step 2: Implement selection-aware portfolio query/mutation**

Accept explicit site IDs, validate ownership, calculate aggregate views, and retain the individual site breakdown.

**Step 3: Add UI selection and prioritization**

Provide select-all, clear, and multi-select controls; show readiness and evidence columns; allow prioritization without pretending the portfolio range is a guaranteed sum.

**Step 4: Run tests and validate with the school portfolio**

Use sites with multiple meters and sites with multiple opportunities.

### Task 9: Concept documentation for county insights, contractor reporting, and future billing

**Files:**
- Create: `docs/plans/2026-10-24-partner-monitoring-and-billing-concepts.md`
- Modify: `docs/plans/2026-10-24-school-portfolio-bulk-validation-design.md` if decisions change

Document public county-source provenance and paid-provider adapters; contractor-managed customer tenants and report delivery; many-to-many relationship billing dimensions; and user-role pricing/permissions. Keep these concept-only and do not expose unfinished controls in the demo.

### Task 10: Full validation, demo ledger, and release checkpoint

**Files:**
- Create: `/home/ubuntu/work/school-portfolio-validation-2026-10-24.md`
- Modify: `/home/ubuntu/SESSION_VAULT.md`

Run:

```bash
pnpm check
pnpm test
pnpm build
```

Then run the browser flow for the isolated user: sign in, open Explore, select each representative grouped site, verify multi-meter views, resolve/reload geometry, inspect rate provenance, complete a recommendation, select a portfolio subset, prioritize a portfolio action, export/report, and inspect print output.

Record exact batch ID, site/meter counts, interval counts, test commands, screenshots/defects, and production-isolation checks. Save a checkpoint only after the full suite and demo flow pass. Never claim the prospective-customer demo is ready if any P0/P1 issue remains.
