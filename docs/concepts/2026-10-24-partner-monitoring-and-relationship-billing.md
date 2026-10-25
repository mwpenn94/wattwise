# Meterly concept: partner monitoring and relationship-aware billing

**Status:** Revised concept for owner decision, 2026-10-24; addresses review R5, Part 2, G1–G7. **No implementation or commercial approval is implied.** All new packages, prices, limits, service targets, and notice periods below are explicit proposals for testing, not current entitlements, offers, measured costs, or commitments. All dollar figures are USD.

## Decision summary

Approve a governed partner-service pilot first, not a pricing launch. A contractor should be able to monitor authorized customer portfolios and send useful reports while billing the customer for its own service. The customer should not need a Meterly dashboard account or app navigation to authorize, receive, revoke, or export that service.

Recommend **hybrid platform + site + active-meter capacity**, with allowances pooled within one billing subject, a separate high-volume data band, and explicitly authorized add-ons. Customer ownership, delegated partner access, and the party paying Meterly are separate relationships. One service point must never acquire two capacity charges merely because it appears in multiple files, reports, sites, or partner relationships.

For address insights, retain the **free outbound-links approach** now: official assessor/recorder/GIS portals plus a clearly labeled CountyOffice directory link. Do not scrape, cache, republish, or sell CountyOffice content. Embedded paid enrichment requires a licensed source or a written CountyOffice agreement covering the actual product and redistribution uses.

The immediate decisions are the institutional minimum package, pooling and proration rules, no-login ownership/consent model, partner operating responsibilities, and pilot security gates. Actual prices, wholesale terms, licensed enrichment, and live billing remain gated on measured economics, rights review, reconciliation, and express owner approval (§8).

## 1. Current reality and non-negotiable boundaries

### 1.1 What exists today

The following reflects source inspection on 2026-10-24, not a production billing audit. `server/billing.ts` is the existing plan/entitlement map; `shared/wattwise.ts` supplies additional limits and honesty labels. Public prices are from `client/src/pages/Home.tsx`.

| Existing plan | Public price / commercial framing | Server sites / scenarios per month | Other server entitlements |
|---|---|---|---|
| Free | $0 | 2 / 3 | Site insights; no portfolio or continuous-monitoring entitlement; no concierge onboarding. |
| Plus | $12/month | 10 / 20 | Energy-plan reports, portfolio, continuous-monitoring entitlement; no concierge onboarding. |
| Pro | $29/site/month public card | Unlimited / unlimited | All reports, portfolio, continuous-monitoring entitlement, concierge onboarding. |
| Founding | Full-access beta without a payment method | Unlimited / unlimited | Pro-tier access, all reports, portfolio, continuous-monitoring entitlement, concierge onboarding. |

**Known mismatch:** the Plus marketing card says unlimited scenarios while the server map says 20/month. Resolve this before migration notices; this concept uses the server's 20, not an assumed unlimited grant. The Pro card's unit is not proof of actual per-site collection: the inspected checkout requests quantity 1 for a configured plan price. Do not infer existing invoices from marketing arithmetic.

Shared Free limits also include **12 source uploads/month**, a **$0.20 analysis-cost threshold**, a **$0.50 monthly LLM budget**, and a **50 MiB upload cap**. These are existing constants, not meter prices or evidence that every ingestion path consistently enforces them. The current `users.tier` values are only `free`, `plus`, and `pro`; Founding is a billing-plan designation mapped to Pro access.

`effectiveEntitlement(null)` returns Free. A `past_due` account retains its plan only while `graceEndsAt` is in the future; missing or expired grace falls back to Free. The grace helper adds **seven days**. The resolver does not itself define a complete canceled/unpaid state machine. `stripeConfigured` currently requires an `sk_test_` key and webhook secret; test-mode readiness is not live-billing permission.

A `continuousMonitoring` entitlement is not a utility connector, an operating SLA, or a promise of live data. Current public copy describes findings on upload and utility feeds as roadmap work. Daily arrival checks and scheduled partner reports below are proposed application capabilities.

### 1.2 Ownership hierarchy is not yet a multi-tenant authorization model

Today, `users` are individual login identities with global `user`/`admin` roles. `entities` group owners under `entities.userId`; a `site` has required `userId` and optional `entityId`; a `meter` has required `siteId` and `userId`. Meter roles include `main`, `submeter`, `generation`, `ev`, and `virtual_total`; serial transitions can create new rows. `site_members` extends a root owner's access with facility-manager/read-only membership. `billing_accounts` has one unique `userId` and a Stripe mirror, not an organization-payer allocation graph.

The proposed relationship is **many meters → one canonical site; many sites → one customer owner organization; multiple owner organizations → one or more expressly scoped payer arrangements**. One person can administer several owners. A payer may cover several owners, but payment creates no data rights. Joint owners can appoint one accountable customer organization and authorized representatives; multiple owner names must not duplicate the physical site or meter. Shared-meter allocations across sites are references to one source identity, not copied meters.

Retain `sites.userId`, entity associations, meter IDs, and current direct-owner behavior for legacy records during additive migration. Do not mistake `entities` for an already-isolated tenant or move customer records under a contractor's user ID to implement partner billing. **New no-login customers require a real customer-organization ownership root independent of login users before pilot onboarding.** The current required-user schema cannot by itself deliver that promise: approve an additive tenant-ownership design and its legacy compatibility rules first. A contact is not a fabricated `users` account, shared credential, or partner impersonation mechanism.

### 1.3 Honesty Charter

Reports, emails, partner branding, sales copy, and address-derived analyses must preserve data dates, source provenance, method/model versions, coverage, confidence, and the modeled-estimate disclaimer. **Never promise a point energy-savings figure.** Show a defensible savings range with baseline, tariff, period, weather/operating assumptions, exclusions, and uncertainty basis; if that basis is missing, say the impact is not estimated. Measured consumption and invoice arithmetic are distinct from modeled savings. Price-testing figures below are exact arithmetic under stated assumptions, not savings promises or evidence of willingness to pay.

## 2. Partner monitoring and reporting without customer app navigation

### 2.1 Relationship modes and authority

