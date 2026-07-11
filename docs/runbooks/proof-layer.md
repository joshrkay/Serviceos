# Proof layer — what CI proves today, and the 15-minute unlock for the rest

The scorecard criticism was "the Docker integration suite couldn't run here,
and the full E2E journeys are still test.skip pending Clerk test tokens."
Investigated 2026-07-11; the honest state is stronger than the criticism:

## What is ALREADY green on every PR (no action needed)

1. **The integration suite runs in CI, for real, under RLS.**
   `pr-checks.yml` pre-pulls `pgvector/pgvector:pg16` and runs
   `npm run test:integration` (which is `RLS_RUNTIME_ROLE=true …` since WS13)
   against a real testcontainer Postgres — 141 files / ~700 tests, every
   tenant-scoped query exercised under the least-privilege
   `rls_app_runtime` role. No secrets, no `services:` block, unconditional.
   The suite only fails to run in Docker-blocked sandboxes (use the
   `EXTERNAL_TEST_DB_URL` seam there — see
   `packages/api/test/integration/global-setup.ts`).

2. **The signup → first-estimate → payment critical path is proven
   continuously** by `packages/api/test/integration/
   signup-to-paid-critical-path.test.ts` (TEST-04): a *signed* Clerk
   `user.created` webhook → the real `/webhooks/clerk` route →
   `bootstrapTenant()` → estimate lifecycle → invoice → payment, all on real
   Postgres. No Clerk cloud needed.

3. **The money loop is proven in the browser hermetically** on every PR:
   `e2e/money-loop/estimate-approve-execute.spec.ts` (W1-1),
   `invoice-webhook-paid.spec.ts` (W1-2), and the public
   approval/pay specs (W1-3/W1-4) run against the offline Clerk stub
   (`e2e/helpers/clerk-stub.ts`) with zero secrets.

4. **A fully hermetic browser Journey-1 now runs on every PR** (WS24):
   `e2e/journeys/signup-to-first-estimate.hermetic.spec.ts`. With ZERO Clerk
   secrets it POSTs a *signed* `user.created` svix webhook to the REAL local
   `/webhooks/clerk` route (running the REAL `bootstrapTenant()` — the same
   signing mechanism as TEST-04), then installs the Clerk stub bound to the
   SAME `sub`, asserts `/api/me` returns that real `tenant_id`, and creates +
   renders the first estimate through the real API and authed SPA. The API
   webServer boots in `DEV_AUTH_BYPASS` mode (playwright.config.ts's
   `apiWebServerEnv`), so the stub's unsigned JWT resolves to the
   webhook-bootstrapped tenant via the single shared in-memory `tenantRepo`
   (app.ts BUG-2 wiring). It runs in the always-on `chromium` project — NOT
   guarded by `hasClerkTestingCreds` — so it gates every PR alongside the
   secret-gated real-Clerk journey.

## The unlock: browser journeys currently `test.skip` (pure ops, ~15 min)

`e2e/journeys/signup-to-first-estimate.spec.ts` and
`onboarding-v2.spec.ts` drive the REAL Clerk hosted signup (bot-bypass
testing tokens) and therefore genuinely need a Clerk dev instance. These
now UPGRADE FIDELITY (real hosted signup UI + real Clerk session tokens)
rather than being the only browser proof of Journey-1 — the hermetic
`signup-to-first-estimate.hermetic.spec.ts` (above) already gates every PR
without them. The workflow (`e2e.yml`) auto-enables the real-Clerk specs
from secret presence; **no workflow edits are needed** to unlock them.

Operator checklist:
1. Clerk dashboard → your dev instance → Configure → **enable Testing
   mode**.
2. Add GitHub repository secrets:
   - `E2E_CLERK_PUBLISHABLE_KEY` (pk_test_… from that instance)
   - `E2E_CLERK_SECRET_KEY` (sk_test_…)
   - `E2E_DATABASE_URL` (a dedicated Postgres for seeded journey data)
   - optional: `E2E_CLERK_USER_USERNAME` / `E2E_CLERK_USER_PASSWORD`
3. Re-run the `e2e` workflow. The secret-derived flags
   (`E2E_HAS_REAL_CLERK_PK`, `VITE_ONBOARDING_V2_ENABLED`,
   `E2E_USE_TEST_DB`) flip automatically and the `test.skip` guards
   evaluate false.
4. (Separate track — nightly QA matrix, not the PR gate:) the
   `qa-matrix-gate.yml` secrets listed in `docs/prod-env-checklist.md`.

## Deliberate design, not debt

The split is intentional: **hermetic-always-on** (stub-auth browser specs,
the hermetic Journey-1, and the TEST-04 integration journey) gates every
PR; **secret-gated-optional** (real-Clerk browser journeys) adds the last
mile of fidelity — the real hosted signup UI and real Clerk session tokens
— when the operator provisions the dev instance. `invoice-to-payment.spec.ts`
is permanently delegated to the hermetic W1-2 + webhook proofs (live Stripe
Elements out of scope by decision).

The once-hypothetical "fully hermetic browser Journey-1 without Clerk
secrets" shipped in WS24: rather than a new offline `/webhooks/clerk` seam,
it reuses the REAL webhook route driven by a locally-signed svix payload,
paired with the stub + the API's existing `DEV_AUTH_BYPASS` so `/api/me`
returns the real bootstrapped tenant. See
`e2e/journeys/signup-to-first-estimate.hermetic.spec.ts`.
