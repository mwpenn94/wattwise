# Meterly Billing and Open Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the additive billing foundation and close the four product follow-ons while preserving the active rate-verification system and honesty charter.

**Architecture:** Add account-level billing mirror tables and a single server entitlement map. Keep Stripe operations behind test-mode configuration and signed webhook verification. Reuse existing unified utility surfaces, telecom service CRUD, and report components rather than adding parallel flows.

**Tech Stack:** React 19, Tailwind 4, tRPC 11, Express 4, Drizzle ORM, MySQL/TiDB, Vitest, Stripe hosted Checkout and Customer Portal when test-mode configuration exists.

---

### Task 1: Add billing persistence and entitlement map

**Files:**
- Modify: `drizzle/schema.ts`
- Create: `drizzle/0022_*.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `server/billing.ts`
- Test: `server/billing.test.ts`

Add nullable/account-safe tables for billing subscriptions, processed webhook event IDs, and billing audit rows. Add a Founding plan mapping for existing accounts without deleting or narrowing data. Export one plan-to-entitlements map and a read-only transition policy.

Run `pnpm check` and the targeted billing tests before continuing.

### Task 2: Add Stripe-safe server boundary

**Files:**
- Modify: `server/_core/env.ts`
- Modify: `server/routers.ts`
- Modify: `server/_core/index.ts`
- Create: `server/stripeBilling.ts`
- Test: `server/stripeBilling.test.ts`

Implement hosted Checkout and Customer Portal session builders that require explicit test-mode configuration and never use a live account. Implement raw-body signature verification, event-id idempotency, and event handling for checkout completed, subscription lifecycle, invoice paid, and payment failed. Add seven-day grace handling and server-side entitlement lookup. If configuration is absent, return a deterministic setup-required response.

### Task 3: Add Billing UI and honest setup state

**Files:**
- Modify: `client/src/pages/console/Account.tsx`
- Modify: `client/src/pages/Home.tsx`
- Modify: `client/src/components/DashboardLayout.tsx`
- Test: relevant UI/server tests

Add a Billing card showing Founding/Free/Plus/Pro status, usage against limits, current setup state, and manage billing controls. Preserve no-charge Founding behavior. Never display fake prices; use explicit “price to be set” copy while prices remain owner-controlled.

### Task 4: Add branded print header

**Files:**
- Modify: `client/src/components/print/SiteInsightsReport.tsx`
- Modify: `client/src/index.css`
- Test or screenshot: print report visual check

Add a local, print-safe Meterly wordmark/mark, site name, report title, and date. Keep browser-generated metadata suppressed and preserve monochrome/color output.

### Task 5: Add Connectivity $/sqft to league table

**Files:**
- Locate and modify the existing league-table query/component
- Modify: relevant portfolio server/client files
- Test: league-table tests

Compute nullable annualized entered connectivity spend divided by known square footage. Keep it separate from EUI and energy dollars. Show `—` with a basis explanation when data is missing and test multi-service and mobile-only cases.

### Task 6: Add telecom price history and creep detection

**Files:**
- Modify: `drizzle/schema.ts`
- Create: `drizzle/0023_*.sql`
- Modify: `server/telecom.ts`
- Modify: `server/routers.ts`
- Test: `server/telecomPriceHistory.test.ts`

Store service-period observations without overwriting current service cost. Normalize comparable periods, require at least two observations, prefer three for sustained trend, apply absolute and percentage materiality thresholds, and disclose exact observed periods. Do not emit a finding for one observation or double-count promo-expiry savings.

### Task 7: Add unified Add Utility flow

**Files:**
- Create: `client/src/components/AddUtilityDialog.tsx`
- Modify: `client/src/components/UtilityServicesCard.tsx`
- Modify: `client/src/pages/console/Dashboard.tsx`
- Modify: existing bill/OCR intake entry points
- Test: utility routing and mobile visual checks

Offer Electric, Gas, Water, and Connectivity from one CTA. Route to existing meter/bill or service/OCR flows, and ensure connectivity bill entry records price history from the first captured period.

### Task 8: Adjudicate rate findings

**Files:**
- Modify only through the existing rate application path and audit records
- Create: `/home/ubuntu/work/run/rate-adjudication-2026-09.md`

Use official tariff sheets or PSC orders. Apply only when class, components, effective period, and governed-row mapping all reconcile. Otherwise retain `change_detected` and preserve evidence.

### Task 9: Final validation and release candidate

Run `pnpm check`, `pnpm test`, targeted tests, desktop and 375px visual checks, print preview, and an honesty audit of every new dollar figure. Verify no live Stripe objects were created, no live charges occurred, no customer email was sent, and the active monthly schedule remains unchanged. Save a checkpoint only after all gates pass.
