# Web / e2e make-it-work pass — 2026-09-17

Branch: `albert/claude-fable-buildout`. Scope: `packages/web`, Playwright, `e2e/`,
release verification.

**Outcome: no source changes were needed.** Every web/e2e gate that can run on
a laptop without secrets or Docker is green on this branch as-is. The only
failures hit during the pass were environmental (missing Playwright browser
binary, un-built `packages/shared`), not code defects. This file is the only
change in the PR.

## What works (verified this pass)

| Gate | Command | Result |
|---|---|---|
| Shared build | `npm run build --workspace=packages/shared` | pass |
| Web typecheck | `npm run typecheck:web` | pass, 0 errors |
| Web production build | `npm run build --workspace=packages/web` | pass (`tsc --noEmit && vite build`) |
| Web unit tests | `npm run test --workspace=packages/web` | 296 files, 2161 tests, all pass |
| API build typecheck (mandatory pre-push) | `npm run typecheck:api` | pass, 0 errors |
| Default Playwright suite (what `e2e.yml` runs) | `npm run e2e` | **62 passed, 0 failed, 0 flaky, 191 skipped** (2.0 min) |
| Release policy unit tests | `node --test scripts/release/*.test.mjs` | 3/3 pass |
| Web security-header contract | `npm run test:web-security-headers` | pass |

Breakdown of the 62 e2e passes: 24 in `chromium` (hermetic smoke, money-loop,
no-401-storm, render-stability, public pages, hermetic Journey-1
signup → tenant → first estimate), 37 in `chromium-devauth` (the mobile /
auth-gated specs against the dev test-auth stack), 1 `devauth-setup` seed.

Environment used: macOS arm64, Node v22.22.3 (repo pins `^20.20.0` via
`.nvmrc`; npm prints `EBADENGINE` but everything passed — CI uses 20.20.2),
Playwright 1.63.0 / chromium-headless-shell build 1243.

## How to verify

```bash
npm ci
npm run build --workspace=packages/shared   # see gotcha 1 below
npm run typecheck:web
npm run build --workspace=packages/web
npm run test --workspace=packages/web
npm run typecheck:api
npx playwright install chromium --only-shell   # ~200 MB; see gotcha 2
npm run e2e
```

If other worktrees/agents on the same machine may be running e2e at the same
time, isolate the ports — with `reuseExistingServer` on (non-CI) Playwright
will otherwise adopt a foreign vite/api on 5173/3000 that proxies to the
wrong checkout. This is the exact invocation used for the green run:

```bash
PORT=3100 E2E_API_URL=http://localhost:3100 VITE_API_URL=http://localhost:3100 \
E2E_WEB_PORT=5273 \
E2E_DEVAUTH_WEB_PORT=5274 E2E_DEVAUTH_API_PORT=3101 \
E2E_NOAUTHBYPASS_WEB_PORT=5275 E2E_NOAUTHBYPASS_API_PORT=3102 \
E2E_WEBSERVER_TIMEOUT_MS=240000 \
npx playwright test --reporter=list
```

### Gotchas hit during this pass

1. **`packages/shared/dist` can be missing after `npm ci`.** Web typecheck
   then fails with ~100 `TS2307 Cannot find module '@ai-service-os/shared'`
   plus knock-on `TS7006` implicit-any errors. `dist` is git-ignored and is
   built by the shared package's `prepare` script, which ends in `|| true`, so
   a failed build is silent. Observed once on the first install (disk had
   <1 GB free at the time); a second `npm ci` built it. Not reproduced, root
   cause not confirmed. Fix when it happens:
   `npm run build --workspace=packages/shared`.
2. **Playwright browser cache disappeared mid-session.**
   `~/Library/Caches/ms-playwright` (chromium 1243) existed at the start and
   was gone minutes later — removed by something outside this session, most
   likely another process freeing disk. Symptom: 61 specs fail in ~1 ms with
   `browserType.launch: Executable doesn't exist ... chrome-headless-shell`.
   Reinstalling the headless shell fixed all 61; none were app failures.
