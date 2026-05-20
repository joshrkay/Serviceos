# Deployment Runbook (Railway)

## API startup contract

The API service **must not** run migrations in `startCommand`.

- `startCommand` is reserved for booting the HTTP server only:
  - `node packages/api/dist/src/index.js`
- Health checks remain on:
  - `/ready`

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
3. `healthcheckPath` remains `/ready`.

Do not reintroduce migration-gated startup.


## Horizontal scaling note

Now safe to scale beyond single dyno.

## Dispatch feasibility env vars

The dispatch board's feasibility composer (overlap + travel-time + skill checks) reads the following optional env vars. All are safe to omit — the API degrades to a haversine-only travel estimator and stub skill matcher.

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | unset | Enables the Google Distance Matrix provider for traffic-aware drive-time estimates. When unset, the API falls back to a haversine great-circle estimator (~30 mph). |
| `TRAVEL_TIME_CACHE_TTL_SECONDS` | `300` | TTL for Google Distance Matrix responses cached in-process. |
| `TRAVEL_TIME_CACHE_MAX_ENTRIES` | `1000` | Hard cap on the in-process LRU cache; prevents unbounded memory growth on multi-tenant deploys. |

## Observability sink validation (post-deploy)

After each deploy in `dev`, `staging`, and `production`, validate that redaction processors are active on every sink.

1. Trigger a synthetic error with known sensitive fields in `extra`, request body, and user context (email/phone/name).
2. Confirm Sentry event payload has masked/redacted values only (`[REDACTED]` or masked forms).
3. Confirm breadcrumbs on the same event are redacted.
4. Confirm CloudWatch log lines do not contain unredacted secret or PII values.
5. If any sink receives raw values, rollback and treat as Sev-1 data leak risk.

Validation should include at least one request path that logs through transport adapters and one path that throws to Sentry.

## Solo owner launch (voice)

| Variable | Purpose |
|----------|---------|
| `TWILIO_MEDIA_STREAMS_ENABLED=true` | Media Streams |
| `TTS_PROVIDER=elevenlabs` | Streaming TTS after soak |
| `ELEVENLABS_API_KEY` | TTS |
| `DEEPGRAM_API_KEY` | STT + keyword boost |
| `DATABASE_URL` | Required in prod |
