# Invoice Agent — Test Plan

Test coverage targets: **100% branch coverage on state transitions and idempotency keys**, **≥ 90% line coverage on agent skills**, **integration tests against ephemeral Postgres + Stripe test mode**.

## Categories

### 1. Happy paths (state machine A→Z)

| ID | Scenario | Entry | Expected terminal state | Side effects asserted |
|---|---|---|---|---|
| H-1 | Manual invoice paid in full, single payment | dispatcher `POST /api/invoices` | `paid` | invoice row, audit chain, Stripe payment-link, `record_payment` row, balance = 0 |
| H-2 | Estimate accepted → auto-approve → paid | `estimate_accepted` event with confidence 0.95, total $400, tenant auto_approve on, cap $500 | `paid` | no human approval row; emitted `invoice.issued` |
| H-3 | Job completed → human approve → paid | `job_completed` event | `paid` | proposal queued, approved, issued |
| H-4 | AI proposal → review → approve → paid | voice agent emits `issue_invoice` proposal | `paid` | proposal preserved, approval audit |
| H-5 | Partial payment then second payment | $400 invoice → $200 first, $200 second | `paid` | stays `awaiting_payment` after partial; `paid` after second; two `record_payment` rows |
| H-6 | Voided before payment | dispatcher voids issued invoice | `voided` | Stripe link expired, `invoice.voided` audit, follow-up rules suppressed |
| H-7 | Written off after 90 days | owner write-off | `written_off` | bad-debt ledger entry, follow-up reminders permanently paused |

### 2. Idempotency

| ID | Scenario | Expected |
|---|---|---|
| ID-1 | Same `job_completed` event fired twice within 1s | one invoice; `idempotent: true` on 2nd call |
| ID-2 | Stripe webhook delivered twice for same `payment_intent.succeeded` | one `record_payment`; second skipped via `webhook_idempotency` |
| ID-3 | Issuing retry after Stripe 5xx (transient) | one Stripe payment-link, identified by idempotency key `invoice:${id}:v${rev}` |
| ID-4 | Two simultaneous `submit_for_review` calls (race) | exactly one transition; second returns existing state |

### 3. Validation

| ID | Scenario | Expected |
|---|---|---|
| V-1 | Line item total mismatch (qty 2 × $5 but `total_cents` says $20) | `validating` → `draft` w/ `field_errors[0].path = 'line_items[0].total_cents'` |
| V-2 | Subtotal + tax ≠ total | rejected w/ structured error |
| V-3 | Currency mismatch (USD invoice, EUR line item) | rejected |
| V-4 | Customer with no billing address | rejected |
| V-5 | Negative total without `is_credit_memo: true` | rejected |
| V-6 | Empty line items | rejected |

### 4. Auto-approve policy

| ID | Scenario | Expected |
|---|---|---|
| AA-1 | Tenant flag off | always queue proposal |
| AA-2 | Flag on, source=`manual` | queue proposal (manual never auto in v1) |
| AA-3 | Flag on, source=`estimate_accepted`, total=$300, cap=$500, conf=0.95 | auto-approve |
| AA-4 | Flag on, source=`estimate_accepted`, total=$600, cap=$500 | queue proposal |
| AA-5 | Flag on, source=`ai_proposal` (not estimate_accepted) | queue proposal (only estimate_accepted auto-approves in v1) |
| AA-6 | Flag on, conf=0.85 | queue proposal (below 0.9 threshold) |

### 5. Payment edge cases

| ID | Scenario | Expected |
|---|---|---|
| P-1 | Overpayment ($400 invoice, $500 paid) | apply $400, refund $100 to Stripe automatically, alert owner |
| P-2 | Customer pays via two channels (Stripe link + manual `record_payment` proposal) | second attempt detected; reject duplicate; alert |
| P-3 | Payment fails (decline) | `payment_failed` state; followup agent fires `invoice_payment_failed` rule |
| P-4 | Webhook delivered 6h late | reconcile-sweep catches it; invoice transitions to `paid` |
| P-5 | Stripe dispute opened | `disputed` state; customer dunning paused 30 days; owner alert |
| P-6 | Refund issued in Stripe Dashboard (out-of-band) | reconciler detects negative payment; balance adjusted; if balance > 0 again, status reverts |

### 6. Multi-tenant isolation

| ID | Scenario | Expected |
|---|---|---|
| MT-1 | Tenant A's webhook never matches tenant B's invoice | strict `tenantId` lookup via metadata; cross-tenant matches REJECTED with audit |
| MT-2 | Tenant A's auto-approve config never affects tenant B | per-tenant settings load; B always queues |
| MT-3 | Invoice number sequences are independent per tenant | tenant A's seq=42 doesn't advance tenant B's |

### 7. State-machine completeness

For every (state, event) pair NOT in the transition table, assert the agent **rejects with `IllegalTransition`** and emits an audit row. Generate cases programmatically from the table.

### 8. Cost ceilings

| ID | Scenario | Expected |
|---|---|---|
| C-1 | Draft via AI gateway | total tokens × cost ≤ $0.05 |
| C-2 | Edit eval via AI gateway | bounded by gateway budget; alert at 90% |

### 9. Failure recovery