| Mode | Who pays Meterly? | What the partner may do |
|---|---|---|
| Referral | Customer pays its direct subscription. | Introduce the customer; access only through separate consent. Referral compensation is separate from capacity billing. |
| Reseller | Partner pays agreed wholesale capacity; partner invoices its customer. | Operate only within the delegated scope. Buying capacity does not grant ownership or raw-data access. |
| Managed service | Exactly one elected capacity payer: partner **or** customer. | Monitor, analyze, and report within consent. Customer-paid capacity plus a partner tools subscription is allowed only as separate, disclosed products—not duplicate capacity charges. |

A relationship is a time-bounded delegation. Record customer legal owner, partner organization, authorized approver, covered sites/meters/commodities, permitted actions, recipients/channels, start/end dates, reporting cadence, and elected payer. Uploads, metadata correction, threshold changes, scenarios, raw export, and external sharing are separate capabilities. A partner can propose a change but cannot expand its own grant. Commercial payer changes additionally require the incoming payer's acceptance and the customer's authorization.

Each partner worker uses an individual account. Portfolio views are projections of currently authorized customer scopes, not a common customer-data pool. No identifiable cross-customer comparisons, secondary training, or anonymized aggregate product is implicitly authorized; any such use needs a separate consent/privacy decision.

### 2.2 Concrete no-login customer journey

1. **Proposal:** the partner submits the legal customer owner, covered sites, authorized contact, recovery contact, scope, recipients, cadence, payer, and service terms. The relationship stays pending; it exposes no existing customer data and authorizes no ingestion on that customer's behalf.
2. **Independent approval:** Meterly sends a clearly identified, optionally co-branded email to the customer-controlled address. A proposed 24-hour, one-use invitation opens a purpose-limited consent page; email verification uses a separate short-lived code. No dashboard or general application account is required. A verified signed institutional authorization may instead be reviewed by staff. Email possession alone does not prove authority to bind a university or school: verify the signer's role and procurement authority and retain the evidence and consent version.
3. **Plain-language decision:** show who owns the data, who pays whom, exact data/action scope, recipient list, cadence and freshness limits, retention/export terms, attachment risks, and how to revoke. Obtain affirmative approval; do not treat opening a report as consent. Future scope expansions require renewed customer approval.
4. **Operate:** the partner manages ingestion, exceptions, and standard reports. Customers receive a report/download notice with coverage, unresolved issues, next review date, and a direct “manage recipients / revoke / request export” route. A report link itself cannot authorize governance or billing changes.
5. **Change or revoke:** a fresh email-verified, purpose-limited governance link or verified support process permits recipient changes, export, suspension, or revocation without app navigation. Scope expansions require the same authority check as the initial grant. Keep a customer-controlled recovery contact independent of the partner; contact replacement requires identity/authority verification, not partner approval alone. Suspend risky access while resolving disputed authority.
6. **Offboard:** revoke access/tokens/online links and stop queued jobs and deliveries immediately. Give the customer a standard export or a separately approved transfer to a new partner without re-upload. Access revocation is never contingent on an invoice being paid. Contract cancellation and payer settlement are separate, transparent actions.

### 2.3 Draft monitoring operating contract

Start with application-owned scheduled work and durable delivery records, not personal external automations or an assumed live utility feed. Do not configure a scheduler as part of this concept revision.

| Operating element | Proposed pilot default | Honest boundary |
|---|---|---|
| Arrival and quality checks | Daily metadata/data-arrival check against each source's agreed expected cadence; new material exceptions in a daily roll-up. | A monthly workbook is not missing until its agreed due date; no new data means no new measured consumption finding. |
| Analysis and operator queue | Up to four full-year-equivalent automated scan sets per active meter-month; weekly partner queue. Incremental checks should reuse validated results. | Scan capacity is a pricing assumption, not a benchmark of the current engine. Additional/custom runs require a quote or approved spending rule. |
| Standard customer reporting | One scheduled report per active site/month plus one customer-portfolio summary/month; up to ten approved recipients per customer per run. | Base capacity covers standard generation/delivery, not bespoke analyst narratives, unlimited reruns, or premium report frequency. Meterly-caused corrections/retries are not new paid reports. |
| Human monitoring | The partner assigns an operator. Draft acknowledgment target: one business day for material exceptions; unresolved material items escalate after two business days to the customer-approved contact. | These are proposed partner operating targets, not current capabilities, guaranteed resolution times, emergency response, or 24/7 coverage. Business hours, timezone, and holidays must be in the service agreement. |
| Meterly service work | Base price tests include up to 15 minutes of ordinary setup/technical assistance per payer subject-month, no dedicated human monitoring, manual rate research, or bespoke onboarding. | Additional Meterly labor is separately scoped and accepted. Partner labor belongs in the partner's service invoice, not an assumed Meterly margin. |

For manual monthly uploads, describe the service as **“scheduled review of latest available data.”** A real-time claim requires a functioning connector, documented arrival latency, measured operating capacity, and a separately approved service level.

An exception progresses through `new → assigned → acknowledged → resolved`, with an explicit suppressed/duplicate disposition when appropriate. Record customer/site/service identity, rule/version, data cutoff and coverage, severity/confidence, dedupe key, assigned operator, first/last occurrence, acknowledgment/resolution times, and notes. A proposed 24-hour quiet window suppresses repeated identical notifications while retaining occurrences; new severity or scope is not silently suppressed. Missing data goes to the partner queue, not a fabricated savings or consumption alert. Quality/service notices need their own honest policy rather than inventing a dollar impact to satisfy an existing dollar-first digest gate.

Reports show measured versus modeled quantities, missing-data coverage, applicable savings ranges and basis, unresolved exceptions, actions taken, and the next review date. Explainable rules can cover missing arrivals, quality degradation, anomalies/demand spikes, tariff verification changes, bill mismatches, and implementation-verdict updates. Partners cannot erase the customer-visible audit history.

### 2.4 Delivery, security, corrections, and retention

Default sensitive reports to **email-bound secure download**, not anonymous bearer links or attachments. Proposed online access expiry is 30 days, renewable only while current consent and recipient scope permit it. Optional co-branded/white-label PDFs must retain methodology, confidence, data-date, and modeled-estimate disclosures. Branding never changes authentication or permits impersonation. Attachments require explicit approval and a warning: a delivered email/PDF or downloaded copy cannot be revoked or recalled.

