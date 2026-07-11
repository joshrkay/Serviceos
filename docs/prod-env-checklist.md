# Production Environment Checklist

**Purpose:** Single source of truth for required Railway prod secrets.  
**Do not commit secret values** — mark each row confirmed in your operator runbook.

## Boot-fail (process exits or refuses mock providers)

| Variable | Required when | Verified by |
|----------|---------------|-------------|
| `DATABASE_URL` | Always prod/staging | Pool created; durable `webhookRepo` wired (`packages/api/src/app.ts`) |
| `CLERK_SECRET_KEY` | Always prod/staging | `validateProductionConfig` |
| `CLERK_PUBLISHABLE_KEY` | Always prod/staging | `validateProductionConfig` |
| `CLERK_WEBHOOK_SECRET` | Always prod/staging | `validateProductionConfig` |
| `AI_PROVIDER_API_KEY` | Always prod/staging | `validateProductionConfig` |
| `CORS_ORIGIN` | Always prod/staging | Explicit origin, not wildcard |
| `STRIPE_SECRET_KEY` or `STRIPE_API_KEY` | Always prod/staging | `createPaymentLinkProvider` forbids mock |
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
| `STRIPE_WEBHOOK_SECRET` | Stripe webhooks return 500 |
| `METRICS_TOKEN` | `/metrics` returns 503 in prod/staging |
| `TRANSCRIPT_ENCRYPTION_KEY` | Falls back to `TENANT_ENCRYPTION_KEY`; if neither set, raw transcripts not retained |
| `TENANT_ENCRYPTION_KEY` | Fallback for transcript encryption |

## Web service (build / runtime)

| Variable | Notes |
|----------|-------|
| `VITE_API_URL` | API base URL for browser |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk frontend |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Customer invoice payment page (`InvoicePaymentPage`) |
| `VITE_ONBOARDING_V2_ENABLED` | Onboarding shell; set `true` in prod |

## API URLs and billing

| Variable | Notes |
|----------|-------|
| `WEB_URL` | Stripe success/cancel URLs, upgrade emails |
| `STRIPE_PRICE_ID` | Onboarding trial subscription price |

## Advisory (recommended for launch)

| Variable | Notes |
|----------|-------|
| `SENTRY_DSN` | Error tracking; no-op without it |
| `DEEPGRAM_API_KEY` | Streaming STT for inbound voice |
| `TTS_PROVIDER` / `ELEVENLABS_API_KEY` | TTS when not using OpenAI default |

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
3. Trigger deliberate test error → event appears in Sentry (`SENTRY_DSN`).
4. `npm run qa:doctor` with matrix secrets → all probes `[OK]`.
5. Stripe test webhook → 200 (not 500 missing secret).

## Durable webhook wiring

With `DATABASE_URL` set, `app.ts` wires `PgWebhookRepository`. Without it, `createWebhookRouter` throws in production. Confirm boot logs show no webhook router error.
