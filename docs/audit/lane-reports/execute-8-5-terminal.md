# Lane report — §8.5 row 5.5, the doorstep card (Stripe Terminal)

**Ticket:** #1018 (§8.5 Execute) · **Row:** 5.5 · **Lane:** Opus, MONEY · **Branch:** `cloud/execute-8-5-terminal` (off `origin/main` @ `384a814`) · **Date:** 2026-09-12

> **As J**, I want to take a card on the doorstep, so I get paid before I drive away.
> **Given** an active Connect account, **when** I tap to pay, **then** the charge completes — **and without one, a clean 409, never a silent failure.**

**Printed rung:** 3 (PROVEN-UNIT: `test/payments/stripe-terminal.test.ts` 10/10, `test/routes/terminal.route.test.ts`).
**This lane does not state a rung.** Only Fable does. What follows is the evidence.

---

## 1. What was built

One new file, test-only. **No product change was needed** — the 409 path is already clean and coded; nothing in `routes/terminal.ts` or `payments/stripe-terminal.ts` was touched (`git status` shows one untracked test file plus the docs).

`packages/api/test/integration/stripe-terminal-doorstep.test.ts` — 7 tests, real Postgres, driving the **real routes the mobile app calls**. `packages/mobile/src/api/terminal.ts` `prepareTerminalCollect()` fires `POST /api/terminal/connection-token` and `POST /api/terminal/payment-intents` in parallel; both are exercised here, mounted from the real `createTerminalRouter` and wired exactly as `app.ts:5122` wires it (the production `connectAccountResolver` closure over a real `StripeConnectService`, real `PgInvoiceRepository` / `PgAuditRepository`).

### The stub boundary — named exactly

The **only** thing stubbed is Stripe's own REST API, at the `StripeFetch` seam the route already accepts (`deps.stripeFetch`). Four calls are stubbed, because the routes must make them and this lane has no Stripe test key and no Connect test account (parked on #1000):

| Stubbed call | Why it must be stubbed |
|---|---|
| `GET  https://api.stripe.com/v1/accounts/:id` | `createTerminalSession` reads the connected account's business address for the Location |
| `POST https://api.stripe.com/v1/terminal/locations` | Terminal requires a Location before a reader/Tap-to-Pay connect |
| `POST https://api.stripe.com/v1/terminal/connection_tokens` | the SDK connection token |
| `POST https://api.stripe.com/v1/payment_intents` | **the card_present intent itself** |

Everything else is real: real Postgres (testcontainer or a kept plain container), the real terminal router with its real `requireAuth`/`requireTenant`/`requirePermission` chain, the real `StripeConnectService` reading and writing the real `tenants.stripe_connect_*` / `stripe_terminal_location_id` columns, real `PgInvoiceRepository` / `PgPaymentRepository` / `PgAuditRepository` / `PgWebhookRepository`, and the **real signed `createWebhookRouter` settlement path** (HMAC per `invoice-webhook-paid.test.ts`). No DB is mocked. The webhook is not stubbed. **On the 409 leg the Stripe stub is asserted to have received zero calls** — the gate closes before the network.

---

## 2. Commands and raw output

### 2.1 RED — negative control on the gate (the silent failure the story forbids)

The 409 legs pass on an untouched tree, so the honest RED is a planted violation: `requireConnectAccount` (`src/routes/terminal.ts:48`) patched to fall back to a platform account instead of refusing — precisely the "silent failure" regression the story names. Patch applied, run, reverted (`git checkout src/routes/terminal.ts`).

