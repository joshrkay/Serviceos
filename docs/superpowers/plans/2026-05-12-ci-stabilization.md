# CI Stabilization Plan — 2026-05-12

**Audience:** lead engineer / on-call
**Status:** refresh of the 2026-05-11 plan from PR #357 (which merged into a
feature branch but never reached `main`). C2 has since landed via PR #356;
C1/C3/C4 are still open, and a new dominant failure mode — merge-conflict
debris in long-running cursor branches — needs a process fix that sits
underneath C3.
**Goal:** restore a green PR pipeline on `main` so the in-flight QA-gap PRs
(337, 331, et al.) can be reviewed and merged without the operator
hand-waving past red checks.

---

## 0. TL;DR

| Job | Latest signal on open PRs | Cause |
|-----|--------------------------|-------|
| `test` (pr-checks.yml) | flaky across PRs | author TS errors from merge-conflict debris |
| `playwright` (e2e.yml) | red on every PR (~90s, exits 1 before tests run) | webServer race + Vite hard-throw on missing Clerk pk |
| `voice-quality` | skipped (depends on `test`) | cascades from `test` |
| Railway "unique-adaptation" | red on every PR | out of scope (Railway side) |

Four issues, in priority order (changed from the 2026-05-11 plan — C3 is
now first because it would have prevented the four "fix CI" PRs we shipped
this past week):

| # | Issue | Severity | Fix size |
|---|-------|----------|----------|
| C3 | TS errors slip into PRs because `tsconfig.build.json` typecheck isn't enforced pre-push, and merge-conflict debris keeps reintroducing them | 🔴 root cause of weekly fire-drills | 1–2 hr |
| C1 | `playwright` job fails on every PR (~90s, exits 1 before tests print) | 🔴 blocks merge | 0.5–1 day |
| C4 | Workflows pinned to Node 20 / actions@v4 (deprecated 2026-06-02) | 🟠 future-dated, ~3 weeks out | 30 min |
| C2 | `deploy.yml` typecheck used wrong tsconfig | ✅ FIXED in PR #356 | — |

---

## 1. Inventory of what's failing and why

### 1.1 The `test` job — merge-conflict debris (NEW)

The dominant `test` job failure pattern this week has been TS errors that
come not from new code, but from operator merges of `main` into
long-running cursor branches dropping imports/declarations. Evidence —
PRs we shipped solely to repair merge debris in the last 7 days:

| PR | Title |
|----|------|
| #345 | fix(ci+web): unblock playwright job, clear stale UI state on fetch exceptions |
| #352 | Replace Job ID text input with dropdown selector in forms (CI repair) |
| #355 | Refactor interactions API (fix/review-ci-issues) |
| #356 | fix(ci): repair merge-conflict artifacts blocking typecheck |
| #359 | fix(qa): repair merge-conflict debris blocking web typecheck |

The pattern: an operator merges `main` into a feature branch, the merge
drops a `lucide-react` import or a `useCallback` declaration, the editor's
TS server is happy (because the symbol still parses), and the breakage
surfaces only when CI runs `tsc --project tsconfig.build.json --noEmit`
90 seconds later.

`CLAUDE.md` already mandates this check pre-push. We have no automated
enforcement, so the rule is honored only when the author remembers.

Fix lives in C3.

### 1.2 The `playwright` job — silent webServer death

Sequence: `npm ci` → strip broken PPAs → `playwright install --with-deps
chromium` → `npm run e2e`.

Observed behavior across PRs 337, 341, 331: job runs ~1m 28s and exits 1,
no `test-results/` artifact uploaded ("No files were found"). Two fixes
landed earlier this week (`b7ba881` PPA strip, `1103c58` ESM/CJS export
collision) — neither resolves the current mode.

Remaining hypotheses, ranked by likelihood (carried forward from the
2026-05-11 plan; still our best read):

1. **Vite dev server crashes when `VITE_CLERK_PUBLISHABLE_KEY` is empty.**
   `packages/web/src/main.tsx:12` does `throw new Error(...)` at module top.
   Playwright's `webServer.url` health probe (`baseURL`, i.e. `/`)
   succeeds because Vite serves `index.html` even when JS later throws.
   PRs from operators without the `E2E_CLERK_*` secrets get an empty
   string, not a workflow error.
2. **120s `webServer.timeout` is tight on bare runners** with two cold
   dev servers (`packages/api` + `packages/web`) starting in parallel.
   Either timing out kills the run before the first spec ever loads.
