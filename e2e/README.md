# ServiceOS E2E tests

Playwright-based end-to-end tests covering critical user journeys.

## Quick start

```bash
# From repo root — starts API + web dev servers automatically and runs smoke tests
npm run e2e:smoke

# Run the full suite (smoke + journeys — most journeys are currently skipped)
npm run e2e

# Interactive debugger
npm run e2e:ui

# View the HTML report after a run
npm run e2e:report
```

First run downloads Chromium (~90MB). Cached after that.

## What's covered today

### Smoke (`smoke.spec.ts`)
- `/login` page renders without errors (Rivet chrome + Clerk sign-in widget)
- `/signup` page renders without errors (Rivet chrome + Clerk sign-up widget)
- Unauthenticated visit to `/` shows the public marketing landing page
- Unauthenticated visit to `/jobs` redirects to `/login`
- API `/health` endpoint responds 200

These always run. If any fail, something basic is broken in the stack.

### 401 resilience (`no-401-storm.spec.ts`)
Real-browser regression suite for the 2026-07-06 401-redirect-storm fix.
Recreates the outage locally — a stubbed signed-in Clerk
(`helpers/clerk-stub.ts`, zero network egress needed) plus route-mocked 401s
on every `/api/*` call — then counts what the app does:

- persistent 401s → exactly ONE latched Clerk sign-out, one soft navigation
  to `/login`, zero further document loads, and a quiet network afterwards
- a signed-out `/login` fires zero `/api` traffic (identity bridges gated)
- healthy-API control: the same signed-in boot stays on the app, no sign-out

Runs whenever `VITE_CLERK_PUBLISHABLE_KEY` is set (any syntactically valid
`pk_test_` works — the stub short-circuits Clerk's script download, so no
Clerk account or network access is required).

### Public money loop (`public/*.spec.ts`)
Hermetic, always-on (no Clerk journey secrets):

- **`public/estimate-approval.spec.ts` (W1-3)** — `/e/:id` approve happy
  path (Zod-pinned fixture → two-decimal money → sign → POST `/approve` →
  success UI) plus network-failure error UI with no fixture-data leak
  (Blocker 8). Thread plan:
  `docs/plans/wave1/W1-3-public-estimate-approval.md` on branch
  `docs/wave1-prove-money-loop-followup`.

Needs a syntactically valid `VITE_CLERK_PUBLISHABLE_KEY` (or
`E2E_BASE_URL`) so `main.tsx` boots — same gate as UI smoke. Clerk is
stubbed offline via `helpers/clerk-stub.ts`.

### Journeys (`journeys/*.spec.ts`)
All three are currently `test.skip()` — the spec code documents the intended
test shape, but the test doesn't execute until the preconditions in each
file's header comment are met.

1. **signup-to-first-estimate** — new user signs up, Clerk webhook bootstraps
   a tenant, user drafts their first estimate. Needs Clerk testing tokens +
   ephemeral test PG.
2. **estimate-approval-execution** — AI task produces a draft proposal,
   operator approves, 5s undo window elapses, auto-delivery worker executes,
   estimate row appears. Needs AI provider creds or mocked gateway.
3. **invoice-to-payment** — approved invoice generates Stripe payment link,
   `charge.succeeded` webhook flips invoice to paid. Needs Stripe test keys
   and P5-016 closed (Stripe Elements frontend).

## CI secrets (unlock journeys)

Add these repository secrets to run UI smoke and journeys in GitHub Actions:

| Secret | Purpose |
|--------|---------|
| `E2E_CLERK_PUBLISHABLE_KEY` | Clerk testing publishable key |
| `E2E_CLERK_SECRET_KEY` | Clerk testing secret for `@clerk/testing` token mint |
| `E2E_CLERK_USER_USERNAME` | Test user email |
| `E2E_CLERK_USER_PASSWORD` | Test user password |

Optional: `E2E_USE_TEST_DB=1` with a dedicated Postgres URL for seeded journey data.

Until secrets are set, `e2e.yml` runs API health smoke only; journey specs remain skipped.

## Running against deployed envs

By default the config starts local dev servers via `webServer`. To run against
a deployed environment (Railway dev/staging) instead, set `E2E_BASE_URL`:

```bash
E2E_BASE_URL=https://serviceos-dev.up.railway.app \
E2E_API_URL=https://serviceos-api-dev.up.railway.app \
npm run e2e
```

When `E2E_BASE_URL` is set, Playwright does NOT start local servers.

## Full matrix / runbook

The smoke suite above is the lightweight gate. Matrix and full beta runbook
execution require operator-provided Railway secrets — without them
`npm run qa:doctor` correctly reports blocked checks.

**Canonical guide:** [docs/runbooks/qa-full-matrix-unblock.md](../docs/runbooks/qa-full-matrix-unblock.md)

```bash
cp .env.qa.example .env.qa   # fill Railway URLs, DB URLs, CLERK_SECRET_KEY
source .env.qa
npm run qa:setup             # seed both fixture sets → mint → doctor

npm run qa:matrix:run        # matrix only (~30–60 min)
# OR
npm run qa:runbook           # qa-runner §1–17 + matrix (~90–120 min)
```

**Deployed API flag:** `CLERK_DEV_HMAC_TOKENS=true` (Railway → API Variables).
CI secrets manifest: [docs/runbooks/qa-github-secrets.md](../docs/runbooks/qa-github-secrets.md).

## Why most journeys are skipped

The smoke suite works today because `/login` and `/signup` are public Clerk
widgets — no auth state required. The three journeys all need real auth,
which means solving three things that are not yet wired:

1. **Clerk testing tokens** — Clerk supports a test-mode flow where you can
   complete signup/login without real OTP. Setup: https://clerk.com/docs/testing/playwright
2. **Ephemeral test DB** — journeys write real data (tenants, estimates,
   invoices). We need a per-run PG branch or a seed+truncate helper.
3. **Per-integration test credentials** — OpenAI test key, Stripe test key,
   Twilio off, webhook signing keys.

Unskipping each journey is a separate, small PR. Ship this scaffold first,
then fill in the preconditions one at a time.

## Layout

```
e2e/
├── README.md                              # this file
├── smoke.spec.ts                          # always runs
└── journeys/
    ├── signup-to-first-estimate.spec.ts   # skipped
    ├── estimate-approval-execution.spec.ts # skipped
    └── invoice-to-payment.spec.ts         # skipped
```

## CI

See `.github/workflows/e2e.yml` — runs on every PR and posts the HTML report
as a build artifact. Failure screenshots + traces are uploaded for debugging.