Reauthorize at scheduled execution, artifact lookup, download, export, and immediately before every send/retry. Scope queries, object paths, caches, and job payloads by customer and relationship. A grant remembered when a schedule was created is insufficient. All report access—including the original `report_artifacts` verification-token route—must use one revocable authorization policy. An expiring wrapper must not leave a permanent original URL bypass. Printed/current comparison must not reveal newly out-of-scope data.

Each revision is an immutable snapshot with data cutoff, source revisions, template/model versions, recipient approvals, and branding profile. Corrected data creates a new report revision and a correction notice; do not silently replace the prior PDF. Record delivery outcome, bounce, and retry. Proposed retry policy: at most three transient-failure retries within 24 hours using backoff; permanent bounces go directly to the operator queue. Dedupe by report revision and recipient; no retry may survive revocation. Email delivery is not proof the recipient read the report.

Customer exports include sites, meters, intervals, retained source files, bills, tariffs used, analyses, alerts, and report snapshots, subject to third-party source-license restrictions disclosed before purchase. Partner billing records do not justify retaining customer raw utility data. Propose 24 months of standard raw intervals/source files and issued report retention for price testing, with retention extensions separately approved; this is not a statement of current retention. Institutional records duties may require a different term. Revoked partner copies follow a contractual deletion/retention policy; customer-retained records and backups follow their documented lifecycle, not an impossible instant-deletion claim. Security events and legally required audit records have a separately approved minimal retention policy.

## 3. Billing architecture and deterministic attribution

### 3.1 Options and recommendation

| Option | Advantage | Trade-off / decision |
|---|---|---|
| Site-only with explicit meter/data allowance | Easiest public card and familiar value unit. | Strict non-poolable limits penalize a dense campus and invite site-splitting. Unlimited meters hide service cost. Viable only with published exceptions. |
| Active-meter-only tiers | Simple connection to source workload. | Understates site onboarding/reporting and fixed customer support; small sites and complex multi-owner relationships still cost money. |
| **Hybrid platform + pooled site/meter capacity** | Separates workspace value, physical footprint, and data workload; supports reseller allocation. | More invoice lines and ledger discipline. **Recommended**, with estimates before activation, clear pooling, no automatic add-ons, and spending controls. |

A **billing subject** is the contracted Meterly payer workspace, not an individual login, customer recipient, site, or `entity` row. Charge one base package per subject. A direct subject may include multiple customer owner organizations when payer authority and data isolation are verified. A partner subject uses the wholesale schedule; do not also attach a retail base fee to each sponsored customer unless a distinct, accepted contract requires it.

### 3.2 Billable units and activation

| Unit / edge case | Proposed deterministic rule |
|---|---|
| Site capacity | One enabled canonical physical premise/campus counts once per subject. Aliases, site groups, reports, or building allocations do not create extra sites. Archived or hypothetical sites are not automatically enrolled into paid monitoring. Splitting/merging sites requires an explicit reviewed change and charge preview. |
| Physical active meter | One stable service point or independently monitored physical channel, explicitly activated with a capacity estimate and payer approval. Uploading historical data does not silently start a subscription. Continued enrollment counts even if an expected upload is late: missing-data checks still operate. |
| Main/submeter/generation/EV | Separately ingested and enabled physical channels count once each. Multiple measurements on the same source row, such as usage and demand, do not count as two meters. A distinct submeter feed can count alongside a main; a mathematical allocation of the main cannot. |
| Virtual total / derived channel | Never an additional billable physical meter or accepted source row. Standard aggregation cost belongs in the underlying capacity model. No charge for the same input again because it also feeds a campus total. |
| Serial replacement / regrouping | Continuing service-point identity survives serial changes, file/sheet renames, retries, and site moves. Non-overlapping replacement rows do not create a new permanent slot. Genuinely overlapping separately monitored feeds require explicit extra activation. Ambiguous identity must be resolved before charging. |
| Historical / inactive data | Readable/exportable within agreed retention. Backfill has a separately approved one-time processing allowance or quote, including an explicit zero-price allowance where applicable; it is excluded from recurring new-data row counts. No automatic historical meter-month charges. |
| Telecom | A separate service-record/bill-processing allowance, not electric/gas/water interval meters. No telecom price is approved here; retain legacy handling and require a scoped quote before new paid processing. |
| Operational user | A named human with operational capabilities enabled in that payer workspace, counted once even if serving many customers. Governance-only admins, billing contacts, viewers, and recipients do not consume seats. Logging in is not the meter; enabled capability is. |

**Proration:** new hybrid contracts use UTC calendar-month billing at launch; monitoring/reporting can use each customer's local timezone. Fix the billing timezone for the period. Activation/deactivation and payer changes have exact effective timestamps. An active unit-day is active seconds divided by 86,400; charge the sum of fractional unit-days divided by days in that UTC billing month. Do not round each partial day up. Apply the same rule to extra site and operator capacity. Base packages are monthly commitments; base-plan changes take effect at the next month unless a separately accepted proration quote says otherwise.

For the retail packages in §4, at each instant let `S`, `M`, and `O` be enabled sites, physical meters, and operational users; let `S0`, `M0`, and `O0` be the package inclusions. Extra sites are `max(S − S0, 0)`; included meter capacity is `M0 + 2 × extra sites`; excess meters are `max(M − included meter capacity, 0)`; extra operators are `max(O − O0, 0)`. Integrate each excess quantity over the billing month under the proration rule. This prevents unused capacity at one time being retroactively applied to another time and keeps dense-campus pooling consistent. Preview a site's deactivation if losing its included meter slots would affect the remaining portfolio.

### 3.3 Payer allocation and usage ledger

Each enabled canonical site and service identity has **exactly one effective Meterly capacity payer allocation at an instant**. Meter allocations follow the canonical site's payer in the initial pilot; splitting one site's meters among several payers is deferred. Different sites of the same owner may have different payers. References to a shared meter do not create new allocations or entitlement rights. If multiple parties share costs, the elected payer settles that allocation externally rather than Meterly duplicating the physical usage.

