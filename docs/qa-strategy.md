# QA Strategy — closing the tests-pass-features-broken gap

> Companion to `docs/testing-strategy.md`. That doc defines the testing
> pyramid as policy; this doc is the operational plan for closing the
> specific gap between "CI green" and "the app works when a human
> clicks it."

## Why this doc exists

On 2026-05-10, PR #339 shipped 8 user-visible bug fixes (BUG-1..BUG-8)
that 4,898 automated tests had silently allowed through:

| Bug | What broke | Why the test pyramid missed it |
|---|---|---|
| BUG-1 | Settings "Sign out" navigated to `/login` but never called Clerk `signOut` | SettingsPage test mocked `useClerk()` with a `vi.fn()` — the mock accepted the missing call |
| BUG-2 | Public-intake router and dev-auth-bypass middleware held disjoint `DevInMemoryTenantRepository` instances | No test exercised both surfaces against the same in-memory store |
| BUG-3 | NewJobFlow stayed disabled with no explanation when required fields were missing | Disabled-state is a render outcome; no test reads the user-visible hint text |
| BUG-4 | "New invoice" button had no `onClick` | Component test asserted button is visible, not that click does anything |
| BUG-5 | `GET /api/dispatch/technician/:id/appointments` returned 404 | No integration test for this route — TechnicianDayView's fetch was never exercised against a real router |
| BUG-6 | `/api/maintenance-contracts` not registered | Same — Contracts page's fetch never hit a real router in CI |
| BUG-7 | `GET/PATCH /api/settings/language` not registered | Same — language toggle's fetch path never tested against a real router |
| BUG-8 | "Edit" on company-profile card had no `onClick` | Same as BUG-4 |

The shared root cause: **every test layer is mocked.** Vitest mocks
Clerk. Component tests use `msw` to fake API responses. Route tests
inject tenant context directly. Nothing in PR CI actually drives a
real browser against a real backend before merge.

The fix is not "write more tests" — coverage is already 70-95% by
policy. The fix is **adding a layer that exercises wiring, not
behavior in isolation.**

## Definition of "verified"

A change is **verified** when, in PR CI, at least one of:

1. A real-browser Playwright test clicks the affected UI and asserts
   the outcome (navigation, modal open, fetch resolved 2xx, DB row
   present).
2. A route-level integration test calls the real Express handler with
   real auth middleware and asserts the response shape.
3. A human runs the **route coverage sweep** (`npm run e2e:coverage-sweep`)
   against the deployed env and the sweep is green.

"Unit tests pass" + "type checks pass" is **not** verification for any
change that crosses a wire boundary (HTTP, click handler, modal open,
auth flow).

## The four levers

We have four discrete gaps. Each closes a specific class of bug; each
is in flight on branch `claude/plan-qa-testing-strategy-QpdAY`.

### Lever 1 — Unskip the journey tests

**What it catches:** end-to-end user flows. Signup → tenant bootstrap.
Estimate draft → approval → execution. Invoice → payment.

**Current status:** `e2e/journeys/*.spec.ts` contains 3 scaffolded
specs all marked `test.skip()`. The blocker has been (a) Clerk testing
tokens and (b) ephemeral test PG.

**Plan:**
- `e2e/helpers/clerk-testing.ts` — wraps `@clerk/testing` so each spec
  can call `setupClerkTestingToken(page)` and skip real OTP.
- `e2e/fixtures/setup-test-db.ts` / `seed-journey-fixtures.ts` /
  `teardown-test-db.ts` — Postgres lifecycle, seeded fixtures, safe
  teardown. Refuses to run against anything that looks like prod.
- `playwright.config.ts` — `globalSetup` + `globalTeardown` so journey
  specs run against a fresh DB when `E2E_USE_TEST_DB=true`.
- `.github/workflows/e2e.yml` — runs journeys on every PR.

**Single command after setup:** `npm run e2e` (journeys un-skipped).

### Lever 2 — Run the QA matrix live

**What it catches:** cross-layer (API + UI + DB) regressions on the
domains it covers — Estimates, Invoices, Assistant. 18 matrix rows,
each producing API/UI/DB evidence per run.

**Current status:** `e2e/qa-matrix/` is built. Has never been run
live. Predicted verdicts only.

**Plan:**
- `scripts/qa-matrix-doctor.ts` — pre-flights every required env var
  and connection.
- `scripts/qa-matrix-run.sh` — doctor → seed → run → print report path.
- `qa/reports/2026-05-11/qa-matrix-live-runbook.md` — exact dashboard
  steps for the human (which Railway / Clerk / Stripe values to copy).

**Single command after setup:** `npm run qa:run:now`.

### Lever 3 — Route coverage sweep