3. **Residual top-level imports** of CJS-style modules elsewhere in
   `e2e/`. `global-setup.ts` itself is clean (lazy imports verified
   `e2e/global-setup.ts:83-84`), but the audit hasn't covered every
   spec/fixture file.

We don't yet have the full failing log — the CI page requires auth and
`WebFetch` only sees the public preview. First step of the C1 fix is to
grab the real log.

### 1.3 Workflow drift — RESOLVED

PR #356 (commit `b9f69cb`) updated `deploy.yml` to use
`tsconfig.build.json`. Both workflows now match `CLAUDE.md`.
`deploy.yml:18` confirms.

### 1.4 Node 20 / actions@v4 deprecation

All six workflows still pin `actions/checkout@v4`, `actions/setup-node@v4`,
`actions/upload-artifact@v4`, and `node-version: '20'`. GitHub has
scheduled the Node-20 runtime for deprecation on **2026-06-02**. ~3 weeks
out. Not failing today; will fail across the entire pipeline if untouched.

---

## 2. Fix plan

### C3 — Enforce build-config typecheck pre-push + branch protection (FIRST)

Reordered from the 2026-05-11 plan. We've spent five PRs and a week of
calendar time on a class of bug a 30-second pre-push hook would have
caught.

Two layers; do both:

1. **`.husky/pre-push`** running:
   ```
   cd packages/api && npx tsc --project tsconfig.build.json --noEmit
   cd packages/web && npx tsc --noEmit
   npm run lint
   ```
   Add `husky` as a devDep at the repo root, wire `prepare: "husky"`
   into `package.json`. Operators bypassing with `--no-verify` is fine —
   the goal is to make accidental TS-error pushes impossible, not to
   override deliberate ones.
2. **Branch protection: require `test` (and `playwright` after C1)** as
   passing checks before merge to `main`. Uses the existing CI signal,
   no client install needed.

**Done when:** a PR that drops `import { useCallback }` from a file that
uses `useCallback` cannot be pushed without `--no-verify`, and cannot be
merged via the UI.

**Files in scope:**
* `package.json` (root) — add `husky` devDep, `prepare` script
* `.husky/pre-push` — new file
* (out-of-tree) GitHub branch-protection settings

### C1 — Unblock the `playwright` job

**Step-by-step:**

1. **Capture the real failure.** Re-run `playwright` on PR 337 with
   `ACTIONS_STEP_DEBUG=true` set as a repo secret. Download the runner
   log + `playwright-report` artifact. Paste the last 200 lines into a
   follow-up comment on this plan.
2. **Make the Vite dev server boot under CI without secrets.** Soften
   `packages/web/src/main.tsx:9-13` — accept any non-empty pk for the
   smoke path (`pk_test_ci_placeholder` is fine; journey specs that need
   real Clerk already self-skip when `E2E_CLERK_SECRET_KEY` is empty),
   or render a CI-friendly fallback page instead of throwing. The
   workflow can also export
   `VITE_CLERK_PUBLISHABLE_KEY: ${{ secrets.E2E_CLERK_PUBLISHABLE_KEY || 'pk_test_ci_placeholder' }}`
   (currently line 50 has no default).
3. **Tighten the `webServer` block.** Bump `playwright.config.ts:104,112`
   timeouts from 120s to 180s on CI. `stdout: 'pipe'` is already set —
   confirm the pipe is actually dumped on `timeout`/`exit` (the current
   default behavior swallows it).
4. **Add a pre-flight smoke step in `e2e.yml`** before `npm run e2e`:
   ```yaml
   - name: Verify dev servers are reachable
     run: |
       for i in 1 2 3 4 5; do
         curl -sf http://localhost:3000/health && \
         curl -sf http://localhost:5173/ && exit 0
         sleep 5
       done
       exit 1
   ```
   Converts a silent `webServer` death into a 30-second targeted failure.
5. **Audit `e2e/**/*.ts` for top-level imports** that force ESM compile
   mode on smoke runs. `global-setup.ts` is already lazy
   (`global-setup.ts:83-84`); check the rest with
   `grep -rn "from './fixtures/" e2e/ | grep -v 'await import'`.
6. **Verify on a throwaway PR.** Confirm `playwright` reaches at least
   the `smoke.spec.ts` "1 passed, 7 skipped" exit-0 state on a runner
   with no Clerk/DB secrets.

