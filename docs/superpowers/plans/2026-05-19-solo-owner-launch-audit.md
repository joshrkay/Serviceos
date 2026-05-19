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
| Lead-capture corpus comment | `test/voice-quality/corpus/03-lead-capture.test.ts` | **PASS** | `c86b33ad` — stale P17-001 comment updated |
| Invoice delivery prod fail-fast | `test/proposals/execution/invoice-delivery-boot.test.ts` | **PASS** | `da3d085b` — `resolveInvoiceDeliveryProvider` throws in prod/staging without SendService |
| Onboarding v2 env default | `.env.example` | **PASS** | `8ef2b704` — `VITE_ONBOARDING_V2_ENABLED=true` |
| Sound-human tests | Phase 3 vitest (32 tests) | **PASS** | `ac6bf9a5` |
| Onboarding E2E (code) | `e2e/journeys/onboarding-v2.spec.ts` | **PASS** | `8ef2b704` — run Playwright with Clerk creds |
| Launch runbook | `solo-owner-public-launch.md` | **PASS** | `2e8c8cee` |
| Onboarding v2 in prod deploy | Railway/Vercel build env | **PENDING** | ops |
| Voice quality full gate | All 40 scripts + cassettes | **PENDING** | Phase 2 — partial worker run passed 10/10 mock corpus |

## Gaps for launch (ordered)

1. Phase 2 — record cassettes + full corpus `launchGate.pass` + human sign-off  
2. Ops — set production env vars (see [solo-owner-public-launch.md](../runbooks/solo-owner-public-launch.md))  
3. Manual — TTFA spot-check; Playwright journey with Clerk creds  

## Human sign-off

| Gate | Approver | Date |
|------|----------|------|
| Voice quality Layer 1 | | |
| Public launch go | | |
