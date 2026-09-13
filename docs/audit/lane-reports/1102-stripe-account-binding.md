# SECURITY #1102 — Stripe settlements bound to the tenant's own connected account

**Lane:** Opus implementer, isolated worktree, branch `local/fix-stripe-webhook-account-binding`
**Base:** `origin/main` @ `d6e59ad19` (PR #1103 already MERGED, so no cherry-pick was needed)
**Issue:** #1102 · raised from the §8.5 lane's F5 finding (PR #1097 / batch #1100), see
`docs/audit/lane-reports/execute-8-5-terminal.md` §F5
**Scope:** money path only. No RLS policy changes, no migrations, no route renames.

---

## 1. The mechanism

Every Stripe settlement branch in `packages/api/src/webhooks/routes.ts` decided *whose*
invoice to credit from the event payload's own metadata, and nothing else:

```ts
const tenantId = pi.metadata?.tenant_id;
const invoiceId = pi.metadata?.invoice_id;
```

`event.account` — the connected account the money actually landed in — was never read on any
of those paths. Before this change the only `event.account` read in the whole 2,722-line file
was the unrelated `payment_method.attached` / `setup_intent.succeeded` branch, and the file
never resolved a tenant's own `tenants.stripe_connect_account_id` at all (`grep`: zero hits).

The signature check does not help. `verifyWebhookSignatureAny` proves **Stripe** sent the
event; it says nothing about **whose account earned the money**. Both facts are true at once
for a genuine, correctly-signed delivery from an attacker's own connected account.

**The attack.** Any tenant holding a connected account on this platform creates a
PaymentIntent **on their own account** whose metadata names a neighbour's `tenant_id` and
`invoice_id`. Stripe delivers a real, correctly-signed `payment_intent.succeeded` from the
Connected-accounts destination. The handler marks the neighbour's invoice **paid**, writes a
completed `payments` row (`created_by = stripe_webhook`) and `payment.recorded` +
`invoice.status_changed` audit rows — while the cash sits in the attacker's Stripe balance.
The victim need never have enabled Connect at all.

### Affected branches (line numbers as of this branch, post-fix)

| Branch | `if` at | What it does with the money |
| --- | --- | --- |
| `checkout.session.completed` | `routes.ts:1333` | credits a job deposit **or** settles the invoice |
| `payment_intent.processing` | `routes.ts:1604` | credits an in-flight ACH debit |
| `payment_intent.succeeded` | `routes.ts:1712` | settles the invoice / flips an in-flight row to completed |
| `payment_intent.payment_failed` | `routes.ts:1916` | **reverses** a settled payment and reopens the invoice |

The fourth is the one the issue did not spell out but matters just as much: an unbound
`payment_failed` is a *vandalism* vector, not a mis-credit — it reopens a paid invoice and
reverses a legitimate payment.

---

## 2. The seam

One helper trio at the top of `createWebhookRouter`, called by every branch above **before any
invoice or payment write**:

| Symbol | `routes.ts` | Role |
| --- | --- | --- |
| `STRIPE_ACCOUNT_MISMATCH` | `:347` | the single reason string — response body, audit row, `error_message` |
| `resolveTenantConnectAccountId(tenantId)` | `:372` | the tenant's own `stripe_connect_account_id`, or `null` |
| `assertEventAccountBelongsToTenant(event, tenantId)` | `:411` | the decision |
| `refuseUnboundStripeEvent(res, webhookEventId, ctx)` | `:431` | the refusal: 403 + audit + `webhook_events` status |

### The decision

```
no `event.account`   → PLATFORM-ORIGIN. Unchanged, deliberately. Stripe only stamps
                       `account` on deliveries from a Connected-accounts destination,
                       so there is nothing to bind against and platform payments must
                       not regress.
account === tenant's own stripe_connect_account_id → settle, exactly as before.
anything else        → REFUSE. This single arm covers BOTH a neighbour's account and a
                       tenant that never enabled Connect (the original report's victim).
```

### Resolution order, and why it fails closed

`resolveTenantConnectAccountId` tries three sources, all of which read the **same**
`tenants.stripe_connect_account_id` column, because the router is wired differently in
production and in the various harnesses:

1. `deps.connectAccountResolver` — what `app.ts:1108-1124` already wires into the webhook
   router deps (`webhookRouterDeps.connectAccountResolver = connectAccountResolver`). This is
   the production path; no new dependency was added to ship the fix.
2. `deps.connectService` — `StripeConnectService.getAccount()` directly.
3. `deps.pool` — the column, read straight, guarded by `isValidTenantId`.

A tenant we cannot find owns no connected account, so an unknown or malformed tenant id
resolves to `null` and the caller refuses (`NotFoundError` is caught for exactly this; any
other error is rethrown so a genuine pool outage still becomes a retryable 500 rather than a
silent refusal of a real payment). Nothing wired at all likewise resolves to `null`: a
deployment with no Connect wiring has no connected accounts, so an `event.account` on it can
never belong to one of our tenants. Both are **fail-closed by construction**.

Resolved at most once per event: the settlement branches are mutually exclusive
`if (event.type === …)` arms, and in `checkout.session.completed` the single call sits ahead of
both the deposit credit and the invoice credit.

### The refusal outcome

| Surface | Value | Why |
| --- | --- | --- |
| HTTP | `403` + `{"error":"Forbidden","reason":"stripe_account_mismatch"}` | 4xx-class as #1102 asked. Never a 500 — a 500 is indistinguishable from an outage, and it is what the old code did on the adjacent cross-tenant case (`'Invoice not found'` thrown deep in the settlement path), making Stripe retry an event that can never succeed. |
| Audit | `webhook.auth_failed`, `entity_type='webhook'`, `entity_id='stripe_account_mismatch'`, `correlation_id=<stripe event id>`, metadata `{reason, stripeEventId, stripeEventType, eventAccount, tenantConnectAccountId, invoiceId}` | Written on the **named (victim) tenant**, so the victim can see the attempt. Best-effort (a failed audit write must not turn a correctly-refused event into a 500) and skipped for a malformed tenant id. |
| `webhook_events` | `status='failed'`, `processed_at` **null**, `error_message` naming the reason and both accounts | See below. |

**Which status, and why.** The column's CHECK allows only
`received | processing | processed | failed`. `processed` would be a lie — it is what the
settlement path writes and what `processed_at` stamps. `received`/`processing` would leave the
row retry-swept (`findRetryable` returns `WHERE status = 'received'`). `failed` is the only
member of the existing vocabulary that is terminal-but-not-settled: `processed_at` stays null,
the sweep ignores it, and `handleWebhookEvent`'s dedup treats it as retry-eligible — which is
correct here, because Stripe retries a non-2xx and the retry must be *refused again*, which is
pinned as a test.

**Deviation from the issue text:** #1102 suggested an audit `webhook.rejected`. This uses
`webhook.auth_failed`, the type the file's existing `rejectBound` helper (`routes.ts`, Twilio /
Vapi cross-tenant refusals) already writes for precisely this semantic — a signed webhook
refused because it is not bound to the tenant it names. One vocabulary, one query. Flag at
review if you want the new type instead.

