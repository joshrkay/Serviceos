# Blocked / Deferred — Onboarding Launch-Readiness Pass

## BLOCKED (environment) — Docker-gated integration tests cannot execute here

**What:** `npm run test:rls`, `npm run test:activation`, and the full
`test/integration/**` suite (which includes the new
`onboarding-activation.test.ts` and the extended `rls-tenant-isolation.test.ts`).

**Diagnosis:** The integration harness (`test/integration/global-setup.ts`) starts a
`pgvector/pgvector:pg16` testcontainer. In this environment the Docker daemon is up,
but **pulling the image fails with `403 Forbidden`** from the registry blob CDN
(`production.cloudfront.docker.com`) — the same 403 also hits `postgres:16-alpine`,
so it's an environment-level egress block on image-blob downloads, not image-specific.
The testcontainers Ryuk reaper image (`testcontainers/ryuk:0.14.0`) is likewise
absent; `TESTCONTAINERS_RYUK_DISABLED=true` clears that, but the pgvector pull still
403s.

**Mitigation / status:**
- The test **files are authored and type-check cleanly** (verified with
  `tsc --noEmit -p tsconfig.json` — zero errors in the new/modified files).
- The activation logic they exercise is **fully covered by unit tests** that run
  here: `test/voice/activation.test.ts` (10 cases against a mocked pool — the
  count-based rule, idempotent check-and-set, every gate, email-once). The funnel
  contract is covered by `analytics.funnel.test.ts`.
- On any runner that can pull the pgvector image, `npm run test:rls` and
  `npm run test:activation` will execute the real-Postgres assertions as written.

## BLOCKED (environment) — `test:e2e:onboarding` cannot execute here

**What:** `npm run test:e2e:onboarding` (`playwright test e2e/journeys/onboarding-v2.spec.ts`).

**Diagnosis:** The spec self-skips without `hasClerkTestingCreds()` (no
`E2E_CLERK_*`) and without `VITE_ONBOARDING_V2_ENABLED=true`; its DB-backed test
needs `E2E_USE_TEST_DB=true`, which starts the same blocked pgvector container.
Playwright's `webServer` also boots the API (`packages/api npm run dev`), which needs
a reachable Postgres. None of those are available here. No Clerk testing keys are
provisioned in this environment.

**Mitigation / status:** The client funnel emissions the e2e would assert are
covered by component unit tests that run here (`LandingPage.funnel.test.tsx`,
`SignupPage.funnel.test.tsx`, `TestCallStep.funnel.test.tsx`) plus the
`analytics.funnel.test.ts` contract test. The e2e mock helper
(`e2e/helpers/onboarding-v2-mock.ts`) was updated to the new contract shape so the
journey runs faithfully wherever Clerk creds + DB are available.

## SHIPPED (was deferred) — calendar choice + identity-based activation + Vapi

After the "go fully literal" decision (DECISIONS.md D9), the items previously
deferred were built:

- **`wizard_step_calendar` / calendar connection** — SHIPPED. `calendar_provider`
  column (migration 149), `POST /api/onboarding/calendar/choose` (google/builtin),
  `CalendarChoicePanel` UI (Google OAuth handoff / built-in skip), `wizard_step_calendar`
  emit + test. (Next-7-days availability *seeding* on Google connect remains a small
  follow-up — the provider choice + OAuth handoff ship now.)
- **Identity-based activation** — SHIPPED as the primary path
  (`maybeFireActivationForInboundCall`, driven by the Vapi webhook's caller number;
  caller ≠ verified phone ⇒ activation). The count-based rule remains the Twilio-only
  fallback. No new `test_call_from_e164` column was needed — `owner_phone` +
  `business_phone` are the verified set.
- **Vapi integration** — SHIPPED (`integrations/vapi/*`): assistant create/link,
  signature-verified idempotent webhook, provisioning wiring. Off-by-default without
  `VAPI_API_KEY`.

## REMAINING follow-up (small) — Google availability seeding

Pulling the next 7 days of Google Calendar busy-blocks into a tech-availability
template on connect is not yet wired (the OAuth handoff + provider persistence are).
Effort: ~0.5 day, reusing `routes/calendar-integrations.ts` token storage.
