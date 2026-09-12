# Lane report — #1022 §8.8 payments to target rung (money, Opus)

**Branch:** `cloud/payments-8-8` (cut from `origin/main` @ `a306aa7`) · **Ticket:** joshrkay/Serviceos#1022 (child of #995)
**Input:** the G1 comment on #1022 (from the §8.8 entry audit #1009 / PR #1027) — its marks replace the printed rungs.
**Constraint:** TEST-ONLY. No money code changed — no pricing, totals, billing engine, discount/tax math, payment providers, webhooks, refunds, RLS, auth or migrations. `git diff origin/main --stat` touches `packages/api/test/integration/` and `docs/` only.

**I do not state rungs.** Each row below reports the four things the map asks for — command, raw output, evidence class, tenant grade — plus what is *not* proven. Fable grades.

---

## How everything was run

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose test/integration/<file>.test.ts
```

One file at a time, real Postgres (`pgvector/pgvector:pg16`) via the harness's testcontainer, pools from
`getSharedTestDb()` (`packages/api/test/integration/shared.ts:8`). Audit rows are read back through the real
`PgAuditRepository.findByEntity` / `.findByCorrelation` (`packages/api/src/audit/pg-audit.ts:48`, `:58`).
Nothing below uses a mocked DB or an in-memory audit repository.

Production build check, after the last change:

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
BUILD_TSC_EXIT:0
```

`git status --porcelain` is empty on the branch (verified after the final commit).

**TDD.** Every new assertion was first written with a deliberately wrong expectation and RUN (RED), then corrected
(GREEN). Raw output for both is quoted per row, verbatim from the run.

---

## Row 8.6 — two payments arriving at once (concurrency cluster) · G1: 3, single-tenant, no audit asserted

**Files (all three of the cluster):**
`test/integration/payment-concurrent-credit.test.ts`, `test/integration/payment-duplicate-race.test.ts`,
`test/integration/payment-reversal-concurrent.test.ts`

**Seam driven:** `recordPayment` (`packages/api/src/invoices/payment.ts:514`) with the real `PgInvoiceRepository` /
`PgPaymentRepository`, and the audit repo in positional arg 6, so `applyPostPaymentSideEffects`
(`src/invoices/payment.ts:100`, `payment.recorded` emitted at `:126`) writes to real Postgres.
`reversePayment` (`src/payments/payment-service.ts:290`, `payment.reversed` at `:441`) for the reversal file.

**What was added (test-only):**
- both racing credits now carry the audit repo; `payment.recorded` is read back per credit and matched against the
  `payments` rows by id and amount;
- a NEIGHBOUR tenant races its own payment in the same `Promise.all` — its money never lands on this tenant's
  balance or ledger, and neither tenant can read the other's invoice audit trail;
- duplicate-race: a replayed intent leaves exactly ONE `payment.recorded` (the duplicate delivery finds the invoice
  already consistent with the ledger, `repaired: false`, and must emit nothing), and the SAME provider reference in
  a neighbour tenant credits only that tenant — the partial unique index is `(tenant_id, reference_number)`;
- reversal: `payment.reversed` read back on the `payment` entity alongside the raced credit's `payment.recorded`,
  plus a new case (d) — a neighbour tenant can neither reverse this tenant's payment (NotFound, row still
  `completed`, invoice still paid) nor have its own reversal appear on this tenant's trail.
- hygiene: the fixture chains were lifted into per-file helpers so both tenants are seeded identically, and the
  now-unused module-level `customerId` in the reversal suite was deleted.

