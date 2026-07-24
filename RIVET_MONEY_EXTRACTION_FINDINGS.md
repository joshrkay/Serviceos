# Money Extraction Findings

Read-only extraction pass over the Rivet money surface. Five parallel tracks,
no fixes, no gates. Produced by `/money-extract`; grounds `/goal money`.

Date: 2026-07-24 · Base: `1d5c7e5` · Branch: `claude/rivet-money-extraction-u5x8du`

**Headline:** the money path is far stronger than the comms surface was at the
same stage — every money column is integer cents, the Stripe boundary is clean,
RLS is complete across all money tables, and idempotency is enforced by a real DB
unique index. The defects are not structural sloppiness; they are seven specific
holes, four of which lose or misstate real money silently.

**Revision note.** P0-6 and P0-7, and the L4 layer, were added during review after
the first synthesis asserted invariants the code does not hold. Both concern
concurrency and both were invisible to the original single-path tracing — a
reminder that this surface's defects live in interleavings, not in any one file.

---

## P0 — silent money bugs (surfaced first, unconditionally)

Ranked by blast radius. Each passes every existing test.

### P0-1 · Void does not invalidate the payment link — money captured with no local record
**Track 2.** `packages/api/src/invoices/invoice.ts:406-431` → `pg-invoice.ts:203-206`

The entire void path writes `status` and `updated_at`. Nothing else.
`stripe_payment_link_id` / `stripe_payment_link_url` (`db/schema.ts:1241-1244`) are
**never cleared by any code path** — every write is a set, never a clear.
`provider.deactivateLink` (`payments/stripe-payment-link.ts:81`) has exactly three
callers (`routes/public-portal.ts:1195`, `invoices/public-invoice-service.ts:251-260`,
`estimates/public-estimate-service.ts:813-829`) — all DB-write rollbacks, none the void path.

After void the customer still holds a live Stripe-hosted payment link. When they pay it:

1. Stripe captures the money.
2. `checkout.session.completed` → `webhooks/routes.ts:1167` → `recordPayment`.
3. `recordPayment` throws `Cannot record payment on invoice with status 'void'`
   (`invoices/payment.ts:475`).
4. The webhook catch at `webhooks/routes.ts:1212-1214` matches `message.includes('status')`,
   logs *"Invoice already settled, ignoring Stripe payment"*, and **ACKs 200**.

Result: **money captured at Stripe with no payment row, no invoice credit, no audit
event, and no alert.** The `restrictions[completed_sessions][limit]: 1` on the link
(`public-invoice-service.ts:222`) prevents a *second* charge, not a *post-void* charge.

Same shape on the PaymentIntent surface: `routes/public-payments.ts:90-97` rejects void
at mint time, but an already-minted client secret is never cancelled on void.

### P0-2 · Web write path computes line totals in float dollars; server persists verbatim
**Track 1.** `packages/api/src/shared/contracts.ts:114` + four web call sites

The client round-trips money through float dollars — `rate: unitPriceCents / 100` on read,
then `totalCents: Math.round(qty * rate * 100)` on write:

- `packages/web/src/components/estimates/EstimatesPage.tsx:71, 88-89`
- `packages/web/src/components/invoices/InvoicesPage.tsx:57, 77-78` (PUT at `:882`)
- `packages/web/src/components/forms/LineItemEditor.tsx:79-80, 108, 175` — the canonical
  shared editor, used by `InvoiceForm.tsx:123` and `catalogToLineItem.ts:62`
- `packages/web/src/components/estimates/NewEstimateFlow.tsx:205, 709, 1300, 1306` (POST at `:1333`)

The server validates `totalCents: z.number().int().nonnegative()` — an **integer shape
check only**. `estimates/estimate.ts:278, 517` and `invoices/invoice.ts:229, 356` store the
array verbatim, and `calculateDocumentTotals` (`billing-engine.ts:99-102`) then sums *the
client's* numbers. **No REST path ever recomputes a line total from
`quantity × unitPriceCents`.**

Empirically confirmed divergence (Track 1 ran the competing formulas):

| unitPriceCents | qty | server `round(q*upc)` | client `round(q*rate*100)` |
|---|---|---|---|
| 29 | 0.5 | 15 | 14 |
| 45 | 0.7 | 31 | 32 |
| 9 | 2.5 | 23 | 22 |

Three different operation orderings of the same computation exist across the codebase.
The wrong value flows into `subtotal_cents` → `total_cents` → `amount_due_cents` → the
Stripe `unit_amount`. The Stripe boundary is clean; the value **arrives already wrong
from persistence**.

The AI/voice path is **safe** — it routes through `buildLineItem` → `calculateLineItemTotal`
(`invoices/invoice-editor.ts:74-86`, `estimate-editor.ts`). This is specifically a REST/UI defect.

### P0-3 · `incrementAmountPaidAtomic` can write `'paid'` from any state, including `void`
**Track 2.** `packages/api/src/invoices/pg-invoice.ts:320-333`

The SQL `WHERE` is `id = $2 AND tenant_id = $1` — **no status filter** — and the `CASE`
unconditionally writes `'paid'` when the balance reaches zero (`:325`). `recordPayment`
reads the invoice at `invoices/payment.ts:470` and credits at `:570` with no row lock and
no transaction spanning the two, so an invoice voided in that window is credited and
flipped `void → paid` — a transition `INVOICE_STATUS_TRANSITIONS` explicitly forbids
(`invoice.ts:174`).

Its sibling `decrementAmountPaidAtomic` **does** carry `AND status IN ('open','partially_paid','paid')`
in SQL (`pg-invoice.ts:367`), which makes the omission look accidental rather than designed.

Also unguarded: `reconcileInvoiceFromPayments` (`invoices/payment.ts:29-59`) writes
`status: 'paid' | 'partially_paid'` with no status guard and no transition validation at `:51-57`.

### P0-4 · Refund double-apply under failed-then-retry interleaving
**Track 3.** `packages/api/src/payments/payment-service.ts:93-106`

`recordRefund`'s per-refund guard remembers only the **latest** refund id
(`last_refund_stripe_id`). The defeating interleave:

1. Event A (`re_1`) throws *after* `incrementRefundAtomic` committed → marked `failed`.
2. Event B (`re_2`) records → `lastRefundStripeId = re_2`.
3. Stripe retries A → `failed` status means *not duplicate* → re-runs → `lastRefundStripeId`
   is `re_2`, not `re_1` → no short-circuit → **`re_1` counted twice**.

