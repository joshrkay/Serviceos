# Invoice Agent — Skills

Most of these skills already exist as code in `packages/api/src/invoices/*`, `packages/api/src/payments/*`, and `packages/api/src/proposals/contracts/*`. The agent's value-add is **state machine orchestration + idempotency + audit**, not new business logic.

## Skill index

| Skill | Used in states | Wraps existing | New code | Notes |
|---|---|---|---|---|
| `create_invoice_draft` | trigger → draft | `invoices/invoice.ts` repo, `billing-engine` | small | wrapper |
| `apply_invoice_edit` | draft (edit) | `invoice-editor.ts`, `invoice-edit-task.ts` | small | wrapper + delta audit |
| `validate_invoice` | validating | `invoice-proposal-validator.ts` | small | wrapper |
| `compute_totals` | draft (on every edit) | shared `billing-engine` | none | reuse |
| `check_auto_approve` | awaiting_approval | tenant policy + AI confidence read | small | new |
| `queue_invoice_proposal` | awaiting_approval (manual) | proposal engine | small | wraps `issue-invoice` proposal handler |
| `issue_invoice` | issuing | `proposals/handlers/issue-invoice.ts`, `stripe-payment-link.ts` | small | wraps existing |
| `record_invoice_in_provider` | issuing | `stripe-invoice-updater.ts` | none | reuse |
| `generate_invoice_pdf` | issuing (background) | `invoice-context.ts` + new pdf renderer | medium | new (v1 stub: HTML invoice; v2: real PDF) |
| `notify_customer_of_invoice` | awaiting_payment | followup agent `send_email` / `send_sms` | small | hand-off, not in-process |
| `apply_payment` | reconciling | `invoice-payment-reconciler.ts`, `record-payment.ts` proposal | small | wraps existing |
| `handle_payment_failed` | payment_failed | followup agent rule | small | new (emits failure event) |
| `handle_dispute` | disputed | Stripe webhook + audit | small | new |
| `void_invoice` | voiding → voided | Stripe void + DB update | small | new |
| `write_off_invoice` | writing_off → written_off | bad-debt ledger entry | small | new |
| `reconcile_late_payments` | background sweep | reconciler in scan-mode | small | new (handles stuck webhooks) |
| `emit_audit` | every transition | shared audit | none | reuse |

## Skill specs

---

### `create_invoice_draft` (small — wrap)

Creates the canonical invoice row in `draft` state. Source-aware so we don't duplicate from re-fired events.

**Input:**
```ts
type CreateDraftInput =
  | { source: 'job_completed', jobId: string }
  | { source: 'estimate_accepted', estimateId: string }
  | { source: 'manual', dispatcherId: string, payload: InvoiceDraftPayload }
  | { source: 'ai_proposal', proposalId: string, payload: InvoiceDraftPayload };
```
**Output:** `{ invoiceId: string, idempotent: boolean }`
**Errors:** `MissingCustomerError`, `MissingLineItemsError`, `IdempotencyConflict`
**State:** `draft`
**New file:** `packages/api/src/agents/invoice/create-draft.ts`

**Implementation notes:**
- Idempotency: `(tenantId, source, sourceRef)` unique key. Re-firing returns existing `invoiceId`.
- Line items are sourced:
  - `job_completed`: from `job.line_items` snapshot at completion.
  - `estimate_accepted`: from accepted estimate revision.
  - `manual` / `ai_proposal`: from explicit payload.
- Totals are computed by **billing engine** — never inline math.

---

### `apply_invoice_edit` (small — wrap)

Applies a typed patch to a draft invoice and records an edit-delta. Only valid in `draft`.

**Input:** `{ invoiceId, patch: InvoiceEditPatch, actorId }`
**Output:** `{ revision: number, totals: InvoiceTotals }`
**Errors:** `InvoiceNotEditable` (if not in `draft`), `InvalidPatch`
**State:** `draft`
**Wraps:** `invoice-editor.ts`, AI evaluation `invoice-edit-delta.ts` for audit context.

