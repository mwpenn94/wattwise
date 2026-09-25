# Meterly Billing and Open Queue Design

> **Approved by:** the attached fire-and-forget execution prompt dated 2026-09-25.

## Goal

Add a safe, tenant-level billing foundation and complete the explicitly listed open queue without charging real customers, changing live Stripe objects, or weakening Meterly's provenance and honesty rules.

## Architecture

Billing is provider-agnostic at the application boundary and Stripe-specific at a disabled-until-configured integration boundary. Meterly stores one account-level subscription mirror, one event-id idempotency record, and an audit trail. Entitlements are derived from a single server-side plan map. Existing users receive a no-charge Founding plan with the current full-access tier preserved; new accounts remain Free unless an approved subscription or admin override changes them.

The checkout and portal calls remain unavailable until a Stripe test-mode account and server secrets are configured. The current connector exposes only a live-mode account, so no Stripe objects are created in this run. The code must fail closed with a clear setup-required response rather than falling back to live mode.

The product queue is implemented in this order: branded print header; Connectivity spend per square foot; telecom price-history storage and creep detection; then a shared Add Utility flow that records history from bill entry on day one. Rate findings are reviewed separately and only adopted through the existing conservative apply path when all five evidence gates hold.

## Billing behavior

Free retains the existing free capabilities. Plus adds portfolio views, reports and exports selected by the existing report gates, continuous monitoring, and deeper analytics as defined by current code. Pro retains the existing Pro-gated portfolio and export behavior and adds the remaining higher-tier features already enforced by the code. Founding is a no-charge compatibility plan that maps to the current full-access tier until the owner sets final commercial policy.

Hosted Checkout is the intended subscription entry point. Customer Portal is the intended self-service management surface. Upgrades use immediate proration. Downgrades and cancellation set period-end behavior. Payment failures remain in a seven-day grace state before application access returns to Free; no user data is deleted. Webhooks verify signatures, reject replayed event IDs, and mirror supported subscription and invoice events.

## Data flow

1. An authenticated account opens Billing and sees its plan, limits, usage, and setup status.
2. If Stripe test configuration is present, a server procedure creates a hosted Checkout session for a configured price ID. The browser is redirected to Stripe.
3. Stripe sends signed events to the server webhook. The handler checks the raw body signature, records the event ID once, updates the subscription mirror, and writes an audit row.
4. Every protected server procedure continues to enforce an entitlement derived from the server map. The client only displays status and upgrade prompts.
5. Over-limit downgrades preserve all rows and return read-only or limit errors; deletion is never part of billing transitions.

## Rate decision policy

Southwest Gas must distinguish residential G-5 from commercial G-25 and store Monthly Gas Cost as a time-varying component. Phoenix Water must withhold site-specific dollars when territory, meter size, or billing month is unknown and model 748-gallon seasonal and meter-size charges only when an additive representation is honest. LG&E/KU can change numeric rows only from approved tariff sheets or a PSC order with unambiguous governed-row mapping.

## Testing

Tests cover entitlement mapping, Founding grants, tenant isolation, webhook signature rejection, event idempotency, billing status transitions, telecom history normalization, price-creep thresholds, Add Utility routing, league-table missing-data behavior, print branding, and the existing full suite. Stripe sandbox lifecycle tests remain parked until a test-mode account exists; the application-level test doubles must still cover the state machine without touching Stripe.