**Follow-up after review (xhawk-ai on PR #1055, Medium/Testing — a correct finding on my own tests):** the first
version of the two neighbour cases reused the suite-level invoice and depended on an earlier test's credit, so
they failed when run alone or shuffled. Reproduced before fixing:

```
$ … --reporter=verbose test/integration/payment-concurrent-credit.test.ts -t "neighbour"
 FAIL … a neighbour tenant's concurrent payment never counts toward this tenant's balance
AssertionError: expected 5000 to be 30000 // Object.is equality
$ … --reporter=verbose test/integration/payment-duplicate-race.test.ts -t "neighbour tenant"
 FAIL … the SAME provider reference in a neighbour tenant credits only that tenant
 - 1  + 0            (the count of rows for `pi_dup_race_1` under this tenant)
```

Both now seed their own invoices — and, in the duplicate-race case, their own first credit for a freshly generated
shared reference — inside the test. Green filtered AND whole:

```
 ✓ payment-concurrent-credit.test.ts > … > a neighbour tenant's concurrent payment never counts toward this tenant's balance 56ms
      Tests  1 passed | 1 skipped (2)
 ✓ payment-duplicate-race.test.ts > … > the SAME provider reference in a neighbour tenant credits only that tenant 63ms
      Tests  1 passed | 3 skipped (4)
 … full files: Tests 2 passed (2) · Tests 4 passed (4)
```

Every other test added by this lane was checked the same way (`-t` filtered, one at a time) and was already
self-contained: the reversal (d) case, the refunds RLS case, the webhook neighbour case, the void-link neighbour
case and the arithmetic neighbour case all pass alone.

**RED** (`payment-concurrent-credit`, deliberate: audit count 3 instead of 2; neighbour's 22000 claimed to leak in):

```
 × payment-concurrent-credit.test.ts > … > a $100 cash entry racing a $150 ACH webhook both credit the invoice (no lost update)
   → expected [ { …(10) }, { …(10) } ] to have a length of 3 but got 2
 × payment-concurrent-credit.test.ts > … > a neighbour tenant's concurrent payment never counts toward this tenant's balance
   → expected 30000 to be 52000 // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

**RED** (`payment-duplicate-race`, deliberate: the duplicate claimed to audit twice; the neighbour's 7000 claimed to
credit this tenant):

```
AssertionError: expected [ { …(10) } ] to have a length of 2 but got 1
AssertionError: expected 20000 to be 27000 // Object.is equality
      Tests  2 failed | 2 passed (4)
```

**RED** (`payment-reversal-concurrent`, deliberate: two `payment.reversed` events claimed; this tenant's payment
claimed to be flipped by the neighbour's attempt):

```
AssertionError: expected [ { …(10) } ] to have a length of 2 but got 1
AssertionError: expected 'completed' to be 'failed' // Object.is equality
      Tests  2 failed | 2 passed (4)
```

**GREEN:**

```
 ✓ payment-concurrent-credit.test.ts > … > a $100 cash entry racing a $150 ACH webhook both credit the invoice (no lost update) 38ms
 ✓ payment-concurrent-credit.test.ts > … > a neighbour tenant's concurrent payment never counts toward this tenant's balance 24ms
 Test Files  1 passed (1) · Tests  2 passed (2)

 ✓ payment-duplicate-race.test.ts > … > a second recordPayment for the same intent credits the invoice only once 41ms
 ✓ payment-duplicate-race.test.ts > … > a failed attempt does not block the later successful retry of the same intent 21ms
 ✓ payment-duplicate-race.test.ts > … > the raw duplicate INSERT is rejected by the partial unique index (23505) 4ms
 ✓ payment-duplicate-race.test.ts > … > the SAME provider reference in a neighbour tenant credits only that tenant 36ms
 Test Files  1 passed (1) · Tests  4 passed (4)

 ✓ payment-reversal-concurrent.test.ts > … > (a) a reversal racing a concurrent credit — both apply, no lost update 55ms
 ✓ payment-reversal-concurrent.test.ts > … > (b) a redelivery after a crash-before-decrement reopens the invoice from the ledger 38ms
 ✓ payment-reversal-concurrent.test.ts > … > (c) decrementAmountPaidAtomic clamps at 0 and leaves a terminal invoice untouched 17ms
 ✓ payment-reversal-concurrent.test.ts > … > (d) a neighbour tenant can neither reverse nor be touched by this tenant's reversal 50ms
 Test Files  1 passed (1) · Tests  4 passed (4)
```

**Evidence class:** PROVEN-REAL-DB, write **and** audit leg, three files / ten tests.
**Tenant grade:** T1 on each file — a second tenant is present, acts concurrently through the same code path and
the same pool, and is asserted not to cross (balance, ledger rows, audit reads). Not T3: neither tenant is
*differently configured* (same settings, same currency, same feature flags), so a config-divergence claim is not
made here.
**Grep (G4):** see [Tenant greps](#tenant-greps).

---

## Row 8.8 — a refund adjusts the record without lying · G1: 4−, T1, no audit

**File:** `test/integration/payment-refunds.test.ts`
**Seam driven:** `recordRefund` (`packages/api/src/payments/payment-service.ts:77`; the `payment.refunded` write is
`:146`) with the real `PgPaymentRepository` (the `recordRefundIdempotent` claim/increment CTE) and the real
`PgAuditRepository`.

**What was added (test-only):**
- the P0-4 interleave now reads `payment.refunded` back by entity: exactly TWO events for two applied refunds,
  each carrying its own delta and the new cumulative total (3000/3000 and 2000/5000), correlated by the Stripe
  refund id. The deduped redelivery returns **before** the audit write, so a third event would claim 8000 was
  refunded when 5000 was;
- "adjusts the record without lying" asserted against the RAW payment row: `amount_cents` still 10000 and `status`
  still `completed` after 5000 of refunds — only `refunded_amount_cents` moves;
- the RLS case gains its audit half: the refund is readable under this tenant, returns nothing under the
  neighbour, and the neighbour's rejected attempt writes neither a claim row nor an audit event.

**RED #1** (deliberate: the original payment's `amount_cents` claimed to have been rewritten to 5000):

```
 × payment-refunds.test.ts > … > P0-4 interleave: an earlier refund retried after a later refund is deduped
   → expected 10000 to be 5000 // Object.is equality
 × payment-refunds.test.ts > … > RLS: refund claims are invisible to another tenant
   → expected [] to have a length of 1 but got +0
      Tests  2 failed | 3 passed (5)
```

**RED #2** (the first assertion short-circuited the audit-count one, so it was re-run after correcting the first —
deliberate: three `payment.refunded` events claimed, i.e. the dedup audits too):

```
 × payment-refunds.test.ts > … > P0-4 interleave: an earlier refund retried after a later refund is deduped
   → expected [ { …(10) }, { …(10) } ] to have a length of 3 but got 2
      Tests  1 failed | 4 passed (5)
```

**GREEN:**

```
 ✓ payment-refunds.test.ts > … > P0-4 interleave: an earlier refund retried after a later refund is deduped 26ms
 ✓ payment-refunds.test.ts > … > two concurrent deliveries of one refund id apply exactly once (FOR UPDATE + unique claim) 17ms
 ✓ payment-refunds.test.ts > … > a rejected over-refund strands no claim row — a corrected retry still applies 14ms
 ✓ payment-refunds.test.ts > … > RLS: refund claims are invisible to another tenant 19ms
 ✓ payment-refunds.test.ts > … > migration 264 backfills legacy refund claims … 23ms
 Test Files  1 passed (1) · Tests  5 passed (5)
```

**Evidence class:** PROVEN-REAL-DB, write + audit leg.
**Tenant grade:** T1 (neighbour present on the RLS case, negative control on both the claim ledger and the audit
trail). Not T2/T3: the neighbour never successfully refunds its own payment in this file, so no "both tenants
refund concurrently" claim is made.

---

## Row 8.5 — ACH · stored card · off-session & card-present (reported as three halves, no blended rung)

### 8.5a ACH — confirmed, nothing changed

**File:** `test/integration/ach-webhook.test.ts` (unmodified by this lane; re-run to confirm).
**Seam driven:** the real Stripe webhook router `createWebhookRouter` (`src/webhooks/routes.ts`) over
`express.raw` with a signed body (`createWebhookSignature`), against `PgInvoiceRepository` / `PgPaymentRepository`
/ `PgAuditRepository` (`ach-webhook.test.ts:150-161`).
**Audit read-back cited:** `ach-webhook.test.ts:198-201` — `auditRepo.findByCorrelation(tenant, piId)` contains
`payment.processing` and `payment.recorded`; `:225-226` contains `payment.reversed` on the ACH-return leg.
**Neighbour cited:** `ach-webhook.test.ts:244-256` — "a processing payment row is rejected by neither the status
CHECK nor RLS (cross-tenant isolated)": `findByProviderReference(other.tenantId, piId)` is null.

```
$ RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose test/integration/ach-webhook.test.ts
 ✓ … processing → succeeded persists one completed payment + paid invoice + audit chain 87ms
 ✓ … processing → payment_failed reverses the in-flight credit and reopens the invoice 56ms
 ✓ … duplicate processing delivery does not double-credit 72ms
 ✓ … a processing payment row is rejected by neither the status CHECK nor RLS (cross-tenant isolated) 29ms
 Test Files  1 passed (1) · Tests  4 passed (4)
```

Evidence class: PROVEN-REAL-DB with audit. Tenant grade: T1. **G1's mark is confirmed as it stands; no change was
needed and none was made.**

### 8.5b Stored card on file — **the requested move is BLOCKED, and the row did not move**

The ticket asks for "the audit read-back" on `test/integration/customer-payment-methods.test.ts`.
**There is no audit event to read back.** Storing a card emits none:

- the storage path is the `setup_intent.succeeded` branch, `src/webhooks/routes.ts:1074`; it calls
  `deps.customerPaymentMethodRepo.create(...)` at `:1118` and then `logger.info('Saved customer payment method
  from setup_intent.succeeded', …)` at `:1135` — a log line, not an audit row;
- `PgCustomerPaymentMethodRepository.create` (`src/payments/pg-customer-payment-method.ts:38`) writes the row and
  nothing else;
- exhaustive grep over `packages/api/src` for emitted event types finds no payment-method event at all:
  `invoice.*` (11 kinds), `payment.credit_rejected|failed|processing|recorded|refunded|reversed|unapplied_capture`,
  `refund.recorded`, `terminal.payment_intent_created` — and nothing for a saved card. No
  `entityType: 'payment_method'` exists anywhere.

Emitting one is a change to webhook/payment code, which this lane is forbidden to make. So: **no test was written
that would look like the requested proof.** The row stays where G1 put it (4−, T1, no audit), with the blocker
named here and appended to `docs/audit/blocked-on-josh.md`. The existing file's T1 grep does match
(`customer-payment-methods.test.ts:77`, "does not leak across tenants"), and its `create`/`setDefault`/unique-index
assertions are real-Postgres — that part of G1's mark is confirmed.

A stronger proof is *available without touching money code* — driving `setup_intent.succeeded` through the real
webhook router at real Postgres with a neighbour tenant, as `invoice-webhook-paid` does — but it still cannot clear
the row's audit bar, so it is left for whoever lands the audit emission. Flagged, not built.

### 8.5c Charging off-session, and card-present — mocked; graded honestly, nothing built

- **Off-session charge:** `chargeOffSession` (`src/payments/stripe-saved-card.ts:184`) is fetch-based. Its only
  test, `test/payments/stripe-saved-card.test.ts`, injects a hand-written `StripeFetch` stub returning canned JSON.
  That proves our request shape (`Stripe-Account` header, `off_session=true`, metadata) — it proves **nothing**
  about Stripe's behaviour. A mocked client is not proof: the half stays at G1's 3.
- **Card-present (Terminal):** `createTerminalPaymentIntent` (`src/payments/stripe-terminal.ts:236`) and friends
  are tested the same way (`test/payments/stripe-terminal.test.ts`, `vi.fn()` fetcher). Per the ticket, **no
  Stripe Terminal proof was built** — it shares #1018's 5.5 finding (hardware + credentials).
- There are no Stripe test-mode credentials in this sandbox and **no Stripe cassette seam exists**: the repo's
  only record/replay layer is `CassetteLLMGateway` (`src/ai/voice-quality/cassette-gateway.ts`), which records
  **LLM** exchanges for the voice-quality runner — nothing under `src/payments`, `src/webhooks` or
  `src/invoices` references a cassette, and no HTTP-level recorder backs any Stripe call. Both halves are
  appended to `docs/audit/blocked-on-josh.md`.

---

## Row 8.7 — voiding an invoice kills its payment link · G1: unit-only, fake provider

**File (new):** `test/integration/invoice-void-payment-link.test.ts`
**Seam driven:** the production service `transitionInvoiceStatus` (`src/invoices/invoice.ts:539`), which calls
`deactivateInvoicePaymentLink` (`src/invoices/invoice-payment-link.ts:150`) and `cancelInvoicePaymentIntents`
(`src/invoices/invoice-payment-link.ts:295`) — armed exactly as the routes arm them (`opts.paymentLink.provider`,
`opts.auditRepo`, `opts.actor`) — against `PgInvoiceRepository` and the real `PgAuditRepository`. The link is
minted through the real `createInvoicePaymentLink` (`invoice-payment-link.ts:22`), so the guarded
`setPaymentLinkIfPayable` UPDATE (`src/invoices/pg-invoice.ts:470`) and the `clearPaymentLinkIfMatches` CAS
(`:500`) are both real SQL.

**What the provider seam actually is — precisely:**
- `MockPaymentLinkProvider` (`src/payments/payment-link-provider.ts:68`), the in-repo fake, for the link half. It
  records `active: false` on deactivate; `isActive(linkId)` is what the test reads.
- The Mock deliberately does **not** implement the optional `listInvoicePaymentIntents` / `cancelPaymentIntent`
  capability, so the PI sweep no-ops through it (`invoice-payment-link.ts:308-310`). The PI half therefore uses a
  test-local subclass (`PaymentIntentCapableFake`) that implements them and records the calls.
- **The Stripe-side call is RECORDED against the fake, not proven.** No test-mode key, and no Stripe cassette to
  replay (the repo's cassette layer is LLM-only — see 8.5c). Everything on our side of that seam — the SQL, the
  cleared columns, the audit rows, the tenant scoping — is real.

**RED** (deliberate: the link claimed to survive the void; the terminal `succeeded` PI claimed to be cancelled too;
the neighbour's link claimed to die with this tenant's):

```
 × … > void deactivates the hosted link, clears the real columns, and audits it
   AssertionError: expected false to be true   (provider.isActive(linkId) after the void)
 × … > void cancels the live PaymentIntents it finds and skips the terminal ones
   AssertionError: expected [ 'pi_live_secret' ] to deeply equal [ 'pi_live_secret', 'pi_already_paid' ]
 × … > a neighbour tenant's live link survives this tenant's void, and its void cannot be driven cross-tenant
   AssertionError: expected true to be false   (provider.isActive(theirLinkId))
 Test Files  1 failed (1) · Tests  3 failed (3)
```

**GREEN:**

```
 ✓ invoice-void-payment-link.test.ts > … > void deactivates the hosted link, clears the real columns, and audits it 43ms
 ✓ invoice-void-payment-link.test.ts > … > void cancels the live PaymentIntents it finds and skips the terminal ones 25ms
 ✓ invoice-void-payment-link.test.ts > … > a neighbour tenant's live link survives this tenant's void, and its void cannot be driven cross-tenant 37ms
 Test Files  1 passed (1) · Tests  3 passed (3)
```

Asserted: `stripe_payment_link_id` / `_url` go from set to NULL in the raw row while `status` becomes `void`;
`invoice.payment_link_deactivated` carries the link id, `reason: 'voided'` and the acting owner;
`invoice.payment_intent_canceled` carries `pi_live_secret` only; the failure events
(`…_deactivation_failed`, `…_clear_failed`, `…_cancel_failed`) are asserted ABSENT; a cross-tenant void returns
`null` and leaves the link live.

**Evidence class:** PROVEN-REAL-DB for the persistence + audit legs; **provider call RECORDED-AGAINST-FAKE** for
the Stripe leg.
**Tenant grade:** T1 — one provider instance holds both tenants' links, so a cross-tenant reach would be visible.

---

## Row 8.4 — pay from a link on the phone · G1: 3

**File:** `test/integration/invoice-webhook-paid.test.ts`
**Seam driven:** the real webhook router's `checkout.session.completed` branch (`src/webhooks/routes.ts:1170`,
crediting via `recordPayment` at `:1308`) over a signed raw body, with `PgInvoiceRepository`,
`PgPaymentRepository`, `PgWebhookRepository` and `PgAuditRepository`.

**What was added (test-only):**
- the settlement's `payment.recorded` (amount, payment id, the intent id as `correlationId`) and the single
  `open → paid` `invoice.status_changed`, read back by entity;
- the replay test now also asserts the deduped delivery leaves ONE `payment.recorded`, not two;
- a neighbour-tenant control: an event whose metadata names the NEIGHBOUR but carries THIS tenant's invoice id
  credits nothing — no invoice movement, no payment row under either tenant, no audit row — and the delivery is
  **not** ACKed as applied (HTTP 500, `webhook_events` row `failed`, so Stripe retries); then each tenant's own
  event credits only its own invoice, with the audit trails unreadable across the line;
- a pre-existing type error in this file's fixture was fixed (the seeded `ServiceLocation` was missing
  `addressType`; `tsc --project tsconfig.build.json` excludes tests, so it never reached the deploy build).

**RED** (deliberate: two `payment.recorded` claimed for one settlement; the cross-tenant event claimed to credit):

```
 × invoice-webhook-paid.test.ts > … > signed checkout.session.completed flips open invoice to paid (real columns)
   AssertionError: expected [ { …(10) } ] to have a length of 2 but got 1
 × invoice-webhook-paid.test.ts > … > an event naming a neighbour tenant credits nothing; …
   AssertionError: expected +0 to be 50000 // Object.is equality
 Test Files  1 failed (1) · Tests  2 failed | 2 passed (4)
```

**GREEN:**

```
 ✓ invoice-webhook-paid.test.ts > … > signed checkout.session.completed flips open invoice to paid (real columns) 69ms
 ✓ invoice-webhook-paid.test.ts > … > replay of the same Stripe event id does not double-apply (durable idempotency) 38ms
 ✓ invoice-webhook-paid.test.ts > … > Connect direct charge (payment_intent.succeeded with event.account) settles the real ledger + idempotent 36ms
 ✓ invoice-webhook-paid.test.ts > … > an event naming a neighbour tenant credits nothing; each tenant's own event credits only its own invoice 68ms
 Test Files  1 passed (1) · Tests  4 passed (4)
```

**Evidence class:** PROVEN-REAL-DB, write + audit leg, driven through the real signed-webhook surface.
**Tenant grade:** T1 with a genuine negative control (a mis-addressed event).
**Explicitly NOT proven here:** the embedded-elements half of this story is jsdom-only, and the hermetic
Playwright public-pay journey (the rung-5 claim: a phone-width browser reaching Pay Now with no SQL, no
platform-admin, no env var) is a **separate browser lane** — nothing in this file speaks to it.

---

## Row 8.13 — the arithmetic is exactly right · G1: 3 (unit fuzz)

**File (new):** `test/integration/invoice-server-total-persisted.test.ts`
**Seam driven:** the production `createInvoice` (`src/invoices/invoice.ts:311`, which normalizes every line at
`:322` via `normalizeLineItemTotals`) through `PgInvoiceRepository.create` (`src/invoices/pg-invoice.ts:22`, line
items at `:546`), with the persisted columns read back by RAW SQL — not the mapped object.
**The billing engine is NOT touched.** `calculateDocumentTotals` is called only as the ORACLE the persisted rows
are compared against.

This is the DB leg of I9's second clause ("`createInvoice` persists the server total, **discarding the client's**"),
which the unit fuzz (`test/shared/billing-engine.property.test.ts`) cannot reach because nothing there is
persisted. Every line item posted here carries a LYING client `totalCents`.

**RED** (deliberate: the non-taxed total claimed; the client's claimed line totals asserted to be what persisted;
a wrong neighbour total):

```
 × … > the client's line total is discarded: the fractional-quantity cent lands server-side
   AssertionError: expected 6508 to be 6012 // Object.is equality
 × … > 1000 randomized documents: …
   AssertionError: seed=0x5c0ffee iter=0: expected [ 152086, 180475, 19750, 45013, …(2) ] to deeply equal [ -1, -1, -1, -1, -1, -1 ]
 × … > a neighbour tenant's identical payload persists its own totals, invisible to this tenant
   AssertionError: expected 26609 to be 26440 // Object.is equality
 Test Files  1 failed (1) · Tests  3 failed (3)
```

**GREEN:**

```
 ✓ invoice-server-total-persisted.test.ts > … > the client's line total is discarded: the fractional-quantity cent lands server-side 15ms
 ✓ invoice-server-total-persisted.test.ts > … > 1000 randomized documents: every persisted money column is an integer, non-negative, and the engine's own number 3343ms
 ✓ invoice-server-total-persisted.test.ts > … > a neighbour tenant's identical payload persists its own totals, invisible to this tenant 11ms
 Test Files  1 passed (1) · Tests  3 passed (3)
```

What the 1000 documents assert, per document, after the round trip through Postgres and the `pg` driver:
every money column is an **integer**; `total_cents` and `amount_due_cents` are **non-negative**; each column
**equals the engine's own number**; and every persisted line total is `round(quantity × unitPriceCents)` — never
the client's claim (the claims cycle through `-1`, `0.5`, `999999999`, `7`). The exact P0-2 case is pinned
separately: `0.5 × 29¢` persists as the server's **15**, not the web UI's float-dollar **14**.

Iterations: 1000 (the PRD's "≥1000 randomized documents"), ~3.3 s. Seed `0x5c0ffee`, the unit suite's generator,
so a failure prints seed + iteration.

**Evidence class:** PROVEN-REAL-DB (the property now crosses the DB boundary).
**Tenant grade:** T1.
**Still true, and not claimed otherwise:** this is a seeded-PRNG fuzz, **not** a property-based test (no shrinking,
no generator combinators) — the same honest caveat the unit suite's own header carries. If the PRD's §8.13 wording
implies property-based testing, that wording is still wrong; what changed is only that the *persistence* clause now
has a real-DB proof.

---

## Artifact evidence (post-GREEN, kept container)

A plain Postgres container was started and kept, every touched file re-run against it with
`EXTERNAL_TEST_DB_URL`, then the rows dumped.

```
$ docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test \
    -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300
b787769ea052…   (port 32768)

$ EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
  RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/<each file>.test.ts
```

All eight files green against that container (29 tests):

```
######## payment-concurrent-credit        Tests  2 passed (2)
######## payment-duplicate-race           Tests  4 passed (4)
######## payment-reversal-concurrent      Tests  4 passed (4)
######## payment-refunds                  Tests  5 passed (5)
######## invoice-void-payment-link        Tests  3 passed (3)
######## invoice-webhook-paid             Tests  4 passed (4)
######## invoice-server-total-persisted   Tests  3 passed (3)
######## ach-webhook                      Tests  4 passed (4)
```

### audit_events

```
$ docker exec <cid> psql -U test -d serviceos_test -P pager=off -c "SELECT left(tenant_id::text,8), event_type, entity_type, count(*) FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"
   left   |            event_type            | entity_type | count 
----------+----------------------------------+-------------+-------
 5e89e4b9 | invoice.created                  | invoice     |     2
 82ff6d73 | invoice.created                  | invoice     |     1
 848b5b91 | invoice.payment_intent_canceled  | invoice     |     1
 848b5b91 | invoice.payment_link_deactivated | invoice     |     3
 2704cdae | invoice.status_changed           | invoice     |     5
 5c75294d | invoice.status_changed           | invoice     |     3
 64881625 | invoice.status_changed           | invoice     |     3
 76963276 | invoice.status_changed           | invoice     |     4
 774a7524 | invoice.status_changed           | invoice     |     1
 848b5b91 | invoice.status_changed           | invoice     |     3
 9451996a | invoice.status_changed           | invoice     |     1
 c3aafa6e | invoice.status_changed           | invoice     |     1
 cc40a7f5 | invoice.status_changed           | invoice     |     1
 e981505b | invoice.status_changed           | invoice     |     2
 2704cdae | payment.processing               | invoice     |     4
 2704cdae | payment.recorded                 | invoice     |     1
 5c75294d | payment.recorded                 | invoice     |     3
 64881625 | payment.recorded                 | invoice     |     3
 76963276 | payment.recorded                 | invoice     |     4
 774a7524 | payment.recorded                 | invoice     |     1
 9451996a | payment.recorded                 | invoice     |     1
 c3aafa6e | payment.recorded                 | invoice     |     1
 cc40a7f5 | payment.recorded                 | invoice     |     1
 e981505b | payment.recorded                 | invoice     |     1
 e73ccdb8 | payment.refunded                 | payment     |     3
 2704cdae | payment.reversed                 | payment     |     1
 64881625 | payment.reversed                 | payment     |     1
 e981505b | payment.reversed                 | payment     |     1
(28 rows)
```

Read it as the tenant separation it is: `5c75294d` (concurrency tenant) holds three `payment.recorded` while its
neighbour `c3aafa6e` holds exactly one — the neighbour's 22000; `774a7524` (duplicate-race tenant) holds ONE
despite the replay, while its neighbour `9451996a` holds its own one for the same provider reference;
`64881625` and its neighbour `e981505b` each hold their own single `payment.reversed`.
**No `payment_method.*` / saved-card event type appears anywhere — that is 8.5b's blocker, visible in the data.**

### payments

```
$ docker exec <cid> psql -U test -d serviceos_test -P pager=off -c "SELECT left(p.tenant_id::text,8) AS tenant, left(p.invoice_id::text,8) AS invoice, p.amount_cents, p.status, p.payment_method, p.reference_number, p.refunded_amount_cents, p.reversal_reason FROM payments p ORDER BY p.tenant_id, p.created_at;"
  tenant  | invoice  | amount_cents |   status   | payment_method |              reference_number               | refunded_amount_cents | reversal_reason 
----------+----------+--------------+------------+----------------+---------------------------------------------+-----------------------+-----------------
 2704cdae | d69e7268 |        10000 | completed  | bank_transfer  | pi_ad288ab7-b2ec-48e8-af08-0018ea8cfecc     |                     0 | 
 2704cdae | 8de7ff44 |        10000 | failed     | bank_transfer  | pi_1636038f-7bba-44ef-8852-521548166cf2     |                     0 | ach_return
 2704cdae | bb68059a |        10000 | processing | bank_transfer  | pi_c748f781-2c5b-4ee7-83bb-ede838785bff     |                     0 | 
 2704cdae | 2c2b37c7 |        10000 | processing | bank_transfer  | pi_233de606-27ae-4e88-b758-e33b9e7c0d88     |                     0 | 
 5c75294d | 489ca1e2 |        10000 | completed  | cash           | manual-cash-1                               |                     0 | 
 5c75294d | 489ca1e2 |        15000 | completed  | bank_transfer  | pi_ach_race_1                               |                     0 | 
 5c75294d | 489ca1e2 |         5000 | completed  | cash           | manual-cash-mine                            |                     0 | 
 64881625 | 8e7fbbf3 |        20000 | failed     | credit_card    | pi_rev_a_1                                  |                     0 | ach_return
 64881625 | 8e7fbbf3 |         5000 | completed  | cash           | manual_rev_a_2                              |                     0 | 
 64881625 | 92e6dff3 |        10000 | failed     | credit_card    | pi_rev_b_1                                  |                     0 | ach_return
 64881625 | 53059109 |         4000 | completed  | cash           | cash_rev_c                                  |                     0 | 
 64881625 | 4e59ba16 |        10000 | completed  | credit_card    | pi_rev_d_mine                               |                     0 | 
 76963276 | d241f377 |        50000 | completed  | credit_card    | pi_evt_7e10b9d8-0e94-4785-936a-1061de2befa8 |                     0 | 
 76963276 | 8d2b9a27 |        50000 | completed  | credit_card    | pi_evt_751d73a6-6f04-4970-865b-f4c6a8d2da04 |                     0 | 
 76963276 | 3eae2cb7 |        50000 | completed  | credit_card    | pi_evt_7f0e3943-e33e-4cd0-9e83-d1951c5edd59 |                     0 | 
 76963276 | 5ae6e2e9 |        50000 | completed  | credit_card    | pi_evt_83535709-65f1-4b8c-a032-0eba71c03a53 |                     0 | 
 774a7524 | 6371aeb3 |        10000 | completed  | credit_card    | pi_dup_race_1                               |                     0 | 
 774a7524 | 6371aeb3 |        10000 | failed     | credit_card    | pi_failed_then_ok                           |                     0 | 
 774a7524 | 6371aeb3 |        10000 | completed  | credit_card    | pi_failed_then_ok                           |                     0 | 
 774a7524 | 6371aeb3 |         5000 | completed  | credit_card    | pi_dup_race_2                               |                     0 | 
 9451996a | 5fb22b28 |         7000 | completed  | credit_card    | pi_dup_race_1                               |                     0 | 
 c3aafa6e | f6503cf3 |        22000 | completed  | bank_transfer  | pi_ach_neighbour                            |                     0 | 
 cc40a7f5 | ea3fe35c |        50000 | completed  | credit_card    | pi_evt_a1a1ad47-c862-4859-9a64-523a2a297f3e |                     0 | 
 d8f78411 | b2acfa7b |        10000 | completed  | credit_card    | pi_e133b975-2335-442a-a155-309154fff3a4     |                  3000 | 
 e73ccdb8 | 091c8470 |        10000 | completed  | credit_card    | pi_29d49cee-1d95-40ec-a793-d21026816b02     |                  5000 | 
 e73ccdb8 | 091c8470 |        10000 | completed  | credit_card    | pi_6fbcc2ad-432a-4a2b-b7f2-a9ea572c6ee6     |                  4000 | 
 e73ccdb8 | 091c8470 |        10000 | completed  | credit_card    | pi_e8da9503-7faf-47bf-b29b-80aa137870cc     |                 10000 | 
 e73ccdb8 | 091c8470 |        10000 | completed  | credit_card    | pi_6ec6102a-ddb1-4596-8fe4-c63b733a54bb     |                  1000 | 
 e981505b | 19de4b51 |        10000 | failed     | credit_card    | pi_rev_d_theirs                             |                     0 | ach_return
(29 rows)
```

Note rows `774a7524` and `9451996a`: the SAME `pi_dup_race_1` reference in two tenants, 10000 credited in one and
7000 in the other — the partial unique index is per-tenant, and neither credit crossed. And every refunded row
keeps `amount_cents = 10000` while `refunded_amount_cents` carries 5000 / 4000 / 10000 / 1000: the record is
adjusted, not rewritten (row 8.8's claim, in the data).

### payment_refunds

```
  tenant  | payment  | stripe_refund_id | amount_cents 
----------+----------+------------------+--------------
 d8f78411 | a8b42a97 | re_legacy_bf     |         3000
 e73ccdb8 | e193daf5 | re_pg_1          |         3000
 e73ccdb8 | e193daf5 | re_pg_2          |         2000
 e73ccdb8 | f69e4a57 | re_pg_conc       |         4000
 e73ccdb8 | 08a2d305 | re_pg_over       |        10000
 e73ccdb8 | 057410bb | re_pg_rls        |         1000
(6 rows)
```

One claim per distinct refund id; `re_pg_1` appears once despite being delivered twice. The neighbour tenant holds
no `re_pg_rls` claim.

### invoices (non-fuzz) — including the payment-link columns

```
  tenant  |      invoice_number       |     status     | subtotal_cents | tax_cents | total_cents | amount_paid_cents | amount_due_cents |        stripe_payment_link_id        
----------+---------------------------+----------------+----------------+-----------+-------------+-------------------+------------------+--------------------------------------
 2704cdae | INV-2c2b37c7              | paid           |          10000 |         0 |       10000 |             10000 |                0 | 
 2704cdae | INV-8de7ff44              | open           |          10000 |         0 |       10000 |                 0 |            10000 | 
 2704cdae | INV-bb68059a              | paid           |          10000 |         0 |       10000 |             10000 |                0 | 
 2704cdae | INV-d69e7268              | paid           |          10000 |         0 |       10000 |             10000 |                0 | 
 5c75294d | INV-RACE-1                | paid           |          30000 |         0 |       30000 |             30000 |                0 | 
 5e89e4b9 | INV-ARITH-f0bc8b7b        | draft          |           6012 |       496 |        6508 |                 0 |             6508 | 
 5e89e4b9 | INV-ARITH-MINE-84a15967   | draft          |          24690 |      2419 |       26609 |                 0 |            26609 | 
 64881625 | INV-REV-A                 | partially_paid |          30000 |         0 |       30000 |              5000 |            25000 | 
 64881625 | INV-REV-B                 | open           |          10000 |         0 |       10000 |                 0 |            10000 | 
 64881625 | INV-REV-C                 | void           |          10000 |         0 |       10000 |                 0 |            10000 | 
 64881625 | INV-REV-D                 | paid           |          10000 |         0 |       10000 |             10000 |                0 | 
 76963276 | INV-3eae2cb7              | paid           |          50000 |         0 |       50000 |             50000 |                0 | 
 76963276 | INV-5ae6e2e9              | paid           |          50000 |         0 |       50000 |             50000 |                0 | 
 76963276 | INV-8d2b9a27              | paid           |          50000 |         0 |       50000 |             50000 |                0 | 
 76963276 | INV-d241f377              | paid           |          50000 |         0 |       50000 |             50000 |                0 | 
 774a7524 | INV-DUP-1                 | paid           |          20000 |         0 |       20000 |             20000 |                0 | 
 82ff6d73 | INV-ARITH-THEIRS-fd776ce2 | draft          |          24690 |      2419 |       26609 |                 0 |            26609 | 
 848b5b91 | INV-VOID-A                | void           |          40000 |         0 |       40000 |                 0 |            40000 | 
 848b5b91 | INV-VOID-B                | void           |          25000 |         0 |       25000 |                 0 |            25000 | 
 848b5b91 | INV-VOID-C                | void           |          15000 |         0 |       15000 |                 0 |            15000 | 
 9451996a | INV-DUP-NEIGHBOUR         | partially_paid |          20000 |         0 |       20000 |              7000 |            13000 | 
 c3aafa6e | INV-RACE-NEIGHBOUR        | partially_paid |          30000 |         0 |       30000 |             22000 |             8000 | 
 cbf9cb28 | INV-VOID-C-NEIGHBOUR      | open           |          15000 |         0 |       15000 |                 0 |            15000 | 07328e43-1d9d-44d5-be8c-64e3227f3681
 cc40a7f5 | INV-ea3fe35c              | paid           |          50000 |         0 |       50000 |             50000 |                0 | 
 d8f78411 | INV-LEGACY-1              | open           |          10000 |         0 |       10000 |                 0 |            10000 | 
 e73ccdb8 | INV-REFUND-1              | open           |         100000 |         0 |      100000 |                 0 |           100000 | 
 e981505b | INV-REV-D-NEIGHBOUR       | open           |          10000 |         0 |       10000 |                 0 |            10000 | 
(27 rows)
```

Row 8.7 in one line of data: all three of tenant `848b5b91`'s invoices are `void` with a NULL link column, while
its neighbour `cbf9cb28` is still `open` and still carries a live link id.

### the 1000 fuzz documents

```
$ … -c "SELECT count(*) AS fuzz_invoices, count(*) FILTER (WHERE total_cents < 0) AS negative_totals, count(*) FILTER (WHERE total_cents <> subtotal_cents - discount_cents + tax_cents + COALESCE(processing_fee_cents,0)) AS identity_breaks, count(*) FILTER (WHERE total_cents <> trunc(total_cents)) AS non_integer_totals FROM invoices WHERE invoice_number LIKE 'INV-FUZZ-%';"
 fuzz_invoices | negative_totals | identity_breaks | non_integer_totals 
---------------+-----------------+-----------------+--------------------
          1000 |               0 |              18 |                  0
(1 row)

   invoice_number    | subtotal_cents | discount_cents | tax_cents | processing_fee_cents | total_cents | amount_due_cents 
---------------------+----------------+----------------+-----------+----------------------+-------------+------------------
 INV-FUZZ-0-323b81aa |         692787 |           9654 |     34951 |                10269 |      728353 |           728353
 INV-FUZZ-1-aa7bf0c0 |         269713 |          17866 |        14 |                 7732 |      259593 |           259593
 INV-FUZZ-2-1e3d779a |         144995 |           6330 |         0 |                 1470 |      140135 |           140135
 INV-FUZZ-3-4f61c1b8 |         473266 |          10147 |     22913 |                 3062 |      489094 |           489094
 INV-FUZZ-4-1003c0c8 |         273524 |            833 |     10835 |                 6011 |      289537 |           289537
(5 rows)
```

The 18 "identity breaks" are **all** the documented zero-clamp, verified rather than assumed:

```
 breaks | explained_by_zero_clamp 
--------+-------------------------
     18 |                      18
(1 row)

    invoice_number     | subtotal_cents | discount_cents | tax_cents | processing_fee_cents | total_cents 
-----------------------+----------------+----------------+-----------+----------------------+-------------
 INV-FUZZ-29-21e248b6  |           4102 |          10230 |         0 |                    0 |           0
 INV-FUZZ-83-49128187  |           4000 |          11595 |         0 |                    0 |           0
 …
```

i.e. a discount larger than the subtotal persists as `total_cents = 0` (the engine's `Math.max(0, …)`), with
`discount_cents` still recorded above the subtotal. That is the engine's documented behaviour and the unit
property test asserts it; it is flagged below as an observation, not claimed as a defect.

### audit metadata spot-check

```
            event_type            |                                            metadata                                            
----------------------------------+------------------------------------------------------------------------------------------------
 invoice.payment_intent_canceled  | {"reason": "voided", "stripeAccountId": null, "stripePaymentIntentId": "pi_live_secret"}
 invoice.payment_link_deactivated | {"reason": "voided", "stripePaymentLinkId": "b12c5d10-ab3c-4485-95cb-98655e264170"}
 invoice.payment_link_deactivated | {"reason": "voided", "stripePaymentLinkId": "e6128bf8-89c7-4be9-88bf-26dc14674e29"}
 invoice.payment_link_deactivated | {"reason": "voided", "stripePaymentLinkId": "ac91c986-1b0a-44f3-ad7d-1dc2f5f703ff"}
 payment.refunded                 | {"paymentId": "e193daf5-…", "refundCents": 3000, "stripeRefundId": "re_pg_1", "totalRefundedCents": 3000}
 payment.refunded                 | {"paymentId": "e193daf5-…", "refundCents": 2000, "stripeRefundId": "re_pg_2", "totalRefundedCents": 5000}
 payment.refunded                 | {"paymentId": "057410bb-…", "refundCents": 1000, "stripeRefundId": "re_pg_rls", "totalRefundedCents": 1000}
(7 rows)
```

---

## Tenant greps

`grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" <file>` — first matches per
touched file (full output in the run log):

```
### test/integration/payment-concurrent-credit.test.ts
40:  let otherTenant: { tenantId: string; userId: string };
135:    otherTenantInvoiceId = await seedOpenInvoice(otherTenant, 'RACE-NEIGHBOUR', 30000);
214:      tenantId: otherTenant.tenantId,

### test/integration/payment-duplicate-race.test.ts
42:  let otherTenant: { tenantId: string; userId: string };
136:    otherTenantInvoiceId = await seedOpenInvoice(otherTenant, 'DUP-NEIGHBOUR', 20000);
245:    expect(neighbour.payment.tenantId).toBe(otherTenant.tenantId);

### test/integration/payment-reversal-concurrent.test.ts
40:  let otherTenant: { tenantId: string; userId: string };
109:    otherTenantJobId = await seedJobChain(otherTenant, 'REV-NEIGHBOUR');
315:        { tenantId: otherTenant.tenantId, paymentId: mine.id, reason: 'dispute' },

### test/integration/payment-refunds.test.ts
12: *  4. RLS: the claim ledger is invisible cross-tenant
258:  it('RLS: refund claims are invisible to another tenant', async () => {
266:    const otherTenant = await createTestTenant(pool);
285:    expect(await auditRepo.findByEntity(otherTenant.tenantId, 'payment', payment.id)).toEqual([]);

### test/integration/invoice-void-payment-link.test.ts
80:  let otherTenant: { tenantId: string; userId: string };
286:  it("a neighbour tenant's live link survives this tenant's void, and its void cannot be driven cross-tenant", …
305:    const theirLinkId = (await linkColumns(otherTenant.tenantId, theirInvoiceId)).id!;

### test/integration/invoice-webhook-paid.test.ts
51:  let otherTenant: { tenantId: string; userId: string };
313:          metadata: { tenant_id: otherTenant.tenantId, invoice_id: mineInvoiceId },
358:      (await invoiceRepo.findById(otherTenant.tenantId, theirInvoiceId))?.amountPaidCents,

### test/integration/invoice-server-total-persisted.test.ts
73:  let otherTenant: { tenantId: string; userId: string };
166:    otherTenantJobId = await seedJobChain(otherTenant, 'ARITH-NEIGHBOUR');
333:    expect(await invoiceRepo.findById(otherTenant.tenantId, mine.id)).toBeNull();

### test/integration/ach-webhook.test.ts          (unmodified — cited for 8.5a)
244:  it('a processing payment row is rejected by neither the status CHECK nor RLS (cross-tenant isolated)', …
253:    // ...but is invisible to another tenant (RLS).

### test/integration/customer-payment-methods.test.ts   (unmodified — 8.5b, blocked)
77:  it('does not leak across tenants', async () => {
```

---

## Not done / judgment calls

1. **8.5b's audit read-back was not written, because there is nothing to read.** Saving a card emits no audit
   event anywhere in the codebase (see 8.5b above for the three greps that establish it). Adding the emission is a
   webhook/payment-code change, which this lane is forbidden to make. I did **not** write a test that would pass
   while looking like the requested proof, and I did not write a negative test asserting the absence (that would
   lock the gap in). The row stays as G1 marked it.
2. **No Stripe Terminal proof was built** (explicitly out of scope per the ticket; shares #1018's 5.5 finding), and
   **no off-session charge proof** — both are credential/hardware blocked, appended to `blocked-on-josh.md`.
3. **No Stripe cassette layer was introduced.** The repo's only record/replay layer is `CassetteLLMGateway`
   (LLM exchanges for the voice-quality runner); nothing records Stripe HTTP. Building an HTTP recorder for a
   money lane is a product/infra decision, not a test change. Where a fake is the only seam, the report says
   "recorded, not proven".
4. **No rung is stated anywhere in this report**, per the map's rule — including for rows whose evidence obviously
   improved. Fable grades; the §12.4d checks (*evidence not source · directory is not proof · mocked is not proven
   · a doc-comment is not a wiring*) should find every claim above tied to a command and its raw output.
5. **T3 is not claimed on any row.** Every neighbour tenant here is configured identically to the tenant under
   test; proving a *differently configured* neighbour is a separate, larger fixture change.
6. **Rung 5 is not claimed on 8.4.** The hermetic public-pay browser journey is a separate lane; the
   embedded-elements half remains jsdom-only.
7. **One unrelated fix rode along:** `invoice-webhook-paid.test.ts`'s fixture was missing `addressType` on its
   seeded `ServiceLocation`, a pre-existing `tsc` error in the test lane (the deploy build excludes tests). Fixed
   because the file was already being edited.
8. **The `payment_intent.processing` rows under tenant `2704cdae` in the dump** come from the unmodified
   `ach-webhook` file, re-run for the 8.5a confirmation — they are not new coverage.

## Money defects found and NOT fixed (surfaced, not answered)

1. **Saving a customer payment method writes no audit event.** `src/webhooks/routes.ts:1074-1139` stores a card
   (ids, brand, last4, expiry, default flag, and the Connect account it lives on) and records the fact with
   `logger.info` only. Every other money mutation in this system emits an audit event; this one — which arms
   later off-session charging — does not, so there is no durable, tenant-scoped record of who put a chargeable
   instrument on file or when. Not fixed: money/webhook code is out of bounds for this lane. This is the single
   thing blocking 8.5b from its audit read-back.
2. **Observation, not a defect — an over-discount silently absorbs the excess.** 18 of the 1000 fuzz documents
   persist `total_cents = 0` with `discount_cents` exceeding `subtotal_cents` (raw data above). That is the
   engine's documented `Math.max(0, …)` clamp and the unit property test asserts it, so nothing here is wrong
   against the spec — but the persisted row then does not satisfy
   `total = subtotal − discount + tax + fee`, and any reconciliation that assumes the identity will flag these.
   Whether an over-discount should be rejected, clamped-and-recorded, or left as-is is a product call. Discount
   math is untouchable on this map (Q12), so it is noted here and nowhere else.
3. **A mis-addressed Stripe event is retried forever, by construction.** In `invoice-webhook-paid`'s new
   cross-tenant case, an event carrying tenant B's `tenant_id` with tenant A's `invoice_id` raises
   `ValidationError('Invoice not found')`, which falls through the branch's `else { throw payErr }`
   (`src/webhooks/routes.ts:1404-1408`) to the outer catch at `:2465` — webhook row `failed`, HTTP 500, so Stripe
   retries on a permanent condition. That is the *safe* direction (never credit the wrong tenant) and the test
   pins the no-credit behaviour, so nothing was changed; flagged only because a permanently-500ing event id is a
   reconciliation smell an operator should be able to see.

---

*Every command in this report was run on this branch in the cloud sandbox; the raw output is quoted as produced.
Prior learnings for this area live in `docs/solutions/`. Fable reviews every row; only Fable states a new rung.*