---

## 3. RED → GREEN

All runs at real Postgres (`pgvector/pgvector:pg16`, colima), `RLS_RUNTIME_ROLE=true`.

### RED — 1. the pinned defect, flipped to a plain `it` on today's code

`test/integration/stripe-terminal-doorstep.test.ts`, `it.fails` → `it`, no source changes:

```
 × test/integration/stripe-terminal-doorstep.test.ts > Postgres integration — 5.5 doorstep card (Stripe Terminal) > PRODUCT DEFECT: a connected account can settle ANOTHER tenant's invoice — event.account is never validated 33ms
   → expected 'paid' to be 'open' // Object.is equality

 FAIL  test/integration/stripe-terminal-doorstep.test.ts > ... > PRODUCT DEFECT: a connected account can settle ANOTHER tenant's invoice — event.account is never validated
AssertionError: expected 'paid' to be 'open' // Object.is equality

Expected: "open"
Received: "paid"

 ❯ test/integration/stripe-terminal-doorstep.test.ts:782:37
    780|       // WHAT HAPPENS TODAY — the invoice is 'paid' and a payments row…
    781|       const victimInvoice = await invoiceRepo.findById(noConnect.tenan…
    782|       expect(victimInvoice?.status).toBe('open');
       |                                     ^

 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

The webhook log line above the failure is the defect in one line — the victim tenant
(`1a0c9abb…`, which has no connected account) settled from the attacker's intent:

```
{"level":"info","message":"Invoice marked paid via payment_intent.succeeded (async settlement)","tenantId":"1a0c9abb-be2a-41e2-8bd7-7ec272bb4816","invoiceId":"faed52f5-de7b-4ceb-b2c5-308f34085736","amountCents":24500,"paymentIntentId":"pi_term_attacker_4fe0ee923a82"}
```

### RED — 2. the new seam file, on today's code

`test/integration/stripe-webhook-account-binding.test.ts` (new), no source changes:

```
 Test Files  1 failed (1)
      Tests  9 failed | 7 passed (16)
