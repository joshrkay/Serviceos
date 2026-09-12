# Public surfaces rung-5 reachability — estimate approve+sign, pay-from-a-link, self-booking

Branch: `cloud/public-surfaces-r5`, off `origin/main` (137dc55, PR #1047 landed). One commit per spec. Run in Claude Code on the web (cloud sandbox), 2026-09-12. Test-only lane — `git diff --stat origin/main..HEAD -- packages/api/src packages/web/src` is empty (verified below). No product code changed.

Rows: PRD-v5-as-built.md §8.2 row **2.9** (self-booking), §8.7 row **7.6** (estimate approve+sign), §8.8 row **8.4** (pay from a link). Ticket parents: #1014 (2.9), #1012 (7.6), #1022 (8.4). Per D-032/§8.0, **only Fable states a new rung** — this report is evidence for that call, not the call itself.

## Setup (shared by all three specs)

```bash
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts
# -> export DATABASE_URL=postgres://test:test@localhost:32768/serviceos_e2e_test
```

Each spec run:

```bash
DB_SSL=false DATABASE_URL=<url from setup> E2E_USE_TEST_DB=true \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npx playwright test <bare spec name> --project=chromium --reporter=line
```

(8.4 additionally needs `STRIPE_WEBHOOK_SECRET=whsec_e2e_public_pay_link_test_secret` — see its row.)

`chromium` (not `chromium-devauth`) is the project used throughout — `chromium-devauth` forces `InMemoryProposalRepository`/in-memory repos and would only prove the mocked path, per docs/testing-strategy.md's own "one of three distinct e2e runners" note. Every setup step (customer/location/job/estimate/invoice/booking, owner identity + business hours) goes through the real authenticated `/api/*` routes or the real public routes — no SQL, no platform-admin route, no env var the product wouldn't itself set (`STRIPE_WEBHOOK_SECRET` is exactly the credential a tenant's own Stripe webhook endpoint configuration sets in production; see docs/runbooks/stripe-go-live.md). Audit-row assertions query Postgres directly through a raw `pg.Client`, `SET LOCAL app.current_tenant_id` per query — the same RLS-scoped read pattern `e2e/qa-matrix/helpers/rw-db.ts` already uses in this repo; there is no authenticated API for reading audit rows.

Because `E2E_USE_TEST_DB=true` truncates every table in `global-teardown.ts` at the end of each run, a 1.5s-interval poller ran alongside every Playwright invocation:

```bash
while true; do
  docker exec <pg container> psql -U test -d serviceos_e2e_test -c "SELECT ... FROM audit_events GROUP BY ...;"
  docker exec <pg container> psql -U test -d serviceos_e2e_test -c "SELECT ... FROM estimates ...;"
  docker exec <pg container> psql -U test -d serviceos_e2e_test -c "SELECT ... FROM invoices ...;"
  docker exec <pg container> psql -U test -d serviceos_e2e_test -c "SELECT ... FROM appointments ...;"
  sleep 1.5
done
```

The last snapshot before each run's teardown is saved alongside this report (`spec1-db-snapshot.txt`, `spec2-db-snapshot.txt`, `spec3-db-snapshot.txt`), tenant ids visible.

Build gate: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` → clean, exit 0 (unaffected — this lane touches no `packages/api/src` or `packages/web/src` file). `npx tsc --project tsconfig.json --noEmit` at the repo root also reports zero errors in the three new spec files.

---

## Row 7.6 — estimate approve + sign

**File:** `e2e/journeys/public-estimate-approve-sign.spec.ts` (new).

**What it drives:** owner creates a tiered (good-better-best) estimate via `POST /api/estimates` (two `groupKey: 'tier'` line items) → `POST /api/estimates/:id/send` (channel `email`, generates the real `view_token`) → customer opens `/e/:token` in a real 390×844 browser session → picks the Premium tier → opens the approve sheet → draws a real signature on the `<canvas>` (mouse down/move/up) → submits → durable acceptance asserted through `GET /api/estimates/:id` (status, `acceptedByName`, `acceptedSignatureData`, `acceptedByIp`, `acceptedUserAgent`, `totals.totalCents`) and a real-Postgres `public_estimate.approved` audit row. Then `POST /api/estimates/:id/convert-to-invoice` (the natural, still-reachable owner-side next step — no SQL, no platform-admin, no env var) proves `estimate.converted`. A second, un-tiered estimate on the same tenant proves the **stale-revision guard**: the owner revises it (`POST /:id/revise`) while the customer's page still holds the old `version` in React state; the customer's real submit gets refused (409) and the page shows the "This estimate was updated by the business" banner — asserted to never reach the success screen, and the DB row stays `status: 'sent'`, `acceptedAt: undefined`. **T2**: a wholly independent tenant B estimate is opened first and asserted to show only tenant B's business name — never tenant A's.

### RED

Two real bugs were found and fixed during RED, not planted — see "Judgment calls" below. The deliberately-wrong assertion, once the flow itself was working:

```
    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "RED-CHECK-WRONG-NAME"
    Received: "Pat Playwright Signer"

      372 |     };
      373 |     expect(estimateRow.status).toBe('accepted');
    > 374 |     expect(estimateRow.acceptedByName).toBe('RED-CHECK-WRONG-NAME');
  1 failed
```

### GREEN

```
Running 1 test using 1 worker
[1/1] [chromium] › e2e/journeys/public-estimate-approve-sign.spec.ts:300:7 › ...
  1 passed (2.3m)
```

Re-run once more after a `drawSignature` robustness fix (below), still green:

```
  1 passed (2.3m)
```

**Reached:** the full 7.6 acceptance criterion — token link, tier pick, real signature, durable acceptance + signature/IP/UA persistence, `public_estimate.approved` audit row, stale-version refusal, T2 isolation, plus the owner-side `estimate.converted` leg. Nothing stopped short.

**Tenant grade:** T1 (the estimate-approval and conversion audit rows are queried scoped to tenant A only) + **T2** (tenant B's token opens only tenant B's data, asserted in-browser).

**DB snapshot:** `spec1-db-snapshot.txt` — `EST-0001` (tenant A) `accepted`, `accepted_by_name = 'Pat Playwright Signer'`, `sig_prefix` a real `data:image/png;base64,...` string; `EST-0002` (same tenant, the stale target) stayed `sent` at version 2; tenant B's `EST-0001` stayed `sent`, completely untouched; `public_estimate.approved` and `estimate.converted` both present exactly once for tenant A.

**Screenshots:** `7.6-estimate-before.png`, `7.6-estimate-after-reload.png` (page reloaded post-acceptance; "Estimate accepted!" persists).

**Judgment calls:**
- Two real bugs surfaced and fixed during RED (not the product's — the spec's own first draft): (1) `page.getByText('Bexar Plumbing 7.6')` and `page.getByText('Acme HVAC 7.6')` were strict-mode ambiguous — the business name also appears inside "No account needed · {businessName}" beneath the CTA — fixed with `{ exact: true }`. (2) `page.reload()` after acceptance exceeded the default 30s Playwright test timeout (this test does two tenant bootstraps, several real page loads, and a revise round-trip) — fixed with `test.setTimeout(180_000)` and `{ waitUntil: 'domcontentloaded' }`.
- `drawSignature` retries its mouse-down/move/up stroke up to 3 times, gated on the "Clear" button appearing (which only renders once the canvas's own `onChange(true)` fires) — a single headless mouse-event dispatch occasionally lands before the canvas's pointer handlers attach, leaving the Approve button disabled. Documented as a Playwright/headless-timing issue, not a product bug.
- `estimate.converted` is not emitted by the public approval path itself (`convertEstimateToInvoice` is a separate, owner-triggered action — confirmed by reading `packages/api/src/invoices/convert-estimate.ts` and `packages/api/src/estimates/public-estimate-service.ts`). The task's own wording asked for both audit rows, so this spec drives the natural owner-side follow-on call rather than fabricating the event or skipping half the ask.

---

## Row 8.4 — pay from a link

**File:** `e2e/journeys/public-invoice-pay-link.spec.ts` (new).

**What it drives:** owner creates an invoice (`POST /api/invoices`) → issues it (`POST /:id/issue`) → sends it (`POST /:id/send`, real `view_token`) → mints a payment link (`POST /:id/payment-link` — in this dev environment, with no `STRIPE_SECRET_KEY`, this resolves to the real `MockPaymentLinkProvider` fallback the app itself uses in every non-prod environment, per `packages/api/src/payments/payment-link-provider.ts`'s own production guard) → re-issuing the SAME call is asserted idempotent (same URL — the "persists only on a payable, unchanged, link-free invoice" guard, `createInvoicePaymentLink`'s early-return path). Customer opens `/pay/:token`. The hosted Stripe checkout itself cannot be driven hermetically — settlement is proven the same way `packages/api/test/integration/invoice-webhook-paid.test.ts` proves it: a SIGNED `checkout.session.completed` webhook posted straight to the real API (`POST /webhooks/stripe`, HMAC-SHA256 `t=…,v1=…` signature, same recipe as `createWebhookSignature`). After the webhook, the public page is reloaded and reads **Paid**; `payment.recorded` and `invoice.status_changed` (metadata `newStatus: 'paid'`) are both confirmed at real Postgres, plus the `payments` row itself. A post-paid re-mint attempt is refused 409 (no longer payable). **T2**: tenant B's independent invoice and link stay untouched throughout.

### Reachability boundary, reported honestly

The embedded `<PaymentElement>` "Pay" control cannot render in this sandbox: `POST /api/public-payments/create-payment-intent` 503s with `STRIPE_NOT_CONFIGURED` whenever `deps.stripeConfig` is null (`packages/api/src/routes/public-payments.ts:107-116`) — true here, since there is no `STRIPE_SECRET_KEY` and no route to Stripe's real API in this environment. Stubbing Stripe.js client-side (`e2e/helpers/stripe-stub.ts`) does not change this — the gate is server-side, ahead of any client code, and stubbing the client while the server still 503s would just hide the real state. So the spec asserts the actual, honest state — `data-testid="stripe-not-configured"` ("Online payment is temporarily unavailable") — rather than faking a rendered PaymentElement. This is the one place this lane stopped short of full UI reachability, exactly per instructions ("say exactly why and stop at the last reachable step — do not fake it"). It does not block the rest of the story: settlement is independent of whether the Elements UI ever rendered, and the story's own wording already anticipates this ("the hosted Stripe checkout cannot be hermetic").

### RED

```
    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "RED-CHECK-WRONG-STATUS"
    Received: "paid"

      360 |       amountDueCents: number;
      361 |     };
    > 362 |     expect(paidBody.status).toBe('RED-CHECK-WRONG-STATUS');
  1 failed
