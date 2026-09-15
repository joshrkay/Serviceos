# Release verification repair — September 14, 2026

Initial base: main `02b3b404a9864797566b87fa0c7b7fc0c1155db6`. Updated with merged safety fixes #1216, #1217 and #1220 during verification. Implementation: [PR #1224](https://github.com/joshrkay/Serviceos/pull/1224).

## Defects reproduced and repaired

- `e2e/global-setup.ts` returned success when explicitly requested Postgres bootstrap failed. Reproduced with a refused localhost test database: before printed `SETUP_RETURNED_SUCCESS`; after exits 1. Added a subprocess regression against the real setup module.
- Main E2E run 34911588965 passed 59 tests and skipped 192, including missing-Clerk onboarding integration. This is valid smoke evidence, not a release verdict. Added separate jobs with explicit scopes and a result gate that rejects empty, skipped, flaky or failed reports.
- Database browser jobs now provision/migrate Postgres before Playwright loads its webServer environment, so API processes actually receive DATABASE_URL. They include the provider-stub fixture values needed to execute the full identity/pack/trial/AI-check path.
- Added an opt-in, real-Clerk Development journey: fresh signup, authenticated tenant, identity, first draft estimate, reload and returning sign-in. It obtains a real session bearer token and asserts `tenant_id`; it does not reuse the legacy test's unauthenticated `/api/me`, wrong `tenantId` field or health-only second test. The new journey is excluded from ordinary chromium runs.

## Locally executed evidence

- Node 20.20.0; isolated `pgvector/pgvector:pg16` container.
- API production TypeScript check passes.
- 66 tests pass across eight suites: trial-provisioning-first-value, signup-to-paid-critical-path, clerk-owner-membership, flow1-saas-billing-runthrough, milestone-billing-recorded-estimate, e1-life-safety-handler, i3-voice-approval-challenge-lock and voice-token-cap-level-triggered. Real Postgres and RLS runtime role where applicable; provider boundaries simulated.
- Four browser journeys pass, zero skipped, zero retries: signup webhook replay/isolation; identity form/database/audit with neighbour tenant; identity → pack → stub phone → signed trial webhook → AI-check worker with two tenants; signup → first estimate visible in the UI.
- Three browser regressions pass for email submission versus OAuth and both Clerk OTP layouts.
- Three release-policy/setup regression tests pass. The result gate accepts the four-pass report and rejects a report with failures/skips.
- [Real Development run 34929941703](https://github.com/joshrkay/Serviceos/actions/runs/34929941703) passed against test revision `b3e9707c7`: fresh Clerk email signup, real tenant, identity saved, draft estimate created and visible, reload, sign-out/password sign-in, same tenant and estimate. One executed journey; zero skipped, zero retries. This exercised the existing Development deployment, not a deployment of the PR.
- [Database onboarding CI run 34929604753](https://github.com/joshrkay/Serviceos/actions/runs/34929604753) passed, as did the standard E2E run on that revision. The full latest PR checks are separate from this scoped evidence.

Live iterations found and fixed test defects: ambiguous Continue selected Google OAuth; the route could settle before the OTP input; segmented OTP needed keyboard typing; API authentication required the application's `serviceos` JWT template; reload required waiting for Clerk to restore its session. None was suppressed or converted into a skipped pass.

Requested GPT-5.3-Codex-Spark reviews could not run: the available runtime rejected that model for the signed-in ChatGPT account. No Spark review is claimed.

Local infrastructure initially lacked the Playwright browser build and psql. Used installed Google Chrome and the test container's actual psql client. A low-disk Vite error was resolved by removing this task's redundant temporary source archive. No product data was used by local tests.

## How to run

`Onboarding database verification` runs on PRs/main and manually. It needs no provider credentials; its green check proves the named local app/database journeys only.

`Release verification` runs manually only (never on pull-request code automatically). It uses GitHub environment `dev` and the existing `RAILWAY_TOKEN` to read the Development API's Clerk **test** keys, validates the prefixes and masks the values. Dependencies are installed before keys load. No keys are written to the repository or uploaded artifacts. The target is fixed to the existing Development web URL. It uses real Clerk signup and retains isolated QA draft records for diagnosis, without sending estimates, submitting payments or explicitly buying phone resources. No auth traces are uploaded.

## Remaining release gates

- Target-production verification with an explicitly scoped account remains outstanding; the passing Development journey is not production observation.
- Actual hosted Stripe checkout/trial expiry, configured phone and speech providers, acquisition attribution/pricing consistency, and production isolation evidence are distinct gates. These jobs do not certify them.
- Safety fixes #1216, #1217 and #1220 merged independently while this work ran; their selected integration suites passed locally. Transcript fencing #1218 remains open. This PR does not reproduce those implementations.
- No declaration that public onboarding is release-ready follows from the local passes above.
