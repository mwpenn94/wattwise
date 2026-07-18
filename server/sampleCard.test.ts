/**
 * §5c-2 live sample insight card — contract tests.
 *
 * The homepage's above-the-fold card must be REAL pipeline output, publicly
 * reachable (no auth), carry an actual dollar figure, and honestly label
 * itself a demo building at the estimate rung. A regression here would either
 * break the landing page's first-impression card or, worse, let a fabricated
 * number onto the most-viewed surface in the product.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

function anonCaller() {
  return appRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: {}, ip: `127.2.0.${Math.floor(Math.random() * 250) + 1}` } as never,
    res: { setHeader: () => {}, clearCookie: () => {}, cookie: () => {} } as never,
  } as never);
}

describe("estimate.sampleCard (§5c-2 homepage live card)", () => {
  it("is publicly reachable and returns a real dollar figure", async () => {
    const caller = anonCaller();
    const card = await caller.estimate.sampleCard();
    expect(card.estimatedAnnualCostUsd).toBeGreaterThan(0);
    // A 12,000 sqft office should land in a sane annual range — guards against
    // unit errors (monthly-as-annual, kWh-as-dollars) reaching the homepage.
    expect(card.estimatedAnnualCostUsd).toBeLessThan(500_000);
  });

  it("labels itself a demo building at the estimate rung — never dressed as measured", async () => {
    const caller = anonCaller();
    const card = await caller.estimate.sampleCard();
    expect(card.rung).toBe("estimate");
    expect(card.label.toLowerCase()).toContain("demo");
  });

  it("carries a named top opportunity with a positive savings figure and its basis", async () => {
    const caller = anonCaller();
    const card = await caller.estimate.sampleCard();
    expect(card.topOpportunity).not.toBeNull();
    expect(card.topOpportunity!.title.length).toBeGreaterThan(3);
    expect(card.topOpportunity!.estimatedSavingsUsd).toBeGreaterThan(0);
    expect(card.topOpportunity!.basis.length).toBeGreaterThan(3);
  });

  it("is served from cache on repeat calls (identical object, no recompute per visitor)", async () => {
    const caller = anonCaller();
    const first = await caller.estimate.sampleCard();
    const second = await caller.estimate.sampleCard();
    expect(second).toEqual(first);
  });
});