```

(Reached only after the full mint → idempotent re-mint → public page load → signed webhook → reload → Paid sequence had already succeeded — the only thing wrong was the planted expectation.)

### GREEN

```
Running 1 test using 1 worker
[1/1] [chromium] › e2e/journeys/public-invoice-pay-link.spec.ts:246:7 › ...
  1 passed (2.1m)
```

**Reached:** link issuance + idempotent guard, the public page (with the honest "not configured" boundary documented above), signed-webhook settlement, `payment.recorded` + `invoice.status_changed` audit rows, the post-paid re-mint refusal, and T2 isolation.

**Tenant grade:** T1 (payment/audit rows queried scoped to tenant A) + **T2** (tenant B's page and invoice untouched throughout; asserted both in-browser and via its own `GET /api/invoices/:id`).

**DB snapshot:** `spec2-db-snapshot.txt` — tenant A's `INV-0001` → `paid`; `payment.recorded` + `invoice.status_changed` (`newStatus: 'paid'`) once each; a bonus `invoice.payment_link_deactivated` fired as a side effect of settlement (the now-paid invoice's stale link is killed); tenant B's `INV-0001` stayed `open`.

**Screenshots:** `8.4-invoice-before.png` (real invoice number/amount + the honest "Online payment is temporarily unavailable" state), `8.4-invoice-after-payment.png` ("Payment received!" post-webhook, post-reload).

**Judgment calls:**
- See "Reachability boundary" above — the single biggest judgment call in this lane.
- `page.getByText('$500.00')` needed `.first()` — the amount renders in more than one place on the invoice page (line total + amount due).

**Update (post-gate review, Codex finding on PR #1087, commit 55633e6):** the settlement webhook originally carried metadata constructed independently of the minted link (`tenantA.tenantId`/`invoiceA.invoiceId` typed directly), so the test would have stayed green even if the mint call had issued an unusable link or embedded the wrong metadata — confirmed real: no test in the repo inspects what metadata `createInvoicePaymentLink`'s `generateLink()` call actually sends (every fake `generateLink` in `invoice-payment-link.test.ts` only checks `stripeAccountId`). Partial fix: threaded the invoice's own persisted `stripePaymentLinkId` (read back via `GET /api/invoices/:id` after minting) into the webhook's `payment_link` field.

**Correction (Codex re-review, PR #1087, after commit 55633e6):** that fix does not close the gap it claimed to. Verified directly against `packages/api/src/webhooks/routes.ts`'s `checkout.session.completed` branch: it destructures only `metadata`, `payment_status`, `amount_total` and `payment_intent` off the Stripe session — it never reads `payment_link`. The field added in 55633e6 is inert in production; the spec would still pass today if `issuedLinkId` were replaced with an arbitrary string, because the invoice is selected purely from `metadata.invoice_id`/`tenant_id`, which the test constructs independently rather than reading back from the real minted link. The spec and this report have been corrected (comment on `e2e/journeys/public-invoice-pay-link.spec.ts:363` and here) to stop claiming this ties settlement to the minted link. **Residual gap, not closed by this lane, now stated plainly as OPEN rather than partially addressed:** tying settlement to the exact minted link needs production code that validates the incoming session's link or metadata against the invoice's persisted `stripePaymentLinkId` — a product-code change, out of scope for this test-only, no-product-code-change lane. Verifying that the mint call's `metadata: {tenant_id, invoice_id}` actually reaches a real Stripe object separately needs a live Stripe test-mode key or a spy-capable fake provider — this sandbox has neither. Both flagged inline in the spec and on the PR for whoever states the rung to weigh; the 8.4 row should not be read as having closed the mint→settlement traceability gap.

---

## Row 2.9 — website self-booking

**File:** `e2e/journeys/public-self-booking.spec.ts` (new).

**What it drives:** two tenants are given genuinely different business hours (owner-set via `PUT /api/onboarding/identity`, exactly as production onboarding sets them) — tenant A Mon–Fri 08:00–17:00, tenant B Sat/Sun 09:00–13:00 only, both `America/Chicago`. Tenant A's `/book?t=<tenantId>` page is opened in a real 390×844 browser: real availability loads, a real open slot is picked, the details form is filled, and the real `POST /api/public/booking/:tenantId` fires (captured via `page.waitForResponse`, asserted `201`). Durable proof: `GET /api/appointments/:id` shows `status: 'scheduled'` + `holdPendingApproval: true` + a real `holdExpiryAt` (there is no dedicated `'held'` enum value — this flag combination is what "held pending approval" is, confirmed against the real column, not assumed); a real-Postgres `appointment.booking_requested` audit row, `metadata.proposalId` matching the booking response's own id. The owner then signs in (Clerk stub bound to the bootstrapped `users` row) and, **after a full page reload**, `/inbox` shows the `create_booking` proposal by its distinctive summary text. **T3**: tenant B's disjoint (weekend-only) slot set is proven via the same public API the browser page itself calls — see "Judgment calls" for why the browser wasn't used a second time. **T1**: each tenant's `/inbox` shows only its own booking, never the other's.

### RED

```
    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "RED-CHECK-WRONG-STATUS"
    Received: "scheduled"

      257 |       holdExpiryAt?: string;
      258 |     };
    > 259 |     expect(appt.status).toBe('RED-CHECK-WRONG-STATUS');
  1 failed