---

### `validate_invoice` (small — wrap)

Runs the existing proposal validator on the current draft revision. Returns either `valid` or `field_errors`.

**Input:** `{ invoiceId }`
**Output:** `{ valid: true } | { valid: false, field_errors: ValidationIssue[] }`
**State:** `validating`
**Wraps:** `invoice-proposal-validator.ts`.

**Validation rules** (already implemented):
- All line totals equal `unit_price * quantity` (integer cents).
- Subtotal + tax = total (no rounding errors).
- Customer + billing address present.
- Currency is tenant's configured currency (v1 single-currency).
- No negative totals unless invoice is a credit memo.

---

### `check_auto_approve` (small — new)

Decides whether to skip the human approval queue based on tenant policy + AI confidence + amount.

**Input:** `{ invoiceId, source, aiConfidence?: number }`
**Output:** `{ autoApprove: boolean, reason: 'tenant_off' | 'amount_over_cap' | 'low_confidence' | 'auto_eligible' }`
**New file:** `packages/api/src/agents/invoice/auto-approve.ts`

**Policy (default off):**
- Tenant flag `invoice_auto_approve.enabled = true`
- AI confidence (when source is `ai_proposal`) ≥ 0.9
- Invoice total ≤ tenant `invoice_auto_approve.max_amount_cents` (default 0)
- Source ∈ {`estimate_accepted`} (the estimate was already human-approved); other sources never auto-approve in v1

---

### `queue_invoice_proposal` (small — wrap)

Inserts a proposal of type `issue_invoice` into the proposal queue for human review.

**Input:** `{ invoiceId, draftedBy: 'ai' | 'manual', reasonForReview }`
**Output:** `{ proposalId }`
**State:** `awaiting_approval`
**Wraps:** existing proposal engine + `issue-invoice` proposal handler.

---

### `issue_invoice` (small — wrap)

The big one. Allocates invoice number, creates Stripe payment link, marks invoice `issued`, persists provider IDs. Idempotent on `invoice:${invoiceId}:v${rev}`.

**Input:** `{ invoiceId }`
**Output:** `{ invoiceNumber: string, paymentUrl: string, providerPaymentLinkId: string }`
**Errors:** `StripeApiError(retriable)`, `AlreadyIssued`
**Cost ceiling:** Stripe API only (free).
**State:** `issuing`
**Wraps:** `proposals/handlers/issue-invoice.ts`, `payments/stripe-payment-link.ts`, `payments/stripe-invoice-updater.ts`.

**Implementation notes:**
- Invoice number sequence is **tenant-scoped, monotonic**, allocated at issue (NOT draft). Use Postgres sequence per tenant or `SELECT FOR UPDATE` on counter row.
- After issuing, emit `invoice.issued` event so the followup agent can fire `invoice_issued` rule (e.g. send email with link).

---

### `generate_invoice_pdf` (medium — new, v1 minimal)

v1: render invoice as HTML using existing `invoice-context.ts` and store as `invoice.html_snapshot`. Email links to a hosted view.
v2: render to PDF via Puppeteer or pdfkit; store in S3.

**Input:** `{ invoiceId }`
**Output:** `{ url: string, contentType: 'text/html' | 'application/pdf' }`
**Cost ceiling:** $0 (template render).
**New file:** `packages/api/src/agents/invoice/render-invoice.ts`

---

### `apply_payment` (small — wrap)

Called from Stripe webhook handler when `payment_intent.succeeded`. Matches payment to invoice via metadata, applies, computes balance.

**Input:** `{ paymentIntentId, amountCents, currency, invoiceId, stripeEventId }`
**Output:** `{ remainingBalanceCents: number, status: 'paid' | 'partial' }`
**Errors:** `InvoiceNotFound`, `OverPayment` (handled — auto-refund), `DuplicateEvent` (idempotent skip)
**State:** `reconciling → paid` or stays `awaiting_payment` for partial.
**Wraps:** `payments/invoice-payment-reconciler.ts`, `proposals/contracts/record-payment.ts` (creates payment record).

