# Onboarding v2 launch runbook

Spec: [`docs/superpowers/specs/2026-05-15-onboarding-self-serve-setup-design.md`](../specs/2026-05-15-onboarding-self-serve-setup-design.md)

## Pre-flight (production)

1. **Migrations** — `preDeployCommand` applies all loose SQL under `packages/api/src/db/migrations/`, including:
   - `098_tenant_settings_onboarding_fields.sql` (identity + test-call skip columns)
   - Earlier onboarding-related migrations as numbered in that directory
2. **API env** (Railway `@serviceos/api`):
   - `STRIPE_PRICE_ID` — trial checkout price
   - `WEB_URL` — frontend origin for Stripe return URLs
   - Optional QA only: `TRIAL_VOICE_MINUTES_DAILY_OVERRIDE`, `TRIAL_VOICE_MINUTES_TOTAL_OVERRIDE`
3. **Voice gates** — wired in `app.ts` when Postgres + audit repo exist (`createVoiceGate`). No separate flag.

## Enable v2 UI (Railway / Vercel)

Set on the **web** service (not API):

```bash
VITE_ONBOARDING_V2_ENABLED=true
```

Railway `@serviceos/web` renders this at container start into `/env.js` via `packages/web/start.sh` (no image rebuild required).

Vite dev / CI builds still read `import.meta.env.VITE_ONBOARDING_V2_ENABLED`; production nginx path prefers `window.__APP_CONFIG__`.

**Guard behavior:** `ProtectedRoute` → `OnboardingGuard` polls `GET /api/onboarding/status` every 30s and redirects incomplete tenants to `/onboarding`.

## Verification matrix

| Area | How to verify |
|------|----------------|
| Derived status | `cd packages/api && npm run test:integration -- onboarding` |
| Gate A + B (webhook) | `npx vitest run test/telephony/telephony-voice-gate.test.ts` + `test/voice/voice-gate.test.ts` |
| E2E shell + identity + pack | Clerk secrets + `E2E_USE_TEST_DB=true` → `VITE_ONBOARDING_V2_ENABLED=true npm run e2e -- onboarding-v2` |
| Step 6 (you're live) | Inbound `voice_sessions` row **or** `POST /api/onboarding/test-call/skip` — covered by `derive-status` + integration tests |

## CI

- **PR / deploy:** `test/integration/onboarding-*.test.ts` via `npm run test:integration`
- **E2E workflow:** When `E2E_CLERK_SECRET_KEY` is set, also sets `VITE_ONBOARDING_V2_ENABLED=true` and runs onboarding API integration + Playwright `onboarding-v2` journey (identity submit + pack when test DB is up)

## Rollback

Set `VITE_ONBOARDING_V2_ENABLED=false` on the web service and redeploy/restart. Legacy `OnboardingPage` and inert app-shell guard return immediately. API onboarding routes and voice gates remain (safe; gates protect trial abuse).

## Non-goals (post go-live)

- Rebuilding the legacy 9-step wizard
- Terminology / automation polish steps (optional footer only)