**Done when:** `playwright` is green on at least one PR with no Clerk/DB
secrets, runtime in the 4–8 min range (not 1m 30s).

**Files in scope:**
* `.github/workflows/e2e.yml`
* `playwright.config.ts`
* `packages/web/src/main.tsx`
* (audit only) `e2e/**/*.ts`

### C4 — Bump GitHub Actions to v5 / Node 22 (before 2026-06-02)

Single search-and-replace across `.github/workflows/*.yml` (six files):

```
actions/checkout@v4         → actions/checkout@v5
actions/setup-node@v4       → actions/setup-node@v5
actions/upload-artifact@v4  → actions/upload-artifact@v5
node-version: '20'          → node-version: '22'
```

Node 22 is the real risk — changes the runtime our tests + ts-node run
under. Validate by re-running the full PR check suite on `main` after
the bump and watching for `node --env-file-if-exists` / `ts-node` /
`testcontainers` regressions.

**Done when:** all six workflows pass on `main` with Node 22 + actions@v5
**before 2026-06-02**.

**Files in scope:**
* `.github/workflows/pr-checks.yml`
* `.github/workflows/deploy.yml`
* `.github/workflows/e2e.yml`
* `.github/workflows/voice-quality-nightly.yml`
* `.github/workflows/voice-quality-pre-deploy.yml`
* `.github/workflows/voice-quality-weekly-trend.yml`

### C2 — Align `deploy.yml` typecheck with `pr-checks.yml`

✅ **Done in PR #356** (commit `b9f69cb`). `deploy.yml:18` now uses
`tsconfig.build.json`. Documented here for traceability.

---

## 3. Out of scope (flag-only)

* **Railway "unique-adaptation - @serviceos/api" / "@serviceos/web"
  deploy-preview failures** on every PR. Railway-side build errors, not
  GH Actions. They surface as PR statuses but aren't blocking merges
  (the deploy job in `deploy.yml` runs *post-merge*). Worth a separate
  investigation owned by the deployment-environment maintainer.
* **`voice-quality` check** — currently `skipped` because it
  `needs: [test]`. Will auto-recover once C1 + C3 land.
* **`voice-quality-nightly`** runs with `continue-on-error: true` because
  the runner's `pg` mode isn't implemented yet (per the VQ-008 comment).
  Tracked as a VQ-024 follow-up, not a CI-stabilization item.

---

## 4. Execution checklist

- [ ] **C3.1** — Add `husky` devDep + `prepare` script at repo root.
- [ ] **C3.2** — Add `.husky/pre-push` running api+web typecheck + lint.
- [ ] **C3.3** — Mark `test` (and `playwright` after C1) as required
      checks in branch-protection settings on `main`.
- [ ] **C1.1** — Re-run PR 337 `playwright` with `ACTIONS_STEP_DEBUG=true`;
      paste tail of log into a follow-up.
- [ ] **C1.2** — Soften `main.tsx` Clerk-key hard-throw + add workflow
      default for `VITE_CLERK_PUBLISHABLE_KEY`.
- [ ] **C1.3** — Bump `webServer.timeout` to 180s; ensure stdout is
      surfaced on failure.
- [ ] **C1.4** — Add `curl -sf` pre-flight smoke step in `e2e.yml`.
- [ ] **C1.5** — `grep` audit of top-level imports in `e2e/`.
- [ ] **C1.6** — Re-run on throwaway PR; confirm smoke green in 4–8 min.
- [ ] **C4.1** — Bump actions to @v5, node to 22 across all six workflows.
- [ ] **C4.2** — Validate full suite on `main`; do this before 2026-06-02.

---

## 5. Verification

When C1, C3, C4 are all addressed:

```
# Local
cd packages/api && npx tsc --project tsconfig.build.json --noEmit  # 0 errors
cd packages/web && npx tsc --noEmit                                 # 0 errors
npm run lint                                                        # 0 errors
git push                                                            # blocked if any of the above fail
npm test                                                            # passes
npm run e2e                                                         # smoke green (or graceful skip)

# CI on a fresh PR with no secrets
test           ✅ ~6 min
playwright     ✅ ~6 min (1 passed, 7 skipped if no Clerk secrets)
voice-quality  ✅ ~2 min
```

Until then, the operator workaround is to merge PRs by overriding
required checks one-off — but that loses the launch-gate signal
documented in `docs/superpowers/runbooks/voice-quality-launch-gate.md §4`
and should not become routine.
