# Lane Q — §8.7 Quote, rung-5 reachability (map #995, section ticket #1012)

Rows driven end-to-end through the persona's real surface at real Postgres:
**7.1, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.10, 7.12.** Row 7.6 was already at
target (PR #1087) and its spec is the pattern every file here copies.
Rows **7.2** and **7.11** are report-only (below). Evidence only — rungs are
Fable's.

## Row → spec

| Row | Spec | Persona surface | Tenant leg |
|---|---|---|---|
| 7.1 + 7.3 | `e2e/journeys/estimate-chat-draft-7-1-7-3.spec.ts` | owner browser `/assistant` → real `POST /api/assistant/chat` → `EstimateTaskHandler` → Approve → real `estimates` row + `estimate.created`; per-line `pricingSource` badge; raw-UPDATE DB CHECK probe | T2 |
| 7.4 + 7.5 | `e2e/journeys/estimate-tiers-addons-7-4-7-5.spec.ts` | owner browser `/estimates/new` (real good/better/best authoring form) → public `/e/:token` first-render headline → customer picks Premium+add-on, signs → owner `/estimates/:id` | T2 |
| 7.7 | `e2e/journeys/estimate-stale-revision-approve-7-7.spec.ts` | public `/e/:token` open → owner revises mid-session → stale accept refused (409 + banner) → reload → current accept | T1 (same scenario, both tenants) |
| 7.8 | `e2e/journeys/estimate-concurrent-approval-race-7-8.spec.ts` | two `POST /public/estimates/:token/approve` at the same instant on one job; winner's public page | T2 (both tenants race concurrently) |
| 7.9 | `e2e/journeys/estimate-deposit-gate-7-9.spec.ts` | real `PUT /api/settings` deposit rule → public page gate + capped amount → `after_approval` accept → signed `checkout.session.completed` (deposit_for_job_id) | T3 (fixed/before vs percentage/after) |
| 7.10 | `e2e/journeys/estimate-nudge-sweep-7-10.spec.ts` | the PRODUCTION `runEstimateReminderSweep` (app.ts:6448-6465 interval body) against the webServer's own Postgres, digest-toggle.spec.ts pattern; two concurrent sweeps race one estimate | T4 fan-out (silent tenant A nudged; tenant B skipped because its customer had opened the quote in the real public page — `firstViewedAt`) |
| 7.12 | `e2e/journeys/negotiation-sms-guardrail-7-12.spec.ts` | real signed `POST /webhooks/twilio/sms/:tenantId` discount ask → `callback` proposal in `draft` + `negotiation_guardrail.sms_routed`; owner browser `/inbox`; tenant B opts in via the real Discount-policy sheet | T1·T3 |

Shared bootstrap: `e2e/fixtures/estimate-quote-lane.ts` — owner via the real
Clerk `user.created` webhook + HMAC session, every customer/location/job/
estimate/send through the real authenticated API. No SQL writes to reach a
product state; no platform-admin routes; no `E2E_DEV_AUTH=1`; project
`chromium` only. The one direct write is an UPDATE of two columns on `tenant_integrations`
(7.12): the product's own dev provisioning worker
(workers/provision-twilio.ts:148-166) already gives every new tenant a stub
twilio row (DID `+15005550006`, `stub: true`) but, having no Twilio
account, leaves `subaccount_sid` / `auth_token_primary_enc` empty — and the
signed-webhook route verifies against exactly those two. The spec fills
them on the product's row (run 1's INSERT collided with the product's own
row on `tenant_integrations_tenant_id_provider_key`), the same
justification the merged §8.3/§8.4 phone lanes document, narrowed.