---

### `handle_payment_failed` (small — new)

Called from Stripe webhook when `payment_intent.payment_failed`. Records the failure, emits an event for the followup agent (which fires `invoice_payment_failed` rule), and notifies dispatcher.

**Input:** `{ invoiceId, reason, declineCode? }`
**Output:** `{ recorded: true }`
**State:** `payment_failed`
**New file:** `packages/api/src/agents/invoice/handle-payment-failed.ts`

---

### `handle_dispute` (small — new)

Called from Stripe webhook on `charge.dispute.created`. Marks invoice disputed, freezes follow-up reminders for that customer, alerts the owner.

**Input:** `{ invoiceId, chargebackId, amountCents, reason }`
**Output:** `{ recorded: true }`
**State:** `disputed`
**New file:** `packages/api/src/agents/invoice/handle-dispute.ts`

**Side effects:**
- Set `customers.dunning_paused_until = NOW() + 30 days` so follow-up agent skips this customer.
- Insert `dispute_alerts` row for owner UI.

---

### `void_invoice` (small — new)

Cancels an issued (but unpaid) invoice. Calls Stripe to expire the payment link.

**Input:** `{ invoiceId, reason, actorId }`
**Output:** `{ voidedAt: Date }`
**Errors:** `InvoiceAlreadyPaid` (must refund instead), `InvoiceNotIssued` (just delete draft)
**State:** `voiding → voided`
**New file:** `packages/api/src/agents/invoice/void-invoice.ts`

---

### `write_off_invoice` (small — new)

Marks unpaid invoice as bad debt. Owner-only action.

**Input:** `{ invoiceId, reason, actorId }`
**Output:** `{ writtenOffAt: Date, amountCents: number }`
**Errors:** `RoleNotPermitted` (must be owner)
**State:** `writing_off → written_off`
**New file:** `packages/api/src/agents/invoice/write-off-invoice.ts`

**Side effects:**
- Insert `bad_debt_ledger` entry (tenant_id, invoice_id, amount_cents, written_off_at, reason).
- Pause follow-up reminders permanently for this invoice.

---

### `reconcile_late_payments` (small — new)

Background sweep run every 15 min: finds Stripe payments that succeeded but didn't trigger our local apply (webhook delay/loss).

**Input:** `{ tenantId, lookbackHours: 24 }`
**Output:** `{ matched: number, unmatched: number }`
**State:** N/A (sweep)
**New file:** `packages/api/src/agents/invoice/reconcile-sweep.ts`

**Implementation:**
- Query Stripe `payment_intents` with `metadata.invoice_id` set, status `succeeded`, created in last 24h.
- For each, check local invoice — if not yet `paid`, run `apply_payment` synthetically.
- Emit `invoice.late_reconciled` audit if we caught one.

---

### `emit_audit` (shared)

Every state transition emits an audit row with `actor_type` (`agent` | `user` | `system`), `from_state`, `to_state`, `reason`, and a JSON snapshot of the invoice. Reuses shared audit module.

## Build vs reuse summary

| Status | Skills |
|---|---|
| Reuse (no new code) | `compute_totals`, `record_invoice_in_provider`, `emit_audit` |
| Wrap existing | `create_invoice_draft`, `apply_invoice_edit`, `validate_invoice`, `queue_invoice_proposal`, `issue_invoice`, `apply_payment` |
| New (small) | `check_auto_approve`, `handle_payment_failed`, `handle_dispute`, `void_invoice`, `write_off_invoice`, `reconcile_late_payments` |
| New (medium) | `generate_invoice_pdf` (v1 HTML; v2 real PDF) |
| Hand-off (not implemented here) | `notify_customer_of_invoice` (delegated to followup agent) |

The agent itself is a **thin state-machine module** under `packages/api/src/agents/invoice/state-machine.ts` that wires these skills together. The existing invoice repo + payments code does the heavy lifting unchanged.