| ID | Scenario | Expected |
|---|---|---|
| F-1 | Stripe 503 during issuing | retry 3× w/ backoff; success on retry → state advances |
| F-2 | Stripe 503 persistent | after 3 retries → `closed (provider_error)`; alert dispatcher |
| F-3 | Stripe 4xx (invalid currency) | back to `draft` w/ error surfaced; no retry |
| F-4 | DB error during validation | task returned to queue with delay; no half-state |
| F-5 | PDF render fails | invoice still `awaiting_payment` (PDF is async/best-effort); retry queued |
| F-6 | Webhook with unknown `payment_intent_id` | dead-letter audit; do NOT crash worker |

### 10. Authorization

| ID | Scenario | Expected |
|---|---|---|
| AZ-1 | Technician attempts `void_invoice` | `RoleNotPermitted` (owner/dispatcher only) |
| AZ-2 | Dispatcher attempts `write_off_invoice` | `RoleNotPermitted` (owner only) |
| AZ-3 | Cross-tenant void attempt | `NotFound` (no tenant leak) |

### 11. Audit completeness

For each happy path: assert audit chain has every state transition with `actor_type`, `from_state`, `to_state`, `reason`. Run `audit-replay` test that reconstructs final state from audits alone — must match DB.

### 12. Reconciliation sweep

| ID | Scenario | Expected |
|---|---|---|
| R-1 | Webhook delayed 23h | sweep at hour 24 catches; invoice → `paid` |
| R-2 | Webhook delayed 25h (outside lookback) | sweep misses; alert raised in stuck-payments dashboard |
| R-3 | Sweep run twice in same window | idempotent; no double-apply |

### 13. Performance

| ID | Scenario | Target |
|---|---|---|
| Perf-1 | Issue invoice (Stripe roundtrip) | p95 < 1.5s |
| Perf-2 | Apply payment (webhook → state) | p95 < 500ms |
| Perf-3 | Validate draft | p95 < 200ms |
| Perf-4 | Reconcile sweep (1k invoices) | p95 < 30s |

### 14. Integration with adjacent agents

| ID | Scenario | Expected |
|---|---|---|
| I-1 | Estimate accepted → invoice agent enters `draft` automatically | invoice draft pre-populated from estimate revision |
| I-2 | Invoice issued → followup agent fires `invoice_issued` rule sending email | one email send within 60s |
| I-3 | Invoice 7d overdue → followup agent fires `invoice_reminder_7d` | SMS sent (per `customer-followup` test plan) |
| I-4 | Customer replies STOP to reminder | followup adds DNC; invoice agent untouched |
| I-5 | Invoice voided → followup agent suppresses pending reminders | no further reminders for that invoice |

### 15. End-to-end (happy path)

```
job_completed(jobId) 
  → invoice_agent: draft 
  → validate (auto) 
  → auto_approve (off, default) 
  → queue proposal 
  → owner approves in UI 
  → issuing 
  → Stripe payment link created 
  → email sent (via followup) 
  → customer pays 
  → webhook → reconciling → paid 
  → commission worker triggered
```

Asserted: 7 audit rows, 1 proposal row, 1 record_payment row, 1 commission_calc enqueue, 0 errors.

### 16. Pre-launch checklist (must pass before turning agent ON in production)

- [ ] All happy paths green in CI (H-1 through H-7)
- [ ] All idempotency cases green (ID-1 through ID-4)
- [ ] State-machine completeness coverage = 100%
- [ ] Stripe webhook signature verification ON
- [ ] Stripe metadata strategy documented (`tenantId`, `invoiceId`, `revision`)
- [ ] Reconcile sweep cron scheduled (`*/15 * * * *`)
- [ ] Auto-approve flag DEFAULT OFF for new tenants
- [ ] Audit replay test green
- [ ] Tenant isolation (MT-1 through MT-3) green
- [ ] Authorization (AZ-1 through AZ-3) green
- [ ] Bad-debt ledger schema migrated
- [ ] Voided invoice retention set ≥ 7 years (soft-delete)

## Test fixtures

Reusable fixtures under `packages/api/test/fixtures/invoice/`:
- `tenant.basic.json` — single-currency USD tenant, auto-approve off
- `tenant.auto-approve.json` — auto-approve enabled with $500 cap
- `customer.with-address.json` — billing address present
- `customer.no-address.json` — for V-4
- `job.completed.json` — job ready for invoicing
- `estimate.accepted.json` — accepted estimate ready for conversion
- `stripe-events/payment-succeeded.json` — webhook payload
- `stripe-events/payment-failed.json`
- `stripe-events/charge-disputed.json`
- `stripe-events/payment-refunded.json`

## Tooling

- **Stripe test mode** for integration tests; mock `stripe.paymentLinks.create`, `stripe.refunds.create` in unit tests.
- **Ephemeral Postgres** via testcontainers for state-machine tests; migrations applied at suite setup.
- **Vitest** with `--coverage` and the `c8` provider; CI gate at 90% line / 100% branch on agent state machine.
- **Property-based** transition tests: generate (state, event) pairs from the transition table and assert no `IllegalTransition` for legal pairs, and `IllegalTransition` for all others.