Tenant-isolation method: cross-tenant INVISIBILITY is proven through the
real API (the other owner's `GET` → 404), and every direct Postgres read
is scoped by `tenant_id = $n` exactly as the repositories scope. A direct
read "as" the other tenant (`SET LOCAL app.current_tenant_id`) proves
nothing under this harness — its connection is the testcontainer superuser,
which bypasses RLS even under `FORCE ROW LEVEL SECURITY`
(schema.ts:545-548); the `SET ROLE rls_app_runtime` path only runs with
`RLS_RUNTIME_ROLE=true`, i.e. the vitest-integration recipe. (7.1/7.3
run 3 read tenant A's estimate "as" tenant B that way; the probe was
moved to the API and the 7.12 cross-reads re-scoped.)

## Invocation (every spec, its own Playwright process, under the test lock)

```
DBU=$(TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts | grep -oE 'postgres://[^ ]+' | tail -1)
PORT=38610 E2E_API_URL=http://localhost:38610 PUBLIC_API_URL=http://localhost:38610 \
E2E_WEB_PORT=38611 VITE_API_URL=http://localhost:38610 E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0 E2E_WEBSERVER_TIMEOUT_MS=300000 \
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
TENANT_ENCRYPTION_KEY=<64 hex> \
npx playwright test <spec> --project=chromium --retries=0 --workers=1
```

The lane was assigned api port 38510; it ran on **38610/38611** because a
second lane-Q session in this same worktree booted stacks on 38510 (a vite
that never came up on 38511 timed the third tiers run out) and later on
38520 (`FATAL EADDRINUSE :::38520` mid-way through 7.9 run 3: my requests
were answered by a peer api on a different database while my direct reads
went to mine — 0 rows — and the pin test got "socket hang up"). The
dedicated-port rule exists precisely so two Playwright stacks never adopt
each other's servers; the pair moved twice for that reason, never for the
specs.

`E2E_WEBSERVER_TIMEOUT_MS` is also new (additive, unset ⇒ the old 120s): with
three lanes' ts-node apis cold-booting on one Mac, the api's compile alone
overran Playwright's 120s webServer window (the log stops at ".env not
found" with no `[startup]` line) — a harness limit, not a product one.

`E2E_WEB_PORT` is new in `playwright.config.ts` (additive, unset ⇒ unchanged):
the legacy `chromium` pair's vite always bound 5173 and `reuseExistingServer`
adopted a sibling lane's vite — whose `/api` + `/public` proxy points at THAT
lane's api port — so a browser leg silently talked to the wrong database.
`E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0` stop the two fixed-port pairs (3001/5174,
3002/5175) from booting; a sibling holding 3001 is what made the first run's
webServer "exit early". No AI_PROVIDER_API_KEY is set, so the api boots the
PRODUCTION `createHermeticMockLLMGateway()` (factory.ts:470) — that is what
7.1/7.3 draft against, not a test double.

## Runs (raw output appended per spec below)

### 7.7 — `estimate-stale-revision-approve-7-7.spec.ts`

Run 1 (09:20Z, before `logRows`): the first two attempts on this Mac were
infrastructure, not the spec — (1) webServer "exited early" (a sibling lane
held the fixed devauth port; fixed with `E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0`),
(2) `locator.click` timeout on a disabled "Accept estimate" (the sheet needs
a signature; `drawSignature` added, as in 7.6). Then:

```
✓  1 [chromium] › e2e/journeys/estimate-stale-revision-approve-7-7.spec.ts:93:7 › stale-version approve is refused; current version is accepted (7.7) — real Postgres › a revision mid-session refuses the stale approve (409/banner, status stays sent); the current version then accepts; T1 isolation on a second tenant running the same scenario (9.3s)
  1 passed (1.3m)
EXIT=0
```

Screenshots: `8-7-quote-r5/7.7-{a,b}-before-revise.png`,
`7.7-{a,b}-stale-refused.png`, `7.7-{a,b}-current-accepted.png`.

### 7.4 + 7.5 — `estimate-tiers-addons-7-4-7-5.spec.ts`

Runs 1–6 were all harness, none of them the product: EADDRINUSE from the
previous run's lingering api (runner now waits for the pair to free), the
"What's new in Rivet" walkthrough dialog intercepting the first click
(`signInOwnerBrowser` seeds the walkthrough-seen keys), a vite that never
came up on the shared 38511 (pair moved to 38520/38521), and — the real
find — the owner form's `<select value={form.jobId} required>` blocking
submit via native validation until its `<option>` renders (focus jumped to
the select, no handler, no POST; the fixed assistant bar covering the
submit at 390×844 was a second, independent cause). Run 7:

```
✓  1 [chromium] › e2e/journeys/estimate-tiers-addons-7-4-7-5.spec.ts:163:7 › good/better/best tiers with add-ons (7.4) + headline-over-default-selection (7.5) — real Postgres › owner drafts 3 tiers + an add-on through the real form; the public page headline equals the default tier before any click; the customer picks Premium+Warranty; all rows + the accepted selection survive; a neighbour tenant is untouched (T2) (12.6s)
  1 passed (1.9m)
EXIT=0
```

Row dumps (from the run's stdout, `[8.7 row-dump]`):

```
7.4 estimate_line_items after owner-form draft (tenant A)
  Basic Package     group_key=Service Tier is_optional=true is_default_selected=true  unit_price_cents=20000
  Premium Package   group_key=Service Tier is_optional=true is_default_selected=false unit_price_cents=35000
  Deluxe Package    group_key=Service Tier is_optional=true is_default_selected=false unit_price_cents=50000
  Extended Warranty group_key=null         is_optional=true is_default_selected=false unit_price_cents=4500

7.4/7.5 owner GET /api/estimates/:id after accept
  status=accepted  estimateNumber=EST-0001  version=1
  lineItems: 4 (all four rows still present)
  totals: { subtotalCents: 39500, discountCents: 0, taxCents: 0, totalCents: 39500 }   ← Premium 35000 + Warranty 4500, NOT the 109500 sum of all four
  acceptedSelection: [c64bf615… (Premium Package), 1eb78ddc… (Extended Warranty)]
  acceptedByName="Tier Picker Customer" acceptedByIp="::1" acceptedSignatureData="data:image/png;base64,…" (real canvas PNG)
7.4 estimate_line_items after accept — all four rows survive: 4 rows
7.4/7.5 T2 tenant B estimate untouched: status=sent
```

First-render headline on the public page: `$200.00` visible, `$1,095.00`
absent (7.5 first half); after Premium + Warranty: `$395.00`.

Screenshots: `7.4-7.5-owner-draft-tiers.png`, `7.4-7.5-owner-draft-tiers-tenantB.png`,
`7.5-headline-before-selection.png`, `7.5-accepted-non-default-selection.png`,
`7.4-owner-detail-accepted-rows.png`.

### 7.8 — `estimate-concurrent-approval-race-7-8.spec.ts`

Run 1 was the api's cold ts-node boot overrunning the 120s webServer window
(no `[startup]` line; `E2E_WEBSERVER_TIMEOUT_MS` added). Run 2:

```
✓  1 [chromium] › e2e/journeys/estimate-concurrent-approval-race-7-8.spec.ts:117:7 › concurrent estimate-approval race, exactly one wins (7.8) — real Postgres › two estimates on one job approved at the same instant settle to exactly one accepted, the loser gets a clean 409; T2 on a second, independent tenant racing the same instant (5.9s)
  1 passed (2.4m)
EXIT=0
```

Row dumps:

```
7.8 TenantA loser response (409)
  { "error": "CONFLICT", "message": "Another estimate on this job has already been accepted. Please contact us — this estimate may no longer be current." }
7.8 TenantB loser response (409)   ← the two tenants raced at the same instant
  { "error": "CONFLICT", "message": "Another estimate on this job has already been accepted. …" }
7.8 tenant A estimates on the raced job
  9dfa6822… status=sent
  8896a115… status=accepted            ← exactly one
7.8 tenant A audit_events public_estimate.approved (winner)
  [ { event_type: public_estimate.approved } ]   ← exactly one
7.8 tenant B estimates on ITS raced job (T2)
  56da933f… status=sent
  06a40fe7… status=accepted
```

Cross-tenant: `GET /api/estimates/<A's winner>` under tenant B → 404.
Screenshot: `7.8-winner-accepted-public-view.png` ("Estimate accepted!" on the
winner's token).

### 7.9 — `estimate-deposit-gate-7-9.spec.ts`

Run 1 reached the very last assertion of the main test and waited on the
wrong testid (an ACCEPTED estimate renders `SuccessScreen`, whose paid
marker is `success-deposit-paid`, not the pre-accept `estimate-deposit-notice`)
— and its pin reported "Expected to fail, but passed": with
`STRIPE_SECRET_KEY` set the route does NOT 400, it 500s (below). Runs 2–3
were killed from outside (worker SIGKILL; then a foreign api on 38520 —
pair moved). Run 4:

```
✓  1 [chromium] › e2e/journeys/estimate-deposit-gate-7-9.spec.ts:116:7 › deposit-before-approval gate + fixed-amount cap (7.9) — real Postgres › before_approval blocks Approve and shows the CAPPED deposit; after_approval (T3, divergent config) accepts immediately and settles via a signed webhook (33.7s)
✘  2 [chromium] › e2e/journeys/estimate-deposit-gate-7-9.spec.ts:263:7 › … the real deposit-checkout route genuinely refuses (no live Stripe key, no mock fallback) — pinned, not faked (6.7s)   ← test.fail(): expected failure
  2 passed (2.2m)
EXIT=0
```

Row dumps:

```
7.9 tenant A approve-without-deposit response (409)
  { "error": "CONFLICT", "message": "Deposit must be paid before this estimate can be approved" }
  (public page: estimate-deposit-notice shows "$99.00" — the $200 fixed rule CAPPED at the $99 total —
   estimate-pay-deposit-cta visible, no "Accept this estimate" button; estimate stays sent)
7.9 tenant B jobs row after after_approval accept        (T3: percentage 10% / after_approval)
  [ { deposit_required_cents: 5000, deposit_paid_cents: 0, deposit_status: "pending" } ]
  (success screen: success-deposit-prompt "Pay your $50.00 deposit to confirm scheduling")
7.9 tenant B jobs row after signed checkout.session.completed (metadata.deposit_for_job_id)
  [ { deposit_required_cents: 5000, deposit_paid_cents: 5000, deposit_status: "paid" } ]
  api: "Deposit credited via Stripe checkout"; reload → success-deposit-paid "Deposit paid — thank you!"
7.9 tenant A jobs row untouched by B settlement
  [ { deposit_paid_cents: 0 } ]

7.9 pin — POST /public/estimates/:token/deposit-checkout (before_approval, placeholder key) response 500
  {"error":"INTERNAL_ERROR","message":"An unexpected error occurred"}
7.9 pin — jobs row after the failed mint (required stays 0 → webhook cannot credit)
  [ { deposit_required_cents: 0, deposit_paid_cents: 0, deposit_status: "not_required", deposit_stripe_payment_link_url: null } ]
```

Screenshots: `7.9-before-approval-gate.png`, `7.9-after-approval-accepted-tenantB.png`,
`7.9-deposit-paid-tenantB.png`.

### 7.10 — `estimate-nudge-sweep-7-10.spec.ts`

Run 1: both sends failed "Cannot send SMS — … customer has no primary phone"
(worker default channel `sms`, estimates sent by email → `channel: 'email'`),
and the T4 premise was wrong (an injected `now` of +4d makes a seconds-old
send look 4 days old too — tenant B is now skipped because its customer
OPENED the quote in the real public page, `firstViewedAt`). Run 2: a fresh
customer's GET 404'd for the whole 2s #1133 window under three lanes' load
(poll widened to 10s, lag reported). Run 3: `duplicate key value violates
unique constraint "idx_dispatches_idempotency"` — SendService keys every
dispatch on the WALL-CLOCK minute (send-service.ts:575-583), so a nudge in
the same minute as the owner's send collides by design; the spec now lets
the minute roll over first. Run 4:

```
{"message":"Estimate-reminder sweep completed","service":"estimate-reminder-worker-e2e","tenants":2,"reminders":1,"failed":0}
   ← first sweep over BOTH tenants: A (silent) nudged, B (viewed) skipped
{"level":"warn","message":"Estimate-reminder sweep: estimate failed", … "estimateId":"6cd2bf41-…","error":"Estimate nudge already in flight for estimate 6cd2bf41-… (reminder #1) — a concurrent attempt already claimed this occurrence."}
{"message":"Estimate-reminder sweep completed", … "tenants":1,"reminders":0,"failed":1}
{"message":"Estimate-reminder sweep completed", … "tenants":1,"reminders":1,"failed":0}
   ← the two CONCURRENT sweeps on estimate C: exactly one send, the other refused by the claim-before-send gate
✓  1 [chromium] › e2e/journeys/estimate-nudge-sweep-7-10.spec.ts:114:7 › … the real sweep nudges exactly one eligible estimate per tenant, records the audit + reminder bookkeeping, two concurrent sweep calls do not double-send, and a second (untouched) tenant proves T4 fanout (1.5m)
✘  2 [chromium] › e2e/journeys/estimate-nudge-sweep-7-10.spec.ts:281:7 › … the real setInterval-driven automatic trigger cannot be observed inside a bounded hermetic run — pinned, not faked (2.9s)   ← test.fail(): expected failure (POST /api/workers/estimate-reminder/run → 404)
  2 passed (6.1m)
EXIT=0
```

Asserted at real Postgres (row dumps added for the second pass): tenant A
`reminder_count=1`, `last_reminder_at` set, exactly one
`estimate.reminder_sent` audit row; tenant B `reminder_count=0`, no audit
row; estimate C `reminder_count=1` after the race with exactly one
in-memory delivery.

### 7.1 + 7.3 — `estimate-chat-draft-7-1-7-3.spec.ts`

Run 1: the second real chat turn had not completed inside a 20s wait (the
first took 14s under three lanes' load) — waits raised to 90s. Run 2: the
spec tried to one-tap-approve the UNCATALOGUED draft and timed out on a
`disabled` Approve — the product refusing, correctly (7.2's cap on the real
surface); the spec now asserts that refusal. Run 3: the T2 cross-read was a
superuser SQL read "as" tenant B (see the isolation note above) — moved to
the real API. Run 4:

```
✓  1 [chromium] › e2e/journeys/estimate-chat-draft-7-1-7-3.spec.ts:103:7 › §8.7 rows 7.1 + 7.3 … › a dictated draft_estimate persists a real estimate + audit event through the owner Assistant chat; a mixed-pricing draft shows per-line badges and the DB CHECK refuses a bogus pricing_source; a neighbour tenant never sees any of it (T2) (1.1m)
✘  2 [chromium] › e2e/journeys/estimate-chat-draft-7-1-7-3.spec.ts:308:7 › … the "customer photo" leg has NO owner-facing transmission path — pinned, not faked (2.5s)   ← test.fail(): expected failure (the literal photo-turn body yields no proposal)
  2 passed (3.0m)
EXIT=0
```

Row dumps:

```
7.1 drafted estimates row (chat → hermetic gateway → EstimateTaskHandler → Approve → execute)
  { id: a5a67e33-…, tenant_id: 1d01ed55-…, status: "draft" }
7.1/7.3 estimate_line_items (catalog-grounded line)
  [ { description: "Service estimate for Sarah Customer", unit_price_cents: 15000, pricing_source: "catalog" } ]
     ← the seeded catalog item's price won; the badge on the card read "From catalog"
7.1 audit_events estimate.created for the drafted estimate
  [ { event_type: "estimate.created" } ]
7.3 uncatalogued draft — proposals row (line pricingSource, capped confidence, NOT approved)
  { id: 34746dfd-…, status: "ready_for_review", confidence_score: "0.5",
    line_description: "Service estimate for Priya Vendor", line_pricing_source: "uncatalogued", overall_confidence: "low" }
     ← card: "AI-estimated" badge + "\"Service estimate for Priya Vendor\" is not in the tenant catalog — the price is AI-estimated and needs review"; Approve disabled
7.3 raw UPDATE estimate_line_items SET pricing_source = 'bogus' — Postgres refusal
  { code: "23514", message: "new row for relation \"estimate_line_items\" violates check constraint \"estimate_line_items_pricing_source_check\"" }
7.1/7.3 T2 — tenant B GET /api/estimates/<A's id> → 404; GET /api/estimates → []
```

Screenshots: `7.1-drafted-proposal-catalog.png`, `7.1-approved-proposal-catalog.png`,
`7.3-uncatalogued-badge.png`.

### 7.12 — `negotiation-sms-guardrail-7-12.spec.ts`

Run 1: INSERT collided with the product's own dev stub twilio row (now an
UPDATE of its two credential columns). Run 2: the quote was sent by email
to a phone-only customer (`Cannot send email — … no email on file`; now
SMS). Run 3: the Discount-policy sheet's Save resolved to three buttons
(scoped to the dialog). Run 4:

```
✓  1 [chromium] › e2e/journeys/negotiation-sms-guardrail-7-12.spec.ts:215:7 › negotiation guardrail — SMS discount ask never concedes (7.12) — real Postgres › a discount-asking SMS always produces a capture-class owner callback + audit row, never a price to the customer, under two divergent tenant configs (T1·T3) (12.7s)
  1 passed (2.2m)
EXIT=0
```

Row dumps:

```
7.12 tenant A proposals (callback)            ← A left at the DEFAULT discountMaxBps (unset ⇒ 0): V1 path
  [ { id: 7b187353-…, proposal_type: "callback", status: "draft",
      source_context: { source: "sms", fromPhone: "+15125559001", messageSid: "SMb02040e3…" },
      summary: "Discount request from the customer — AI didn't negotiate; call back" } ]
7.12 tenant A audit_events negotiation_guardrail.sms_routed
  [ { metadata: { askType: "discount", proposalId: "7b187353-…" } } ]          ← ONE row, no decision (never evaluated)
7.12 tenant B proposals (callback)            ← B opted in through the real Discount-policy sheet (10% cap): V2 path
  [ { id: 5c2e1e77-…, proposal_type: "callback", status: "draft",
      source_context: { source: "sms", fromPhone: "+15125559002", messageSid: "SMd4dc9ad9…" },
      summary: "Discount request from the customer — AI didn't negotiate; call back" } ]
7.12 tenant B audit_events negotiation_guardrail.sms_routed (T3: carries decisionKind)
  [ { metadata: { quotedCents: 22500, decisionKind: "NEEDS_APPROVAL", requestedDiscountBps: null, requestedTargetCents: 20500 } },
    { metadata: { askType: "discount", proposalId: "5c2e1e77-…" } } ]        ← TWO rows: the REAL evaluated decision on the REAL $225 quote
```

No concession either way: both estimates' `totals.totalCents` unchanged
(22500), both proposals `draft`, the only customer reply is the holding line
(in-memory delivery). Cross-tenant: B's scope holds neither A's proposal
nor an audit row naming it. Owner browser: tenant A's `/inbox` shows
"Discount request from the customer — AI didn't negotiate; call back".

Screenshots: `7.12-tenantB-discount-policy-configured.png`,
`7.12-tenantA-inbox-callback.png`.

<!-- RUNS -->

## What is NOT proven (pinned, not faked)

- **7.1 "customer photo" leg.** The Assistant's photo input captures an
  attachment in local React state but `sendToConversationAPI`
  (AssistantPage.tsx:69-90) never transmits it; the only vision-drafting
  path is the customer-initiated MMS surface, dispatched through the
  `mms-ingest-worker.ts` background worker, not the synchronous webhook.
  Pinned with `test.fail()` in the 7.1/7.3 spec. The "spoken description"
  leg is proven through the deterministic `matchDraftEstimatePhrase`
  short-circuit (intent-classifier.ts:1702) + the production hermetic
  gateway; literal browser speech-to-text is not attempted (#1119).
- **7.3 multi-source badge on ONE card.** The production hermetic mock
  scripts exactly one line per draft, so the two badges ("From catalog" /
  "AI-estimated") are proven on two cards; the same-document mixture stays
  with `test/integration/estimates.test.ts` (T1).
- **7.9 paying a `before_approval` deposit.** `getOrCreateDepositCheckoutUrl`
  has no hermetic path: with NO `STRIPE_SECRET_KEY` it throws
  `ValidationError('Payment processing is not configured')`
  (public-estimate-service.ts:756-758 → 400) — no Mock-provider fallback,
  unlike the invoice pay-link path; with the placeholder key the money-row
  invocation sets, it POSTs to the REAL `https://api.stripe.com/v1/payment_links`
  (:872-882), Stripe rejects the key, and the plain
  `throw new Error(\`Stripe API error (…)\`)` (:883-886) is unmapped — the
  customer's "Pay deposit" tap gets a **raw 500** (observed, run 1; the pin
  test records status + body). `depositRequiredCents` is only persisted
  after a successful mint (:906-913), so it stays 0, the deposit webhook
  refuses to credit (webhooks/routes.ts:1409-1414) and approve stays 409.
  Parked with #1000/#1002 (live Stripe). **New finding for Fable:** a Stripe
  failure on the public deposit route surfaces as an unmapped 500 rather
  than a mapped, customer-readable error.
- **7.10 compressed calendar vs wall-clock idempotency.** `SendService`'s
  second idempotency layer keys every dispatch on the WALL-CLOCK minute
  (`estimate:<id>:<channel>:<floor(Date.now()/60000)>`,
  notifications/send-service.ts:575-583, `idx_dispatches_idempotency`), not
  on the sweep's injected `now`; a nudge in the same minute as the owner's
  send collides with that send's dispatch row by design (run 3: "duplicate
  key value violates unique constraint idx_dispatches_idempotency"). The
  spec waits for the minute to roll over between a send and the sweep that
  re-sends it — it waits for the product's guarantee, it does not bypass
  it. Also: the worker's default channel is `sms`; the estimates here were
  sent by email, so the sweep runs with `channel: 'email'` (run 2 failed
  "Cannot send SMS — … no primary phone" on email-only customers).
- **7.10 wall-clock trigger.** The sweep only fires from a hardcoded hourly
  `setInterval` (app.ts:6467, no env override unlike
  `OVERDUE_SWEEP_INTERVAL_MS`); the spec calls the identical production
  function the interval body calls. The voice-triggered manual nudge's own
  48h cooldown (`ESTIMATE_NUDGE_COOLDOWN_MS`, handlers.ts:1055) needs the
  intent classifier to route "nudge the X estimate" — not scripted by the
  hermetic mock (only create_customer / draft_estimate / create_invoice) —
  so it stays with `test/integration/estimate-nudge.test.ts` (#1119).
- **7.12 the holding-line text.** The customer reply goes through the
  in-process `InMemoryDeliveryProvider`; `message_dispatches` carries no
  body and is estimate/invoice-scoped, so "no concession" is asserted as:
  proposal stays `draft`, the sent estimate's `total_cents` is unchanged,
  and only tenant B (opted in) carries a `decisionKind` on its audit row.

## Report-only rows

- **7.2 (3/3).** Grounding is exercised by every 7.1/7.3 draft here (the
  catalog line lands `pricing_source='catalog'` at 15000¢ — the catalog
  price won over the mock's own figure). The cap was then OBSERVED on the
  real surface, unplanned: the uncatalogued "Priya Vendor" draft rendered
  the "AI-estimated" badge, the per-line marker "… is not in the tenant
  catalog — the price is AI-estimated and needs review", and its **Approve
  button disabled** — run 2 of the 7.1/7.3 spec tried to one-tap-approve it
  and timed out on `disabled`; the spec now asserts that refusal plus the
  proposal row's `confidence_score < 0.9`. That is reachability evidence for
  the cap; whether it lifts 7.2 is Fable's call (the cap's arithmetic is
  still only the 84/84 unit proof, #1012).
- **7.11 (3).** `getSupervisorReviewGate()` still reaches 2 of 93 origins
  (E10.18, parked on O-9). Nothing in the assistant-chat draft path above
  passes through a supervisor review before the owner-facing card renders;
  the Inbox shows the draft directly. No reachability run is possible until
  the gate is wired to the drafting origins.

## Ticket

No OPEN §8.7 issue exists: `gh issue list --search "§8.7 Quote" --state open`
returns only the map (#995). The section's ticket is **#1012** (closed
2026-09-12 when the rung-4 work landed); the PR link is commented there and
on #995 so Fable can re-route.
