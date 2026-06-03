# Deployment Runbook (Railway)

## Deployment topology

Railway is the **only** deployment target. The deployed services are
`packages/api` (Dockerfile target `api`) and `packages/web` (nginx stage),
configured by `/railway.toml` and `/Dockerfile` and shipped by
`.github/workflows/deploy.yml` (`railway up`).

Other top-level directories are **not deployed** and must not be mistaken
for production infrastructure — see their READMEs:
`infra/` (AWS CDK, deployed by nothing), `service-os-app/` and
`service-os-agent/` (prototypes), and `supabase_migration.sql` (the
prototype's schema, unrelated to the canonical in-code migrations).

## API startup contract

The API service **must not** run migrations in `startCommand`.

- `startCommand` is reserved for booting the HTTP server only:
  - `node packages/api/dist/src/index.js`
- The Railway **health check targets `/health`** (see `railway.toml`), not
  `/ready`. `/health` returns 200 whenever the server is up; `/ready`
  intentionally 503s on a cold/unreachable DB and would roll back
  otherwise-healthy deploys. (`/ready` remains the right probe for a
  traffic-gating load balancer, just not for Railway's deploy health gate.)

This keeps startup fast and prevents deployments from failing the health check while waiting for long-running migrations.

## Migration execution policy

Run database migrations as a **separate one-off/release step** before each API deploy.

Required migration command:

```bash
node packages/api/dist/src/db/migrate.js
```

In practice this runs as Railway's `preDeployCommand` (see `railway.toml`),
which executes before the new release takes traffic and separately from
`startCommand`:

```toml
preDeployCommand = "node packages/api/dist/src/db/migrate.js"
```

To run the same migration step manually against an environment via the
Railway CLI:

```bash
railway run --service api --environment <env> -- node packages/api/dist/src/db/migrate.js
```

## Guardrail for future changes

If deployment flow changes in the future, keep these invariants:

1. API `startCommand` starts the server only.
2. Migrations run in a separate one-off/release step (`preDeployCommand`).
3. `healthcheckPath` remains `/health` (deploy gate), per the rationale above.

Do not reintroduce migration-gated startup.


## Horizontal scaling note

**Launch on a single instance.** Scaling the API beyond one instance is
**not yet safe**: tenant-wide scheduled sweeps (recurring agreements,
overdue-invoice, appointment/estimate reminders, Google-reviews) run as
in-process `setInterval`s in `app.ts`, so every additional instance would
re-run every sweep — duplicate invoices, reminders, and review replies.
Graceful shutdown is also incomplete (intervals/in-flight jobs are not
drained on SIGTERM). Before scaling out, gate the sweeps behind a leader
lock (Postgres advisory lock) or move them to a single worker process, and
implement graceful drain. (Tracked as go-live Blocker 5.)

The proposal-execution worker itself is multi-instance-safe
(`ProposalRepository.claimForExecution` atomically claims work), so the
constraint above is specifically about the in-process schedulers.

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