A referral plus a managed-service grant does not create two charges. A payer change atomically closes the old allocation and opens the accepted new one at the same timestamp; pre-transfer usage remains with the prior payer. It neither transfers ownership nor broadens access. An unaccepted incoming payer, conflicting allocations, or missing consent blocks new paid work and raises an exception—never a guessed bill to the customer. On partner revocation, immediately stop its delegated work; continue customer-direct work only if separately authorized. Meterly must not silently make a no-login customer the replacement payer.

The invariant is: **allocated active service time equals physical active service time, never more**, including mid-month transfers. Recompute each subject's own excess after transfer against its accepted package; do not transfer unused package allowances between payers or charge two full months for one transferred meter.

Usage events carry stable event ID, service/site identity, customer owner, payer subject, relationship if relevant, unit, quantity, occurrence time, plan/price version, and source revision. Ingestion/import/provider retries are idempotent. Accepted source rows are unique logical readings for a service/channel, UTC interval timestamp and duration; usage and demand stored together are one row. A duplicate import or correction of the same logical reading does not create a second accepted-row unit. Retain provenance for revisions and rectify mistaken identity merges/splits by explicit adjustments. Scans, derived totals, and retries consume internal cost telemetry, not new accepted-source-row charges.

Recurring row allowance is **3,000 × prorated physical active meter-months**, pooled within the subject; include only those enrolled meters' new-data ingestion, not historical backfill. Attribute a newly accepted reading to the effective payer when processing is authorized/accepted, not retroactively to the date represented in the file. Late uploads and backfills must show their treatment before approval. A payer transfer never recharges previously accepted readings.

Proposed row excess is **$1.50 × excess unique accepted rows / 10,000**, pro rata, not rounded-up blocks; round only final invoice currency line totals to cents. This is a placeholder with the normal 15-minute workload assumption, not a charge for every database read or channel column.

Corrections use append-only reversals/adjustments linked to the original event; closed invoices are not silently edited. Provide customer-attributed quantities, price versions, transfer timestamps, and a draft **30-day dispute window**, subject to contract and statutory rights. A partner gets its wholesale breakdown; a customer gets its own data/capacity reconciliation, not other customers' data or the partner's confidential margin.

Show forecasts and notices at 80% and 100% of each included allowance, and of the approved spend cap. Default unapproved add-on spend is zero. Excess capacity requires a confirmed change or a preapproved ceiling; reserve quoted work before launching a costly job. Pause/queue new discretionary work at the cap, not delete data. Notify the partner and customer of any service suspension through an approved operational channel; do not silently suppress previously identified material issues. This is not a safety-critical monitoring product.

## 4. Price tests and cost-to-serve sensitivity

### 4.1 Explicit placeholder package assumptions

These are **new concept packages**, not aliases for current Free/Founding/Plus/Pro. All figures assume one full UTC billing month, standard 15-minute data, pooled capacity within one subject, §2's standard reporting/service limits, and §3's deduplication rules. Exclude tax, payment processing, custom onboarding, premium human monitoring, paid enrichment, OCR/model add-ons, connectors, API/egress overages, and extended retention. None is automatically purchased.

| Price-test package | Monthly base | Included sites / physical meters / operational users | Draft eligibility |
|---|---:|---|---|
| Home | $25 | 1 / 2 / 2 | Qualifying residential customers only; not schools, universities, or other institutions. |
| Business | $79 | 3 / 6 / 2 | Minimum institutional/business package, including a one-site school. |
| Portfolio | $199 | 10 / 20 / 5 | Multi-site or multi-owner portfolios with verified payer authority. |

Additional site capacity is **$11/site-month and adds two pooled physical-meter slots**; excess physical meters are **$4/meter-month**; extra operational users are **$15/seat-month**. The operator assumption prices enabled capability above inclusion, not each customer served. Standard source rows and excess follow §3. Billing admins and report recipients are not operator seats. Licensed enrichment, custom work, and API/export beyond agreed standard export remain quote-only, with zero unapproved spending.

**Pooling is subject-wide, not two meters attached to each address.** Included unused site slots still carry the package's meter pool. A dense campus consumes that pool but is not charged a second time for exceeding two meters at that campus. Capacity is not pooled across independent direct subscriptions.

### 4.2 Worked invoices under those assumptions

| Case | Full-month calculation | Illustrative result |
|---|---|---:|
| Home: 1 site / 2 meters / up to 2 operators | Fits Home. | **$25/month** |
| Business: 3 sites / 5 meters / up to 2 operators | Fits Business. | **$79/month** |
| University/school: **1 site / 10 meters** / up to 2 operators | Business minimum; its six meter slots are pooled even with only one occupied site slot: $79 + (10 − 6) × $4. | **$95/month** |
| KUSD: **18 campuses / 38 meters** / up to 5 operators | Portfolio + eight sites: 20 + 8 × 2 = 36 included meter slots; $199 + 8 × $11 + (38 − 36) × $4. | **$295/month** |
| Partner: 12 sponsored customers, each averaging 3 sites / 5 meters; 2 partner operators total | Wholesale example in §4.3: $299 + 12 × $25. | **$599/month** to Meterly; not the end-customer invoice. |

For the exact institutional example, one Business site with two meters remains $79; ten meters cost $16 more under this pooled package, although physical-meter workload is roughly five times that of two meters. If Home were offered to the institution, the arithmetic would instead be $25 + (10 − 2) × $4 = **$57/month**. The recommendation is to disallow that eligibility, explicitly—not let the institution infer a package from site count alone.

The apparent current Pro marketing comparison is **$29/month for either one-site institution**, or **18 × $29 = $522/month for KUSD**. Neither is a verified collected invoice or a quote; the comparison reveals the unit mismatch, not an economically justified discount. At KUSD's eight-agreement campus, eight source identities consume the common meter pool; there is no additional campus-local six-meter surcharge on top of the district's two pooled excess meters.

### 4.3 Wholesale example contract, not an approved discount

The proposed **$299 partner platform/month** includes two partner operators **total**, not two per customer. Each **$25/customer-month sponsored bundle** adds three pooled sites and five pooled physical meters, the standard per-active-meter row allowance, and §2's standard customer reporting. Twelve active bundles therefore supply 36 sites and 60 physical meters across the subject, with attribution and isolation still enforced per customer. Bundle activations use fractional-day proration; the partner base is a monthly commitment.