Bounded only by the DB guard `refunded_amount_cents + $3 <= amount_cents`
(`pg-payment.ts:255-262`). Self-documented at `payment-service.ts:93-96`; the fix
(a `payment_refunds` child table) is already tracked as **D2-4a**.

### P0-5 · `'stripe_checkout'` literal providerReference collides tenant-wide
**Track 3.** `packages/api/src/webhooks/routes.ts:1143-1150`

When `session.payment_intent` is absent, `providerReference` falls back to the **literal
string** `'stripe_checkout'`, which collides across every checkout in a tenant. The second
one hits `23505` on a different invoice → `recordPayment` throws `ValidationError`
"already recorded on a different invoice" (`payment.ts:521-525`) → the webhook catch
(`routes.ts:1185-1220`) does not match that message → rethrow → 500 → **Stripe retries
forever**.

### P0-6 · Concurrent payments overpay an invoice; no guard rejects the second
**Track 2.** `packages/api/src/invoices/pg-invoice.ts:320-333`, `invoices/payment.ts:470-480`

Same missing predicate as P0-3, different victim. `recordPayment`'s two guards — payable status
(`payment.ts:473-476`) and `amountCents > amountDueCents` (`:478-480`) — both evaluate an
in-memory invoice read at `:470`. The UPDATE they gate is keyed `WHERE id = $2 AND tenant_id = $1`
only, with **neither a payable-status nor a remaining-balance predicate**.

Two full-balance payments starting concurrently on one open invoice — a double-clicked pay button,
or a payment link and a Terminal charge landing together — both pass both checks, both insert a
payment row, and both credits apply, because the UPDATE derives from the row's own current value by
design (`:316-318`). Result: `amount_paid_cents` at 2× `total_cents`, `amount_due_cents` clamped to
0 by `GREATEST` (`:323`) so the overpayment is invisible on the invoice, status `paid`. **The
customer is charged twice and every existing test passes.**

Not caught by L3: both payment rows exist and sum to the inflated column, so the balance invariant
still agrees. The assertion that catches it is L4 (`amount_paid_cents <= total_cents`).

### P0-7 · The two reconcilers disagree on whether refunds subtract — L3 has two definitions
**Track 3/4.** `packages/api/src/invoices/payment.ts:38-40` vs `payments/payment-service.ts:234-237`

The codebase states `amount_paid == Σ(active payment amount_cents)` **refund-inclusive**
(`payment-service.ts:234-237`), and `reconcileInvoiceAfterReversal` honors it. But the *other*
reconciler computes the balance **refund-net**:

```
paidCents = payments
  .filter(completed|processing, !reversedAt)
  .reduce((sum, p) => sum + (p.amountCents - (p.refundedAmountCents ?? 0)), 0)   // payment.ts:38-40
```

