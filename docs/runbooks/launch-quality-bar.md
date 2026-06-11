# Launch Quality Bar

The gate that must be green before §10 self-serve onboarding opens to real
customers. The bar has two tiers; we are currently on **tier 1** (10–50
self-serve customers).

## Tier 1 — current (10–50 customers)

Verified via `npm run launch-quality-check` from `packages/api/` (Task 22).
Twelve check items:

| Item | What | Implementation |
|------|------|----------------|
| H1.1 | Executor idempotency guard required (compile-check) | `IdempotencyGuard` is a required constructor arg on `ProposalExecutor`. |
| H1.2 | `proposal_executions` partial unique index | Migration 099 — `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. |
| H2.A | Synthetic voice smoke (every deploy) | `test/voice/voice-smoke.synthetic.test.ts` runs in `.github/workflows/deploy.yml`. |
| H2.B | Real-call voice smoke (daily cron) | `.github/workflows/voice-smoke-real.yml` at 09:00 UTC. |
| H3   | Sentry rules + Slack integration | 4 rules configured per `alerting.md`; four critical paths wrapped via `instrument()`. |
| H4.1 | Rollback runbook exists | `docs/runbooks/rollback.md`. |
| H4.2 | Migration-discipline runbook exists | `docs/runbooks/migration-discipline.md`. |
| H4.3 | Migration-discipline guard test in CI | `packages/api/test/db/migration-discipline.test.ts`. |
| H5   | Voice load test run within 30 days | `docs/runbooks/voice-capacity.md` records last-run date. |
| D1   | `decisions.test.ts` green | Existing — no §11 change. |
| D2   | Critical-path smoke tests green | Existing `smoke-test.ts` + new synthetic voice smoke. |
| D3   | Migration immutability green | Existing — no §11 change. |

## Tier 2 — deferred (promote at 100+ customers)

Each tier-2 item has a trigger condition. Re-spec when the trigger fires.
None of these are "do later" — they are "do when the trigger fires" — so
we carry no implementation debt for them in the meantime.

| Item | Trigger to promote |
|------|--------------------|
| PagerDuty rotation + sleep coverage | First customer in a non-US timezone signs up. |
| Datadog/Grafana metrics dashboards | 50+ customers, OR investigation needs metrics correlation Sentry can't provide. |
| Canary deploys | Two production incidents traceable to deploys in the same quarter. |
| Auto-rollback on smoke failure | Synthetic voice smoke proven non-flaky for 30 days. |
| Twilio phone number version-pinning | Webhook URL needs to change in a non-backward-compatible way. |
| Voice load test in CI | Customer traffic approaches the documented per-instance ceiling. |

## How to verify the bar before opening self-serve

```bash
cd packages/api && npm run launch-quality-check
```

All 12 items must report `PASS`. Items requiring human verification (alerting,
runbook reads, capacity run) trust the timestamps in `.launch-quality-acks.json`
— the script does not re-verify the human steps.
