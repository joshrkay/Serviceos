# CI Gating Matrix — Launch Baseline

**Last verified:** 2026-07-12 (QUALITY-2026-07-12)  
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
| Voice quality Layer 1 | `pr-checks.yml`, `voice-quality-nightly.yml`, `deploy.yml` | `npm run voice-quality` with `VOICE_QUALITY_ENFORCE_LAUNCH_GATE=true` (merge step exits non-zero on any launch-gate blocker); on deploy it blocks both Railway jobs |
| Voice quality Layer 2 (LLM judge) | `voice-quality-pre-deploy.yml` | Push to `release/*`; hard-fails when `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` absent |
| FK-path coverage guard | `pr-checks.yml` | `scripts/check-fk-path-coverage.sh` |
| Mobile typecheck | `pr-checks.yml` | `mobile-typecheck` job — root + mobile `npm ci`, then `tsc --noEmit` |
| Mobile unit tests (vitest) | `pr-checks.yml` | `npx vitest run --root packages/mobile` (RN jest-expo suite intentionally ungated — needs a scoped jest.config first) |
| Playwright job | `e2e.yml` | `npm run e2e` — **job** must pass |
| Owner-loop + voice smoke | `deploy.yml` only | `owner-loop-critical-path`, `voice-smoke.synthetic` (duplicate owner-loop step removed 2026-07-12) |
| Migration dry-run | `deploy.yml` only | `npm run migrate:dryrun` |
| Post-deploy health + smoke | `deploy.yml` only | `scripts/ci/wait-for-healthy.sh` + `npm run smoke-test` against `DEV_/PROD_HEALTHCHECK_URL`; missing URL secrets hard-fail (no false green) |

Per-module coverage (`check-coverage.ts`) is **gating** — there is no `continue-on-error` on PR checks.

## Advisory / nightly-only

| Suite | Workflow | Notes |
|-------|----------|-------|
| Voice quality weekly trend | `voice-quality-weekly-trend.yml` | Alerting steps advisory |
| QA matrix gate | `qa-matrix-gate.yml` | Nightly/dispatch; hard-fails early when any of its 11 `E2E_*` secrets are absent (no false green) |
| Real-call voice smoke | `voice-smoke-real.yml` | Scheduled/dispatch; hard-fails when Twilio/staging secrets absent |
| Redis multi-instance correctness | `redis-multi-instance.yml` | Weekly/dispatch; the gate for `numReplicas > 1` — runs the two-instance quota/fan-out/presence/connection-cap suites against a real Redis |
| Onboarding integration (E2E workflow) | `e2e.yml` | Skips with exit 0 when `E2E_CLERK_SECRET_KEY` unset (annotated with an explicit `::warning::`) |

See `docs/launch/secret-manifest.md` for the full per-workflow secret table
and which gates are hard operational blockers without credentials.

## E2E decision (launch)

**Selected: Option B — smoke-only until Clerk secrets are wired.**

Without GitHub secrets `E2E_CLERK_PUBLISHABLE_KEY` and `E2E_CLERK_SECRET_KEY`:

- `e2e.yml` stays **green** (job passes).
- Only `e2e/smoke.spec.ts` API health check runs reliably (~1 test).
- Journey specs self-skip via `hasClerkTestingCreds()` in `e2e/helpers/clerk-testing.ts`.
- `invoice-to-payment.spec.ts` and `estimate-approval-execution.spec.ts` are permanently `test.skip` until implemented.

**To upgrade to Option A (full journeys):** add both Clerk secrets to GitHub repo settings. See `qa/reports/2026-05-11/clerk-testing-tokens-runbook.md`. Optionally set `E2E_DATABASE_URL` for BYO Postgres instead of ephemeral testcontainers in E2E global setup.

## Voice quality: nightly Layer 1 (pg mode removed)

The nightly `voice-quality-nightly.yml` previously advertised a `VOICE_QUALITY_REPO=pg`
run against a Postgres service, gated behind `continue-on-error: true`. That
run was decorative: the runner's `pg` mode was a throwing stub, so the corpus
never actually executed against Postgres — the step errored and was ignored.

QUALITY-2026-07-12 WS1 removed the fake `pg` option. Layer 1 is memory-only by
design: the LLM is mocked via deterministic cassettes, and the harness driver
reads several repos (owner-approval settings, catalog, on-call, DNC) that the
runner's `RepoBundle` does not own — so a partial-Pg bundle would be a
misleading DB signal, not a faithful one. The nightly now runs the same
memory-mode Layer-1 corpus as PR CI, with the launch gate **enforced**
(`VOICE_QUALITY_ENFORCE_LAUNCH_GATE=true`) and **no** `continue-on-error`, so a
regression reddens it. A true DB-backed Layer-1 harness (real Pg repos +
migrations + RLS runtime role) is tracked as future work, not faked in CI.

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
