# Production Environment Checklist

**Purpose:** Single source of truth for required Railway prod secrets.  
**Do not commit secret values** — mark each row confirmed in your operator runbook.

## Boot-fail (process exits or refuses mock providers)

| Variable | Required when | Verified by |
|----------|---------------|-------------|
| `DATABASE_URL` | Always prod/staging | Pool created; durable `webhookRepo` wired (`packages/api/src/app.ts`) |
| `CLERK_SECRET_KEY` | Always prod/staging | `validateProductionConfig`; live keys (`sk_live_`) required when `NODE_ENV=production` unless `ALLOW_CLERK_TEST_KEYS=true` |
| `CLERK_PUBLISHABLE_KEY` | Always prod/staging | `validateProductionConfig`; must match web `VITE_CLERK_PUBLISHABLE_KEY` instance; `pk_live_` in prod |
| `CLERK_WEBHOOK_SECRET` | Always prod/staging | `validateProductionConfig`; writes `public_metadata.tenant_id` + `role` for JWT template |
| `AI_PROVIDER_API_KEY` | Always prod/staging | `validateProductionConfig`. Empty ⇒ hermetic mock / `providers: []`. Profiles: `docs/runbooks/live-ai-restore.md` |
| `AI_PROVIDER_BASE_URL` | Recommended always | Must match model ids. Profile B: `https://openrouter.ai/api/v1`. Profile A: `https://api.openai.com/v1` |
| `AI_LIGHTWEIGHT_MODEL` / `AI_STANDARD_MODEL` / `AI_COMPLEX_MODEL` | Recommended always | Profile B: `meta-llama/llama-3.1-8b-instruct` / `meta-llama/llama-3.3-70b-instruct` / `qwen/qwen2.5-vl-72b-instruct`. Profile A (OpenAI): `gpt-4o-mini` / `gpt-4o-mini` / `gpt-4o` — never Claude/Llama on OpenAI |
| `AI_DEFAULT_MODEL` | Optional | OpenAI Profile A fallback (`gpt-4o-mini`). Ignored when all three tier vars are set. After PR #714 applies to all tenants via system override |
| `AI_CLASSIFY_INTENT_DEADLINE_MS` | Recommended prod | **12000** on production. Never leave as empty string (silent 4s default). `npm run check:ai-provider-config` fails on blank. |
| `AI_FALLBACK_PROVIDER_API_KEY` + `AI_FALLBACK_PROVIDER_BASE_URL` | Recommended for voice 50/50 | Dual-provider failover (FM-03). Both required or neither. Keep Profile A primary; OpenRouter as fallback. `./scripts/apply-railway-ai-fallback.sh` |
| `AI_FALLBACK_LIGHTWEIGHT_MODEL` (optional standard/complex) | With fallback | Defaults: Llama 8B / 70B / Qwen VL — rewritten onto failover requests |
| `CORS_ORIGIN` | Always prod/staging | Explicit origin, not wildcard |
| `STRIPE_SECRET_KEY` or `STRIPE_API_KEY` | Always prod/staging | `createPaymentLinkProvider` forbids mock (`payments/payment-link-provider.ts`; pinned by `test/payments/payment-link-provider.test.ts`) |
| `STRIPE_WEBHOOK_SECRET` | Always prod/staging (SEC-43) | `validateProductionConfig` (`shared/config.ts`); pinned by `test/shared/config.test.ts` "SEC-43". Without it the Stripe webhook handler 400s/503s on the first real event — **the customer is charged but the invoice never settles**. Fail-fast at boot instead. **Accepts a comma-separated list** (one secret per Stripe endpoint — platform + connected accounts). Go-live gate: `docs/runbooks/stripe-go-live.md` |
| `RLS_RUNTIME_ROLE=true` | Always prod/staging (SEC-01; no opt-out) | `validateFeatureRequiredConfig`; boot probe `verifyRlsRuntimeRole` also fails fast if `rls_app_runtime` (migration 217) is unprovisioned. See `docs/runbooks/rls-runtime-role-rollout.md` |
| `TWILIO_ACCOUNT_SID` | Unless `TELEPHONY_ENABLED=false` and `EMAIL_ENABLED=false` | `validateFeatureRequiredConfig` |
| `TWILIO_AUTH_TOKEN` | Same | Feature gate |
| `TWILIO_FROM_NUMBER` | Same | Feature gate |
| `TWILIO_DEFAULT_TENANT_ID` | Unless `TELEPHONY_ENABLED=false` | Inbound call tenant resolution |
| `SENDGRID_API_KEY` | Unless `EMAIL_ENABLED=false` | Invoice/estimate email |
| `SENDGRID_FROM_EMAIL` | Unless `EMAIL_ENABLED=false` | Invoice/estimate email |
| `R2_ACCOUNT_ID` | Unless `STORAGE_ENABLED=false` | Recordings + uploads |
| `R2_ACCESS_KEY_ID` | Unless `STORAGE_ENABLED=false` | Recordings + uploads |
| `R2_SECRET_ACCESS_KEY` | Unless `STORAGE_ENABLED=false` | Recordings + uploads |

