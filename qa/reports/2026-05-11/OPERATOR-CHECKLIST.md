# Operator checklist — 2026-05-11

You asked the team to figure out why automated tests pass while real
features ship broken. PR #339 shipped 8 user-visible bugs that 4,898
tests had silently allowed through. This branch
(`claude/plan-qa-testing-strategy-QpdAY`) ships the strategy +
infrastructure to stop that. Your job from here is one-time dashboard
setup, then enforcement.

For the strategic argument, see `docs/qa-strategy.md` on this branch.

---

## What just shipped on this branch

| # | Commit | What it gives you |
|---|--------|---|
| 1 | `6bcd3f4` | `docs/qa-strategy.md` — operational complement to `docs/testing-strategy.md`. Defines "verified", the four levers, the unblock cascade for the 212 blockers from the 2026-05-11 manual QA. |
| 2 | `cfc6e9d` | **Lever 1a — Clerk testing tokens.** `e2e/helpers/clerk-testing.ts`, `e2e/global-setup.ts`, unskipped `signup-to-first-estimate.spec.ts`, runbook at `clerk-testing-tokens-runbook.md`. |
| 3 | `f12c060` | **Lever 1b — Ephemeral test PG.** `e2e/fixtures/{safety,setup-test-db,seed-journey-fixtures,teardown-test-db}.ts`, `e2e/global-teardown.ts`. testcontainers strategy + BYO-DB fallback + production-DB safety guard. Runbook at `ephemeral-test-db-runbook.md`. |
| 4 | `94897ce` | **Lever 3 — Route coverage sweep.** `e2e/coverage-sweep.spec.ts` walks 30 routes, asserts no console errors + every button has a click handler + no 4xx/5xx fetches. Opt-in via `COVERAGE_SWEEP=1`. Runbook at `coverage-sweep-runbook.md`. |
| 5 | `74fd27c` | **Lever 2 — QA matrix prep.** `scripts/qa-matrix-doctor.ts`, `scripts/qa-smoke-tools.ts`, `scripts/qa-matrix-run.sh`, runbook at `qa-matrix-live-runbook.md`. ⚠ Commit *title* says "untrack playwright-report" — that's a packaging accident; the *content* is the QA matrix prep work (5 files, +777/-90). `git show 74fd27c` for the truth. |
| 6 | `e1c3e7e` | `@clerk/testing` dev dep bump. |

All 6 commits are on origin. No PR opened — review locally first, then
open the PR when you're ready.

---

## Order of operations — what you do next

Time estimates assume you have the right dashboards open. Total
~30 minutes of dashboard work.

### Step 0 — re-verify BUG-1..BUG-8 in the browser  (~15 min)

**Goal:** flip 8 fails + ~33 cascade-blocked steps from your 2026-05-11
manual QA. The fixes for BUG-1..BUG-8 are real in code on `origin/main`
(receipts table in chat with file:line). What we don't know is whether
the deployed Railway dev build is current.

Action: open Railway dev (`https://serviceosweb-development.up.railway.app`),
re-run sections 2, 4, 5, 6, 12, 13, 14 from the manual sweep. If any
of the 8 bugs still repros after a verified-fresh deploy, open BUG-9
with a screenshot.

This step has nothing to do with the new infrastructure — it's the
fastest credibility-restore move and can run in parallel with the
rest.

### Step 1 — wire Clerk testing tokens  (~10 min)

Follow `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`:

1. Clerk dashboard → development instance → Configure → Testing → on.
2. Copy `pk_test_...` and `sk_test_...` from Configure → API keys.
3. GitHub repo → Settings → Secrets → Actions. Add:
   - `E2E_CLERK_PUBLISHABLE_KEY` = `pk_test_...`
   - `E2E_CLERK_SECRET_KEY` = `sk_test_...`
   - `VITE_CLERK_PUBLISHABLE_KEY` = `pk_test_...` (same value, web build needs it)
4. (Optional) export the same three locally in your `.env` if you want
   to run journey tests locally.

Verify: `npx playwright test e2e/journeys/signup-to-first-estimate.spec.ts --reporter=list`
should now run end-to-end (not skip).

### Step 2 — ephemeral test PG  (~5 min, mostly zero-config)

Follow `qa/reports/2026-05-11/ephemeral-test-db-runbook.md`:

- **CI:** nothing to do. The workflow exports `E2E_USE_TEST_DB=true` and
  the testcontainer auto-starts on `ubuntu-latest` (Docker preinstalled).
  Cold start ~10s.
- **Local:** install Docker, then `npm run e2e` runs against an
  ephemeral testcontainer Postgres on the fly.
- **BYO DB (advanced):** set `E2E_DATABASE_URL=postgres://...test_db`.
  Refuses if the DB name doesn't contain `test`/`e2e`/`ephemeral`/`ci`
  — the safety guard catches mistargets at `e2e/fixtures/safety.ts`.

Verify: `npx tsx e2e/fixtures/setup-test-db.ts --dry-run` exits 0.

### Step 3 — fire the QA matrix live  (~15 min)

Follow `qa/reports/2026-05-11/qa-matrix-live-runbook.md`. This is the
**first ever live run** of the harness — every verdict in
`qa/backlog/README.md` today is a prediction.

1. Open the runbook — it has the exact `export E2E_*=...` commands per
   var with explicit Railway tab paths.
2. The biggest gotcha: `E2E_CLERK_HMAC_SECRET` must equal Railway's
   `CLERK_SECRET_KEY` byte-for-byte. Drift = universal 401s.
3. Run `./scripts/qa-matrix-run.sh` (or `npm run qa:matrix:run`).
4. Read `qa/reports/<date>/QA-REPORT.md` — that's your real backlog.

The doctor script (`scripts/qa-matrix-doctor.ts`) preflights every
required env var and connection so misconfigs fail loudly with the
exact missing var name.

### Step 4 — run the route coverage sweep  (~3 min)

Follow `qa/reports/2026-05-11/coverage-sweep-runbook.md`.

```bash
COVERAGE_SWEEP=1 npm run e2e:coverage-sweep
```

This visits all 30 SPA routes and is the thing that would have caught
BUG-1, BUG-4, BUG-8 automatically. Run it before every release
candidate.

### Step 5 — adopt the merge gate

Update your PR-merge process (`docs/qa-strategy.md` §Rules of the road):

- **No merge to `main` without:** unit + integration green (existing
  policy) AND coverage-sweep green against the PR's preview deploy.
- **Bug fixes ship with a regression test** that fails before the fix
  and passes after.
- **"Fixed" is a claim that requires a screenshot or a green Playwright
  run.** Green commit message is not evidence.

---

## Stuff still needing your input (account / credential level)

These can't be agent-automated:

| Need | Why |
|---|---|
| Clerk dev instance + `pk_test_` / `sk_test_` | Lever 1a — see Step 1 |
| (Optional) Twilio test creds | Unblocks Calling Agent + Notifications sections of manual sweep (16 steps) |
| (Optional) Stripe test mode + Stripe CLI | Unblocks QA matrix rows INV-05, INV-06 |
| (Optional) SendGrid sandbox | Unblocks notification email tests |

The Clerk one is hard-blocking on Lever 1. The other three are tier 3
unlocks — work without them, the matrix just reports those rows as
`n/a`.

---

## Definition of done for this strategy

You can call this work shipped when:

1. ✅ `signup-to-first-estimate.spec.ts` runs end-to-end in PR CI (not
   `test.skip`).
2. ⏳ The first live QA matrix run produces a real `QA-REPORT.md` in
   `qa/reports/<date>/`. (Predicted-verdict rows become measured.)
3. ⏳ Coverage sweep runs as a required check on every PR.
4. ⏳ A new bug surfaced post-merge has either an open BUG-NN story
   with allowed-files + pass criteria, OR a regression test in the
   same PR.

(1) is unblocked by Step 1 above. (2) is unblocked by Steps 2-3.
(3) is unblocked by adding the sweep to `.github/workflows/e2e.yml`
as a required check (one-line follow-up, intentionally not done in
this branch so you can review the spec output first).

---

## If you only do one thing

**Re-run sections 2, 4, 5, 6, 12, 13, 14 of the 2026-05-11 manual
sweep against the current Railway dev deploy.** That's the fastest
credibility-restore. 41 of your 212 blockers — 19% — turn green in
one Cursor session if the fixes have actually deployed.

Then Step 1 (Clerk). Everything else follows from there.
