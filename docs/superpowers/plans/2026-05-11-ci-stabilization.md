# CI Stabilization Plan — 2026-05-11

**Audience:** lead engineer / on-call
**Goal:** restore a green PR pipeline on `main` so the in-flight QA-gap PRs (337, 341, 331, et al.) can be reviewed and merged without the operator hand-waving past red checks.
**Context:** Two emergency CI fixes have already landed on `main` this week (`fa462e1` Claude/fix-ci-issues, `1103c58` playwright globalSetup, `b7ba881` PPA strip + UI catch). Despite both being merged, the `test` and `playwright` jobs are still failing across every open PR, and `deploy.yml` is drifting from the build-verification rule in `CLAUDE.md`.

---

## 0. TL;DR

Every open PR currently shows two red checks:

| Job | PR 337 | PR 341 | PR 331 | Cause |
|-----|--------|--------|--------|-------|
| `test` (pr-checks.yml) | ❌ | ❌ | ✅ | PR-author TS errors slipping past local checks |
| `playwright` (e2e.yml) | ❌ | ❌ | ❌ | webServer / globalSetup still racy on bare CI runners |
| `voice-quality` | skipped (depends on `test`) | skipped | ✅ | Cascades from `test` |
| Railway deploy preview | ❌ | ❌ | n/a | Out of scope (operator-managed env) |

There are **four** issues to fix, in priority order:

| # | Issue | Severity | Fix size |
|---|-------|----------|----------|
| C1 | `playwright` job fails on every PR (~90s, exits 1 before tests print) | 🔴 blocks merge | 0.5–1 day |
| C2 | `deploy.yml` typecheck uses the wrong tsconfig (drift from `CLAUDE.md`) | 🟠 silent prod-build risk | 15 min |
| C3 | TS errors slip into PRs because the mandatory `tsconfig.build.json` check is not enforced pre-push | 🟠 PR churn | 1–2 hr |
| C4 | All workflows pinned to Node-20 GitHub Actions (deprecated 2026-06-02) | 🟡 future-dated | 30 min |

C1 is the only one actively keeping PRs red right now. C2–C4 are correctness/forward-looking fixes that should ride alongside the C1 hotfix.

---

## 1. Inventory of what's failing and why

### 1.1 The `test` job (`.github/workflows/pr-checks.yml`)

Sequence: `npm ci` → `tsc --project tsconfig.build.json --noEmit` (api) → `tsc --noEmit` (web) → lint → unit → integration → coverage.

**Observed failure on PR 337** (commit `23c20fc`, run `25703737711/job/75469327019`):

The web typecheck step exits non-zero with 10 errors, all in `packages/web/src/components/.../InteractionsPage.tsx`:

```
Cannot find name 'RefreshCw'        (x2)
Cannot find name 'MessageSquare'
Cannot find name 'User'
Cannot find name 'Clock'
Cannot find name 'AlertCircle'
Cannot find name 'Phone'
Cannot find name 'useCallback'
Duplicate function implementation
Cannot redeclare exported variable 'InteractionsPage'
```

Diagnosis: PR 337 added a "Dispatch Log" tab to `InteractionsPage` and lost the `lucide-react` + `useCallback` imports during a merge, and there are now two `InteractionsPage` declarations in the same file. This is **author code**, not a CI infrastructure problem.

But it's also a CI **process** problem: `CLAUDE.md` already mandates

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

before pushing. We have no automated enforcement, so authors push when their editor's TS server happens to be happy and discover the failure 90s later in CI. Fixing C3 makes this category of failure impossible to push.

### 1.2 The `playwright` job (`.github/workflows/e2e.yml`)

Sequence: `npm ci` → strip broken PPAs → `playwright install --with-deps chromium` → `npm run e2e`.

**Observed failure on PR 337**: job ran 1m 28s and exited 1. No `test-results/` directory was uploaded ("No files were found with the provided path"). Behavior matches PR 341 and PR 331.

Two fixes landed this week to address earlier modes of failure:

* `b7ba881` (May 11) — strip `deadsnakes` / `ondrej/php` PPAs before `playwright install --with-deps` (apt-get was failing with 403).
* `1103c58` (May 10) — fix ESM/CJS export collision in `e2e/fixtures/setup-test-db.ts` and lazy-import the DB-fixtures module so smoke runs don't pull in `pg`/`testcontainers`.

Both are present on `origin/main` and the PR head commits all merged-in. The job no longer dies in apt, but **still** exits early without producing test output. Remaining hypotheses, ranked by likelihood:

1. **Vite dev server crashes at runtime when `VITE_CLERK_PUBLISHABLE_KEY` is empty.** `packages/web/src/main.tsx:12` does `throw new Error(...)` at module top-level when the env is missing. Playwright's `webServer` block treats the dev server as "up" the moment `http://localhost:5173` returns 200 (it does — Vite serves `index.html` fine), but the SPA's JS bundle then throws and no smoke spec can mount. PRs from operators who don't own the `E2E_CLERK_*` secrets get an empty value, not a thrown workflow error.
2. **120s `webServer.timeout` fights `npm ci` cost.** With `reuseExistingServer: false` (CI) plus two cold dev servers (api + web), the startup window is tight on a bare runner. If either dev server takes >120s the whole run dies before specs run.
3. **`E2E_USE_TEST_DB` gating still wrong.** The expression `${{ secrets.E2E_CLERK_SECRET_KEY != '' && 'true' || 'false' }}` is evaluated in workflow context. In some PR contexts secrets are masked to empty and this resolves to `'false'` — fine. But `E2E_USE_TEST_DB` is also wired through to `globalSetup`, and if a stale env propagates through `npm ci` cache layers the lazy import path may still be taken.
4. **A residual top-level `import` in `e2e/global-setup.ts` or one of its callers** that pulls a CJS/ESM mismatched module (the 1103c58 fix dropped a similar issue from `setup-test-db.ts` but the same pattern could exist elsewhere).

We do not yet have the full log — the CI page requires auth, and `WebFetch` can only see the public preview. The first step of the C1 fix is to **get the real log**, which is a 10-minute operator task (download the failing job log from the Actions UI and paste the last 100 lines into this doc or a fresh issue).

### 1.3 Workflow drift (`deploy.yml` vs `pr-checks.yml`)

`pr-checks.yml` (PR-time):
```
- run: npx tsc --project tsconfig.build.json --noEmit
  working-directory: packages/api
```

`deploy.yml` (post-merge, blocks Railway deploy):
```
- run: npx tsc --noEmit
  working-directory: packages/api
```

`CLAUDE.md` explicitly warns:

> The default `tsconfig.json` includes test files and vitest types — it is NOT sufficient to verify the production build. Always use `tsconfig.build.json`.

Consequence: a PR can be green at PR-time and red at deploy-time (or vice-versa) depending on whether the regression sits in test code or product code. We've already burned cycles on this twice this month.

### 1.4 Node-20 GitHub Actions deprecation

All four workflows pin `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`. Each runs on the Node-20 runtime, which GitHub has scheduled for deprecation **2026-06-02**. Not failing today; will fail in three weeks if untouched.

---

## 2. Fix plan

### C1 — Unblock the `playwright` job (this week)

**Owner:** whoever picks up this story. **Branch:** `claude/ci-issue-plan-jmUJp` extends to actual fix on a sibling branch.

Step-by-step:

1. **Capture the real failure.** Re-run the `playwright` job on PR 337 with diagnostics enabled (`ACTIONS_STEP_DEBUG=true`, `ACTIONS_RUNNER_DEBUG=true` as repo-level secrets). Download `playwright-report` artifact and the raw runner log. Paste the last 200 lines into a follow-up comment on this plan doc.
2. **Make the web dev server fail loudly when its key is missing.** Change `packages/web/src/main.tsx:9-13` from a runtime throw to a build-time `console.error` + render of a CI-friendly fallback page, OR gate the `webServer.url` health probe on a real `/health` endpoint instead of `/`. The smallest change: have `main.tsx` accept any non-empty pk for the smoke-test path (e.g. `'pk_test_ci_placeholder'` is fine for Playwright smoke; journey specs that need real Clerk already self-skip).
3. **Tighten the webServer block.** In `playwright.config.ts`, bump `webServer[*].timeout` from 120s to 180s on CI, and add a `stdout: 'pipe'` log dump on failure so the runner log shows *why* Vite/Express died.
4. **Add a CI smoke pre-flight step.** Before `npm run e2e`, run `curl -sf http://localhost:3000/health` and `curl -sf http://localhost:5173/` with retries, and fail the job at that point if either is down. This converts a silent webServer death into a 30-second targeted failure that the next on-call can read.
5. **Verify the lazy-import fix is complete.** `grep -rn "from './fixtures/setup-test-db'" e2e/` should show only function-scoped `await import()` calls (no top-level `import`). Likewise `setup-test-db.ts` should not re-export anything that forces ESM compile mode.
6. **Re-run on a throwaway PR.** Push a tiny no-op change to PR 337 or a fresh branch and confirm `playwright` reaches at least the `smoke.spec.ts` "1 passed, 7 skipped" exit-0 state on a bare runner (no Clerk secret, no DB secret).

**Done when:** `playwright` is green on at least one PR that has no Clerk/DB secrets configured, with a runtime in the 4–8 minute range (not 1m 30s).

**Files in scope (allowed to touch):**

* `.github/workflows/e2e.yml`
* `playwright.config.ts`
* `e2e/global-setup.ts`, `e2e/global-teardown.ts`, `e2e/fixtures/setup-test-db.ts`
* `packages/web/src/main.tsx`

### C2 — Align `deploy.yml` typecheck with `pr-checks.yml` (today)

One-line change in `.github/workflows/deploy.yml`:

```diff
-      - name: Type check API
-        run: npx tsc --noEmit
+      - name: Type check API (build config)
+        run: npx tsc --project tsconfig.build.json --noEmit
         working-directory: packages/api
```

No risk: brings deploy-time check in line with PR-time check and `CLAUDE.md`. Verify with one PR that touches `packages/api`.

**Done when:** the two workflows produce identical type-check results for any given commit on `packages/api`.

### C3 — Enforce the build-config typecheck pre-push (this week)

PR 337's failure mode (missing imports in `InteractionsPage`) cannot survive `tsc --project tsconfig.build.json --noEmit`. We need to enforce that locally. Two ways, pick one:

1. **Husky pre-push hook** — runs the same command `pr-checks.yml` runs, exits 1 on failure. Lives in `.husky/pre-push`. Trivial to add, easy to bypass with `--no-verify`.
2. **GitHub branch protection: require `test` check to pass before merge** — uses the existing CI signal, no client install needed. Already partially configured (judging from the "voice-quality is a required check" comment in `pr-checks.yml`).

**Recommend (1) + (2):** local hook for fast feedback, branch protection as the backstop. Cost: ~1 hour to land Husky on `package.json` "prepare" script if it isn't already.

**Done when:** a PR with a missing-import TS error can't be pushed locally without `--no-verify` AND can't be merged via the UI.

### C4 — Bump GitHub Actions to v5 / Node-22+ runtime (within two weeks)

Single search-and-replace across `.github/workflows/*.yml`:

```
actions/checkout@v4         → actions/checkout@v5
actions/setup-node@v4       → actions/setup-node@v5
actions/upload-artifact@v4  → actions/upload-artifact@v5
node-version: '20'          → node-version: '22'   (or '24')
```

The `node-version` bump is the real risk: it changes the Node runtime our tests + ts-node run under. Validate by re-running the full PR check suite on `main` after the bump and watching for `node --env-file-if-exists` / `ts-node` / `testcontainers` regressions.

**Done when:** all four workflows pass on `main` with Node-22+ runtime, before the 2026-06-02 deprecation date.

---

## 3. Out of scope (flag-only)

* **Railway "unique-adaptation - @serviceos/api" / "@serviceos/web" deploy-preview failures** on every PR. These are Railway-side build errors, not GitHub Actions. They surface as PR statuses but aren't blocking merges (the deploy job in `deploy.yml` runs *post-merge*). Worth a separate investigation owned by the deployment-environment maintainer.
* **`voice-quality` check** — currently `skipped` because it `needs: [test]`. Will auto-recover once C1 + C3 land.
* **The PR 337 author fix itself** (missing icon imports). That's the PR author's responsibility — they should rebase + add the `import { RefreshCw, MessageSquare, User, Clock, AlertCircle, Phone } from 'lucide-react'` and `import { useCallback } from 'react'`, and dedupe the second `InteractionsPage` declaration. This plan exists to make sure the *next* PR like this can't slip through.

---

## 4. Execution checklist

- [ ] C1.1 — Re-run PR 337 playwright job with `ACTIONS_STEP_DEBUG=true`; paste tail of log into a follow-up.
- [ ] C1.2 — Soften the `main.tsx` Clerk-key hard-throw for CI / replace with `/health` probe.
- [ ] C1.3 — Bump `webServer.timeout` to 180s; pipe stdout/stderr to logs on failure.
- [ ] C1.4 — Add `curl -sf` pre-flight smoke step in `e2e.yml`.
- [ ] C1.5 — Audit `e2e/**/*.ts` for top-level imports of CJS-style modules that force ESM compile mode.
- [ ] C1.6 — Re-run on throwaway PR; confirm smoke passes in 4–8 min.
- [ ] C2 — Update `deploy.yml` API type-check step to use `tsconfig.build.json`.
- [ ] C3.1 — Add `.husky/pre-push` running the build-config typecheck + `npm run lint`.
- [ ] C3.2 — Add `test` (and `playwright` after C1 lands) as a required check in branch-protection settings.
- [ ] C4 — Bump GitHub Actions to v5 + Node-22, validate full suite on `main`.

---

## 5. Verification

When all four issues are addressed:

```
# Local
cd packages/api && npx tsc --project tsconfig.build.json --noEmit  # 0 errors
cd packages/web && npx tsc --noEmit                                 # 0 errors
npm run lint                                                        # 0 errors
npm test -- --reporter=verbose                                      # passes
npm run e2e                                                         # smoke green (or graceful skip)

# CI (on a fresh PR with no secrets)
test           ✅ ~6 min
playwright     ✅ ~6 min (1 passed, 7 skipped if no Clerk secrets)
voice-quality  ✅ ~2 min
```

Until then, the operator workaround is to merge PRs by overriding required checks one-off — but that loses the launch-gate signal documented in `docs/superpowers/runbooks/voice-quality-launch-gate.md §4` and should not become routine.