For a complete test schedule, propose wholesale excess at the same placeholder rates—$11 per additional site-month adding two meter slots, $4 per excess meter-month, $15 per additional partner operator-month, and pro-rata $1.50/10,000 excess source rows. Apply §3's formula with included sites/meters supplied by the active customer bundles, not a retail base. Do not stack a $79 Business subscription onto these sponsored customers. A direct-paying managed-service customer is not a sponsored bundle and uses its direct capacity contract instead.

Twelve separate $79 Business packages would total **$948/month**; $599 is a **36.81% illustrative price reduction**, not a cost-justified margin or energy-savings claim. The packages are not identical: wholesale offers two shared operators and five meters per customer bundle versus retail's two operators and six meters per Business package. The partner sets its own end-customer service fee, tax treatment, payment processing, and margin. Propose Meterly as merchant of record for its partner software contract and the partner for its customer services; finance/legal must confirm procurement and contractual treatment before sale.

### 4.4 Physical workload: what the ten-meter site actually changes

**Sizing arithmetic, not observed infrastructure costs.** Assume one logical reading every 15 minutes, 365 days/year, no gaps, and one source channel per enrolled meter. One meter produces 96 readings/day, **35,040/year**, **2,920/month on annual average**, and **2,976 in a 31-day month**. Usage and demand on one row count once.

| Physical meters | Source readings/year | Average month | 31-day month | Logical payload at assumed 150 bytes/row, one year | Four full-year scans/month |
|---:|---:|---:|---:|---:|---:|
| 1 | 35,040 | 2,920 | 2,976 | 5.256 MB | 140,160 row visits |
| 10 | 350,400 | 29,200 | 29,760 | 52.560 MB | 1,401,600 row visits |
| 38 (KUSD) | 1,331,520 | 110,960 | 113,088 | 199.728 MB | 5,326,080 row visits |

The real KUSD workload is **two workbooks, 38 service agreements/meters, 18 campuses, and eight agreements at one campus**. Files are transport/source objects, not meter or site billing units. A complete year would yield the counts above; this is not a claim that the supplied workbooks contain a complete year. KUSD's proposed allowance is 38 × 3,000 = **114,000 rows/month**, enough for its **113,088** readings in a 31-day month at standard resolution. Ten meters similarly receive 30,000 rows/month, above 29,760. Higher-frequency or extra independent feeds require a different estimate.

The 150-byte figure is an assumption using decimal MB, not a measurement of this database; exclude indexes, replicas, backups, raw workbooks, PDFs, and caches. Four scans are a sizing scenario, not an observed query plan. Ten meters can mean ten source validations, service-agreement checks, bill reconciliations, and exception checks. One campus report may still render once, and identical tariff lookups may be reused. Costs have shared and variable components; neither exactly linear per meter nor flat per site is a defensible assumption without telemetry.

### 4.5 COGS worksheet and sensitivity

Use this worksheet per payer/month, retaining customer attribution:

`COGS = allocated platform/site cost + ingest/validation compute + database storage/scans + connector/API fees + OCR/model cost + reports/email/egress + human minutes × loaded hourly cost / 60 + amortized onboarding.`

**Human-service sensitivity only—not observed staffing or a vendor quote:** assume Meterly itself performs the service, loaded labor costs **$60/hour**, onboarding takes **20 minutes/meter**, and onboarding is amortized over **12 months**. If the partner performs the labor, that portion is the partner's economics instead. The table deliberately excludes infrastructure, shared technical assistance, tax/processing, and other overhead; residual is **not profit or gross margin**.

| Case / hypothetical monthly capacity revenue | Low-touch: 2 minutes/meter/month | Mid-touch: 5 minutes | High-touch: 10 minutes | One-time onboarding / monthly amortization | Revenue remaining after labor + amortization, low / mid / high |
|---|---:|---:|---:|---:|---:|
| 10 meters / $95 | $20 | $50 | $100 | $200 / $16.67 | $58.33 / $28.33 / **−$21.67** |
| 38 meters / $295 | $76 | $190 | $380 | $760 / $63.33 | $155.67 / $41.67 / **−$148.33** |

Thus $95 or $295 cannot honestly include unlimited human monitoring. High-touch labor alone exceeds these prices before hosting or support. Keep dedicated monitoring/onboarding separately scoped and priced, cap included work, and measure median and upper-percentile costs before setting margins. Do not invent cloud/API coefficients or portray placeholders as market prices.

Collect three to six months of telemetry per customer, payer, commodity, source, and meter-month: unique source rows and resolution; stored bytes and retention; actual rows scanned/CPU; parsing failures and manual intervention; analysis runs/queue time; OCR pages/model tokens/provider charges; connector costs; territories/rates and verification minutes; report/email/link/API/egress volumes; support and onboarding minutes. Include reused tariff work and derived totals so exclusions from customer invoices do not hide real COGS. Finance must approve a measured margin target and stress-case ceiling before pricing goes live.

## 5. Permissions and billing for every persona

All permissions require an authenticated identity or purpose-limited verified contact, current customer scope, and the relevant capability. Paying or holding a global application-admin flag is not partner consent. Governance and operational capabilities may be held by the same person, but each action is checked independently.