```

Every **refusal** case fails; every **settle / platform-origin control** case already passes —
which is the point: the fix must add a refusal without moving the settle paths. Representative
failures:

```
 FAIL  … > payment_intent.succeeded > REFUSES a delivery whose event.account is another tenant's, when the named tenant HAS its own account
AssertionError: expected 200 to be 403 // Object.is equality
- Expected
+ Received
- 403
+ 200

 FAIL  … > audits the refusal under the NAMED tenant, not the account owner — the victim can see the attempt
AssertionError: expected 'invoice.status_changed' to be 'webhook.auth_failed' // Object.is equality
Expected: "webhook.auth_failed"
Received: "invoice.status_changed"

 FAIL  … > a refused delivery is retried-and-refused deterministically — never settled on the retry
AssertionError: expected 200 to be 403 // Object.is equality
```

### GREEN — the seam file

```
 ✓ … > payment_intent.succeeded > REFUSES a delivery whose event.account is another tenant's, when the named tenant HAS its own account 47ms
 ✓ … > payment_intent.succeeded > REFUSES a delivery on a connected account when the named tenant never enabled Connect 25ms
 ✓ … > payment_intent.succeeded > SETTLES a delivery on the tenant's OWN connected account 40ms
 ✓ … > payment_intent.succeeded > SETTLES a PLATFORM-ORIGIN delivery with no event.account at all (control) 31ms
 ✓ … > checkout.session.completed > REFUSES a delivery whose event.account is another tenant's, when the named tenant HAS its own account 23ms
 ✓ … > checkout.session.completed > REFUSES a delivery on a connected account when the named tenant never enabled Connect 23ms
 ✓ … > checkout.session.completed > SETTLES a delivery on the tenant's OWN connected account 31ms
 ✓ … > checkout.session.completed > SETTLES a PLATFORM-ORIGIN delivery with no event.account at all (control) 32ms
 ✓ … > payment_intent.processing (ACH in-flight) > REFUSES a delivery whose event.account is another tenant's, when the named tenant HAS its own account 21ms
 ✓ … > payment_intent.processing (ACH in-flight) > REFUSES a delivery on a connected account when the named tenant never enabled Connect 22ms
 ✓ … > payment_intent.processing (ACH in-flight) > CREDITS an in-flight debit on the tenant's OWN connected account 34ms
 ✓ … > payment_intent.processing (ACH in-flight) > CREDITS a PLATFORM-ORIGIN in-flight debit with no event.account at all (control) 29ms
 ✓ … > payment_intent.payment_failed > REFUSES an unbound delivery instead of reversing the tenant's settled payment 37ms
 ✓ … > payment_intent.payment_failed > still records a PLATFORM-ORIGIN decline with no event.account (control) 20ms
 ✓ … > audits the refusal under the NAMED tenant, not the account owner — the victim can see the attempt 13ms
 ✓ … > a refused delivery is retried-and-refused deterministically — never settled on the retry 22ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

