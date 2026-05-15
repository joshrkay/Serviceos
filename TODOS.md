# TODOS — Deferred from /autoplan (2026-04-16)

All 4 originally-deferred items have been closed in this PR. This file now
tracks follow-ups surfaced during /review that were intentionally not fixed.

---

## Executor double-execution on multi-instance deploys ✅ CLOSED

`packages/api/src/proposals/execution/executor.ts:17-72` checks
`proposal.status === 'approved'` from the in-memory object returned by
`findReadyForExecution`, runs the handler's side effects, THEN calls
`updateStatus('executed')`. With more than one API instance running, two
workers can both claim the same approved proposal via `findReadyForExecution`
and run the handler twice (customer created twice, appointment booked twice,
etc.).

This was surfaced during `/review` of PR #89 but explicitly deferred to keep
the P0-gap PR focused. Not a problem today because ServiceOS runs a single
Railway dyno, but any horizontal scale flips this on.

**Fix:** atomic claim via `UPDATE proposals SET status = 'executing' WHERE id
= $1 AND status = 'approved' RETURNING *` before running the handler. If the
update returns no row, another worker claimed it — skip. Add an `'executing'`
ProposalStatus (or a dedicated `claimed_by` + `claimed_at` column pair) and
thread it through the lifecycle.

**Effort:** ~30 min CC + careful thinking about crash recovery (what if the
handler crashes mid-execution — do we reset `executing` back to `approved` on
a timeout?). Flag before scaling past one dyno.

This same issue covers the §8 `log_expense` idempotency concern — same
double-execution risk, same fix.

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

## Partial refunds are unrepresentable

`PaymentStatus` is binary: `'pending' | 'completed' | 'failed' | 'refunded'`.
A $500 payment with a $50 partial refund either stays `'completed'` (refund
invisible) or flips to `'refunded'` (overstates the refund as $500). The §8
tax export currently uses the binary status — refunded rows surface with
`[REFUNDED]` in the description so the accountant can adjust manually, but
the magnitude isn't carried.

**Fix:** add `refunded_amount_cents INTEGER` and `refunded_at TIMESTAMPTZ`
columns to `payments`. Treat refund as a separate event: the original
payment stays `completed` for its original receivedAt period; the refund
is a separate `expense` row (or a negative income row) dated by `refunded_at`.
Migration is straightforward — both new columns are NULL-able and
default-NULL doesn't break existing rows.

**Effort:** ~1 hour CC + schema migration + update the tax-export
income loop to emit refund rows.

Not blocking launch because solo-operator partial refunds are rare and the
accountant can adjust the `[REFUNDED]` rows manually.
