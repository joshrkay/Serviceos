# Release verification repair — September 14, 2026

Base: main `02b3b404a9864797566b87fa0c7b7fc0c1155db6`.

## Defects reproduced and repaired

- `e2e/global-setup.ts` returned success when explicitly requested Postgres bootstrap failed. Reproduced with a refused localhost test database: before printed `SETUP_RETURNED_SUCCESS`; after exits 1. Added a subprocess regression against the real setup module.
- Main E2E run 34911588965 passed 59 tests and skipped 192, including missing-Clerk onboarding integration. This is valid smoke evidence, not a release verdict. Added separate jobs with explicit scopes and a result gate that rejects empty, skipped, flaky or failed reports.
- Database browser jobs now provision/migrate Postgres before Playwright loads its webServer environment, so API processes actually receive DATABASE_URL. They include the provider-stub fixture values needed to execute the full identity/pack/trial/AI-check path.
- Added an opt-in, real-Clerk Development journey: fresh signup, authenticated tenant, identity, first draft estimate, reload and returning sign-in. It obtains a real session bearer token and asserts `tenant_id`; it does not reuse the legacy test's unauthenticated `/api/me`, wrong `tenantId` field or health-only second test. The new journey is excluded from ordinary chromium runs.

## Locally executed evidence

- Node 20.20.0; isolated `pgvector/pgvector:pg16` container.
- API production TypeScript check passes.
- 42 tests pass across trial-provisioning-first-value, signup-to-paid-critical-path, clerk-owner-membership, flow1-saas-billing-runthrough and milestone-billing-recorded-estimate integration suites. Real Postgres and RLS runtime role; provider boundaries simulated.
- Four browser journeys pass, zero skipped, zero retries: signup webhook replay/isolation; identity form/database/audit with neighbour tenant; identity → pack → stub phone → signed trial webhook → AI-check worker with two tenants; signup → first estimate visible in the UI.
- Three release-policy/setup regression tests pass. The result gate accepts the four-pass report and rejects a report with failures/skips.
- Real-provider suite loads and typechecks; execution requires the CI Development credential path. Do not treat test discovery as a live journey pass.

Local infrastructure initially lacked the Playwright browser build and psql. Used installed Google Chrome and the test container's actual psql client. A low-disk Vite error was resolved by removing this task's redundant temporary source archive. No product data was used by local tests.

## How to run

`Onboarding database verification` runs on PRs/main and manually. It needs no provider credentials; its green check proves the named local app/database journeys only.

`Release verification` runs manually or on same-repository PRs changing its files. It uses GitHub environment `dev` and the existing `RAILWAY_TOKEN` to read the Development API's Clerk **test** keys, validates the prefixes and masks the values. No keys are written to the repository or uploaded artifacts. The target is fixed to the existing Development web URL. It uses real Clerk signup and retains isolated QA draft records for diagnosis, without sending estimates, submitting payments or explicitly buying phone resources. No auth traces are uploaded.

## Remaining release gates

- Successful real-provider CI journey on the deployed Development revision, then target-production verification with an explicitly scoped account.
- Actual hosted Stripe checkout/trial expiry, configured phone and speech providers, acquisition attribution/pricing consistency, and production isolation evidence are distinct gates. These jobs do not certify them.
- Open safety/security fixes #1216, #1217, #1218, #1220 require their own review and verification. This change does not merge or reproduce their implementations.
- No declaration that public onboarding is release-ready follows from the local passes above.
