# Invoice Agent — Flow

**Purpose:** Orchestrate the lifecycle of an invoice from **draft → reviewed → issued → paid (or written-off)**. Wraps existing invoice skills (`invoice-task`, `invoice-editor`, `invoice-proposal-validator`, `issue-invoice`, `record-payment`, `stripe-payment-link`, `invoice-payment-reconciler`) into a typed state machine with a single entry point and predictable side effects per transition.

The invoice agent does **not** dun — overdue reminders are emitted by the **customer-followup agent** (`invoice_reminder_*` rules). The invoice agent's responsibility ends at "issued + payment URL active", and resumes only on lifecycle events: `payment.received`, `payment.failed`, `customer_disputed`, `void_requested`, `write_off_requested`.

**Companion files:** `skills.md`, `test-plan.md`, `implementation-roadmap.md`. **Framework:** `../README.md`.

## Trigger sources

The agent does **not** poll. It runs in response to:

| Trigger | Origin | State entered |
|---|---|---|
| `job_completed` event | jobs worker | `draft` |
| `estimate_accepted` event | estimate agent | `draft` (auto-converts estimate → invoice draft) |
| Manual: dispatcher creates invoice in UI | API `POST /api/invoices` | `draft` (manual) |
| AI proposal: voice/follow-up agent drafts invoice | proposal engine | `draft` (AI) |
| `payment.received` webhook | Stripe webhook | `paid` (terminal) — async |
| `payment.failed` webhook | Stripe webhook | `payment_failed` |
| `void_requested` action | UI / dispatcher | `voiding` |
| `write_off_requested` action | UI / dispatcher | `writing_off` |

## State machine

```
              ┌──────┐
              │ idle │
              └──┬───┘
                 │ trigger (job_completed / estimate_accepted / manual / AI)
                 ▼
            ┌──────────┐
            │  draft   │  ← editable; line items, taxes, discounts
            └────┬─────┘
                 │ submit_for_review
                 ▼
        ┌─────────────────────┐  rejected
        │  validating         │──────────────┐
        └────┬────────────────┘              │
             │ valid                         │
             ▼                               │
        ┌─────────────────────┐              │
        │  awaiting_approval  │              │
        └────┬────────────────┘              │
             │ approved (auto or human)      │
             ▼                               │
        ┌─────────────────────┐              │
        │  issuing            │              │
        └────┬────────────────┘              │
             │ issued (Stripe link active)   │
             ▼                               │
        ┌─────────────────────┐              │
        │  awaiting_payment   │ ◀────────────┘ (back to draft)
        └────┬────────────────┘
             │ payment_received    payment_failed     dispute    void / write_off
             ▼                          │                │            │
        ┌─────────────────────┐         ▼                ▼            ▼
        │  reconciling        │  ┌─────────────┐  ┌──────────┐  ┌──────────┐
        └────┬────────────────┘  │ payment_    │  │ disputed │  │ voiding  │
             │                    │ failed      │  └────┬─────┘  └────┬─────┘
             ▼                    └──┬──────────┘       │             │
        ┌─────────────────────┐      │ retry           ▼             ▼
        │  paid               │      │              ┌──────┐    ┌──────────┐
        └─────────────────────┘      └──────────────│closed│    │ voided / │
                                                    └──────┘    │written_off│
                                                                └──────────┘
```

### State definitions

| State | Description | Entry side effects | Exit |
|---|---|---|---|
| `idle` | No active invoice for this entity. | — | trigger |
| `draft` | Editable invoice. Line items, taxes, totals computed via shared **billing engine**. | Persist draft row. Compute totals. Emit `invoice.draft.created`. | `submit_for_review` event |
| `validating` | Run `invoice-proposal-validator` (zod schemas + business rules: line totals = unit × qty, tax math, currency consistency, customer billing address present, no negative totals unless credit). | Run validator. | `valid` → `awaiting_approval`; `rejected` → back to `draft` w/ field errors |
| `awaiting_approval` | Auto-approve OR queue proposal for human review based on tenant policy + AI confidence. | Insert proposal row OR auto-approve. | `approved` or `rejected` |
| `issuing` | Allocate invoice number, call Stripe to create payment link, write final invoice + provider payment link id to DB. | Stripe API call (idempotent by invoice id). PDF generation enqueued. Email/SMS send queued via follow-up agent. | provider ack |
| `awaiting_payment` | Invoice live; payment URL active; customer can pay. | Audit `invoice.issued`. Emit `estimate.invoice_created` (closes estimate loop). | webhook |
| `reconciling` | Stripe `payment_intent.succeeded` received. Match payment → invoice via metadata. Update balance. | `invoice-payment-reconciler` runs. Apply payment. Compute remaining balance. | full payment → `paid`; partial → stay in `awaiting_payment` |
| `paid` | Balance = 0. | Audit. Emit `invoice.paid`. Trigger commission calc + payout schedule. | terminal |
| `payment_failed` | Charge failed (insufficient funds, expired card, etc.). | Audit. Notify dispatcher. Followup agent fires `invoice_payment_failed` rule. | retry → `awaiting_payment`; abandon → `closed` |
| `disputed` | Customer initiated chargeback. | Audit. Freeze further follow-ups. Notify owner. | dispute resolved → `paid` or `closed` |
| `voiding` | Dispatcher voided invoice. | Stripe void call. Audit. | void confirmed → `voided` |
| `voided` | Terminal. Invoice marked void. No payment expected. | Audit. Emit `invoice.voided`. | terminal |
| `writing_off` | Owner accepts loss. | Mark write-off w/ reason. | confirmed → `written_off` |
| `written_off` | Terminal. Loss booked to bad-debt ledger. | Audit. | terminal |
| `closed` | Catch-all terminal for abandoned invoices. | Audit w/ reason. | terminal |