## Runtime-fail (boot OK; feature broken or insecure)

| Variable | Behavior if missing |
|----------|---------------------|
| JWT template `serviceos` (Clerk dashboard) | Web `getToken({ template: 'serviceos' })` returns null → auth abort / login loop. See `docs/runbooks/clerk-setup.md` |
| Stripe webhook **destinations** (Dashboard) | Not an env var — a Dashboard step, and the #1 silent money-loop failure. Connect direct charges live on the connected account, so you need **two** event destinations (platform + connected accounts), configured separately in Test and Live, both hitting `POST /webhooks/stripe`. Missing the connected-accounts destination ⇒ customer pays, money lands in the tenant's Stripe balance, but the Rivet invoice never flips to `paid`. See `docs/ops/stripe-connect-webhooks.md` and the go-live gate `docs/runbooks/stripe-go-live.md` |
| Per-tenant Stripe **Connect onboarding** | Not an env var — per-tenant state. A tenant whose Connect account is not `charges_enabled` has its customers' charges fall back to the **platform** account with no automatic payout to the tenant. Verified via `GET /api/billing/connect`. See `docs/runbooks/stripe-go-live.md` |
| `METRICS_TOKEN` | `/metrics` and `GET /api/health/ai/completion` return 503 in prod/staging without Bearer token |
| `TRANSCRIPT_ENCRYPTION_KEY` | Falls back to `TENANT_ENCRYPTION_KEY`; if neither set, raw transcripts not retained |
| `TENANT_ENCRYPTION_KEY` | Fallback for transcript encryption |

## SLO monitoring / operator alerting (WS15 — all optional, safe defaults)

The SLO monitor (`packages/api/src/workers/slo-monitor.ts`, worker/all roles)
evaluates call completion rate, queue staleness, and sweep lag every 5 min and
pages on breach. **What makes a breach reach a human:** `SENTRY_DSN` (+ the
Sentry→Slack/DM rules in `docs/runbooks/alerting.md`) and, optionally,
`ALERT_SMS_TO`. Without both, breaches only appear in logs/metrics. Runbook:
`docs/runbooks/slo-alerts.md`.

| Variable | Default | Notes |
|----------|---------|-------|
| `ALERT_SMS_TO` | unset (SMS channel off) | Operator phone (E.164); sent owner-class, never consent-suppressed |
| `SLO_CALL_COMPLETION_MIN` | `0.85` | Min completion rate, trailing 60 min |
| `SLO_CALL_COMPLETION_MIN_SAMPLE` | `5` | Sample floor before completion rule can breach |
| `SLO_QUEUE_STALE_MIN` | `15` | Pending job age (min) that counts as a stuck queue |
| `SLO_SWEEP_LAG_MIN` | `15` | Sweep-heartbeat age (min) treated as a wedged worker loop |
| `SLO_ALERT_COOLDOWN_MIN` | `60` | Per-rule re-page cooldown |

## Web service (build / runtime)

| Variable | Notes |
|----------|-------|
| `VITE_API_URL` | API base URL for browser |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk frontend — same instance as API `CLERK_PUBLISHABLE_KEY`. Requires JWT template `serviceos` (see `docs/runbooks/clerk-setup.md`) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Customer invoice payment page (`InvoicePaymentPage`) |
| `VITE_ONBOARDING_V2_ENABLED` | Onboarding shell; set `true` in prod |

## API URLs and billing

| Variable | Notes |
|----------|-------|
| `WEB_URL` | Stripe success/cancel URLs, upgrade emails |
| `STRIPE_PRICE_ID` | Onboarding trial subscription price |

## Deploy topology (web + worker split)

See `docs/deployment.md` "Deploy topology (web + worker)" for the full
setup steps (config-file-path linking, ordering). All rows are dashboard
service variables — not set in the `.toml` files.

| Variable | Service | Notes |
|----------|---------|-------|
| `PROCESS_ROLE=web` | API/voice service (`railway.toml`) | HTTP + voice/WS only, zero background worker loops |
| `PROCESS_ROLE=worker` | Worker service (`railway.worker.toml`) | Background sweeps + queue drain only; no public traffic, no voice WS upgrades |
| `PROCESS_ROLE=voice` | Optional dedicated voice service (`railway.voice.toml`, WS14) | HTTP + voice/WS only, zero background worker loops — same surface as `web`, deployed separately so web/worker deploys never drain live calls |

Migrations run on the **web service only** (its `preDeployCommand`); the
worker's and voice's configs have none. The web service must deploy first
whenever a release contains a migration. A single-service deploy leaves
`PROCESS_ROLE` unset on the one service (⇒ `all`), which needs no
checklist row.

**`PUBLIC_API_URL` is per-service, not global.** Each of `web`, `worker`,
and `voice` (when it exists) should set its own `PUBLIC_API_URL` to its own
public domain — this is what Twilio signature validation reconstructs the
request URL against, and what any `<Connect><Stream/>` TwiML embeds as the
WS target. On the voice service specifically, `PUBLIC_API_URL` MUST be the
voice service's own domain, not the web domain, or inbound Twilio signature
checks fail and Stream URLs point at the wrong socket.