| Persona | Allowed within approved scope | Explicit restrictions | Draft Meterly billing |
|---|---|---|---|
| Customer owner/admin | Grant/revoke relationships; approve recipients and exports; manage customer governance. | Cannot bind a different payer without that payer's acceptance. | Governance-only is seat-free; enabling uploads/analysis consumes one operator slot, not a second identity fee. Customer capacity only if the elected payer. |
| Billing administrator/contact | Invoices, budgets, payment details, accepted payer changes. | No raw utility data, report access, or consent authority from billing role alone. | Seat-free unless separately granted operational capability. |
| Facility manager | Scoped uploads, site facts, monitoring rules, actions and acknowledgments permitted by the owner. | No consent expansion, payer changes, or raw export/external sharing by default. | One operator slot; included 2 in Home/Business, 5 in Portfolio; $15/month only above inclusion under §4 assumptions. |
| Customer analyst | Approved analysis/scenarios and practitioner work. | Export/sharing require separate high-risk capabilities; no payer or consent control. | One operator slot on the same schedule. |
| Read-only stakeholder | Approved site views/reports. | No mutation, raw export, recipient changes, or operational acknowledgment. | No seat charge; approved report-recipient limits still apply. |
| Partner account lead | Propose relationship/recipient changes; administer its own staff within existing customer-approved roles and scope. | Cannot approve its own scope expansion or grant new customer data rights. | Governance-only is free; operational powers consume one partner operator slot. |
| Partner operator | Ingest/repair approved source data; configure approved rules; triage assigned exceptions. | Cannot change customer owner, payer, consent, or recipient scope. | One operator slot per payer workspace, not per customer served. |
| Partner analyst | Approved scenarios, analysis, and report preparation. | No scope/payer changes; raw export/external send need explicit capabilities. | Same operator-slot rule; one human with both analyst/operator roles counts once. |
| Partner viewer | Read only the customer projections granted to it. | No export, sends, acknowledgments, or rule changes. | No operator seat charge. |
| Referral partner | Introduction and separately consented read access. | No automatic operating tools or client-data access. | No Meterly capacity fee merely for referring; optional tools require a separate accepted subscription. |
| Reseller / partner-paid managed service | Scoped service delivery under the partner contract. | Never owns customer data merely by paying. | Partner pays wholesale base, sponsored capacity, and approved extras; no duplicate Meterly capacity invoice to customer. |
| Customer-paid managed service | Partner service delivery under delegation; customer retains direct capacity subscription. | Partner tools fee cannot re-bill the customer's physical capacity. | Customer pays direct capacity; partner pays only any separately contracted operator/tools offering. |
| Customer-of-partner, no login | Approved reports plus verified consent/revocation/export routes. | A report recipient is not automatically a customer administrator. | No phantom user, seat fee, or default Meterly invoice. Partner invoices its own service. |
| API/service account | Independently scoped ingestion/export credentials sponsored by an authorized operator. | No consent/payer changes, interactive human use, or credential-based bypass of grants and spending controls. | No human seat; declared usage within an accepted API/egress schedule. Above approved allowance, queue/quote rather than invent a price. |
| Meterly support/admin | Time-limited, audited support access under approved policy. | Not a global partner role or substitute for customer consent. | Not a customer operator seat; exceptional service work follows the accepted support scope. |

Additional-operator proration follows §3. Users count once per payer workspace; if enabled in two independent payer workspaces, each workspace explicitly provisions its own slot. Pure viewers and no-login recipients stay seat-free, but delivery/abuse limits do not become unlimited paid send capacity.

## 6. Per-address public-record insights: free first, licensed enrichment later

### 6.1 Current capability and legal boundary

`server/propertyRecords.ts` currently provides **outbound links**, including Mohave County assessor parcel search, recorder, and GIS/open-data portals, plus a CountyOffice county-directory link. Other counties may have only the directory fallback. This is not a nationwide official-portal catalog, automatic parcel match, verified ownership lookup, or embedded property dataset. There is no CountyOffice scraping or content caching in this feature.

CountyOffice's [Terms and Conditions](https://www.countyoffice.org/terms-and-conditions/), **updated October 14, 2026 and reviewed October 24, 2026**, establish the relevant restrictions:

- **§5.2(3):** no use of content to build, train, or enhance a competing database, product, or service.
- **§5.2(4):** no copying/publishing/resale/redistribution except as expressly allowed by §8.
- **§5.2(5):** no automated access, extraction, or indexing without express written permission. Its robots-compliant search-engine/AI-assistant carve-out is **not** a license to build Meterly's property database or redistribute content.
- **§8.2:** limited, non-transferable access for personal/internal business purposes.
- **§8.3:** purchased reports may be shared internally for internal use, but resale, redistribution, publication, or commercial exploitation of reports/underlying data requires express written agreement.

A free directory visit, consumer subscription, report purchase, or the fact that underlying records are public **does not establish permission for Meterly to ingest content or deliver it to partner customers**. Do not treat a paid CountyOffice subscription as an API/redistribution license, or invite uploads of its purchased reports as a workaround. Public access is not blanket reuse permission. Final use rights require legal/commercial review; no vendor agreement is assumed here.

### 6.2 Options and recommendation

| Option | Permitted product direction, subject to source terms | Economics and recommendation |
|---|---|---|
| **Free/public outbound assistance** | Show clearly labeled official portal links and optional third-party directory link; users visit those sites at their own request. Explain what to verify: parcel/APN, building area/year/use, or relevant recorded facts. | **Launch now within existing capability.** No Meterly enrichment surcharge or representation that third-party reports are free. No proxying, extraction, cache, or republication. |
| Direct official open data | Future opt-in ingestion only where the particular county/dataset's license permits the contemplated commercial use, storage, transformation, and customer reports. | Potentially low acquisition cost but nonzero engineering, coverage, update, matching, and support cost. Require a dataset-by-dataset rights/coverage register; an official website alone is not permission. |
| Licensed embedded enrichment | A contracted property-data source, or a written CountyOffice agreement explicitly permitting Meterly's intended automated acquisition, storage, derivatives, and partner/customer delivery. | **Potential paid plan/add-on after rights and economics validation.** No provider, price, nationwide coverage, or redistribution right is represented as verified here. A consumer plan is not this option. |

Use the free path as **“public-record research links for this address/county,”** not “CountyOffice-verified insights.” Where the address or county is ambiguous, ask for confirmation and show missing coverage rather than invent a parcel match. The customer/partner may enter independently known facts or lawfully obtained official-source facts, retaining provenance and permissible-use confirmation; do not copy CountyOffice content into Meterly via manual transcription as a product workaround.

### 6.3 Proposed paid-enrichment contract and safeguards

Before embedding any data, secure explicit rights for address/parcel lookup, commercial utility-analysis use, caching and retention, derived features, report snippets, co-branding/white-label delivery, exports, partner/reseller use, and post-termination treatment. Confirm whether model processing/training is allowed; default training and unrelated reuse to off. Review minimum commitments, lookup/refresh charges, coverage, update frequency, source attribution, rate limits, support, privacy/security, and deletion obligations. If a license forbids exporting raw fields, disclose that exception to the standard export promise before purchase.

