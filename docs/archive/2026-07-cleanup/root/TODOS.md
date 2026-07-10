# TODOS — Deferred from /autoplan (2026-04-16)

All 4 originally-deferred items have been closed in this PR. This file now
tracks follow-ups surfaced during /review that were intentionally not fixed.

---

## Executor double-execution on multi-instance deploys ✅ CLOSED (in code)

Shipped via `ProposalRepository.claimForExecution(proposalId, workerId)`
(see `packages/api/src/proposals/proposal.ts:546` for the in-memory impl
and `pg-proposal.ts:285` for the Postgres impl). The execution worker calls
`claimForExecution` at `packages/api/src/workers/execution-worker.ts:67`,
which atomically transitions `approved → executing` and returns `null` if
another worker won the race. `'executing'` is in the `ProposalStatus`
enum (`proposal.ts:14`) and `resetStaleExecuting` (`proposal.ts:557`)
handles crash recovery with a retry count cap.

Safe to scale past one dyno.

---

## Money dashboard + tax export bucket by UTC, not tenant timezone

`packages/api/src/reports/money-dashboard.ts:resolveMonthWindow`,
`packages/web/src/components/reports/MoneyDashboardPage.tsx:monthRange`,
and the tax-export `from`/`to` parser all use `Date.UTC` / `new Date('YYYY-MM-DD')`
(UTC midnight). A California tenant whose accountant says "Q1 2026"
expects PST midnight Jan 1 — UTC 08:00 Jan 1. A payment received 5pm PST
on Jan 31 lands in the **February** export, not January. End-of-year
boundary payments (Dec 31 11pm local time) can shift income across tax
years.

CLAUDE.md says "All times: stored UTC, **rendered in tenant timezone**"
but the dashboard math violates the second half.

**Fix:** add `tenant.timezone` (IANA TZ like `America/Los_Angeles`) and
bucket per-tenant. Touches `resolveMonthWindow`, `monthRange`,
`tax-export` date parsing, and the tax-export response (the `date` column
in each CSV row should be in tenant TZ). Use `Intl.DateTimeFormat` or
`luxon` if it's already a dep.

**Acceptable for now because:** beta tenants are US-only and Pacific time
is dominant. Document the UTC bucketing in the dashboard UI ("Buckets
reflect UTC days") so users aren't surprised at year-end.

**Effort:** ~2 hours CC + a design call on whether tenants pick TZ or we
infer it from their address.

---

## charge.refund.updated handler for pending → succeeded transitions

D2-4 (PR #384) added `charge.refunded` handling and `091e6e1` adds a
`refund.status === 'succeeded'` guard so non-settled refunds (`pending`,
`requires_action`, `failed`, `canceled`) are skip-ACKed without mutating
`refundedAmountCents`. When Stripe later settles a previously-pending
refund, it re-fires `charge.refunded` with `status='succeeded'`, so the
guard is functional today.

**Optional enhancement:** wire a dedicated `charge.refund.updated`
handler in `packages/api/src/webhooks/routes.ts`. This event fires on
every refund status transition (including `pending → failed`), letting
us explicitly observe failed-refund cases for monitoring rather than
relying on the absence of a re-fired `charge.refunded`. Low priority —
the current handler is correct, this would just improve observability.

**Effort:** ~30 min CC + 2 tests.

Surfaced by `chatgpt-codex-connector[bot]` in PR #384 review (2026-05-16).

---

## Partial refunds are unrepresentable ✅ MOSTLY CLOSED (D2-4)

D2-4 (2026-05-16, PR #384) added `refunded_amount_cents`, `refunded_at`, and `last_refund_stripe_id` columns to `payments` (migration 100), wired `recordRefund()` in `packages/api/src/payments/payment-service.ts` (with over-refund guard), connected the Stripe `charge.refunded` webhook, and updated `tax-export.ts` + `money-dashboard.ts` to emit negative-income rows + gross/net distinction.

**Known limitation carried forward:** multi-partial-refund time-bucketing.

`packages/api/src/payments/payment-service.ts` stores cumulative
`refundedAmountCents` plus a single `refundedAt` timestamp on the
payment row. Two partial refunds across different months collapse to
the latest refund's date in the tax export — Jan + Feb refunds both
get attributed to February. The over-refund magnitude guard at
`payment-service.ts:72-76` keeps totals correct; only per-event
time-bucketing is lossy.

**Fix (follow-up D2-4a):** add a `payment_refunds` child table:

```sql
CREATE TABLE payment_refunds (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  stripe_refund_id TEXT NULL,
  refunded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_refunds_tenant_payment ON payment_refunds(tenant_id, payment_id);
CREATE INDEX idx_payment_refunds_refunded_at ON payment_refunds(refunded_at);
```

Then refactor `recordRefund()` to INSERT a row (instead of updating
cumulative columns), and rebuild `tax-export.ts` + `money-dashboard.ts`
to aggregate from the child table. Keep the cumulative columns as a
denormalization for fast reads, updated by a trigger or in the same
transaction as the INSERT.

**Acceptable for now because:** beta is US-only solo-operator; multi-partial-refunds are rare; accountants can adjust manually using the `payment.refunded` audit events (which DO carry accurate per-event timestamps).

**Effort:** ~half-day CC + migration 101 + test refresh.

Surfaced by `gemini-code-assist[bot]` in PR #384 review (2026-05-16).
