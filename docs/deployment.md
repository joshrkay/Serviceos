# Deployment Runbook (Railway)

## Deployment topology

Railway is the **only** deployment target. The deployed services are
`packages/api` (Dockerfile target `api`) and `packages/web` (nginx stage),
configured by `/railway.toml` and `/Dockerfile` and shipped by
`.github/workflows/deploy.yml` (`railway up`).

A prior AWS CDK deployment path (D-001) and two non-deployed prototypes
(a Next.js app, a Python LangGraph agent) were quarantined under
`experiments/` and removed entirely in 2026-07 — see `docs/decisions.md`
D-016. They are recoverable from git history but are not part of the
working tree; Railway (above) has been the only deployment target.

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

## Deploy topology (web + worker)

Production runs **two Railway services from the same image and the same
`startCommand`** (`node packages/api/dist/src/index.js`), differing only by
which config file and env var each is linked to. This is the defined
production topology — it decouples the request surface from background
work, so a spike in sweeps or the queue drain can never affect HTTP/voice
latency, and each half can scale and restart independently.

A single-service deploy (`PROCESS_ROLE` unset on the one service ⇒ `all`,
serving HTTP/voice/WS **and** running every background worker loop
in-process) remains fully supported and is the default for local/dev —
nothing to configure there, and it is byte-for-byte identical to the
pre-split behavior.

| Service | Config file | `PROCESS_ROLE` | Networking | Runs |
|---|---|---|---|---|
| API / voice (web) | `railway.toml` | `web` | Public (Railway public domain) | HTTP + voice/WS/media-streams only; **zero** background worker loops |
| Worker | `railway.worker.toml` | `worker` | Private (no public domain needed) | All background sweeps + the queue poll loop; no public traffic; no voice WS upgrades |
| Voice (optional, WS14) | `railway.voice.toml` | `voice` | Public (its own Railway domain) | HTTP + voice/WS/media-streams only; **zero** background worker loops; same surface as `web` |

### Setup

1. Create the second Railway service pointing at the same repo/image.
2. On the worker service, set **Settings → Config File Path** to
   `railway.worker.toml` (Railway's per-service config-as-code path
   setting). Leave the web service on the default `railway.toml`.
3. Set the `PROCESS_ROLE` **dashboard service variable** on each service
   explicitly: `web` on the API/voice service, `worker` on the worker
   service. Railway config-as-code (the `.toml` files) does not support
   setting service env vars, so this step can't be folded into the config
   files — it must be set per-service in the dashboard (or via `railway
   variables set`). Leaving it unset defaults to `all`, which is correct
   for a single-service deploy but redundant (and defeats the isolation
   goal) once the worker service exists — set it explicitly once you've
   split.
4. Deploy the **web service first** whenever a release contains a
   migration. Migrations run exactly once, via `preDeployCommand` on the
   web service only (`railway.worker.toml` intentionally has no
   `preDeployCommand`) — see "Migration execution policy" above. Workers
   tolerate reading against the old schema for the short window before
   their own deploy lands; additive migrations plus the leader-locked
   sweeps / `SKIP LOCKED` queue consumers are written to be
   forward-compatible with that window.

Notes:

- Both roles still call `app.listen` on `$PORT` (the worker's `/health`
  backs Railway's deploy gate); Railway networking decides exposure. The
  worker does **not** need a public domain.
- `PROCESS_ROLE=worker` additionally gates the voice Media Streams WS
  upgrade attach (`app.ts`, guarded alongside `TWILIO_MEDIA_STREAMS_ENABLED`)
  — a worker never constructs the Deepgram/TTS providers or wraps
  `app.listen` for the WS upgrade handler, since Twilio has no path to
  reach a private-networked worker anyway. `/health` stays role-agnostic.
- Cheap observability intervals (pool-occupancy and queue-depth metric
  samplers) run in **every** role, so the `web` service still exports its
  own `/metrics`.
- **Safe to get wrong:** if both services are accidentally left as `all`,
  the tenant-wide sweeps are still gated by `runAsLeader` (Postgres
  advisory lock), so exactly one instance runs each tick — you get
  redundancy, not duplicate invoices/reminders. The split is an isolation
  optimization; leader locks keep it correctness-safe even if
  misconfigured.

### Optional third service: dedicated voice (WS14)

Today, even in the two-service topology above, live calls ride the `web`
service — Twilio's phone-number webhooks point at the web domain, so every
web deploy risks calls active past the `overlapSeconds`/`DRAIN_TIMEOUT_MS`
drain window. `PROCESS_ROLE=voice` adds a **third, opt-in** service that
hosts telephony webhooks + the media-streams WS and deploys rarely, so web
(and worker) deploys never touch live calls. It is recommended for
production voice once call volume makes web-deploy-interrupts-calls a real
risk; the two-service topology remains fully supported if you don't need
this yet.

`voice` behaves exactly like `web` (full HTTP surface, media-streams WS
attached, zero background worker loops) — the only difference is which
Railway service it's deployed as and which domain Twilio is told to call.

1. Create a third Railway service pointing at the same repo/image.
2. Set **Settings → Config File Path** to `railway.voice.toml`.
3. Set the `PROCESS_ROLE` **dashboard service variable** to `voice` on this
   service (same caveat as step 3 above — config-as-code can't set this).
4. Set this service's own `PUBLIC_API_URL` to **its own** public domain,
   not the web service's. This matters for two things: Twilio signature
   validation reconstructs the request URL from `PUBLIC_API_URL`
   (`packages/api/src/telephony/twilio-signature.ts`) so a mismatched
   domain fails every inbound signature check; and any
   `<Connect><Stream/>` TwiML the app emits embeds `PUBLIC_API_URL` as the
   WS target, so it must point back at this same service.
5. Point Twilio's phone-number webhooks (Voice URL, status callback,
   recording callback) at **this service's** public domain instead of the
   web service's. This is the entire mechanism — there is no code-level
   routing involved; whichever domain Twilio is configured to call is
   whichever service's drain window a live call is exposed to.
6. Set `VOICE_PUBLIC_URL` (this voice service's public base URL) as a
   dashboard variable on the **web and worker** services — the services
   where provisioning jobs execute. The automated number-provisioning flow
   (`packages/api/src/workers/provision-twilio.ts`, driven from onboarding)
   runs as a background queue job on `web`/`worker`/`all` (never `voice`,
   which runs zero background workers), and uses `VOICE_PUBLIC_URL` for
   the newly-provisioned number's `VoiceUrl` (`/api/telephony/voice`) and
   voice-call status callback (`/webhooks/twilio/status/:tenantId`), so
   every number provisioned or claimed through onboarding automatically
   points at the voice domain. SMS inbound
   (`/webhooks/twilio/sms/:tenantId`, via the messaging service) and the
   Vapi event webhook (`/webhooks/vapi/:tenantId`) intentionally stay on
   the web domain — neither is a live-call surface on our infrastructure.
   Unset `VOICE_PUBLIC_URL` falls back to the web base, i.e. exactly
   today's single/two-service behavior.
   **One residual operator step:** numbers provisioned **before** the
   voice-service cutover still carry the web domain in their Twilio
   webhook config — re-point those at the voice domain once, in the
   Twilio console or via the number record (inherently operational; the
   code path only covers numbers provisioned after `VOICE_PUBLIC_URL` is
   set).

Payoff: with Twilio pointed at the voice domain, `web` and `worker` deploys
never interrupt a live call — only a `voice`-service deploy can, and that
service is meant to change rarely (telephony wiring, not everyday feature
work), so it drains the same 25s/35s window as `web` today but on a much
lower-frequency deploy cadence.

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

## Production readiness (scale-to-1000)

The scale-to-1000 work — PgBouncer two-DSN routing, Redis-backed shared state
(WS caps, voice fan-out, LLM quotas, rate limiting), queue batch concurrency,
and graceful SIGTERM drain — is merged. This section covers the in-repo
artifacts that make the pooled topology reproducible and the operator-only
steps that must be applied in the Railway account. For the rationale and
rollout sequence see [`docs/runbooks/scaling.md`](runbooks/scaling.md)
(§ Provisioning & rollout); for the actual 1000-concurrent validation run see
[`docs/runbooks/phase5-validation-handoff.md`](runbooks/phase5-validation-handoff.md).

> The **Horizontal scaling note** above predates this work. Its blockers are
> now addressed: the in-process sweeps are gated by `runAsLeader` (a Postgres
> advisory lock, so exactly one instance runs each tick) and SIGTERM triggers a
> graceful drain (`/ready` → 503, new WS upgrades rejected, active voice calls
> drained). Scaling past one instance is safe once Redis + PgBouncer are
> provisioned (below) — provision Redis **before** raising `numReplicas`.

### In-repo deploy artifacts

| Artifact | Purpose |
|---|---|
| `deploy/pgbouncer/pgbouncer.ini` | Transaction-mode pooler config: `pool_mode=transaction`, `max_client_conn=1000`, `default_pool_size=25`, `ignore_startup_parameters=extra_float_digits`, SCRAM auth (`auth_file`, with a documented least-privilege `auth_query` alternative). |
| `deploy/pgbouncer/userlist.txt` | Secret-free SCRAM userlist **template** + generation instructions. |
| `deploy/docker-compose.prod.yml` | The full pooled topology — postgres + pgbouncer + redis + one-shot migrate + scalable api + nginx LB — in one `docker compose up`. For a non-Railway target and local 1000-concurrent validation. |
| `deploy/nginx/api-lb.conf` | nginx LB that round-robins the scaled `api` replicas via Docker DNS, carries WebSocket upgrades, and never caches `/api/*`. |

Local pooled validation (mirrors `scaling.md` § Measuring):

```bash
cp .env.production.example deploy/.env      # then fill the boot-fail secrets
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build --scale api=4
npx tsx loadtest/http-load.ts --url http://localhost:3000 --token "$TOKEN" \
  --max 400 --ramp 60 --hold 300
```

> **Not yet smoke-tested:** Docker was unavailable in the session that authored
> these artifacts, so the live `docker build` + `compose up` run (API healthy,
> `/health` 200, migrate succeeds) is an **operator step**. The configs are
> statically validated only (compose schema + YAML, pgbouncer INI parse, nginx
> brace/directive check).

### Build/deploy defect fixes in this change

- **Test files no longer leak into the prod image** — `packages/api/tsconfig.build.json` now excludes `src/**/__tests__/**`, `src/**/*.test.ts`, `src/**/*.spec.ts`. 12 non-executed placeholder tests were compiling into `dist/` and dragging a `vitest` (devDependency) reference into the production build.
- **Single-image SPA path resolves in dev *and* prod** — `app.ts` serves `web/dist` via `resolveWebDistDir(__dirname)` (anchored on the `packages/api` path boundary) instead of a fixed `../../web/dist` hop that pointed at a non-existent path in the built image. Railway still serves the SPA from the separate `web` service; this only affects single-image serving.
- **`packages/web/nginx.conf`** now documents that its hardcoded `proxy_pass http://api:3000` is **compose/single-host only**; the Railway web service builds `packages/web/nginx.conf.template`, which proxies `/api/` to the API's public URL via `${API_URL}` and listens on `${PORT}`. **Follow-up:** the two files differ on the `/api` trailing slash (`nginx.conf` strips the `/api` prefix; `.template` preserves it) — reconcile against how the API mounts routes before relying on the compose `web` edge.

### Filler call audio (C1)

Filler `.pcm` are gitignored deploy-time artifacts (rendered by `scripts/render-fillers.ts` via ElevenLabs). To **ship** them in the API image, pass the ElevenLabs key as a build arg so the `api-build` stage renders and copies them into `dist`:

```bash
# Plain build arg (key confined to the intermediate api-build stage; visible in build logs/cache):
docker build --target api --build-arg ELEVENLABS_API_KEY="$ELEVENLABS_API_KEY" -t serviceos-api .

# Hardened (key never lands in a layer or log) — switch the api-build RUN to a BuildKit secret mount,
# `RUN --mount=type=secret,id=elevenlabs_api_key ...`, then:
DOCKER_BUILDKIT=1 docker build --target api \
  --secret id=elevenlabs_api_key,env=ELEVENLABS_API_KEY -t serviceos-api .
```

Omit the key and the build **skips** rendering — unchanged behavior: `FillerAudioCache.load()` warns and callers hear no filler (graceful, not a crash). Rendering calls ElevenLabs at build time, so each build spends TTS quota — render on tagged release builds, not every CI build.

### Operator-only Railway actions

Code/config is in-repo; these are applied in the Railway account. Order matters — see `scaling.md` § Provisioning & rollout.

1. **Redis** — add the Railway Redis plugin, set `REDIS_URL` on the API service, and set `VOICE_FANOUT_ENABLED=true`. Makes WS caps, LLM quotas, voice fan-out, and rate limits cluster-wide. Set it **before** raising `numReplicas`.
2. **PgBouncer** — add a PgBouncer service (`pool_mode=transaction`, from `deploy/pgbouncer/pgbouncer.ini`) in front of the Postgres plugin. Point `DATABASE_URL` at PgBouncer (`:6432`) and `DATABASE_DIRECT_URL` at the Postgres plugin's direct URL (`:5432`) — session-scoped advisory locks + LISTEN/NOTIFY bypass PgBouncer. Size `DB_MAX_CONNECTIONS` per replica and PgBouncer `default_pool_size` against Postgres `max_connections`.
3. **Autoscale + drain** — set autoscale min/max in the Railway service settings (no `railway.toml` key): min from steady load, max from the Phase 5 per-instance ceiling. Ensure the **stop grace period ≥ 35s** so a draining replica finishes live calls (`overlapSeconds = 35` in `railway.toml`; drain waits `DRAIN_TIMEOUT_MS` 25s with a `SHUTDOWN_FORCE_EXIT_MS` 30s backstop).

### Boot env

Every variable that throws at boot in production — the TIER 0 set (`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SECRET`, `CORS_ORIGIN`, Stripe) — is covered by `.env.production.example`. The scale-to-1000 vars (`REDIS_URL`, `DATABASE_DIRECT_URL`, `VOICE_FANOUT_ENABLED`, `DB_MAX_CONNECTIONS`, …) are safe to omit (single-instance / in-memory fallback). `deploy/docker-compose.prod.yml` wires the boot-fail secrets via `${VAR:?}` so a missing value fails fast.

### Validated local multi-tenant run (Docker)

The pooled topology was stood up end-to-end and exercised with concurrent
multi-tenant logins on 2026-06-27 (Colima / Docker 29, Ubuntu 24.04 guest):

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.dev-auth.yml --env-file deploy/.env up -d --build
curl http://localhost:3000/health        # -> 200 {"status":"ok","checks":{"database":{"status":"ok"}}}
```

`deploy/docker-compose.dev-auth.yml` flips the api/migrate to
`NODE_ENV=development` + `DEV_AUTH_BYPASS=true` so the stack boots without real
Clerk/Stripe and accepts per-tenant dev tokens (the bypass decodes the JWT
`sub` and bootstraps an RLS-scoped tenant per user), and exposes Postgres on
`:5433` for host tooling.

**Verified:**

- All 6 services healthy; `migrate` exited 0 ("Migrations completed successfully") running DDL against the **direct** DSN (bypassing PgBouncer).
- `/health` 200 (database ok) through the nginx LB → api → **PgBouncer :6432 (transaction pool)** → Postgres; Redis up.
- 3 tenants logged in and created a customer **concurrently** (HTTP 201 each, distinct ids); 3 rows persisted.
- **Tenant isolation: 9/9** — each tenant reads its own customer (200), every cross-tenant read is denied (404), and each list returns only the caller's rows. RLS holds under concurrency.

This is a load-shape smoke test, not the full Phase 5 ramp/soak — for the
1000-concurrent run see `docs/runbooks/phase5-validation-handoff.md`.
