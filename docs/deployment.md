# Deployment Runbook (Railway)

## API startup contract

The API service **must not** run migrations in `startCommand`.

- `startCommand` is reserved for booting the HTTP server only:
  - `node packages/api/dist/src/index.js`
- Platform health check is on:
  - `/health` — always 200 when the process is up. Do **not** use `/ready`:
    it 503s when the DB is cold/unreachable and would roll back otherwise-
    healthy deploys. `/ready` stays available for readiness gating.

This keeps startup fast and prevents deployments from failing readiness checks while waiting for long-running migrations.

## Migration execution policy

Run database migrations as a **separate one-off/release step** before each API deploy.

Required migration command:

```bash
node packages/api/dist/src/db/migrate.js
```

In CI/CD (GitHub Actions), migrations are executed with Railway CLI before deploying the API service for each environment (`dev`, `staging`, `production`) using:

```bash
railway run --service api --environment <env> -- node packages/api/dist/src/db/migrate.js
```

## Guardrail for future changes

If deployment flow changes in the future, keep these invariants:

1. API `startCommand` starts the server only.
2. Migrations run in a separate one-off/release step.
3. `healthcheckPath` stays `/health` (liveness), not `/ready` (readiness).

Do not reintroduce migration-gated startup.


## Horizontal scaling note

Now safe to scale beyond single dyno.

## Observability sink validation (post-deploy)

After each deploy in `dev`, `staging`, and `production`, validate that redaction processors are active on every sink.

1. Trigger a synthetic error with known sensitive fields in `extra`, request body, and user context (email/phone/name).
2. Confirm Sentry event payload has masked/redacted values only (`[REDACTED]` or masked forms).
3. Confirm breadcrumbs on the same event are redacted.
4. Confirm CloudWatch log lines do not contain unredacted secret or PII values.
5. If any sink receives raw values, rollback and treat as Sev-1 data leak risk.

Validation should include at least one request path that logs through transport adapters and one path that throws to Sentry.

## Railway dev environment — required service variables

The `claude/assess-voice-config-a52Li` branch deploys to the `dev` environment.
Its `railway.toml` files bake in the dev-safe defaults (`NODE_ENV`, `PORT`,
`API_URL`) so the containers boot without dashboard config. The following still
must be set in the Railway dashboard for full functionality:

**`api` service (dev):**
- Source branch → `claude/assess-voice-config-a52Li`.
- `DATABASE_URL` — link the Railway Postgres service (Railway auto-injects it
  once linked). Until then the API runs in-memory and loses all data on restart.
- `CLERK_SECRET_KEY` — required for auth.
- `CLERK_PUBLISHABLE_KEY` — required for the RS256 login path; without it every
  authenticated request 401s (`auth/clerk.ts:383`).
- `STRIPE_WEBHOOK_SECRET` — required for `/webhooks/stripe`; without it the
  webhook returns 500 and Stripe payments are never recorded.

**`web` service (dev):**
- Source branch → `claude/assess-voice-config-a52Li`.
- Root Directory → `packages/web` (so Railway builds `packages/web/Dockerfile`
  and reads `packages/web/railway.toml`, not the root API config).
- `VITE_CLERK_PUBLISHABLE_KEY` — required; the SPA throws on boot without it.

**Phase 2 (live verification) only — do NOT set for normal use:**
- `CLERK_DEV_HMAC_TOKENS=true` on the `api` service enables the qa-matrix's HMAC
  test tokens. It is mutually exclusive with the RS256 login path, so flip it on
  only while running the matrix, then off again.