### GREEN — the two files the brief named

```
 ✓ … 5.5 doorstep card (Stripe Terminal) > no Connect account: tap-to-pay is refused with a clean coded 409 and writes nothing 42ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > no Connect account: minting a connection token is refused the same way, writing nothing 3ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > T1 cross-tenant: another tenant's active Connect account does not satisfy tenant A's gate 30ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > connected tenant: the Terminal session persists a real location id + audit row 12ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > connected tenant: card_present intent → signed webhook settles the invoice at real Postgres 63ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > an UNSIGNED delivery of the same terminal capture credits nothing 25ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > T1 cross-tenant on settlement: a terminal intent naming another tenant credits nothing 56ms
 ✓ … 5.5 doorstep card (Stripe Terminal) > a connected account can NO LONGER settle another tenant's invoice — event.account is validated (#1102) 23ms
 ✓ … W1-2 invoice webhook → paid > signed checkout.session.completed flips open invoice to paid (real columns) 51ms
 ✓ … W1-2 invoice webhook → paid > replay of the same Stripe event id does not double-apply (durable idempotency) 36ms
 ✓ … W1-2 invoice webhook → paid > Connect direct charge (payment_intent.succeeded with event.account) settles the real ledger + idempotent 44ms
 ✓ … W1-2 invoice webhook → paid > a connected-origin event on an account this tenant does not own credits nothing (#1102) 24ms
 ✓ … W1-2 invoice webhook → paid > an event naming a neighbour tenant credits nothing; each tenant's own event credits only its own invoice 75ms

 Test Files  2 passed (2)
      Tests  13 passed (13)
```

### GREEN — every integration file that touches these events

`grep -rl 'payment_intent.succeeded\|checkout.session.completed' test/integration` — all ten,
in one run:

```
 Test Files  10 passed (10)
      Tests  62 passed (62)
```

(`stripe-terminal-doorstep`, `invoice-webhook-paid`, `stripe-webhook-account-binding`,
`webhooks`, `flow2-money-loop-runthrough`, `ach-webhook`, `money-reconciliation`,
`payment-duplicate-race`, `signup-to-paid-critical-path`, `deposit-concurrent-credit`.)

### GREEN — unit

`npx vitest run test/webhooks test/payments`:

```
 Test Files  37 passed (37)
      Tests  294 passed (294)
```

### Typecheck

```
$ npx tsc --project tsconfig.build.json --noEmit
(no output — clean)

$ npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c webhooks
3
```

The brief's target for that second count is 0. The 3 are **pre-existing on `origin/main`**, in
two files this branch never touches (`git diff --name-only origin/main` confirms):
`test/webhooks/clerk-invitee-pool-null.test.ts` (TS2307 missing `../../src/config`, TS2352 bad
`PendingInvitation` cast) and `test/webhooks/clerk-welcome-email.test.ts` (TS2740 partial
`Queue` stub). All three are Clerk-side and unrelated to this seam. Count attributable to this
change: **0**.

---

## 4. Runtime drive (the artifact of the effect)

Nothing here is a test runner. The real API booted against the kept container and was driven
with `curl` over three genuinely HMAC-signed bodies.

**Setup.** `pgvector/pgvector:pg16` on `127.0.0.1:32826`, migrations applied by the integration
global-setup path (`EXTERNAL_TEST_DB_URL`). Two tenants seeded via `psql`:

- **A** `aaaaaaaa-1102-…-0001` — `stripe_connect_account_id = 'acct_runtime_A'`, charges enabled.
- **B** `bbbbbbbb-1102-…-0002` — **no** connected account (the never-Connected victim).

Each with one open $250.00 invoice. API booted with:

```
NODE_ENV=dev DEV_AUTH_BYPASS=true PORT=3101 LOG_LEVEL=info \
DATABASE_URL=postgres://test:test@localhost:32826/serviceos_test DB_SSL=false \
STRIPE_WEBHOOK_SECRET=whsec_local_1102 npx tsx src/index.ts
```

```
$ curl -s http://localhost:3101/health
{"status":"ok","version":"1.0.0","environment":"dev","timestamp":"2026-09-13T02:58:07.737Z","checks":{"database":{"status":"ok"},"drain":{"status":"ok"}}}
```

Bodies signed with the scheme the route verifies (`createWebhookSignature`:
`t=<unix>,v1=HMAC_SHA256(secret, "<t>.<body>")`).

### BEFORE

```
 invoice_number | status | amount_paid_cents | amount_due_cents
----------------+--------+-------------------+------------------
 INV-A2-1102    | open   |                 0 |            25000
 INV-B2-1102    | open   |                 0 |            25000

 payments: 0   audit_events: 0   webhook_events (evt_runtime_1102_r2%): 0
```

### (i) A's connected account + **B's** metadata — the attack

```
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3101/webhooks/stripe \
    -H "content-type: application/json" \
    -H "stripe-signature: $(cat /tmp/sig-r2-i.txt)" --data-binary @/tmp/body-r2-i.json
{"error":"Forbidden","reason":"stripe_account_mismatch"}
HTTP 403
```

Dump taken **immediately after (i)**, before anything else was delivered:

```
 invoice_number | status | amount_paid_cents | amount_due_cents
----------------+--------+-------------------+------------------
 INV-A2-1102    | open   |                 0 |            25000
 INV-B2-1102    | open   |                 0 |            25000        ← victim untouched

 payments_for_b2
-----------------
               0

       event_type        | entity_type |        entity_id        |         reason          | event_account  | tenant_account
-------------------------+-------------+-------------------------+-------------------------+----------------+----------------
 webhook.auth_failed     | webhook     | stripe_account_mismatch | stripe_account_mismatch | acct_runtime_A | (null)

   idempotency_key    | status | processed_at |                    error_message
----------------------+--------+--------------+------------------------------------------------------
 evt_runtime_1102_r2i | failed |  (null)      | stripe_account_mismatch: event.account 'acct_runtime_A' is not tenant bb…
```

### (ii) A's connected account + **A's** metadata — legitimate

```
{"received":true}
HTTP 200
```

### (iii) **no** `event.account` + B's metadata — platform-origin control

```
{"received":true}
HTTP 200
```

### AFTER

```
 invoice_number | status | amount_paid_cents | amount_due_cents
----------------+--------+-------------------+------------------
 INV-A2-1102    | paid   |             25000 |                0
 INV-B2-1102    | paid   |             25000 |                0

 invoice_number |  status   | amount_cents |     reference_number      |   created_by
----------------+-----------+--------------+---------------------------+----------------
 INV-A2-1102    | completed |        25000 | pi_evt_runtime_1102_r2ii  | stripe_webhook
 INV-B2-1102    | completed |        25000 | pi_evt_runtime_1102_r2iii | stripe_webhook

    idempotency_key     |  status   | processed
------------------------+-----------+-----------
 evt_runtime_1102_r2i   | failed    | f     ← the attack: refused, never processed
 evt_runtime_1102_r2ii  | processed | t
 evt_runtime_1102_r2iii | processed | t
```

Read the `reference_number` column, not just the status: B's invoice is paid by
`pi_…_r2iii` — its **own platform-origin** payment — and never by `pi_…_r2i`, the attack. The
attack left no payments row at all.

---

## 5. What changed

