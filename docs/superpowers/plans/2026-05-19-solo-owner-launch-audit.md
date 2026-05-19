# Solo Owner Launch — Baseline Audit

**Date:** 2026-05-19  
**Branch:** `cursor/solo-owner-launch-design-2e07`  
**Plan:** [2026-05-19-solo-owner-launch.md](./2026-05-19-solo-owner-launch.md)

## Automated checks

| Check | Command / file | Status | Notes |
|-------|----------------|--------|-------|
| Production TypeScript build | `npx tsc --project tsconfig.build.json --noEmit` | **PASS** | exit 0 |
| create_customer persists | `test/proposals/execution/create-customer-handler.test.ts` | **PASS** | 11 tests |
| P18-001 classifier + task | `test/ai/tasks/create-customer-task.test.ts` | **PASS** | 24 tests incl. AST-01 block |
| Idempotency guard unit tests | `test/proposals/execution-idempotency.test.ts` | **PASS** | 8 tests |
| Executor + idempotency wiring | `test/proposals/executor-onexecuted.test.ts` | **PASS** | 5 tests |
| Sound-human streaming TTS | `mediastream-adapter.ts` `synthesizeStream` | **PASS** | present |
| Filler engine | `mediastream-adapter.ts` `runTurnWithFiller` | **PASS** | present |
| app.ts production wiring | grep `CreateCustomerVoiceExecutionHandler`, `proposalIdempotencyGuard`, `PgAssignmentRepository` | **PASS** | lines ~878, 1309, 1315 |
| Onboarding status API | `test/integration/onboarding-status.test.ts` | **PENDING** | excluded from default vitest `include`; run in integration CI |
| Voice quality launch gate | Layer 1 corpus | **PENDING** | Phase 2 — cassettes need recording |
| Invoice delivery prod fail-fast | `resolveInvoiceDeliveryProvider` | **PENDING** | Phase 1 Task 1.2 |
| Onboarding v2 flag in prod | `VITE_ONBOARDING_V2_ENABLED` | **PENDING** | Phase 4 — still `false` in `.env.example` |

## Gaps for launch (ordered)

1. Phase 1.2 — prod/staging boot fail-fast when SendService missing  
2. Phase 2 — record cassettes + `launchGate.pass` + human sign-off  
3. Phase 3 — sound-human test suite + deployment env docs  
4. Phase 4 — enable onboarding v2 default + E2E extension  
5. Phase 5 — public launch runbook + final checklist  

## Human sign-off

| Gate | Approver | Date |
|------|----------|------|
| Voice quality Layer 1 | | |
| Public launch go | | |