3. **Disk is ~100% full on this machine** (≈1 GB free of 228 GB). The bulk is
   model weights: `~/.lmstudio` 39 GB, `~/.ollama` 30 GB,
   `~/.cache/huggingface` 22 GB. Nothing was deleted by this pass. One
   `npm ci` died with `ENOSPC` before succeeding on retry. This is the
   blocker for the Docker-backed lane below.

## Remaining UI / e2e gaps

None of these are failures — they are coverage that **did not run** here. A
green `npm run e2e` without them is CI's "Option B" (smoke + hermetic
Journey-1 + dev-auth) and does not prove the full journeys.

1. **Docker-backed real-Postgres lane — not run (~125 of the 191 skips).**
   All `e2e/journeys/*` "real Postgres" specs (estimates 7.x, invoices/money
   8.x, dispatch 3.x, public booking/pay/approve, reviews 9.x, toggles), all
   `e2e/telephony-*` specs (also need `TENANT_ENCRYPTION_KEY`), and the whole
   `chromium-noauthbypass` project (technician day view, on-my-way,
   running-late, assignment notification — issue #1086) self-skip unless
   `E2E_USE_TEST_DB=true` with a migrated Postgres. Locally that means the
   `pgvector/pgvector:pg16` testcontainer, which needs Docker (Colima here,
   default profile stopped). Deliberately **not started**: with ~1 GB free, a
   VM boot plus image pull risked filling the disk for every other job on the
   machine. To run once disk is freed:
   ```bash
   colima start
   E2E_USE_TEST_DB=true npm run e2e
   ```
   The same lane is what `onboarding-database.yml` and `pr-checks.yml`
   (integration tests) exercise in CI.
2. **Release verification gate — not run.** `playwright.release.config.ts` /
   `release-verification.yml` performs a real signup + first draft estimate
   against the deployed Development environment
   (`serviceosweb-development.up.railway.app`). It hard-requires real Clerk
   development keys (`E2E_CLERK_PUBLISHABLE_KEY=pk_test_…`,
   `E2E_CLERK_SECRET_KEY=sk_test_…`, loaded in CI via `RAILWAY_TOKEN`) and
   mutates a live environment, so it is `workflow_dispatch`-only and was not
   attempted. Only its offline policy tests were run (3/3 pass). To run:
   trigger the "Release verification" workflow, or export the two keys and run
   `npx playwright test --config playwright.release.config.ts` followed by
   `node scripts/release/verify.mjs test-results/release-results.json`.
3. **Real-Clerk journey specs — skipped (~25).** `journeys/onboarding-v2*`,
   `journeys/signup-to-first-estimate.spec.ts`, `journeys/accept-invitation`,
   `onboarding-*-mobile`, `technician-phone-mobile`, and the 4 UI tests in
   `smoke.spec.ts` need `E2E_CLERK_*` testing-token creds (and
   `VITE_ONBOARDING_V2_ENABLED=true`). Same secrets as gap 2; adding them as
   repo secrets upgrades `e2e.yml` to "Option A".
4. **Expected duplicate skips (39), not a gap.** The eight `*-mobile` specs
   skip under `chromium` by design and run for real under `chromium-devauth`
   (where they passed).
5. **Two dev-auth tap-target tests never execute.** In `chromium-devauth`,
   `technician-day-mobile.spec.ts` "appointment card … ≥44px glove target" and
   "technician job-detail (view=tech) fits 320px" skip at runtime because no
   appointment card renders on `/technician/day`. The seed
   (`packages/api/scripts/verify-seed.mjs`) does create an appointment for
   today, so the likely cause is that it is not assigned to the dev-auth
   user's technician profile — **not investigated, cause unconfirmed.** Net
   effect: that mobile tap-target contract has no running Playwright proof in
   the default suite.
6. **Opt-in projects not run:** `qa-matrix` (`QA_MATRIX=1`, needs a seeded
   real backend), `coverage-sweep` (`COVERAGE_SWEEP=1`), `ui-flow`
   (`UI_FLOW=1`).
7. **ESLint backlog, not a gate.** `npx eslint packages/web e2e` reports 410
   errors / 902 warnings. `npm run lint` is `tsc --noEmit` and CI does not
   run ESLint (see the note in `pr-checks.yml`), so this was left alone.
8. **Node version drift.** Local verification ran on Node 22, CI on 20.20.2.
   No Node 20 was available on this machine.