| File | Change |
| --- | --- |
| `packages/api/src/webhooks/routes.ts` | the seam (`:347`, `:372`, `:411`, `:431`) + four call sites (`:1374`, `:1621`, `:1727`, `:1930`) |
| `packages/api/test/integration/stripe-webhook-account-binding.test.ts` | **new** — the seam's real-Postgres proof, 16 cases |
| `packages/api/test/integration/stripe-terminal-doorstep.test.ts` | `it.fails` → `it` + strengthened; `connectAccountResolver` wired as `app.ts` does; the T1 settlement case's pinned `500` → `403` |
| `packages/api/test/integration/invoice-webhook-paid.test.ts` | the U6 connected-origin event now names an account the tenant actually owns (seeded for real); `connectAccountResolver` wired; new negative case |
| `packages/api/test/webhooks/stripe-payment-events.test.ts` | U6 block gets a resolver; new `#1102` block incl. the fail-closed-when-unwired case |

Two test-harness updates deserve a reviewer's eye, because in both the *old* assertion was
asserting the vulnerable behaviour:

1. **`invoice-webhook-paid.test.ts` U6.** It posted `account: 'acct_connect_w1_2_integration'`
   for a tenant whose `stripe_connect_account_id` was **null**, and asserted it settled. That
   is the #1102 attack shape, pinned as a feature ("a connected-origin event must credit the
   ledger identically to a platform one"). The tenant now really owns that account, so the
   test proves what it meant to; the shape it used to assert is now a new negative case.
2. **`stripe-terminal-doorstep.test.ts` T1 settlement.** Its `expect(cross.status).toBe(500)`
   was explicitly pinned as "TODAY'S behaviour, pinned as an observation, not endorsed",
   with a note that a lane barred from touching money code could not change it. This lane is
   not barred; it is now `403` and the file says why. The row's real invariant (nothing
   credited to either tenant) is unchanged and still asserted.

---

## 6. Not done / residual

- **Refund and dispute branches are NOT guarded.** `charge.refunded` (`:2310`),
  `charge.refund.updated` (`:2475`) and `charge.dispute.created` (`:2588`) also touch money and
  also take a tenant from Stripe-supplied data. They were left alone deliberately: the brief
  and #1102 scope the fix to the branches that *settle* from `pi.metadata` / `session.metadata`,
  and the refund pair resolve their tenant partly by cross-tenant `payment_intent` lookup
  rather than metadata, so a correct guard there is a different shape and wants its own RED.
  The residual is bounded — these reduce or reverse money rather than crediting it — but an
  unbound `charge.refunded` naming a neighbour is still a vandalism vector of the same family.
  **Recommend a follow-up issue.**
- **`setup_intent.succeeded` is NOT guarded** (`:1237`). It stores a PaymentMethod for a
  metadata-named tenant + customer and already reads `event.account` (to retrieve the PM from
  that account), so a mismatched delivery would file a stranger's PM against a victim's
  customer. Not a settlement, so out of this lane's scope; same follow-up.
- **An attacker can still write audit noise.** A refused delivery writes one
  `webhook.auth_failed` row on the *named* tenant, which is the point (the victim must be able
  to see the attempt) but does mean an attacker can append rows to a neighbour's audit log at
  Stripe's delivery rate. Cheap and bounded; flagged rather than rate-limited.
- **No live Stripe.** As on #1000, there is no test secret key and no Connect test account
  here, so no real connected-account delivery was exercised end-to-end against Stripe. The
  runtime drive signs bodies with the platform secret the route verifies, which is exactly what
  the route sees, but the Stripe side is still unproven in this lane.
- **PRD/grading untouched.** `docs/PRD-v5-as-built.md` is not edited and no rung is claimed.
  #1102 notes PRD 5.5's settlement half is graded 3 (T1 FAILED) until this lands; the re-grade
  is Fable's, after merge.
- **Pre-existing `tsc` noise** (3 errors, Clerk test files) is untouched — see §3.