```
 × … > no Connect account: tap-to-pay is refused with a clean coded 409 and writes nothing 78ms
   → expected 200 to be 409 // Object.is equality
 × … > no Connect account: minting a connection token is refused the same way, writing nothing 12ms
   → expected 404 to be 409 // Object.is equality
 × … > T1 cross-tenant: another tenant's active Connect account does not satisfy tenant A's gate 48ms
   → expected 200 to be 409 // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

All three 409 legs catch it. Note the second: with the gate removed the connection-token route degrades to a **404**, which is exactly the shape of failure the row's criterion calls out — the technician on the doorstep would see "not found", not "you need to finish Stripe".

### 2.2 RED — negative control on the settlement leg

Second control: the settlement test patched to *not* deliver the signed webhook, keeping every downstream assertion. If money appeared anyway the file would be proving nothing about the charge half.

```
 × … > connected tenant: card_present intent → signed webhook settles the invoice at real Postgres 43ms
   → expected [] to have a length of 1 but got +0

 FAIL … AssertionError: expected [] to have a length of 1 but got +0
 ❯ test/integration/stripe-terminal-doorstep.test.ts:593:22
    592|     const payments = await paymentRepo.findByInvoice(connected.tenantI…
    593|     expect(payments).toHaveLength(1);

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

Creating the intent moves no money. Only the signed webhook does. Control reverted.

### 2.3 GREEN — the new file

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
  --config vitest.integration.config.ts --reporter=verbose \
  test/integration/stripe-terminal-doorstep.test.ts
```

```
 ✓ … > no Connect account: tap-to-pay is refused with a clean coded 409 and writes nothing 71ms
 ✓ … > no Connect account: minting a connection token is refused the same way, writing nothing 9ms
 ✓ … > T1 cross-tenant: another tenant's active Connect account does not satisfy tenant A's gate 47ms
 ✓ … > connected tenant: the Terminal session persists a real location id + audit row 19ms
 ✓ … > connected tenant: card_present intent → signed webhook settles the invoice at real Postgres 80ms
 ✓ … > an UNSIGNED delivery of the same terminal capture credits nothing 36ms
 ✓ … > T1 cross-tenant on settlement: a terminal intent naming another tenant credits nothing 85ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

### 2.4 GREEN — the existing unit lane (unchanged)

```
cd packages/api && npx vitest run test/payments test/routes/terminal.route.test.ts
```
```
 Test Files  16 passed (16)
      Tests  132 passed (132)
```

### 2.5 GREEN — both integration files in one run

```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  test/integration/invoice-webhook-paid.test.ts test/integration/stripe-terminal-doorstep.test.ts
```
```
 Test Files  2 passed (2)
      Tests  11 passed (11)
```

### 2.6 Production build

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit   # exit 0
cd packages/api && npx tsc --noEmit | grep stripe-terminal-doorstep # no output
```

---

## 3. Evidence class and tenant grade

| Leg | What is proven | Class |
|---|---|---|
| (a) the 409 half | refusal is a coded 409 at real Postgres, and **nothing is written** — zero payments rows, zero Stripe calls, zero audit rows | PROVEN-REAL-DB *(negative write)* + STRUCTURAL (negative control §2.1) |
| (b) the gate, cross-tenant | another tenant's live Connect row does not satisfy this tenant's gate; the neighbour's rows are byte-identical after | PROVEN-REAL-DB, **T1** |
| (c) the charge half, settlement | `terminal.payment_intent_created` audit row, then **payments row + invoice `open → paid` + `payment.recorded` + `invoice.status_changed`** through the real signed webhook, all read back via `PgAuditRepository`; replay deduped; unsigned delivery credits nothing | PROVEN-REAL-DB (write **and** audit), **T1** |
| (c′) the live charge | **NOT PROVEN at any rung.** No card is ever presented to Stripe | — (blocked, §5) |

**Tenant grade: T1.** The G4 falsifier over the proving file:

```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant" \
    packages/api/test/integration/stripe-terminal-doorstep.test.ts
91:  /** Tenant B (otherTenant) — Connect live, charges enabled: neighbour, then payer. */
451:  it("T1 cross-tenant: another tenant's active Connect account does not satisfy tenant A's gate", async () => {
482:    // Cross-tenant: another tenant's rows are byte-for-byte unchanged.
661:  it('T1 cross-tenant on settlement: a terminal intent naming another tenant credits nothing', async () => {
```

Not T2/T3: both tenants run one configuration each (Connect on / Connect off), and nothing here reads per-tenant settings that could collide. Not T4: nothing iterates tenants.

---

## 4. The dumps — a kept plain container

```
docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=serviceos_test \
  -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300     # → port 32768
EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/stripe-terminal-doorstep.test.ts                      # 7 passed (7)
```

**Tenants — the gate's actual state on disk:**
```
      tenant      |                  id                  | stripe_connect_account_id | charges | status  |  terminal_location
------------------+--------------------------------------+---------------------------+---------+---------+----------------------
 A (no Connect)   | cd83c395-7773-491f-a36b-3cb4127b32f9 |                           | f       | pending |
 B (Connect live) | 6782a25d-0384-4ed9-a126-0bba8c477e3f | acct_doorstep_tenant_b    | t       | active  | tml_doorstep_created
```

**Payments — tenant A's refused taps wrote nothing; tenant B's settlements wrote exactly one row each:**
```
      tenant      |              invoice_id              | amount_cents |  status   | payment_method |      reference_number      |   created_by
------------------+--------------------------------------+--------------+-----------+----------------+----------------------------+----------------
 B (Connect live) | e69b2315-3335-48d5-b75d-2f99a6f6c50d |        24500 | completed | credit_card    | pi_term_4b6c908561ec4b3d8c | stripe_webhook
 B (Connect live) | a6bf1145-0bd2-41c1-9798-f0f1fdb9eb11 |        24500 | completed | credit_card    | pi_term_00f422f3c1ac48359b | stripe_webhook
(2 rows)
```

**Invoices — A's two stay open at the full balance; B's two settled invoices are paid to zero:**
```
      tenant      | invoice_number | status | total_cents | amount_paid_cents | amount_due_cents
------------------+----------------+--------+-------------+-------------------+------------------
 A (no Connect)   | INV-928b7c63   | open   |       24500 |                 0 |            24500
 A (no Connect)   | INV-85ba05f7   | open   |       24500 |                 0 |            24500
 B (Connect live) | INV-9fc57227   | open   |       24500 |                 0 |            24500
 B (Connect live) | INV-e69b2315   | paid   |       24500 |             24500 |                0
 B (Connect live) | INV-695e9918   | open   |       24500 |                 0 |            24500
 B (Connect live) | INV-a6bf1145   | paid   |       24500 |             24500 |                0
```
(B's two remaining `open` rows are the gate leg's decoy invoice and the unsigned-delivery invoice — both correctly uncredited.)

**Audit events — the whole timeline, by tenant:**
```
      tenant      |            event_type            | entity_type | actor_role | n
------------------+----------------------------------+-------------+------------+---
 B (Connect live) | invoice.status_changed           | invoice     | system     | 2
 B (Connect live) | payment.recorded                 | invoice     | system     | 2
 B (Connect live) | terminal.connection_token_minted | tenant      | owner      | 1
 B (Connect live) | terminal.payment_intent_created  | invoice     | owner      | 3
(4 rows)

           check           | n            |            check             | n
---------------------------+---           |------------------------------+---
 tenant A audit rows total | 0            | tenant A payments rows total | 0
```

Exactly what the story says on the settlement side: one `payment.recorded` and one `invoice.status_changed` per settled doorstep charge, and not one row of anything for the tenant that was refused.

---

## 5. Findings

**F1 — a refused doorstep charge leaves no trace on the tenant's timeline (the dump's `tenant A audit rows total | 0`).**
The route's only audit writes are `terminal.connection_token_minted` and `terminal.payment_intent_created`, both **after** the gate (`routes/terminal.ts:120`, `:183`); `requireConnectAccount` (`:48`) throws before either. So a technician standing on a doorstep being refused produces **no `audit_events` row at all** — no `terminal.connect_required`, nothing. Asked for by the ticket: *"whatever audit row the route writes (if it writes none, SAY SO … do not invent one)"* — **it writes none.** The test pins that as today's behaviour (`expect(await allAuditEventTypes(...)).toEqual(auditBefore)`) so any change becomes visible; **no audit row was invented.**
This is **not** a violation of the story's criterion — the 409 *is* clean and coded, and CLAUDE.md's "all mutations emit audit events" does not reach a refusal that mutates nothing. It is a **product gap for Fable/Josh**: the owner cannot later see that field collection was attempted and blocked, which is the signal that would tell them to finish Connect onboarding. No fix made — out of this lane's test-only scope, and it is a money-surface behaviour change.

**F2 — a doorstep tap settles as `credit_card`, indistinguishable from an online card.**
`mapStripePaymentMethod` (`webhooks/routes.ts:77`) has no `card_present` branch: anything not bank-shaped returns `credit_card`, and `payments.payment_method` is CHECK-constrained to `('stripe','cash','check','other')` anyway — the schema has no card-present value to record. So in-person and online card revenue are not separable in the ledger. Pinned as-is (`expect(payments[0].method).toBe('credit_card')` with the reason in a comment). Reported, not fixed.

**F3 — there is no `payment_intents` table in this schema.**
The ticket's "no `payment_intents` row" resolves to: the card_present intent exists only at Stripe until the webhook settles it, so the assertion is made as **"no intent was ever created"** — the Stripe stub records zero calls on the 409 path. Stated rather than silently reinterpreted.

**F4 — the `stripe` npm SDK is not a dependency anywhere in the monorepo.**
`grep -rn '"stripe"' packages/*/package.json package.json` → no match. Every Stripe call is a hand-rolled `fetch` to `https://api.stripe.com/v1/…`, and no `Stripe-Version` header is set anywhere (`grep -rn "Stripe-Version" packages/api/src/` → empty), so the account's default API version applies. The research question's premise ("the `stripe` npm version pinned in `packages/api/package.json`") has no referent; §6 answers it for the REST surface instead.

---

## 6. Research (report-only, nothing run against Stripe)

**Q: does Stripe provide a simulated Terminal reader / test helpers usable server-side?** **Yes**, and it needs no hardware and no SDK — plain REST, which is all this repo speaks (F4).

| Step | Call | Notes |
|---|---|---|
| Location | `POST /v1/terminal/locations` | already implemented (`ensureTerminalLocation`) |
| **Simulated reader** | `POST /v1/terminal/readers` with **`registration_code=simulated-wpe`**, `location=tml_…` | returns `device_type: simulated_wisepos_e`, `livemode: false`. **Not in the repo** — test-only |
| Intent | `POST /v1/payment_intents` with `payment_method_types[]=card_present` | already implemented (`createTerminalPaymentIntent`) |
| **Hand off** | `POST /v1/terminal/readers/{tmr_…}/process_payment_intent` with `payment_intent=pi_…` | server-driven; **not in the repo** — test-only |
| **Simulate the tap** | `POST /v1/test_helpers/terminal/readers/{tmr_…}/present_payment_method` | with no params, defaults to Visa `4242424242424242` for a `card_present` intent; `amount_tip`, `card_present`, `type` optional. Test-mode only |

Stripe: *"Stripe Terminal SDKs and server-driven integration come with a built-in simulated card reader, so you can develop and test your app without connecting to physical hardware."* and *"When using the server-driven integration, use the `present_payment_method` endpoint to simulate a cardholder tapping or inserting their card on the reader."*

**Connect compatibility** — this repo does **direct charges**, which is the shape Stripe documents: *"If you use direct charges, you submit Terminal API requests to configure readers and accept payments using your platform's API key and the `Stripe-Account` header to identify the connected account"*, and *"all API resources belong to the connected account rather than your platform."* Locations, readers, connection tokens and the `card_present` PaymentIntent all carry `Stripe-Account` — exactly what `buildHeaders` in `payments/stripe-terminal.ts:148` already sends. Caveat from the same page: *"Terminal connected accounts must have the `card_payments` capability to perform transactions."*

**Credential a hermetic-but-live run would need:** a **Stripe TEST secret key** (`sk_test_…`) for the platform account **plus a Connect test connected account with `card_payments` active**. Stripe documents test values that onboard a sandbox account without a human clicking hosted onboarding (`individual[id_number]=000000000`, `individual[address][line1]=address_full_match`, a `1902-01-01` DOB, `business_profile[url]=https://accessible.stripe.com`) — verify the exact set at run time against https://docs.stripe.com/connect/testing; the platform's Connect profile must already be set up. Appended to `docs/audit/blocked-on-josh.md` under **"5.5 doorstep card — live simulated-reader run"** (ticket #1000). **Nothing in this lane was run against Stripe, live or test.**

**Exact sequence such a run would use** (`$SK` = test secret key, `$ACCT` = connected test account):

```bash
# 1. Location on the connected account (the repo already does this)
curl -s https://api.stripe.com/v1/terminal/locations -u "$SK:" \
  -H "Stripe-Account: $ACCT" \
  -d display_name='Field location' \
  -d 'address[line1]=1272 Valencia Street' -d 'address[city]=San Francisco' \
  -d 'address[state]=CA' -d 'address[country]=US' -d 'address[postal_code]=94110'
# → tml_…

# 2. Register the SIMULATED reader on the same account (test-only)
curl -s https://api.stripe.com/v1/terminal/readers -u "$SK:" \
  -H "Stripe-Account: $ACCT" \
  -d registration_code=simulated-wpe -d label='Doorstep simulator' -d location=tml_…
# → tmr_…  device_type=simulated_wisepos_e  livemode=false

# 3. The card_present intent — this is the repo's own call, unchanged
curl -s https://api.stripe.com/v1/payment_intents -u "$SK:" \
  -H "Stripe-Account: $ACCT" \
  -d amount=24500 -d currency=usd -d 'payment_method_types[]=card_present' \
  -d capture_method=automatic \
  -d 'metadata[tenant_id]='"$TENANT" -d 'metadata[invoice_id]='"$INVOICE" \
  -d 'metadata[collection]=terminal'
# → pi_…

# 4. Hand the intent to the simulated reader (test-only)
curl -s https://api.stripe.com/v1/terminal/readers/tmr_…/process_payment_intent -u "$SK:" \
  -H "Stripe-Account: $ACCT" -d payment_intent=pi_…

# 5. Simulate the tap — defaults to Visa 4242424242424242 (test-only)
curl -s -X POST https://api.stripe.com/v1/test_helpers/terminal/readers/tmr_…/present_payment_method \
  -u "$SK:" -H "Stripe-Account: $ACCT"

# 6. Stripe's REAL payment_intent.succeeded into the repo's own webhook
stripe listen --forward-connect-to localhost:3000/webhooks/stripe
```

Sources:
- https://docs.stripe.com/terminal/references/testing
- https://docs.stripe.com/api/terminal/readers/process_payment_intent
- https://docs.stripe.com/api/terminal/readers/present_payment_method
- https://docs.stripe.com/terminal/features/connect.md?connect-charge-type=direct
- https://docs.stripe.com/connect/testing

---

## 7. Not done

- **The live charge.** No card is presented to Stripe anywhere in this lane. `POST /v1/payment_intents` is answered by the in-process stub, so the *creation* of a card_present intent is proven only in shape (its URL, `payment_method_types[]=card_present`, server-derived amount, `Stripe-Account`, idempotency key) — never that Stripe accepts it. Blocked on the credential in §6, parked on #1000.
- **The device half.** Tap-to-Pay on the technician's phone (the Stripe Terminal native SDK consuming the connection token) is not exercised and cannot be from Node. The mobile client's `prepareTerminalCollect` is read but not run.
- **Rung-5 reachability.** No browser/device run reaches this capability as a normally-provisioned tenant would; the Connect row here is set by SQL in `beforeAll`, which is explicitly not reachability.
- **T2/T3/T4.** Out of shape for this row (§3).
- **F1 and F2 are not fixed** — both are money-surface behaviour changes outside a test-only lane.
- `docs/PRD-v5-as-built.md` was **not** edited: only Fable states rungs, and the 5.5 cell is a rung statement.