Store only approved fields needed for the use case, with source URL/provider record ID, license/version, retrieval/effective dates, address/parcel match confidence, and user corrections. Propose initial fields such as building area, year built, and property/use classification when available and licensed. Ownership/address records do not prove occupancy, customer authority, operating hours, current building condition, or utility consumption. Do not use this feature for prohibited individual eligibility decisions or unnecessary personal-data profiling. No source-derived fact silently overrides a customer-confirmed building fact; present conflicts for review.

Use address facts to improve disclosed modeling assumptions, not to assert measured consumption or guaranteed savings. Include source age, match uncertainty, missing fields, and the basis for any modeled savings range. If licensed lookup fails, fall back to the free links and clear “not verified” status—not invented enrichment.

**Billing proposal:** an explicit per-subject enrichment allowance and per-successful-address refresh/add-on quote, independent of physical meter count. Ten meters sharing one confirmed parcel should not trigger ten identical lookups. Define the address/parcel, source/version, requested field set, and refresh window as the idempotency key. Do not charge a customer again for provider retries, failed/no-match lookups, or the same authorized cached result. Provider retry costs still belong in internal telemetry. Licensed caching and cross-customer reuse are allowed only if the contract and tenant privacy boundaries permit them; default to customer-isolated reuse.

Do not publish a dollar add-on yet: vendor costs and rights are unknown. Show the accepted lookup/refresh price and cap before purchase; no charge from merely displaying a research link. The paid launch gate is a signed rights matrix, measured matched-address cost and accuracy/coverage, customer-visible provenance, and a tested failure/refund policy. Keep outbound free assistance even if paid enrichment is declined.

## 7. Additive data model and explicit migration policy

### 7.1 Implementation seams, not changes made by this document

| Existing construct | Preserve | Required additive concept / gate |
|---|---|---|
| `users`, `entities`, `sites`, `meters` | Individual identities, legacy root ownership and IDs, optional entity grouping, physical/derived meter distinctions and provenance. | Customer/partner organization membership; independently valid customer tenant root for no-login ownership; canonical service identity and effective-dated allocations. Review required-user compatibility before new no-login onboarding. |
| `site_members` | Existing customer facility-manager/read-only semantics. | Relationship-scoped capability grants rather than a global partner-admin override. |
| `report_artifacts` | Analytical snapshot and printed/current comparison as the report truth. | Immutable report revisions, schedules, recipient approvals, deliveries, branding and shared revocable access covering the existing token route. |
| `plan_baskets` | Creator/site provenance and measure selections. | Explicit authorized sharing/attribution, not a new source of customer ownership. |
| `billing_accounts` | User-level plan/status/Stripe mirror during migration. | Versioned billing subjects and payer allocations; one authoritative entitlement resolver chosen per account, no competing user-tier/partner gates. |
| `billing_webhook_events`, `billing_audit` | Persisted webhook IDs and commercial audit evidence. | Reconciliation, append-only usage corrections and retry/out-of-order tests; existing tables alone do not prove exactly-once end-to-end billing. |
| Public-record links | Outbound-only behavior and official/directory labels. | Optional field provenance/rights register only if licensed enrichment is later approved. |

Candidate additions include `tenant_memberships`, `partner_customer_relationships`, `delegated_site_grants`, `consent_events`, `customer_contacts`, `report_schedules`, `report_deliveries`, `report_share_links`, `access_audit_events`, `service_accounts`, `billing_subjects`, effective-dated payer allocations, and `usage_ledger`. Names are illustrative; authorization, stable identity, revocation, and auditability are the requirements. Add separate access auditing for actor, acting organization, customer, relationship, scope, timestamp, action/outcome, and redacted metadata. Do not put account numbers, raw intervals, or report contents into ordinary logs.

### 7.2 Legacy transition: no automatic price change

1. **Inventory and reconcile.** Identify each billing account, explicit Founding grant, legal customer owner, payer, sites, physical/derived meters, enabled roles, historical usage, and contract term. Initially map one new billing subject to each existing payer user. Flag orphaned/mismatched `userId`/`entityId` relationships and ambiguous service identities for review. Do not infer unlimited rights from a stale `users.tier`, nor silently turn a missing account into paid service. Preserve verified legacy grants explicitly.
2. **Keep existing entitlements during pilot.** Free remains 2 sites/3 scenarios/12 source uploads monthly; Plus retains the server's 10 sites/20 scenarios; Pro retains its unlimited site/scenario entitlements; Founding keeps full-access, no-charge beta treatment. The pilot's telemetry does not create new meter limits or bills for these users. Reconcile the Plus marketing mismatch separately before notices.
3. **Protect Founding and contracts.** No automatic paid conversion, payment-method requirement, or expiry date for Founding is introduced here. Any end policy requires a separately approved, expressly communicated offer and acceptance. Honor fixed-term/annual agreements until renewal unless an amendment is accepted. Pro's public $29/site unit does not establish a collected legacy amount; use actual account/contract terms in comparisons.
4. **Shadow before collection.** Run at least two complete billing cycles of hybrid shadow invoices alongside actual legacy invoice previews, with no collection. Reconcile sites, physical meter-time, excluded virtual totals, unique rows, time-varying pooled allowances, operator seats, customer/payer attribution, transfers, retries, credits, taxes, and test Stripe events. Include the ten-meter institution, KUSD, multi-owner payer, and partner-transfer cases.
5. **Offer opt-in migration.** Proposed policy: at least 60 days' notice showing old/new line items, assumptions, price increases, grant changes, and a spending ceiling; explicit migration acceptance by authorized customer and payer. These are policy proposals subject to contracts/public procurement, not statements of current legal obligations. Existing dense campuses/backfills are inventoried, not retrospectively charged. Declining customers keep agreed legacy terms; any later sunset requires its own approved policy.
6. **No data hostage at limits.** Historical data stays readable/exportable under the agreed retention contract. For opted-in accounts that exceed approved new capacity, block new paid activations/discretionary expensive work or seek approval—not delete sites/meters, re-bill old imports, or silently switch a partner's customer to direct payment. Standard no-login governance/export must remain available.
7. **Past due is not consent revocation.** Preserve current seven-day grace behavior until an approved replacement. Proposed partner-service policy: maintain already-authorized standard service during valid grace without adding unapproved discretionary spend; notify billing and operational contacts. After grace expires, Free entitlement applies, new paid analyses/reports pause, and affected recipients receive a service-status notice. Keep existing artifacts/exports within their agreed access/retention scope and preserve recorded material issues. Resume only on restored entitlement and current consent. Validate canceled/unpaid and retry/out-of-order behavior explicitly; do not assume the resolver covers it. Obtain agreement on this operating policy before a paid partner pilot.
8. **Reversible rollout.** Use a versioned per-account policy/feature flag and reversible subject mapping. Rollback stops new usage submission, retains the immutable ledger and evidence, reconciles/credits any already-invoiced amounts, and restores the accepted legacy gates without losing customer data. Explicitly test that rollback does not resurrect revoked grants or links.

