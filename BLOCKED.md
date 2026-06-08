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

## DEFERRED (product) — `wizard_step_calendar` / calendar wizard step

**What:** The spec's funnel includes `wizard_step_calendar` and a calendar
connection step (Google OAuth or built-in, with 7-day availability seeding).

**Why deferred:** The real onboarding wizard has **no calendar step** — calendar is a
per-user Google Calendar OAuth in *settings* (`routes/calendar-integrations.ts`), and
there is no built-in-calendar fallback or availability seeding. Inventing a calendar
wizard step is net-new product surface, out of scope for an instrumentation/activation
pass.

**Effort to ship:** ~1–2 days — a wizard step component, OAuth-in-wizard flow (reuse
`calendar-integrations.ts`), a built-in-calendar skip path, next-7-days availability
import into a tech-availability template, and the `wizard_step_calendar` emit + test.

## DEFERRED (engineering) — identity-based activation detection

**What:** Exclude the owner's *own* real calls from activation by comparing the
caller against the owner's verified phone (`tenant_settings.owner_phone`), instead of
the count-based heuristic.

**Why deferred:** `onSessionEnded` does not receive the caller's `From`, and
`voice_sessions` does not persist it. Identity-based detection needs the telephony
adapter to thread `From` into the session-end callback (and likely a
`tenant_settings.test_call_from_e164` column to remember the test caller). That's a
larger telephony change than an instrumentation pass should carry.

**Effort to ship:** ~0.5–1 day — thread `From` through the media-stream / Gather
adapters into `onSessionEnded`, add an additive `test_call_from_e164` column
(migration 147), and switch `voice/activation.ts` to identity comparison with the
count-based rule as fallback.