```

(Reached only after the real slot pick, form submit, and durable-appointment read had already succeeded.)

### GREEN

```
Running 1 test using 1 worker
[1/1] [chromium] › e2e/journeys/public-self-booking.spec.ts:189:7 › ...
  1 passed (1.7m)
```

Re-confirmed after the tenant-B restructure (below), and once more with a second deliberately-wrong expectation on the tenant-B booking POST's status code, RED then GREEN:

```
    Error: expect(received).toBe(expected) // Object.is equality
    Expected: 999
    Received: 201
  1 failed
```
```
  1 passed (2.6m)
```

**Reached:** the full 2.9 criterion on tenant A's real page (open slot pick → held appointment → audit row → owner inbox after reload), plus T1/T3 for tenant B. See judgment calls for the one place a second browser round-trip was traded for a direct API call.

**Tenant grade:** T1 (each tenant's inbox and audit rows scoped correctly, asserted both ways) + **T3** (two tenants, two genuinely different business-hours configurations, two disjoint correct slot sets, in the same run).

**DB snapshot:** `spec3-db-snapshot.txt` — tenant A's held appointment at Monday 08:00 America/Chicago, tenant B's at Sunday 09:00 America/Chicago — disjoint days, both `scheduled` + `hold_pending_approval = true`; `appointment.booking_requested` once per tenant.

**Screenshots:** `2.9-booking-before.png` (tenant A's real slot picker), `2.9-owner-inbox-after-reload.png` (the owner's `/inbox`, reloaded, showing the real `create_booking` proposal).

**Judgment calls:**
- `/api/public/booking` is rate-limited to 5 req/min per IP (`packages/api/src/app.ts:3053-3078`). Tenant A's own page load already costs 2 GETs — React 18 StrictMode double-invokes the availability-fetch effect on mount in dev — plus 1 POST from the real submit. A second full browser page load for tenant B would push the run to 6 calls in the same window and 429.
- First attempt: wait out the rate-limit window (`page.waitForTimeout(65_000)`). This surfaced a real, pre-existing, **unfixed** defect instead of solving the rate limit: the API process crashed on an uncaught `"terminating connection due to idle-in-transaction timeout"` from its `dropped-call-worker` sweep (`dropped-call sweep: send-batch fetch failed`, `Cannot use a pool after calling end on the pool`) — reproduced twice, simply by letting the dev webServer run ~1.5–2 minutes; unrelated to this story and out of scope to fix here. Reported, not fixed.
- Final approach: tenant B's slots/isolation are proven by calling the exact same public `/api/public/booking/:tenantId` endpoints the browser page itself calls, directly (via Playwright's `request` fixture) — no SQL, no platform-admin route, no faked response, just not a second live-browser round-trip. This keeps the run's total booking-router calls at exactly 5 (A: 2 GET + 1 POST; B: 1 GET + 1 POST) with zero added idle time. Tenant A's full flow — the story's actually-named surface — is still proven end to end through the real browser.
- The owner-side "board/queue" assertion uses `/inbox` (`GET /api/proposals/inbox`), not `/dispatch`: the dispatch board defaults its date picker to "today" and only advances via UI interaction, which would have added timezone-reconciliation complexity for no real gain; the Inbox is exactly the surface `packages/web/src/components/inbox/InboxPage.tsx` builds for a `create_booking` proposal awaiting approval (it has dedicated `create_booking` handling, e.g. the hold-expiry line), and is not date-scoped.

---

## Not moved / not claimed

- **No rung is claimed by this report.** Per D-032/§8.0, only Fable states a new rung; this is evidence for that call.
- **8.4's embedded Stripe `<PaymentElement>`** — genuinely unreachable in this sandbox (no `STRIPE_SECRET_KEY`, no path to Stripe's real API); reported honestly above, not faked, not blocking the rest of the story.
- **The `dropped-call-worker` idle-in-transaction crash** discovered incidentally while testing 2.9 — real, reproducible, unrelated to the three surfaces in this lane's scope, not fixed here (no product code changes on this branch). Worth its own ticket.
- Nothing in this lane is blocked on credentials, hardware, or an O-/Q- decision; no entries added to `docs/audit/blocked-on-josh.md`.

## Final verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean, exit 0)

$ npx tsc --project tsconfig.json --noEmit   # repo root, covers the new e2e specs
(no errors reported in the 3 new files)

$ git status --porcelain
?? docs/audit/lane-reports/public-surfaces-r5/
?? docs/audit/lane-reports/public-surfaces-r5.md
?? e2e/journeys/public-estimate-approve-sign.spec.ts
?? e2e/journeys/public-invoice-pay-link.spec.ts
?? e2e/journeys/public-self-booking.spec.ts

$ git diff --stat origin/main..HEAD -- packages/api/src packages/web/src
(empty — no product code touched)
```

Files added (4, plus this report and its evidence directory):
```
e2e/journeys/public-estimate-approve-sign.spec.ts
e2e/journeys/public-invoice-pay-link.spec.ts
e2e/journeys/public-self-booking.spec.ts
docs/audit/lane-reports/public-surfaces-r5.md
docs/audit/lane-reports/public-surfaces-r5/ (screenshots + DB snapshots)
```
