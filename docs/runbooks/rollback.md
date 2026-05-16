# Rollback Runbook

**Target recovery time:** under 5 minutes from alert to verified-green.

## When to roll back

Roll back immediately if any of these are true after a deploy:

- Post-deploy smoke test failed (`packages/api/scripts/smoke-test.ts` exits non-zero).
- Sentry P1 alert from any of the four wrapped paths (see `alerting.md`):
  payment webhook failure, proposal execution failure rate spike, voice agent error.
- Customer reports the voice agent is not answering OR producing visibly broken
  behavior (wrong language, repeated greetings, hangs).
- A migration that shipped in this deploy is producing query errors in logs.

**Do NOT roll back** for: a single transient Sentry event, a slow but functional
response, queue depth growing but recovering, or any P2 alert in isolation.

## Procedure

### 1. Identify the previous release

```bash
railway release list --service api | head -5
```

The latest entry is the current; the one above it is the rollback target.

### 2. Roll back

```bash
railway rollback --service api --to <previous-release-id>
```

Takes ~30 seconds. The webhook URL is stable across deploys, so Twilio numbers
automatically resume routing to the now-active previous handler. No phone-number
reconfiguration is needed.

### 3. Verify

```bash
cd packages/api && npx tsx scripts/smoke-test.ts https://api.serviceos.com
```

Expected: all probes PASS, exit code 0.

### 4. Post in `#alerts`

Reply in the thread of the alert that triggered the rollback:

> Rolled back `api` to `<release-id>`. Smoke green. Investigating root cause.

### 5. Open a post-incident ticket

Capture: what shipped, what broke, how it was detected, how it was reverted,
what changes so it doesn't happen again. Link the original alert + the smoke
test failure (if applicable).

## Bad migration

`railway rollback` reverts application code only. Migrations are forward-only
in this codebase and are NOT rolled back automatically.

1. Roll back the application first (steps 1–3 above).
2. Inspect what the old code does against the new schema. If the additive
   migration (per `migration-discipline.md`) is backward compatible — which is
   the common case — you're done.
3. If the migration corrupted data: write a NEW forward migration that restores
   the prior state. Never mutate a shipped migration — the
   `migration-immutability.test.ts` guard will block the PR, and on-prod
   instances may have already applied the corrupted version.
4. Ship the new forward migration as a normal deploy.

## When auto-rollback would help

Auto-rollback on smoke failure is **deferred to tier 2** (see
`launch-quality-bar.md`). Trigger condition: the synthetic voice smoke proven
non-flaky for 30 days.
