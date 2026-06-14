# CI Gating Matrix — Launch Baseline

**Last verified:** 2026-06-12 on `main` @ `ca31e29b`  
**Purpose:** Single source of truth for which CI suites block merge vs run advisory.

## Gating (must pass to merge)

| Suite | Workflow | Command / step |
|-------|----------|----------------|
| API production typecheck | `pr-checks.yml`, `deploy.yml` | `npx tsc --project tsconfig.build.json --noEmit` |
| Web typecheck | `pr-checks.yml`, `deploy.yml` | `npx tsc --noEmit` (packages/web) |
| Lint | `pr-checks.yml`, `deploy.yml` | `npm run lint` |
| AI gateway guard | `pr-checks.yml` | `npm run check:ai-gateway-guard` |
| Unit tests | `pr-checks.yml`, `deploy.yml` | `npm test` |
| API integration (testcontainers) | `pr-checks.yml`, `deploy.yml` | `npm run test:integration` — image `pgvector/pgvector:pg16` |
| Coverage + per-module thresholds | `pr-checks.yml`, `deploy.yml` | `npm run test:coverage` + `scripts/check-coverage.ts` |
| Voice quality Layer 1 | `pr-checks.yml` | `npm run voice-quality` |
| Playwright job | `e2e.yml` | `npm run e2e` — **job** must pass |
| Owner-loop + voice smoke | `deploy.yml` only | `owner-loop-critical-path`, `voice-smoke.synthetic` |
| Migration dry-run | `deploy.yml` only | `npm run migrate:dryrun` |

Per-module coverage (`check-coverage.ts`) is **gating** — there is no `continue-on-error` on PR checks.

## Advisory / nightly-only

| Suite | Workflow | Notes |
|-------|----------|-------|
| Voice quality pg nightly | `voice-quality-nightly.yml` | `continue-on-error: true` until pg mode lands |
| Voice quality weekly trend | `voice-quality-weekly-trend.yml` | Alerting steps advisory |
| QA matrix gate | `qa-matrix-gate.yml` | Gating within nightly workflow; requires 11 GitHub secrets |
| Onboarding integration (E2E workflow) | `e2e.yml` | Skips with exit 0 when `E2E_CLERK_SECRET_KEY` unset |

## E2E decision (launch)

**Selected: Option B — smoke-only until Clerk secrets are wired.**

Without GitHub secrets `E2E_CLERK_PUBLISHABLE_KEY` and `E2E_CLERK_SECRET_KEY`:

- `e2e.yml` stays **green** (job passes).
- Only `e2e/smoke.spec.ts` API health check runs reliably (~1 test).
- Journey specs self-skip via `hasClerkTestingCreds()` in `e2e/helpers/clerk-testing.ts`.
- `invoice-to-payment.spec.ts` and `estimate-approval-execution.spec.ts` are permanently `test.skip` until implemented.

**To upgrade to Option A (full journeys):** add both Clerk secrets to GitHub repo settings. See `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`. Optionally set `E2E_DATABASE_URL` for BYO Postgres instead of ephemeral testcontainers in E2E global setup.

## Docker / integration reliability

Integration tests pull `pgvector/pgvector:pg16` via testcontainers (`packages/api/test/integration/global-setup.ts`). CI workflows pre-pull this image before `npm run test:integration` to reduce flake from cold pulls.

## Local reproduction checklist

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/web && npx tsc --noEmit
npm run lint
npm test
cd packages/api && npm run test:integration   # requires Docker
npm run test:coverage
cd packages/api && npx ts-node scripts/check-coverage.ts
cd packages/api && npm run voice-quality
```