### 7.3 Phased delivery and exit criteria

**Phase 0 — policy and telemetry:** approve the draft ownership/payer/usage definitions; instrument cost/usage without charging; inventory legacy grants and contracts; keep public-record assistance outbound only. Do not offer a no-login customer tenant before the ownership-root design is approved.

**Phase 1 — governed partner pilot:** add the approved customer/partner ownership and delegation model, contacts, consent, worker identity, scoped credentials, recovery, and auditing. Start with a small manually approved managed-service cohort; partner staff perform triage. Exit only when customer authorization, export, and revocation work without dashboard navigation and customer data is not owned by the partner user.

**Phase 2 — reporting operations:** deliver scoped immutable snapshots with schedules, recipient approval, branding, retry queues, original-token revocation, and offboarding. Prove cross-customer API/object/link/job denial, revocation during an in-flight job and before send, retry dedupe, correction notices, export, and partner removal. Confirm sender-domain verification, reply-to ownership, accessible/tagged PDFs, institutional records duties, and deliverability responsibilities before white-label launch.

**Phase 3 — commercial rehearsal, then separate approval:** generate the shadow cycles, reconcile the authoritative ledger to test invoice previews, rehearse credits/disputes/transfers/rollback, and run Stripe test mode only. Owners approve pricing, margin thresholds, merchant-of-record/tax/procurement, migration notices, and past-due behavior. Live collection requires separate explicit approval and live readiness work; removing a test-only guard is not approval. Licensed address enrichment has its own independent rights/economics gate and need not delay the free-links pilot.

## 8. Owner decisions and launch gates

The recommendations below are concrete defaults for decision, not settled business policy. Assign named individuals to these accountable roles before a pilot; unresolved safety/rights gates block launch rather than relying on optimistic defaults.

| Accountable decision owner | Open question / proposed decision | Gate and evidence |
|---|---|---|
| Product + business owner | Approve Business as institutional minimum, subject-wide pooling, UTC fractional-day billing, explicit activation, and no recurring charge for virtual totals or historical-only meters? | Before price testing: ten-meter and KUSD examples reconcile; source identity, retirement, transfer, and site regrouping examples produce no duplicate capacity. |
| Product + customer-success lead | Start managed-service first; accept §2's report cadence, operator target, recipient limit, and bounded included Meterly assistance? Who does each human task? | Before pilot: signed operating agreement, source-specific expected arrival cadence, partner queue/escalation ownership, no unsupported live/24-hour claims. |
| Engineering + security lead | Approve independent customer tenant root with legacy user-owned compatibility; no phantom accounts? | Before no-login onboarding: scoped APIs/storage/jobs/links deny cross-customer access; recovery and revocation work; no original-token bypass or partner-owned customer bootstrap. |
| Customer and partner authorized representatives | Who can consent for each institution? Which recipients/channels, export rights, retention, and branding are authorized? | Before each onboarding: verified authority and evidence, independent recovery contact, practical no-login revoke/export test; attachment irrevocability acknowledged. |
| Finance + commercial owner | Accept or replace placeholder prices, wholesale bundle ratios/overages, spend caps, dispute/rounding rules, merchant-of-record proposal, and margin targets? | Before paid launch: three to six months of cost telemetry or an explicitly approved limited experiment budget; stress-case labor is priced/capped; customer-attributed quantities reconcile. |
| Billing owner | Approve Founding continuation/end policy, 60-day opt-in notice proposal, fixed-term protection, grace-end reporting behavior, and rollback? | Before migration: two reconciled shadow cycles, no retroactive meter charges, approved notices, state-transition/credit/rollback rehearsal, no live collection without express authorization. |
| Legal/privacy + data partnerships owner | Keep CountyOffice outbound-only; pursue direct official data or a written commercial data agreement later? What fields and downstream uses are allowed? | Before any embedded enrichment: signed rights/retention/redistribution matrix, coverage/match validation, provenance and correction controls, lookup price/cap disclosure. A consumer paid subscription is not sufficient. |
| Customer-success + security/compliance leads | Which retention, data residency, sender-domain, accessibility, procurement, and institutional public-record obligations apply? | Before broader rollout: approved operating policies, tested delivery/offboarding/export, accessible report samples, and a documented incident/support route. |

**Recommended decision now:** approve the governed no-login partner-service direction, the hybrid billing contract for shadow testing, and continued free outbound address assistance. Defer public price replacement, automatic meter charging, live billing, and embedded CountyOffice-derived insights until their explicit gates pass. The sequence is: establish customer authority, prove useful delivery, measure costs, then price—without overstating automation, property-data rights, or savings.

## Source notes

Repository references are relative to the Meterly project root and were inspected for this revision: `server/billing.ts`; `server/stripeBilling.ts`; `shared/wattwise.ts`; `drizzle/schema.ts` (`users`, `entities`, `sites`, `meters`, `site_members`, `report_artifacts`, billing tables); `client/src/pages/Home.tsx`; and `server/propertyRecords.ts`. Review basis: `/home/ubuntu/work/reviews/R5_bulk_and_concepts.md`, Part 2, G1–G7. The KUSD workload is owner-supplied and corroborated by that review; full-year row counts and all hypothetical price/labor calculations are arithmetic, not measured COGS. External rights source: [CountyOffice Terms and Conditions, updated 2026-10-14](https://www.countyoffice.org/terms-and-conditions/), especially §§3.2–3.3, 5.1–5.2, and 8.2–8.3, accessed 2026-10-24. No specific licensed data provider or vendor quote is asserted.
