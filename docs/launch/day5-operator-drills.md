# Day 5 Operator Drills — Launch Rehearsal

Agent-owned isolation tests live in `e2e/qa-matrix/isolation.spec.ts` (ISO-01).  
This runbook covers prod-access drills the operator runs against the live Railway environment.

## Prerequisites

- Day 2 secrets confirmed (`docs/prod-env-checklist.md`)
- Day 3 schema probes pass (`scripts/prod-schema-probe.sql`)
- QA matrix secrets configured for `npm run qa:doctor`

## 1. Two-tenant isolation (automated)

```bash
npm run qa:doctor
npm run e2e:qa-matrix -- --grep "ISO-01"
```

ISO-01 now covers: customer, job, estimate, invoice, conversation, attachments list, audit_events (DB GUC), voice recording, cross-tenant note write, and RLS probes.

**RLS probe note:** `E2E_DB_URL_READONLY` must use the `qa_readonly` role (not superuser). See `qa/backlog/ISO-01-rls-probe-role.md`.

## 2. Single-instance rolling deploy

1. Note current deploy ID in Railway dashboard.
2. Push a no-op or docs-only deploy to prod (or redeploy current image).
3. Watch logs during SIGTERM:
   - `[shutdown] SIGTERM received — closing HTTP server`
   - Background intervals cleared (no duplicate sweep log lines after new instance starts)
4. Confirm advisory-lock sweeps: only one instance logs sweep work per interval (lock keys `590001`–`590013` in `app.ts`).

**Pass criteria:** Clean shutdown message; no duplicate cron side effects; new instance serves `/health` 200.

## 3. Webhook replay drill (Stripe)

Re-send the same Stripe event twice (same `id` / idempotency key):

1. `checkout.session.completed` for a test payment
2. `charge.refunded` for the same charge

**Pass criteria:**

- First delivery: payment credited once.
- Second delivery: deduped (no double credit).
- `webhook_events` has one row per `(source, idempotency_key)`.
- Index `idx_webhook_idempotency` present (Day 3 probe).

Reference: `packages/api/test/integration/webhooks.test.ts`.

## 4. Outbound calling guard

Confirm no production `calls.create` outbound dial path is wired. Future outbound work must route through `packages/api/src/voice/outbound-consent.ts` (`checkOutboundConsent`).

## 5. QA matrix nightly

After landing the 11 qa-matrix secrets, confirm the next `qa-matrix-gate.yml` run is green:

```bash
# Manual trigger
gh workflow run qa-matrix-gate.yml
```

## Failure escalation

If **any** cross-tenant read succeeds in ISO-01 or manual probes: **stop launch**. All other failures are fixable post-hoc.