**What it catches:** the BUG-1, BUG-4, BUG-8 class. Pages that crash
on load. Buttons with no `onClick`. Console errors on every page. Fetches
that 404. Cheap and dumb on purpose — runs in &lt; 60 seconds.

**Current status:** in flight on the same branch.

**Plan:**
- `e2e/coverage-sweep.spec.ts` — visits every authenticated route,
  asserts (a) no `pageerror`, (b) no console.error (with a tight
  allowlist), (c) every primary CTA either navigates, fires a fetch,
  or opens a modal, (d) no fetch returns 4xx/5xx.
- Opt-in via `COVERAGE_SWEEP=1` so it doesn't bloat the default e2e
  run; explicitly run before every release candidate.

**Single command:** `npm run e2e:coverage-sweep`.

### Lever 4 — Manual QA, productized

**What it catches:** UX intent regressions (wrong-feeling flows, copy
errors, motion bugs) that no automated check will catch.

**Current status:** ad-hoc. Cursor-driven manual sweeps have produced
real bug lists (e.g. the 17-section / 253-step audit on 2026-05-11)
but findings are not consistently filed.

**Plan:**
- A standard template at `qa/reports/<date>/manual-sweep.md` with the
  17 section structure already in use.
- Findings flow into `qa/backlog/BUG-NN.md` files (same shape as the
  existing matrix backlog) so every bug has a story file with allowed
  files / pass criteria / verification command.

## Unblock cascade — the 212 blockers

From the 2026-05-11 manual sweep (33 pass / 8 fail / 212 blocked /
253 total):

| Tier | Blocked steps | Unblock by | Owner |
|---|---:|---|---|
| 0 — re-verify the 8 fixes against current Railway dev deploy | ~41 (8 fails + 33 cascade) | Cursor re-run of sections 2/4/5/6/12/13/14 | Operator |
| 1 — Lever 1 (Clerk testing tokens + ephemeral test PG) | 59 (Provisioning 24 + Tenant Isolation 35) | Branch agents in flight | Eng |
| 2 — seeded fixtures (falls out of Lever 1) | ~32 (Schedule 16 + Estimates-after-BUG-3 16) | Lever 1's seeder | Eng |
| 3 — integration creds (Twilio / Stripe / SendGrid) | ~16 (Calling Agent 9 + Notifications 7) | Account setup + secret rotation | Operator |
| 4 — feature gap | 11 (Dispatch Board not built) | Not a QA problem — real feature work | Eng |
| 5 — invalid-token paths | ~12 (Public Pages edge cases) | Spec + 2 small tests | Eng |
| Remainder | ~41 | Misc — auth UX, voice integration, longer-tail | Mixed |

Tiers 0-3 cover **148 of 212** blockers and are mechanical.

## What the operator must do

These actions cannot be automated and gate every lever:

1. **Clerk dashboard** — enable testing mode on the dev instance,
   copy the test publishable + secret keys. Detail steps in
   `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`.
2. **Supabase / Railway** — provision the ephemeral test DB (branch
   or dedicated). Detail steps in
   `qa/reports/2026-05-11/ephemeral-test-db-runbook.md`.
3. **GitHub repo secrets** — add the new env vars from steps 1+2 so
   PR CI can run journeys + coverage sweep.
4. **Stripe + Twilio + SendGrid test creds** — needed for matrix rows
   INV-05, INV-06, AST-04 and Notifications section.
5. **Re-run the 17-section manual sweep** against the current
   `origin/main` deploy to verify BUG-1..BUG-8 fixes hold in browser
   (not just in code).

## Rules of the road

These are the things that have to change in how we work, otherwise
the levers won't stop the bleeding:

- **No PR merges to `main` without a coverage-sweep pass** against
  the PR's preview deploy. If the sweep is amber, document the known
  exception in the PR body.
- **Bug fixes ship with a regression test that fails before the fix
  and passes after.** Test-pyramid policy already says this; from
  now on it's enforced in review.
- **"Fixed" is a claim that requires a screenshot or a green
  Playwright run.** A green commit message is not evidence.
- **Manual QA findings go into `qa/reports/<date>/manual-sweep.md`
  the same day they're found**, even if the fix lands later.
- **Every QA-matrix or coverage-sweep failure opens an issue with
  the artifact attached.** No silent re-runs.

## Status (2026-05-11)

| Lever | Status |
|---|---|
| 1 (journeys) | In flight on this branch — Clerk helper + PG fixtures landing today |
| 2 (matrix) | In flight on this branch — doctor + run script landing today; live run gated on operator secret setup |
| 3 (coverage sweep) | In flight on this branch — spec + project config landing today |
| 4 (manual, productized) | Template adopted; backlog flow exists; this doc closes the loop |

Next: operator runs the runbooks in `qa/reports/2026-05-11/` to wire
secrets, then PR CI starts producing real evidence per change.
