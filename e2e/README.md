# ServiceOS E2E tests

Playwright-based end-to-end tests covering critical user journeys.

## Quick start

```bash
# From repo root — starts API + web dev servers automatically and runs smoke tests
npm run e2e:smoke

# Run the full suite: the legacy `chromium` project (Clerk-key/E2E_BASE_URL-gated)
# AND `chromium-devauth` (D-2 — runs the same auth-gated specs for real against the
# repo's dev test-auth mode, see "Dev-auth mode" below)
npm run e2e

# Interactive debugger
npm run e2e:ui

# View the HTML report after a run
npm run e2e:report
```

First run downloads Chromium (~90MB). Cached after that. This container's
pinned Chromium build is sometimes replaced by a pre-installed one at a
different path — if so, set `QA_CHROMIUM_PATH=/path/to/chrome` (both the
`chromium` and `chromium-devauth` projects honor it) and never run
`playwright install`.

## Dev-auth mode (the `chromium-devauth` project) — D-2

Most auth-gated specs historically self-skipped on a bare PR runner: no real
Clerk publishable key, no authenticated `E2E_BASE_URL`. This repo also ships
a **dev test-auth mode** — `VITE_AUTH_MODE=dev` aliases `@clerk/clerk-react`
to a local shim (`packages/web/src/dev/clerk-dev-shim.tsx`) that returns an
always-signed-in session whose `getToken()` mints an unsigned JWT, and the
API's `DEV_AUTH_BYPASS=true` decodes that JWT to bootstrap a dev tenant (no
Clerk cloud, no Postgres — InMemory repos). See
`packages/web/.claude/skills/verify/SKILL.md` for the full manual recipe.

The `chromium-devauth` Playwright project runs that stack automatically:

- Its own API + vite pair, on **separate ports** from the legacy pair (it
  cannot share vite's dev server — the Clerk alias is baked in at that
  server's startup, so it needs its own process): `E2E_DEVAUTH_WEB_PORT`
  (default `5174`) and `E2E_DEVAUTH_API_PORT` (default `3001`). Override
  either if those happen to collide with something else on the box.
- A `devauth-setup` project (Playwright "setup project", runs once, after
  the dev-auth pair is confirmed healthy, before any `chromium-devauth`
  test) seeds representative data — a customer, 3 jobs, 2 appointments, an
  estimate, a draft invoice — by calling `packages/api/scripts/verify-seed.mjs`'s
  `seedVerifyData()` export against the dev-auth API. See
  `e2e/fixtures/dev-auth-seed.setup.ts`.
- `e2e/helpers/dev-auth.ts` exports a `test` (extending `@playwright/test`'s)
  with a **project-scoped** `devAuthActive` fixture option — true only for
  `chromium-devauth` (set via that project's `use` block in
  `playwright.config.ts`). Specs that were gated on
  `hasRealClerkPublishableKey()` / `E2E_BASE_URL` now also check
  `devAuthActive` in a `test.beforeEach`, so they run for real under
  `chromium-devauth` instead of self-skipping. It's deliberately a fixture
  option, not a bare `process.env` flag: `npm run e2e` runs both projects in
  the same Node process, and the legacy `chromium` project boots the REAL
  Clerk SDK — a global "dev-auth is active" flag would make its tests skip
  their guard too and then fail for real (no network egress to Clerk's CDN
  in CI/sandboxes), rather than cleanly self-skipping as before.
- Disable it with `E2E_DEV_AUTH=0` (it's also skipped automatically when
  `E2E_BASE_URL` is set — nothing local to boot against then).
- Scoped via `testMatch` to exactly the specs it exists to unlock —
  `booking-mobile`, `estimate-approval-mobile`, `invoice-payment-mobile`,
  `comms-inbox-mobile`, `review-response-approval-mobile`,
  `job-scheduling-mobile`, `settings-mobile` — NOT the whole `e2e/` dir like
  `chromium`. Every other spec is either already always-on under `chromium`
  (running it again here would be pure waste) or needs real Clerk secrets
  (out of scope — see below). One is actively incompatible: the hermetic
  signup journey's signed webhook needs `CLERK_WEBHOOK_SECRET`, which is
  only wired into the legacy pair's API env, not `devAuthApiServerEnv`.
- Always call `dismissWhatsNewModal(page)` (from `helpers/dev-auth.ts`)
  right after navigating to an authenticated route, before any click. The
  "What's new" modal (`components/walkthrough/WhatsNewModal.tsx`) is a
  pure-localStorage "seen the latest release?" gate — under `chromium-devauth`
  every test gets a fresh browser context AND a fresh InMemory tenant, so it
  opens on literally every authenticated page's first render, and its
  `fixed inset-0` backdrop intercepts pointer events until dismissed.

**Never active in a real build** — `VITE_AUTH_MODE=dev` is only read by
`packages/web/vite.config.ts`'s dev-server alias and by the shim itself;
production builds never set it, so `@clerk/clerk-react` resolves to the real
package. `DEV_AUTH_BYPASS` is likewise refused outside `NODE_ENV=dev`.

**Not every auth-gated spec is dev-auth eligible.** `smoke.spec.ts`'s UI
tests stay gated to a real Clerk key / `E2E_BASE_URL` only — they assert
either the actual Clerk SignIn/SignUp widget (the dev shim renders a plain
placeholder div instead) or signed-**out** behavior (the landing page,
redirect-to-login), and dev-auth's shim is always signed in by design, so it
structurally cannot represent a logged-out visitor. See the comment at the
top of that file.

### Known failures under dev-auth

None outstanding — three harness bugs surfaced the first time these specs
actually ran (all fixed in the same change that added `chromium-devauth`,
D-2):

- **`comms-inbox-mobile.spec.ts`** — its `page.route('**/api/conversations**', …)`
  mock also matched vite's own dev-server module URL for the page's source
  file, `/src/api/conversations.ts` (the glob is a "contains" match, and that
  path contains the substring `api/conversations` too), so the mock served
  JSON in place of the real JS module and the whole app failed to boot (blank
  page). Fixed by matching on `url.pathname` with an anchored regex
  (`/^\/api\/conversations(\/|\?|$)/`) instead of a bare glob string.
- **`comms-inbox-mobile.spec.ts`** (the thread-click test) — timed out
  clicking a thread row because the "What's new" modal (see above) was still
  open and intercepting the click. Fixed by calling `dismissWhatsNewModal`.
- **`job-scheduling-mobile.spec.ts`** — the "open the first job" locator
  (`getByRole('link', { name: /JOB-/ })`) never matched anything: job rows
  are clickable `role="button"` divs (`JobsList.tsx`), not links, so this
  self-skipped as "no jobs seeded" on every prior run this describe actually
  executed. Fixed to `getByRole('button', { name: /JOB-/ })`. Once it could
  actually open a job, a second bug surfaced: `getByText(/Schedule/i).first()`
  matched the sidebar's "Schedule" nav link (present but hidden at the 320px
  viewport) ahead of the job detail page's own visible "Schedule" label in
  DOM order. Fixed with `.filter({ visible: true })` before `.first()`.

If a new one shows up, record it here as: spec, assertion, screenshot/trace
path under `test-results/`, and suspected root cause.

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

### Render stability (`render-stability.spec.ts`)
Hermetic regression for the 2026-07-09 list/detail flicker fix. Same Clerk
stub + in-page API routes as the 401 suite:

- `/invoices` — triggers `useListQuery` visibility catch-up while holding the
  refresh response; asserts `INV-*` rows stay mounted and the "Loading
  invoices" spinner never replaces them
- `/jobs` — same pattern for job cards across a background refetch

Runs whenever `VITE_CLERK_PUBLISHABLE_KEY` is set. Complements the unit tests
in `useListQuery.test.ts` / `useDetailQuery.test.ts` that pin the hook
contract (`isLoading` stays false during background refetch).
### Public money loop (`public/*.spec.ts`)
Hermetic, always-on (no Clerk journey secrets):

- **`public/estimate-approval.spec.ts` (W1-3)** — `/e/:id` approve happy
  path (Zod-pinned fixture → two-decimal money → sign → POST `/approve` →
  success UI) plus network-failure error UI with no fixture-data leak
  (Blocker 8). Thread plan:
  `docs/plans/wave1/W1-3-public-estimate-approval.md` on branch
Hermetic, always-on (no Clerk journey secrets, no Stripe secrets):

- **`public/invoice-pay-status.spec.ts` (W1-4)** — `/pay/:id` status poll
  proof: unpaid invoice → async `processing` path → poll `open` → `paid`
  in place without blanking the page. Stripe Elements card entry is
  **out of scope** (Vite `@stripe/*` deps are stubbed). Thread plan:
  `docs/plans/wave1/W1-4-public-pay-status.md` on branch
  `docs/wave1-prove-money-loop-followup`.

Needs a syntactically valid `VITE_CLERK_PUBLISHABLE_KEY` (or
`E2E_BASE_URL`) so `main.tsx` boots — same gate as UI smoke. Clerk is
stubbed offline via `helpers/clerk-stub.ts`.

### Journeys (`journeys/*.spec.ts`)
1 and 2 are currently `test.skip()` — the spec code documents the intended
test shape, but the test doesn't execute until the preconditions in each
file's header comment are met. Journey 3 delegates to the W1-2 hermetic
money-loop proof (also skipped here so CI cannot false-green).

1. **signup-to-first-estimate** — new user signs up, Clerk webhook bootstraps
   a tenant, user drafts their first estimate. Needs Clerk testing tokens +
   ephemeral test PG.
2. **estimate-approval-execution** — AI task produces a draft proposal,
   operator approves, 5s undo window elapses, auto-delivery worker executes,
   estimate row appears. Needs AI provider creds or mocked gateway.
3. **invoice-to-payment** — skipped; continuous proof is W1-2:
   `e2e/money-loop/invoice-webhook-paid.spec.ts` (hermetic `/pay` after
   signed-webhook signal, no Elements) plus API proofs
   `packages/api/test/webhooks/invoice-webhook-paid.test.ts` and
   `packages/api/test/integration/invoice-webhook-paid.test.ts`.
   Live Stripe Elements remains out of scope for W1-2.
2. **estimate-approval-execution** — index pointer; hermetic proof is
   `e2e/money-loop/estimate-approve-execute.spec.ts` (W1-1): offline Clerk
   stub + seeded ready_for_review proposal, Inbox Approve → executed.
   Runs with the CI placeholder `pk_test_` (no live LLM / Clerk secrets).
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
├── money-loop/
│   └── invoice-webhook-paid.spec.ts       # W1-2 hermetic /pay proof
├── public/
│   ├── estimate-approval.spec.ts          # W1-3 hermetic /e/:id (always-on)
│   └── fixtures/
│       └── public-estimate-view.ts        # Zod-pinned public estimate fixture
├── helpers/
│   ├── clerk-stub.ts                      # offline Clerk for hermetic UI
│   ├── clerk-key.ts                       # real-vs-placeholder Clerk pk gate
│   ├── dev-auth.ts                        # D-2 devAuthActive fixture (chromium-devauth)
│   └── stripe-stub.ts                     # offline Stripe for W1-4 status poll
├── fixtures/
│   └── dev-auth-seed.setup.ts             # D-2 seeds InMemory data for chromium-devauth
├── public/
│   └── invoice-pay-status.spec.ts         # W1-4 hermetic /pay/:id status
└── journeys/
    ├── signup-to-first-estimate.spec.ts   # skipped
    ├── estimate-approval-execution.spec.ts # skipped
    └── invoice-to-payment.spec.ts         # skipped → see money-loop/
```

## CI

See `.github/workflows/e2e.yml` — runs on every PR and posts the HTML report
as a build artifact. Failure screenshots + traces are uploaded for debugging.
