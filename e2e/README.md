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
- `/login` page renders without errors
- `/signup` page renders without errors
- Unauthenticated visit to `/` redirects to `/login`
- API `/health` endpoint responds 200

These always run. If any fail, something basic is broken in the stack.

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

## Running against deployed envs

By default the config starts local dev servers via `webServer`. To run against
a deployed environment (Railway dev/staging) instead, set `E2E_BASE_URL`:

```bash
E2E_BASE_URL=https://serviceos-dev.up.railway.app \
E2E_API_URL=https://serviceos-api-dev.up.railway.app \
npm run e2e
```

When `E2E_BASE_URL` is set, Playwright does NOT start local servers.

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
