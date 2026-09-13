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
| 7.10 | `e2e/journeys/estimate-nudge-sweep-7-10.spec.ts` | the PRODUCTION `runEstimateReminderSweep` (app.ts:6448-6465 interval body) against the webServer's own Postgres, digest-toggle.spec.ts pattern; two concurrent sweeps race one estimate | T4 fan-out (eligible vs not-yet-due tenant) |
| 7.12 | `e2e/journeys/negotiation-sms-guardrail-7-12.spec.ts` | real signed `POST /webhooks/twilio/sms/:tenantId` discount ask → `callback` proposal in `draft` + `negotiation_guardrail.sms_routed`; owner browser `/inbox`; tenant B opts in via the real Discount-policy sheet | T1·T3 |

Shared bootstrap: `e2e/fixtures/estimate-quote-lane.ts` — owner via the real
Clerk `user.created` webhook + HMAC session, every customer/location/job/
estimate/send through the real authenticated API. No SQL writes to reach a
product state; no platform-admin routes; no `E2E_DEV_AUTH=1`; project
`chromium` only. The one direct insert is `tenant_integrations` (7.12) —
the Twilio DID/subaccount row has no product UI (a background worker
provisions it against a real Twilio account), the same justification the
merged §8.3/§8.4 phone lanes document.

## Invocation (every spec, its own Playwright process, under the test lock)

```
DBU=$(TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts | grep -oE 'postgres://[^ ]+' | tail -1)
PORT=38520 E2E_API_URL=http://localhost:38520 PUBLIC_API_URL=http://localhost:38520 \
E2E_WEB_PORT=38521 VITE_API_URL=http://localhost:38520 E2E_DEV_AUTH=0 E2E_NOAUTHBYPASS=0 E2E_WEBSERVER_TIMEOUT_MS=300000 \
CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=$DBU E2E_USE_TEST_DB=true \
VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
STRIPE_SECRET_KEY=sk_test_e2e_stub_placeholder STRIPE_WEBHOOK_SECRET=whsec_e2e_stub_secret_1234567890 \
TENANT_ENCRYPTION_KEY=<64 hex> \
npx playwright test <spec> --project=chromium --retries=0 --workers=1
```

The lane was assigned api port 38510; it ran on **38520/38521** because a
second lane-Q session was booting its own api on 38510 in this same worktree
(a vite that never came up on 38511 timed the third tiers run out), and the
dedicated-port rule exists precisely so two Playwright stacks never adopt
each other's servers.

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
  (public-estimate-service.ts:756-758) throws `ValidationError('Payment
  processing is not configured')` without a real Stripe key — no
  Mock-provider fallback, unlike the invoice pay-link path — and the deposit
  webhook branch refuses to credit while `job.depositRequiredCents` is 0
  (webhooks/routes.ts:1409-1414). The pin test drives the REAL
  `/deposit-checkout` route and records the 400. Parked with #1000/#1002.
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
  catalog line lands `pricing_source='catalog'` at 15000¢, the uncatalogued
  one `'uncatalogued'`), but the confidence cap has no surface to reach: it
  is a pure function inside `catalog-resolver.ts` whose only observable is
  the drafted proposal's `_meta.overallConfidence`, and the hermetic mock
  fixes `confidence_score` at 0.82 — the cap's own 84/84 unit proof (#1012)
  is the ceiling until a scripted low-confidence draft exists.
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