## Events

**Input (to the agent):**
- `invoice.create_requested(payload, source)` — `source ∈ { job_completed, estimate_accepted, manual, ai_proposal }`
- `invoice.edit_requested(invoiceId, patch)` — only valid in `draft`
- `invoice.submit_for_review(invoiceId)`
- `invoice.approve(invoiceId, approverId)` / `invoice.reject(invoiceId, reason)`
- `invoice.issue_failed(invoiceId, reason)` — Stripe error during issuing
- `payment.received(invoiceId, paymentIntentId, amount)` — from Stripe webhook
- `payment.failed(invoiceId, paymentIntentId, reason)` — from Stripe webhook
- `payment.disputed(invoiceId, chargebackId)` — from Stripe webhook
- `invoice.void_requested(invoiceId, reason, actorId)`
- `invoice.write_off_requested(invoiceId, reason, actorId)`

**Emitted (out):**
- `invoice.draft.created`
- `invoice.issued(invoiceId, providerPaymentLinkId, paymentUrl)`
- `invoice.paid(invoiceId, totalCents)`
- `invoice.payment_failed(invoiceId, reason)`
- `invoice.voided(invoiceId, reason)`
- `invoice.written_off(invoiceId, amountCents, reason)`
- `invoice.disputed(invoiceId, chargebackId)`

## Approval policy (per tenant)

| Tenant config | Auto-approve when | Otherwise |
|---|---|---|
| `auto_approve_invoices: false` (default) | never | always queue proposal |
| `auto_approve_invoices: true, max_auto_amount_cents: 50000` | AI confidence ≥ 0.9 AND total ≤ $500 AND originated from `estimate_accepted` (estimate already approved) | queue proposal |
| `auto_approve_invoices: true, max_auto_amount_cents: 0` | never | always queue (effectively off) |

Manual invoices created by dispatcher in UI bypass the agent's approval gate (the UI submission **is** the approval).

## Idempotency

- Invoice creation: idempotency key = `tenantId:source:sourceRef` (e.g. `t1:job_completed:job_42`). Re-firing the source event does NOT create a duplicate invoice.
- Stripe payment-link creation: idempotency key = `invoice:${invoiceId}:v${rev}` so retries don't double-bill.
- Webhook processing: dedupe by `stripe_event_id` in `webhook_idempotency` table.

## Cost & rate caps

- **AI cost ceiling:** ≤ $0.05 per invoice draft (cheap-tier model for line-item composition; mid-tier only on edit-delta evaluation).
- **Stripe rate limit:** 100 req/sec/account; agent serializes per-tenant Stripe ops to ≤ 25 req/sec.
- **Per-tenant invoice cap:** none (tenants may invoice freely), but burst > 100/min logs an anomaly alert.

## Compliance

- **PCI:** No card data ever touches our servers. Stripe Payment Link only.
- **Tax:** Sales-tax math runs through the **shared billing engine**. Per-tenant rate config; agent never hard-codes rates. v1 = single-jurisdiction tax. v2 = multi-jurisdiction via Stripe Tax.
- **Audit:** Every state transition emits an audit row (`invoice.{state_entered}`). Edits log a typed delta.
- **Retention:** Voided/written-off invoices retained for ≥ 7 years (IRS) — soft-delete only.

## Failure-mode → state map

| Failure | Detection | Behavior |
|---|---|---|
| Validator rejects (math, missing fields) | `invoice-proposal-validator` returns issues | back to `draft` with structured `field_errors` |
| Stripe 5xx during issuing | provider response | retry w/ backoff up to 3x; then `closed (provider_error)` |
| Stripe 4xx (e.g. invalid currency) | provider response | back to `draft` w/ error surfaced; do **not** auto-retry |
| Webhook delivery delay > 24h | reconciliation job | `reconcile_late_payments` worker scans for paid-in-Stripe but unmatched-locally |
| Duplicate webhook | dedupe table | skip; emit `webhook.duplicate` audit |
| Reconciliation finds payment > invoice total | reconciler | flag `overpaid`; create credit-balance entry; alert owner |
| Customer overpays via two channels | reconciler | second payment refunded automatically; alert owner |

## Channel — where the agent is invoked

| Channel | How invoice work surfaces |
|---|---|
| Voice (in-app or telephony) | Calling agent → proposal `issue_invoice` → invoice agent enters `awaiting_approval` |
| Web UI (dispatcher) | Direct REST → `draft` → `validating` → `awaiting_approval` (auto-approves on submit) |
| Background (job_completed) | Worker emits event → agent enters `draft` automatically |
| Estimate accepted | Estimate agent emits event → agent enters `draft` w/ pre-populated line items from estimate |

## Open questions

1. **Partial payments — first-class or proposal-driven?** v1: first-class state. Reconciler keeps invoice in `awaiting_payment` until balance = 0. v2: tenant policy to require full payment.
2. **Multi-currency invoices?** v1 = tenant single currency. v2 = per-invoice currency w/ FX freeze at issue time.
3. **Automatic late fees?** v1 = no. v2 = optional rule on the followup agent that drafts a `late_fee` adjustment proposal.
4. **Refunds — separate agent or this one?** Decision: this agent. Refund is a transition out of `paid` → `refunding` → `refunded` (added in v2 scope).