**`VOICE_PUBLIC_URL` (three-service topology only)** — set on the **web
and worker** services (where provisioning jobs run) to the voice service's
public base URL. The number-provisioning worker
(`packages/api/src/workers/provision-twilio.ts`) uses it for each new
number's Twilio `VoiceUrl` + voice-call status callback, so numbers
provisioned/claimed through onboarding automatically point at the voice
domain (SMS + Vapi webhooks stay on the web domain). Unset ⇒ falls back to
the web base — today's behavior — so it needs no row in a single- or
two-service deploy. Numbers provisioned **before** the cutover still need
a one-time manual re-point at the voice domain in the Twilio console. See
`docs/deployment.md` "Optional third service: dedicated voice (WS14)".

## Advisory (recommended for launch)

| Variable | Notes |
|----------|-------|
| `SENTRY_DSN` | Error tracking; no-op without it |
| `DEEPGRAM_API_KEY` | Streaming STT for inbound voice **and** browser dictation (`POST /api/voice/stream-token` → Deepgram `/v1/auth/grant`). Must be a key with **Member** (or higher) permissions — a usage-only key returns `403 Insufficient permissions` on grant and breaks AI conversation dictation. Create via Deepgram Console → API Keys → Create Key → Advanced → Member. |
| `TTS_PROVIDER` / `ELEVENLABS_API_KEY` | TTS when not using OpenAI default |
| `TWILIO_MEDIA_STREAMS_ENABLED` | Realtime voice master switch (WS7). `false`=Gather-only kill switch; `true`=forced on (requires `TTS_PROVIDER=elevenlabs`+`ELEVENLABS_API_KEY`); **unset/`auto`**=on iff `TTS_PROVIDER=elevenlabs`+`ELEVENLABS_API_KEY`+`DEEPGRAM_API_KEY` all set. See `docs/runbooks/voice-realtime-rollout.md`. |
| `PUBLIC_API_URL` | Absolute API base Twilio POSTs to. Required for the mid-call REST degrade-to-Gather (WS7); absent → realtime failures hang up (1011) instead of falling back mid-call. |
| `AUTONOMOUS_BOOKING_DISABLED` | D-015 amendment — platform-wide kill switch for the autonomous booking lane; unset/`false` preserves per-tenant opt-in gating, `true` disables the lane for every tenant (incident response) regardless of `tenant_settings.autonomous_booking_enabled` |
| `AUTONOMOUS_CLOSE_DISABLED` | D-018 → **deprecated by D-019** (QUALITY-2026-07-12 WS2). There is no autonomous CLOSE execution anymore — the on-call close only STAGES proposals for owner one-tap approval (nothing is system-approved/executed). Still accepted as a platform-wide off switch for even PREPARING the owner-approval chain; independent sibling of `AUTONOMOUS_BOOKING_DISABLED`; unset/`false` is the default |

## QA matrix nightly (GitHub secrets — not Railway)

Required for `qa-matrix-gate.yml` (see `scripts/qa-matrix-doctor.ts`):

- `E2E_BASE_URL`
- `E2E_API_URL`
- `E2E_DB_URL_READONLY`
- `E2E_DB_URL_READWRITE`
- `E2E_CLERK_HMAC_SECRET` (must match deployed `CLERK_SECRET_KEY`)
- `E2E_TENANT_A_ID`, `E2E_TENANT_A_CUSTOMER_ID`, `E2E_TENANT_A_JOB_ID`
- `E2E_TENANT_B_ID`, `E2E_TENANT_B_CUSTOMER_ID`, `E2E_TENANT_B_JOB_ID`

## E2E PR workflow (GitHub secrets — optional)

For full Playwright journeys (see `docs/launch/ci-gating.md`):

- `E2E_CLERK_PUBLISHABLE_KEY`
- `E2E_CLERK_SECRET_KEY`
- `E2E_DATABASE_URL` (optional BYO Postgres)

## Verification steps (operator)

1. Deploy prod with all boot-fail vars set → service starts without crash.
2. `GET /health` → 200; `GET /ready` → 200 when DB reachable.
3. AI config: `cd packages/api && npm run check:ai-provider-config` against exported Railway vars; live `GET /api/health/ai/completion` → `completionProbe.ok: true` (see `docs/runbooks/live-ai-restore.md`).
4. Trigger deliberate test error → event appears in Sentry (`SENTRY_DSN`).
5. `npm run qa:doctor` with matrix secrets → all probes `[OK]`.
6. Stripe test webhook → 200 (not 500 missing secret).
7. **Money-loop go-live:** run the full gate in `docs/runbooks/stripe-go-live.md` before onboarding the first paying tenant — env vars, both webhook destinations (Test + Live), per-tenant Connect onboarding, and an end-to-end paid-invoice smoke.

## Durable webhook wiring

With `DATABASE_URL` set, `app.ts` wires `PgWebhookRepository`. Without it, `createWebhookRouter` throws in production. Confirm boot logs show no webhook router error.