**Same column, two different definitions.** The interleave that fires it: payment row commits →
invoice credit fails (separate transactions, per P0-3's note) → a refund is recorded → duplicate
checkout delivery invokes the repair path. The `paidCents <= invoice.amountPaidCents` guard
(`:46-48`) does **not** short-circuit here, because the failed credit left `amountPaidCents` stale-low
— so the net figure exceeds it and is written. A 100-cent payment refunded 30 leaves
`amount_paid_cents = 70` while `Σ(active payments.amount_cents) = 100`.

**This breaks L3 directly**, and it is self-acknowledged: the function's own docstring concedes the
guard holds "even if a credit type is undercounted here" (`:24-27`). Note the divergence is an
inconsistency, not a clear loss — net-70 is arguably the economically right number; what makes it a
defect is that every other path uses the inclusive convention. Whichever convention wins, **both
reconcilers must implement the same one before L3 can be swept.**

---

## Track 1 — Money type end to end

**Storage type per table.** Schema is one file, `packages/api/src/db/schema.ts`, applied
wholesale by `db/migrate.ts:148`. No `.sql` files; no `ALTER COLUMN ... TYPE` ever touches
a money column.

| Table | Money columns | SQL type | file:line |
|---|---|---|---|
| estimates | discount/tax_rate_bps/subtotal/taxable_subtotal/tax/total `_cents` | `INTEGER NOT NULL DEFAULT 0` | schema.ts:529-534 |
| estimate_line_items | unit_price_cents, total_cents | `INTEGER NOT NULL` | schema.ts:560-561 |
| estimate_line_items | **quantity** | **`NUMERIC` (no scale)** | schema.ts:559 |
| invoices | + amount_paid_cents, amount_due_cents | `INTEGER NOT NULL DEFAULT 0` | schema.ts:627-634 |
| invoices | processing_fee_bps, processing_fee_cents | `INTEGER` nullable | schema.ts:5000-5001 |
| invoice_line_items | unit_price_cents, total_cents | `INTEGER NOT NULL` | schema.ts:661-662 |
| invoice_line_items | **quantity** | **`NUMERIC` (no scale)** | schema.ts:660 |
| payments | amount_cents | `INTEGER NOT NULL` | schema.ts:679 |
| payments | refunded_amount_cents | `BIGINT NOT NULL DEFAULT 0` | schema.ts:2647 |
| jobs | deposit_required_cents, deposit_paid_cents | `INTEGER` + CHECK `paid <= required` | schema.ts:2099-2110 |
| catalog_items | unit_price_cents | `INTEGER NOT NULL CHECK (>= 0)` | schema.ts:1022 |

**No `float`, `real`, `double precision`, `money`, or `decimal` on any money column.**
`DOUBLE PRECISION` appears only on GPS telemetry (`schema.ts:994-998`); `REAL[]` only on
RAG scores (`:1583`). Of the unscaled `NUMERIC` columns, **only `quantity` is in the money path.**

**Domain type.** `LineItem` / `DocumentTotals` (`shared/billing-engine.ts:19-76`), mirrored
by Zod in `packages/shared/src/contracts/money.ts:20-58` (`quantity: z.number()` deliberately
non-int, comment at `:29`). Mappers convert uniformly via `Number()`
(`shared/document-row-mappers.ts:7-50`).

**pg driver behavior — verified, not assumed.** `pg@^8.20.0`; **no `setTypeParser` override
anywhere**. `int4` → JS number (exact). `int8` → string, and every BIGINT money read is
correctly wrapped in `Number()` (7 sites) — exact below 2^53, **no leak found**. `numeric`
(OID 1700) has **no registered parser** → raw string → `Number()` → float. That is the entry
point for `quantity`. SQL aggregates (`SUM(int4)`→bigint, `SUM(int8)`/`AVG`→numeric) are all
`Number()`-wrapped; no leak.

**Stripe-boundary type.** All six outbound sites send `String(<integer cents>)` on a
URL-encoded body. Nothing divides, floats, or rounds before any Stripe call.

| Call site | file:line | Guard |
|---|---|---|
| `POST /v1/payment_links` (provider) | payments/stripe-payment-link.ts:44 | `Number.isInteger` at payment-link-provider.ts:33 |
| `POST /v1/payment_links` (invoice pay-now) | invoices/public-invoice-service.ts:215 | — |
| `POST /v1/payment_links` (deposit) | estimates/public-estimate-service.ts:863 | — |
| `POST /v1/payment_intents` (portal) | payments/stripe-payment-intent.ts:85 | hard guard `:71-73` |
| `POST /v1/payment_intents` (Terminal) | payments/stripe-terminal.ts:264 | guard `:245-247` |
| `POST /v1/payment_intents` (saved card) | payments/stripe-saved-card.ts:199 | guard `:190-192` |

`application_fee_amount` / `transfer_data` are never used — Connect uses direct charges via
the `Stripe-Account` header. No outbound refund call exists.

**API-response type.** Integer cents on the wire (`shared/contracts/invoice.ts:13-38`,
`estimate.ts:20`). `formatUsdCents` uses pure integer `Math.floor(abs/100)` + `abs % 100`
(`shared/contracts/money.ts:66-113`); division by 100 happens only inside `Intl.NumberFormat`
/ `toFixed`. **Mobile is cents-only end to end and entirely clean** (`mobile/src/lib/format.ts:7-19`).

### Float leaks — **NOT NONE**

The invariant *"all money: integer cents, never floating point"* **holds on the server and at
the Stripe boundary, and is violated in the write path.** All five hunted P0 patterns present:

| Pattern | Sites |
|---|---|
| money round-trips through a JS float | web EstimatesPage.tsx:71/88-89, InvoicesPage.tsx:57/77-78, LineItemEditor.tsx:79-80, NewEstimateFlow.tsx:205/1300-1306 |
| arithmetic on non-integer money | `item.qty * item.rate` — same four components |
| `numeric` without scale on a money-path column | schema.ts:559, 660 (`quantity`) → document-row-mappers.ts:12 |
| `parseFloat` on a money value | api/src/ai/resolution/pending-proposal-resolver.ts:201-203; web PriceBookPage.tsx:416 |
| `Math.round` recovering from float drift | uiLineToApi / toLineItemPayload; InvoicesPage.tsx:18-19 |

Server-side, the only place money crosses a float is
`billing-engine.ts:79` — `calculateLineItemTotal = Math.round(quantity * unitPriceCents)` —
documented and bounded by an immediate round to whole cents.

Notable: `pending-proposal-resolver.ts:201` uses `parseFloat` where the **safe integer pattern
already exists in-repo and is unused here** — `negotiation/target-price-parser.ts:58`
(`dollars * 100 + cents`) and `invoices/milestone-sentence-parser.ts:62` do the same job with
pure integer math.

**Out-of-scope but same class:** non-Stripe money egress float-divides —
`integrations/accounting/quickbooks-client.ts:127, 144` (`lineCents / 100`, `totalCents / 100`)
and `financing/financing-provider.ts:101` (`amountCents / 100`).

**Secondary:** core documents are `int4` (ceiling $21,474,836.47) while newer money tables adopted
`BIGINT` (`schema.ts:2725` comments that int8 "matches the established money-column" convention).
Two conventions coexist; the core documents are on the narrower one.

---

## Track 2 — State machines

**State: PARTIAL for all three entities.** Every from→to rule is **application-only**. The DB
enforces value membership (CHECK constraints) and two uniqueness invariants — both of which the
migrations permit to silently degrade — and nothing else. **There are no triggers.**

| Entity | States | Enforcement |
|---|---|---|
| Invoice | draft, open, partially_paid, paid, void, canceled (`schema.ts:626`) | **PARTIAL** — chokepoint `transitionInvoiceStatus` (`invoice.ts:406-431`) exists and is the *only* void route, but **6 of 9 write sites bypass it** |
| Estimate | draft, ready_for_review, sent, accepted, rejected, expired (`schema.ts:528`) | **PARTIAL** — chokepoint `transitionEstimateStatus` (`estimate.ts:649-699`), bypassed by both customer-facing terminal transitions + send |
| Payment | pending, processing, completed, failed, refunded (`schema.ts:680-681`) | **PARTIAL** — no transition function and no transition table, but all three lifecycle flips are genuine SQL compare-and-swaps (`pg-payment.ts:284-296, 316-326, 348-358`) — the strongest race protection of the three |

Bypass detail: the repo exposes an unvalidated generic `update({status})` on both invoices
(`pg-invoice.ts:197-307`) and estimates (`pg-estimate.ts:233-235`). `reviseEstimate`
(`estimate.ts:535-557`) *deliberately* bypasses, because `accepted → sent` is not in
`ESTIMATE_STATUS_TRANSITIONS` (`accepted: []`) — the chokepoint would reject the transition the
product requires.

**Enum drift.** `PaymentStatus` in `packages/shared/src/enums.ts:116-120` declares
`RECORDED / CLEARED / VOIDED` — three values in neither the DB CHECK nor the API type, with
**zero importers**. Dead and wrong. There is no `paymentStatusSchema` in
`shared/contracts/status.ts`, so payment status is the one entity **excluded from the
schema-parity test** (`shared/contracts/status.test.ts:49`).

**Void → link invalidation: BROKEN.** See P0-1.

**Paid-invoice reject: HOLDS SERIALLY, BROKEN UNDER CONCURRENCY.** At the app layer on both paths
`recordPayment` rejects anything outside `['open','partially_paid']` (`invoices/payment.ts:473-476`)
and rejects `amountCents > amountDueCents` (`:478-480`); the webhook paths (`routes.ts:1167`,
`:1387`) route through the same guard and swallow the ValidationError as idempotent success
(`:1212-1214`, `:1410-1416`). Serially, a paid invoice is never credited twice — pinned by
`test/invoices/payment.test.ts:451-462`.

**But both guards are check-then-act against a stale in-memory read, and the write they gate carries
no matching predicate.** `incrementAmountPaidAtomic`'s UPDATE is keyed `WHERE id = $2 AND
tenant_id = $1` only (`pg-invoice.ts:330`) — no payable-status predicate, no remaining-balance
predicate. Two full-balance payments starting concurrently on one open invoice both read the same
balance, both pass both checks, both insert a payment row, and both credits apply: the UPDATE
derives from the row's own current value by design (`:316-318`), so nothing is lost and nothing is
rejected. `amount_paid_cents` ends at 2× `total_cents`, `amount_due_cents` clamps to 0 via
`GREATEST` (`:323`) and hides the overpayment, and status flips to `paid`.

**This is a distinct defect from P0-3, and L3 does not catch it.** Both payment rows exist and sum
to the inflated column, so `amount_paid_cents == Σ(active payments)` still holds — the invariant
that breaks is `amount_paid_cents <= total_cents`, which is why the ladder below needs an L4. Also
weakened by the unguarded `reconcileInvoiceFromPayments`.

Dead payability predicates: `isPayableInvoice` (`invoice-payment-link.ts:75-77`) and
`assessPaymentReadiness` (`payment-readiness.ts:5`) have **no production callers**; every real
guard re-declares its own `PAYABLE_STATUSES` literal — **five separate copies**
(`invoice-payment-link.ts:6`, `payment.ts:473`, `payment-service.ts:605`,
`public-payments.ts:90`, `public-invoice-service.ts:144`).

**Estimate→invoice: IDEMPOTENT on the primary path, DOUBLE-CONVERTIBLE via two secondary paths.**

Primary `convertEstimateToInvoice` (`invoices/convert-estimate.ts:45-150`) requires
`status === 'accepted'` (`:53-57`), returns an existing matching invoice (`:61-63`), and catches
`23505` to return the race winner (`:92-104`). There is **no `converted_at` column**; the backlink
is `invoices.estimate_id` (`schema.ts:624`) plus the partial unique index `uq_invoices_estimate`
(`schema.ts:3148-3175`).

**The index is conditional.** The migration's `DO $$` block detects pre-existing duplicate
`estimate_id` values and falls back to a **non-unique** index with only a `RAISE WARNING`
(`schema.ts:3167-3169`) — leaving app-level idempotency as the sole guard on any tenant with
dirty data. `uq_estimates_accepted_per_job` (`schema.ts:3201-3220`) has the same degrade path.

Two paths bypass `convertEstimateToInvoice` entirely and insert an invoice carrying an
`estimateId` with **no accepted-status check and no already-converted check**:

- `POST /api/invoices` — `routes/invoices.ts:158-160` only verifies existence + tenant, then
  `createInvoiceWithNextNumber` at `:186`.
- `draft_invoice` proposal execution — `proposals/execution/invoice-execution-handler.ts:134, 145`;
  a 23505 surfaces as `{ success: false }` at `:152-157`. Such payloads are minted by
  `invoices/auto-invoice-on-completion.ts:104` and `digest/invoice-one-tap.ts:67`.

Related: `auto-invoice-on-completion.ts:70` treats a **voided** invoice as "not invoiced"
(`isLiveInvoice`, `:32-34`), so voiding a converted invoice **re-arms auto-invoicing** for the same
accepted estimate — which then collides with `uq_invoices_estimate`.

**Racy guards inventory:** `recordPayment` (read `:470` → write `:570`, no lock/transaction — the
only one with *nothing* catching the race); `convertEstimateToInvoice` (`:61`→`:76`, 23505-mitigated);
`public-estimate-service` accept (`:284`→`:374`, 23505-mitigated); `transitionInvoiceStatus` and
`transitionEstimateStatus` themselves (findById-then-update, no `SELECT … FOR UPDATE`).

---

## Track 3 — Webhooks & idempotency

**Handlers.** Exactly **one** Stripe route — `POST /webhooks/stripe`
(`packages/api/src/webhooks/routes.ts:874`), mounted at `app.ts:1169`. Connect vs. platform is
handled by one endpoint accepting a **comma-separated secret list**
(`parseWebhookSecrets`, `webhook-handler.ts:84`; `verifyWebhookSignatureAny`, `routes.ts:900`),
not two routes. The former `/api/webhooks/stripe` alias was deliberately removed for lacking
raw-body middleware (`app.ts:1160-1168`).

**Idempotency mechanism: DB CONSTRAINT — not racy.**
`CREATE UNIQUE INDEX idx_webhook_idempotency ON webhook_events(source, idempotency_key)`
(`db/schema.ts:275`, migration `012`). Insert is
`INSERT ... ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING *`
(`webhooks/pg-webhook.ts:47-81`); on zero rows it re-SELECTs the existing row. The caller *is*
SELECT-then-INSERT (`webhook-handler.ts:153-211`) but carries an explicit **lost-race guard** at
`:206-208` (`if (created.id !== event.id) return classifyExisting(created)`). The DB constraint is
the real arbiter, so concurrent redelivery is safe. Pinned by a real-Postgres integration test
(`test/integration/webhooks.test.ts`).

**Redelivery behavior** (`classifyExisting`, `webhook-handler.ts:142-151`; dispatch at `routes.ts:921-931`):

| Existing status | Behavior |
|---|---|
| `processed` | **No-op**, 200 `{duplicate:true}` |
| `failed` | **RE-APPLIES** — by design, so out-of-order refund/dispute can reconcile |
| `received`/`processing`, age < 30s | **No-op**, 200 duplicate |
| `received`/`processing`, age ≥ 30s | **RE-APPLIES** — assumes a crashed handler |

The status decision is therefore **time-based in app code** (`INFLIGHT_STALENESS_MS = 30s`,
`webhook-handler.ts:129`) even though the dedupe itself is DB-enforced.

**Signature verification: PRESENT and FAIL-CLOSED — but hand-rolled.**
`stripe.webhooks.constructEvent` appears **nowhere in the repo** (zero grep matches).
Verification is a custom HMAC (`verifyWebhookSignature`, `webhook-handler.ts:27-70`): 300s
timestamp tolerance (`:52-53`), `timingSafeEqual` (`:65`), multiple `v1=` accepted for rotation
(`:42-45`). No secret → **500** (`routes.ts:880-883`, no NODE_ENV bypass); missing header → **400**
(`:885-888`); invalid → **401** (`:900-903`). Boot-fails in prod/staging without
`STRIPE_WEBHOOK_SECRET` (`shared/config.ts:214-219`). **No unsigned fallback path anywhere.**
Raw body is correct — `express.raw({type:'application/json'})` at `app.ts:764`, mounted **before**
`express.json()` at `:800`.

*Rough edge:* the pre-parsed-body refusal `throw` at `routes.ts:893-895` sits **outside** the try
block (opens at `:935`) inside an async handler → Express 4 turns it into an unhandled rejection
and the **request hangs** rather than returning 500. Fail-closed for processing, not a clean error.

**Event coverage — 11 types handled.** Two can double-apply:

| Event | file:line | Double-apply? |
|---|---|---|
| `checkout.session.completed` | routes.ts:1037 | No — partial unique index `idx_payments_stripe_reference_unique` (`schema.ts:5811-5815`); `recordPayment` catches 23505 and reconciles (`payment.ts:504-560`) |
| `payment_intent.succeeded` | routes.ts:1327 | No — completed check `:1355`; `settleProcessingPayment` does not re-credit |
| `payment_intent.payment_failed` | routes.ts:1432 | No — CAS `WHERE status='completed' AND reversed_at IS NULL` |
| `charge.refunded` | routes.ts:1808 | **YES, narrowly** — see P0-4 |
| `charge.refund.updated` | routes.ts:1971 | **YES, same defect** |
| `charge.dispute.created` | routes.ts:2084 | No — CAS + self-heal |
| `customer.subscription.*` | routes.ts:1522 | No — real txn with `SELECT ... FOR UPDATE` `:1569-1651` |
| `setup_intent.succeeded`, `checkout.session.expired`, `payment_intent.processing`, `account.updated` | routes.ts:941, 1023, 1237, 2150 | No |

**Partial-commit risk: YES — confirmed and acknowledged in-code.**
`webhookRepo` uses `withClient()` — a bare pool connection with **no transaction**
(`db/pg-base.ts:96-103`). Money mutations use `withTenant`/`withTenantTransaction`, each opening
its **own separate** transaction (`pg-base.ts:29-91`). The request-scoped transaction middleware is
mounted **only on `/api`** (`app.ts:4546`); `/webhooks` (mounted `app.ts:1169`) gets none.

So the receipt row, the `processed` marking, the payment insert, the invoice credit, and the audit
write are **five separate commits**. Even *inside* `recordPayment`, `paymentRepo.create` and
`invoiceRepo.incrementAmountPaidAtomic` are separate transactions — stated outright at
`payment.ts:526-538` ("the winning attempt may have committed the payment row but crashed before
crediting the invoice"). Same for reversals (`payment-service.ts:214-238`).

The codebase compensates with per-handler idempotency (atomic increments, CAS flips, unique
indexes, self-heal reconcilers) rather than a transaction boundary — a deliberate composition,
tested at `test/webhooks/durable-idempotency.test.ts:363-527`.

**Ordering.** No ordering is assumed; out-of-order delivery is handled by throwing to force a Stripe
retry (`routes.ts:1925-1937`, `:2027-2036`, `:2109-2117`). Retries are safe for subscription mirror,
dispute reversal, ACH reversal, deposit credit, invoice credit, and setup_intent — **not** for
partial refunds (P0-4). Known non-idempotent metric side effect: `recordFunnelEvent` fires outside
the `FOR UPDATE` transaction (`routes.ts:1670-1710`) — inflation only, documented at `:1677-1690`.

**P0-014 compliance: PARTIAL.** Stripe does use the shared base (`handleWebhookEvent` +
`WebhookRepository`), but **two parallel idempotency abstractions sit over the same table**:
Stripe/Clerk use `webhookRepo` (`PgWebhookRepository`), while Twilio/SendGrid/Vapi use
`webhookEventRepo` (`PgWebhookEventRepository`, `webhooks/pg-webhook-event.ts`). Two stale
docstrings there cite a nonexistent migration (`049_create_webhook_events` — 049 is actually
`049_add_view_tokens_to_estimates_and_invoices`, `schema.ts:1082`) and a nonexistent index
(`idx_webhook_unprocessed`).

---

## Track 4 — Refunds & tax

**Refund: PARTIAL — recording EXISTS, initiation is ABSENT.**

Nothing in this codebase ever calls Stripe to create a refund. No `stripe.refunds.create`
anywhere in `packages/api/src`; no refund route in any of the 70 files under `routes/`; no button
or form in web or mobile (the only `refund` hit in the UI is `refundsCents` as a display field,
`web/src/pages/digest/DigestPage.tsx:102`). The system is **purely reactive** — it records refunds
already issued from the Stripe Dashboard, via `charge.refunded` (`webhooks/routes.ts:1808`) and
`charge.refund.updated` (`:1971`) → `recordRefund` (`payments/payment-service.ts:77`).

- **Over-refund guard: YES, and cumulative-aware** — not the naive defect. `incrementRefundAtomic`
  (`invoices/pg-payment.ts:247-268`) checks `refunded_amount_cents + $3 <= amount_cents` inside a
  single atomic UPDATE (`:261`), so prior partials count and two concurrent deliveries can't both
  pass. Race-tested at `test/payments/payment-refund-concurrency.test.ts:63,117`.
- **Partial refunds: YES** — `refunded_amount_cents` accumulates across calls.
- **Write-back: PARTIAL by explicit design.** The payment row gets `refunded_amount_cents`,
  `refunded_at`, `last_refund_stripe_id` + a `payment.refunded` audit event
  (`payment-service.ts:138-156`). **The invoice is never touched** — `recordRefund` takes no
  `invoiceRepo`. Per the comment at `payment-service.ts:234-237`: *"Refunds are intentionally NOT
  subtracted from the ledger sum… `invoice.amount_paid == Σ(active payment amount_cents)` holds
  refund-inclusive."* **Practical effect: a fully-refunded invoice still displays `status: 'paid'`
  with its original `amountPaidCents`; no due balance reappears.** Contrast `reversePayment`
  (`:275-473`), which *does* reopen the invoice via `decrementAmountPaidAtomic`.
- Reporting recomputes refund impact at read time from `payment.refundedAmountCents` directly —
  `reports/money-dashboard.ts:193-207`, `reports/tax-export.ts:97-124` — not from a stored aggregate.
- `recordRefund` never triggers the job-money-state / time-to-cash rollup (no `moneyStateDeps`,
  unlike `reversePayment`).

**Tax: STORED, flat, rounded once per document.**

- **Stored, not recomputed.** `tax_rate_bps`, `subtotal_cents`, `taxable_subtotal_cents`,
  `tax_cents`, `total_cents` are real columns on both estimates (`schema.ts:530-533`) and invoices
  (`:628-631`). `calculateDocumentTotals` (`billing-engine.ts:93-124`) writes them; `mapDocumentTotalsRow`
  (`pg-invoice.ts:497-498`) maps them straight through. Conversion carries the frozen rate forward
  (`convert-estimate.ts:83`). **Historical invoices do not drift when a tenant's rate changes.**
- **Rounding point: per-document (aggregate), not per-line.** `applyBps` (`billing-engine.ts:89-91`)
  = `Math.round((amountCents * bps) / 10000)`, called **once** at `:106` on
  `effectiveTaxableAmount = Math.max(0, taxableSubtotalCents - discountCents)` (`:105`). Standard
  round-half-up. (Each line's *price* is separately rounded at `:78-80` — that is the P0-2 surface,
  not the tax.)
- **Rate model: flat, per-document, manually keyed.** A single integer `taxRateBps` on the row,
  captured as one free-text "tax rate %" per invoice (`web/src/components/invoices/InvoiceForm.tsx:63,
  78, 173-188`). `estimate_templates.default_tax_rate_bps` (`schema.ts:847`) is a prefill only.
  **No jurisdiction column, no tax-rate table, no nexus concept anywhere.**
- **Per-line taxability EXISTS** — `taxable BOOLEAN NOT NULL DEFAULT true` on both line-item tables
  (`schema.ts:563, 664`); `calculateDocumentTotals` filters `lineItems.filter(i => i.taxable)`
  (`:100-102`).

### Tax logic that reads as more complete than it is — FLAGGED

1. **`taxExempt` is a phantom.** `ai/supervisor/checks.ts:80-107` reads `payload.taxExempt === true`
   purely to detect "B2B money terms" for **AI-supervisor escalation** (`:116-129`). It never reaches
   `calculateDocumentTotals`, `LineItem`, or any column — **there is no `tax_exempt` field on
   customers or invoices anywhere.** A genuinely tax-exempt customer's invoice is still taxed at the
   flat rate unless a human manually zeroes it or unchecks every line.
2. **`jurisdiction` is a false-positive term in this repo.** It appears extensively
   (`shared/contracts/voice-assistants.ts` `JURISDICTION_FLAGS`, `api/src/compliance/jurisdiction.ts`)
   but is **100% voice-call compliance** (recording disclosure, quiet hours, DNC) — unrelated to tax.
3. Multi-jurisdiction tax is a **documented, acknowledged** gap, not a silent one —
   `docs/quality/crm-deep-state-and-edges.md:337`, `docs/superpowers/agents/invoice/flow.md:137`
   ("v1 = single-jurisdiction tax. v2 = multi-jurisdiction via Stripe Tax" — not built).

### Discount / tax interaction — possible defect

The **same full `discountCents`** is subtracted from the *taxable* subtotal before tax
(`billing-engine.ts:105-106`) **and again in full** from the all-items subtotal for the grand total
(`:112`). The discount is **not split proportionally** across taxable and non-taxable lines. On a
mixed-taxability invoice with a discount, the tax base is reduced by more than the discount actually
applied to taxable lines — **under-taxing**. If `discountCents` exceeds `taxableSubtotalCents`, tax
floors at 0 while the total still absorbs the entire discount.

Ordering elsewhere: processing fee compounds **on top of** tax, computed on
`(subtotal − discount + tax)` (`billing-engine.ts:107-111`). Deposits are strictly downstream —
computed on the already-tax-inclusive `totalCents` (`jobs/deposit-rule.ts:42-68`) — and never feed back.

---

## Track 5 — Ledger & infra

**Ledger: ABSENT as a double-entry construct; PARTIAL as a reconciliation surface.**

*(Tracks 1 and 5 agree on the facts and labelled them differently; this is the reconciled verdict.)*

There is **no ledger, journal, double-entry, or transaction-log table anywhere.** Every
`grep -i "ledger|journal|double.?entry"` hit is either an unrelated concept (consent event log,
recurring-job materialization log, `batch_invoice_runs`) or the informal phrase "payment ledger" in
**code comments** meaning "the flat `payments` table." `service_credits` (`schema.ts:2732`) is a
customer-goodwill table from the reviews flow, not a double-entry construct.

**Money state is invoice + payment rows, plus two denormalized derived-balance columns** —
`invoices.amount_paid_cents` / `amount_due_cents` (`schema.ts:633-634`). These are **maintained
incrementally by atomic single-UPDATE, not derived by SUM on read**:

- `incrementAmountPaidAtomic` (`pg-invoice.ts:309-337`):
  `SET amount_paid_cents = amount_paid_cents + $3, amount_due_cents = GREATEST(0, total_cents - (amount_paid_cents + $3))`
- `decrementAmountPaidAtomic` (`pg-invoice.ts:339-374`), same shape in reverse.

Each is a single compare-and-derive UPDATE (not read-modify-write), so concurrent legitimate credits
don't lose an update — **but it is a stateful counter, not a SUM.** That is the drift surface.

**A third write path to the same two columns exists and is not atomic.** The generic
`InvoiceRepository.update()` carries plain absolute setters — `amount_paid_cents = $N`,
`amount_due_cents = $N` (`pg-invoice.ts:214-221`) — bypassing the increment helpers entirely. Three
live callers write balance columns through it. Two are the crash-recovery reconciliations already
described above (`payment.ts:52-55`, `payment-service.ts:266-270`), where an absolute write is
correct by definition — reconciliation restates the value rather than adjusting it.

The third is **`applyDepositCredit` (`deposit-credit.ts:122-132`), and it is a read-modify-write**:
it computes `newAmountPaid = invoice.amountPaidCents + credit` from an invoice read earlier in the
call (`:122`), then writes that value absolutely (`:129`). A concurrent credit landing via
`incrementAmountPaidAtomic` between that read and that write is **silently overwritten** — the
invoice under-credits the customer, and `amount_paid_cents` falls below `Σ(active payments)`.

Mitigating: the path does insert a matching `payments` row first (`:119`, `amountCents: credit`,
`providerReference: 'deposit_credit'`), so **L3 holds in the serial case** — this is a lost-update
race, not a systematic violation. It is also precisely the drift L3 is built to catch, which
strengthens rather than weakens the case for L3 as the sweep spine. Note the in-file comment at
`:95-96` acknowledges a *different* adjacent risk (payment-write / invoice-update atomicity, shared
with `recordPayment`) — the lost update described here is not that one and is not flagged in code.

The only reconciliation that exists is **narrow, one-directional, and crash-recovery-only**:
`reconcileInvoiceFromPayments` (increase-only, **and refund-net — see P0-7**, `payment.ts:29-59`)
fires solely on a webhook
duplicate-insert retry (`:531-538`); `reconcileInvoiceAfterReversal` (decrease-only,
`payment-service.ts:239-273`) solely when a reversal redelivery finds the payment already flipped
(`:325-334`). **Neither runs as a scheduled job** — no reconciliation or ledger-sweep worker exists
in `packages/api/src/workers/`. **An over- or under-count arising outside those two exact crash
windows never self-heals.**

Secondary derived balances follow the same incremental pattern: `jobs.deposit_paid_cents`
(capped by a CHECK, not a SUM, `schema.ts:2098-2110`) and `payments.refunded_amount_cents`
(WHERE-guarded single UPDATE, `schema.ts:2645-2651`).

**Money-table RLS: CLEAN.** Every money table carries the full three-part pattern —
`tenant_id NOT NULL` + a `tenant_isolation_*` policy + `FORCE ROW LEVEL SECURITY`:

| Table | file:line |
|---|---|
| invoices | schema.ts:622-650 (`024`) |
| invoice_line_items | schema.ts:656-671 (`025`) |
| estimates | schema.ts:524-549 (`020`) |
| estimate_line_items | schema.ts:555-570 (`021`) |
| payments | schema.ts:677-702 (`026`) |
| customer_payment_methods | schema.ts:4412-4431 (`176`) |
| jobs (deposits) | schema.ts:369-390 (`016`) |
| estimate_provenance / estimate_approvals | schema.ts:576-592 / 598-616 |
| invoice_dunning_configs / _events | schema.ts:3498-3541 (`136`) |
| invoice_schedules / batch_invoice_runs | schema.ts:3579-3598 / 3611-3625 |
| service_credits / financing_applications / catalog_items | schema.ts:2734-2748 / 5600-5620 / 1017-1035 |

Tax, payment links, and deposits have **no separate tables** — they are columns on
estimates/invoices/jobs and inherit the parent's RLS.

Backed by **two automated whole-database tests**, both passing: a static migration-text parser
(`test/db/schema.test.ts:119, 134`) asserting every `tenant_id` table has `FORCE`, and a runtime
`pg_catalog` property test (`test/integration/rls-force-catalog.test.ts:39-97`) asserting
`relrowsecurity AND relforcerowsecurity` across all ~116 tenant-scoped tables, with the exemption
set locked to exactly `oauth_states` and `platform_deprovision_log`.

Two footnotes: `expenses` had a genuine ENABLE-only window for ~34 migrations, closed by the bulk
retrofit `130_force_rls_missing_tables` (`schema.ts:3245`) — the "ENABLE now, FORCE later" pattern
exists in this codebase's history. `accounting_integrations` / `accounting_sync_log`
(`schema.ts:4301-4328`) deviate from the naming convention and carry an extra
`OR current_setting('app.system_lookup', true) = 'true'` bypass clause.

**Test convention: CONFIRMED.** npm workspaces (`package.json:5-9`), Vitest
(`packages/api/vitest.config.ts` unit, excludes `test/integration/**`;
`vitest.integration.config.ts:12-14` Docker-gated, `globalSetup`, `pool:'forks', maxWorkers:1`),
testcontainers (`@testcontainers/postgresql@^11.13.0` via `getSharedTestDb()` in
`test/integration/shared.ts`).

Naming: `test/<domain>/<feature>.test.ts` (unit/handler), `test/integration/<feature>.test.ts`
(Docker-gated), `e2e/<flow>/<feature>.spec.ts` (Playwright). **A new money integration test goes in
`packages/api/test/integration/<feature>.test.ts`** following the
`getSharedTestDb`/`createTestTenant`/`closeSharedTestDb` pattern.

Money coverage spans ~90 files across all three layers plus e2e — including
`test/integration/payment-concurrent-credit.test.ts`, `payment-duplicate-race.test.ts`,
`payment-reversal-concurrent.test.ts` (whose docstring notes it pins arithmetic a mocked Pool
"can't prove"), and the full-loop `flow2-money-loop-runthrough.test.ts`.

**Ungrounded DB-mocking tests** — the exact anti-pattern CLAUDE.md names:
`test/estimates/pg-approval.test.ts:1-7` (`PgApprovalRepository` / `estimate_approvals`) and
`test/reputation/pg-service-credit.test.ts:1-21` (`PgServiceCreditRepository` / `service_credits`,
which holds `amount_cents`) both stub the `pg` Pool with **no integration counterpart**
(zero matches in `test/integration/`). `test/estimates/pg-estimate.test.ts` is also mocked-pool but
**is** backstopped by `test/integration/estimates.test.ts`.

---

## What `/goal money` can and cannot assert

**The load-bearing conclusion.**

There is no ledger, so a **double-entry reconciliation invariant does not exist and cannot be
swept.** But the answer is not "row-level correctness only" either. The codebase states its own
balance invariant explicitly, and it is assertable — this is a **derived-balance reconciliation**,
four layers deep:

```
L1  line.total_cents        == round(line.quantity × line.unit_price_cents)   ← BROKEN (P0-2)
L2  invoice.subtotal_cents  == Σ(line.total_cents)
    invoice.tax_cents       == round((taxable_subtotal − discount) × tax_rate_bps / 10000)
    invoice.total_cents     == subtotal − discount + tax + processing_fee
L3  invoice.amount_paid_cents == Σ(active payments.amount_cents)   ← TWO LIVE DEFINITIONS (P0-7)
    invoice.amount_due_cents  == max(0, total_cents − amount_paid_cents)
L4  invoice.amount_paid_cents <= invoice.total_cents               ← BROKEN under concurrency
```

**L4 is not redundant with L3 — it is the layer L3 is blind to.** Concurrent full-balance credits
inflate `amount_paid_cents` *and* write matching payment rows, so the sum still agrees and L3 passes
while the invoice is overpaid. Any sweep built only on L3 would report clean on exactly the
double-credit case it was meant to catch.

**L3 is the money equivalent of comms's RLS sweep.** It is the codebase's own stated invariant
(`payment-service.ts:234-237`), it is currently maintained by a stateful counter rather than a SUM,
and **no scheduled job verifies it** — the only reconciliation is two crash-recovery paths that fire
on specific webhook symptoms. A sweep that recomputes L3 from the `payments` table on every
iteration is exactly the invariant this architecture lacks and can support without new schema.

So `/goal money` **can** assert:

- **L1/L2/L4 arithmetic reconciliation** across every invoice and estimate, today. L1 will fail —
  that is the P0-2 proof — and L4 will fail on any invoice that hit the P0-6 race.
- **L3 only once P0-7 is settled.** It is the intended spine, but two live code paths implement
  different versions of it (refund-net vs refund-inclusive), so sweeping it now would assert a
  convention the codebase does not uniformly hold. **Picking the convention is a prerequisite,
  and it is a product decision rather than a fix.**
- **No payment is credited *after* a void** — and, given P0-1, also *no live payment link survives
  a void*, which is the stronger and more important form. **The invariant must be scoped to
  post-void credits, not to payments-on-void-invoices.** `partially_paid → void` is an allowed
  transition (`invoice.ts:172`) and `transitionInvoiceStatus` writes only status, so a legitimately
  voided partially-paid invoice keeps its completed pre-void payment rows — that is valid history,
  not a defect. The unscoped form would fail it.

  **Scoping this gate is currently blocked, and that is a prerequisite finding rather than a
  detail.** It needs a durable void time to compare `payments.received_at` against, and none
  exists: there is no `voided_at` column, `transitionInvoiceStatus` writes only `status` and
  `updated_at` (`invoice.ts:420-423`), `updated_at` is overwritten by any later mutation, and the
  status route emits **no audit event at all** (`routes/invoices.ts:556-567`). So there is no void
  audit event for a gate to read. **A void timestamp or a void audit event must be added before
  either this gate or the "paid with void history" assertion below can be evaluated** — asserting
  on live payment-link state is the only form available without new writes.
- **State-machine invariants** at the DB level: no invoice in `paid` that has a void/canceled
  history; no estimate with two live invoices via `estimate_id`.
- **Webhook idempotency** under redelivery and concurrency — there is a real DB constraint to
  assert against.
- **RLS completeness** — already enforced by two passing whole-DB tests; the sweep inherits it
  rather than re-proving it.

`/goal money` **cannot** assert:

- Any **double-entry / trial-balance** property — no debits, no credits, no accounts.
- **Refund-adjusted invoice balances** — refunds deliberately do not write back, so
  `amount_paid` is refund-inclusive by design. A sweep asserting "fully refunded ⇒ not paid" would
  contradict the intended invariant, not catch a bug. **This must be encoded as a documented
  exception, or the design decision must change first.**

  **Caveat — the "by design" is not uniformly implemented.** Per P0-7, `reconcileInvoiceFromPayments`
  writes the refund-**net** balance while the stated invariant and the reversal reconciler are
  refund-**inclusive**. So the convention is contradicted by a live repair path, and that
  contradiction *is* assertable even though the refund-adjustment question itself is a design
  decision. **Gate it:** the two reconcilers must agree before L3 is swept, and the sweep should
  fail on any invoice where the two definitions disagree. This belongs in the loop, not in the
  can't-assert list.
- **Cross-system reconciliation against Stripe's balance** — no stored Stripe-side aggregate to
  compare to, and P0-1 means Stripe can hold captures the DB has no row for. This is precisely
  the discrepancy class the extraction was written to anticipate.

**Recommended spine:** L3 recomputation as the per-iteration sweep (comms's RLS-sweep analogue),
with L1 as the first gate — it fails today and its fix is mechanical.

---

## Open decisions surfaced

Flagged, not decided.

1. **Refund → invoice write-back semantics.** Today a fully-refunded invoice reads `paid` with its
   original `amountPaidCents`, deliberately. That is defensible (the invoice *was* paid) but means
   no report answers "what do we still owe back." Changing it changes the L3 invariant. **Decide
   before the sweep encodes L3**, or the gate ossifies the current choice.
2. **Ledger adoption.** A `payment_refunds` child table is already tracked as **D2-4a** and would
   fix P0-4. Whether that generalizes into a real ledger — or stays a targeted child table — decides
   whether a future `/goal money` can ever assert reconciliation against Stripe.
3. **Tax jurisdiction handling.** v2-via-Stripe-Tax is documented but unbuilt. Separately,
   `taxExempt` exists as an AI-supervisor signal with no billing effect — either wire it to the
   billing engine or remove it, because today it reads as a feature that silently does nothing.
4. **Discount proportional split.** Whether a discount on a mixed-taxability invoice should reduce
   the taxable base in full (current) or proportionally (standard practice). This is a tax-correctness
   question, not just a code question.
5. **int4 → int8 on core money columns.** Core documents cap at $21,474,836.47 while newer tables use
   `BIGINT`. Migrating is cheap now and expensive later.
6. **Two webhook repository abstractions** over one table (`PgWebhookRepository` vs
   `PgWebhookEventRepository`). Consolidating is hygiene, but it also removes a second place for
   idempotency semantics to drift.
7. **Payment status excluded from the schema-parity test**, plus a dead, wrong `PaymentStatus` enum
   in `packages/shared`. Adding `paymentStatusSchema` closes the one entity the parity test misses.

---

## Track verdict summary

| Track | Item | Verdict |
|---|---|---|
| 1 | Money columns (all tables) | **EXISTS** — integer cents throughout, no float types |
| 1 | Stripe boundary | **EXISTS, CLEAN** — `String(<int cents>)`, guarded |
| 1 | API response / mobile | **EXISTS, CLEAN** |
| 1 | **Float leaks** | **PARTIAL — VIOLATIONS FOUND** (web write path, P0-2) |
| 2 | Invoice enforcement | **PARTIAL** — chokepoint bypassed by 6 of 9 sites |
| 2 | Estimate enforcement | **PARTIAL** — chokepoint bypassed by accept/decline/send |
| 2 | Payment enforcement | **PARTIAL** — no transition table, but genuine SQL CAS |
| 2 | Void → link invalidation | **BROKEN** (P0-1) |
| 2 | Paid-invoice reject | **BROKEN UNDER CONCURRENCY** (P0-6) — holds serially only; needs the L4 gate |
| 2 | Estimate → invoice | **IDEMPOTENT** primary / **DOUBLE-CONVERTIBLE** via 2 secondary paths |
| 3 | Idempotency mechanism | **EXISTS — DB constraint, not racy** |
| 3 | Signature verification | **PARTIAL** — fail-closed but hand-rolled |
| 3 | Event coverage | **PARTIAL** — refund events can double-count (P0-4) |
| 3 | Transaction boundary | **ABSENT** — five separate commits per webhook |
| 4 | Refund initiation | **ABSENT** |
| 4 | Refund recording + over-refund guard | **EXISTS** — cumulative, atomic, race-tested |
| 4 | Refund → invoice write-back | **ABSENT by design** |
| 4/5 | Balance convention across reconcilers | **BROKEN** (P0-7) — refund-net vs refund-inclusive; L3 is undefined until settled |
| 5 | Balance-column write paths | **PARTIAL** — 3 writers; `applyDepositCredit` is a read-modify-write |
| 4 | Tax storage / rounding / per-line taxable | **EXISTS** — stored, per-document round |
| 4 | Tax jurisdiction / nexus / exemption | **ABSENT** — `taxExempt` is a phantom |
| 5 | Ledger | **ABSENT** (double-entry) / **PARTIAL** (derived-balance surface) |
| 5 | Money-table RLS | **CLEAN** — all tables, two automated whole-DB tests |
| 5 | Test convention | **EXISTS** — workspaces + Vitest + testcontainers confirmed |
