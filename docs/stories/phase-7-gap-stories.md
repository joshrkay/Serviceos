# Phase 7 — Integrations + Beta Hardening: Launch Readiness Gaps

> **7 stories** | Continues from P7-018

---

## Purpose

Phase 7's original 18 stories (P7-001 through P7-018) cover Twilio, Stripe, QuickBooks integrations and beta hardening. Most are not yet started and remain as-is in `phase-7-stories.md`. The stories below cover **additional** gaps not addressed by the original stories: E2E testing, production hardening, dependency cleanup, and operational readiness.

## Exit Criteria

Critical user journeys validated by E2E tests; no known vulnerable dependencies; unused libraries removed; rollback procedure documented and tested; production deployment verified end-to-end.

## Note on Original P7 Stories

The following original Phase 7 stories (P7-001 through P7-018) are **entirely unbuilt** and still need implementation as specified in `phase-7-stories.md`:

| Status | Stories |
|--------|---------|
| **Not started** | P7-001 through P7-004 (Twilio SMS) |
| **Partially built** | P7-005, P7-006 (Stripe — backend webhook handler exists, payment link provider exists) |
| **Not started** | P7-007 through P7-010 (QuickBooks) |
| **Not started** | P7-011 through P7-014 (Support tooling / diagnostics) |
| **Not started** | P7-015, P7-016 (Beta feature flags / degraded mode) |
| **Not started** | P7-017 (Backup/export/recovery) |
| **Not started** | P7-018 (Launch readiness checklist) |

---

## Additional Gap Stories

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P7-019 | E2E test suite for critical user journeys | M | Testing | Medium | Heavy | P0-023, P0-029, P0-030 |
| P7-020 | Dependency audit and vulnerability fixes | S | DevOps | High | Light | None |
| P7-021 | Remove or integrate unused frontend libraries | XS | Cleanup | High | Light | None |
| P7-022 | Rollback documentation and runbook | S | Operations | High | Moderate | P7-017 |
| P7-023 | Production smoke test script | S | Operations | High | Moderate | P0-023, P0-029 |
| P7-024 | Fix `as any` type escapes | XS | Code Quality | High | Light | None |
| P7-025 | Load test with realistic data | S | Performance | Medium | Moderate | P0-023, P0-024 |

---

## Story Specifications

### P7-019 — E2E test suite for critical user journeys

> **Size:** M | **Layer:** Testing | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P0-023, P0-029, P0-030

**Allowed files:** `packages/web/e2e/**, playwright.config.ts, package.json`

**Build prompt:** Install Playwright and create E2E tests for the critical user journeys. The codebase has 152 API test files and 53 web component test files but zero E2E tests. Create tests for: (1) **Signup flow:** Sign up via Clerk → tenant bootstrapped → redirected to onboarding → complete onboarding → land on dashboard. (2) **Customer + estimate flow:** Create customer → create job → draft estimate → review → send to customer → customer approves via public page. (3) **Invoice + payment flow:** Create invoice from estimate → send → customer pays via Stripe (test mode) → invoice status updates to paid. (4) **Dispatch flow:** View dispatch board → drag appointment to different technician → proposal created → approve → board refreshes. (5) **Voice flow:** Record voice note → transcript appears → proposal generated. Configure Playwright to run against a local API with test database. Add to CI pipeline as a separate job.

**Review prompt:** Verify tests cover the 5 critical journeys listed. Verify tests use Playwright best practices (locators, not selectors; auto-waiting). Verify test database is seeded and cleaned between runs. Verify tests work in CI (headless mode). Check that Stripe test mode is used (not real charges). Check that Clerk test mode is used (not real signups).

**Automated checks:**
```bash
npx playwright test
```

**Required tests:**
- [ ] Signup → onboarding → dashboard
- [ ] Create customer → create estimate → send → customer approves
- [ ] Create invoice → send → customer pays → status updates
- [ ] Dispatch drag-and-drop → proposal → approve → refresh
- [ ] Voice record → transcript → proposal generated
- [ ] Auth guard — unauthenticated user redirected to login
- [ ] Public pages — estimate approval accessible without auth

---

### P7-020 — Dependency audit and vulnerability fixes

> **Size:** S | **Layer:** DevOps | **AI Build:** High | **Human Review:** Light

**Dependencies:** None

**Allowed files:** `package.json, package-lock.json, packages/api/package.json, packages/web/package.json`

**Build prompt:** Run `npm audit` across all packages and fix vulnerabilities. Known issues from assessment: deprecated `glob` (security vulnerabilities), deprecated `async` (memory leaks), outdated `superagent`. Steps: (1) Run `npm audit` and document all findings. (2) Run `npm audit fix` for automatic fixes. (3) For remaining vulnerabilities, update transitive dependencies or find alternatives. (4) Pin resolved dependency versions. (5) Add `npm audit` check to CI pipeline (fail on high/critical vulnerabilities).

**Review prompt:** Verify no high or critical vulnerabilities remain. Verify `npm audit fix` didn't break any functionality. Verify CI pipeline includes audit check. Check that pinned versions don't conflict with other dependencies.

**Automated checks:**
```bash
npm audit --audit-level=high
npx tsc --noEmit
npm test
```

**Required tests:**
- [ ] No high/critical vulnerabilities in `npm audit`
- [ ] All existing tests still pass after dependency updates
- [ ] TypeScript compilation succeeds
- [ ] CI audit check configured

---

### P7-021 — Remove or integrate unused frontend libraries

> **Size:** XS | **Layer:** Cleanup | **AI Build:** High | **Human Review:** Light

**Dependencies:** None

**Allowed files:** `packages/web/package.json, packages/web/src/**`

**Build prompt:** Two libraries are installed but never imported: (1) `react-hook-form` — all forms use manual `useState`. Either remove it or migrate one form to use it (Settings page is a good candidate). (2) `recharts` — no charts exist in the UI. Either remove it or add a chart to the dashboard HomePage (estimate/invoice metrics). Decision: remove both unless there's a clear near-term use. This reduces bundle size. Run `npx depcheck` to find any other unused dependencies.

**Review prompt:** Verify removed libraries are not imported anywhere. Verify bundle size decreased. Verify no other unused dependencies remain. Check that removing them doesn't break any test mocks.

**Automated checks:**
```bash
npx tsc --noEmit
npm test
npx depcheck packages/web
```

**Required tests:**
- [ ] Build succeeds without removed packages
- [ ] All tests pass
- [ ] No import references to removed packages

---

### P7-022 — Rollback documentation and runbook

> **Size:** S | **Layer:** Operations | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P7-017

**Allowed files:** `docs/runbooks/**, docs/deployment.md`

**Build prompt:** Create an operational runbook documenting: (1) **Rollback procedure:** How to revert a bad deployment on Railway (git revert + push → auto-deploy, or Railway CLI rollback). (2) **Database rollback:** How to run reverse migrations, or restore from backup. (3) **Incident response:** Steps for common failure modes (database connection lost, Clerk outage, Stripe webhook failures, AI gateway timeout). (4) **Health checks:** What to monitor and how to interpret `/health` endpoint responses. (5) **Environment variable reference:** Complete list of required and optional vars with descriptions. (6) **Contact escalation:** Who to contact for infrastructure issues.

**Review prompt:** Verify rollback procedure is tested (not just theoretical). Verify database rollback steps are correct. Verify all environment variables are documented. Verify health check interpretation is clear. Check that the runbook is accessible to on-call engineers.

**Automated checks:**
```bash
# Documentation review — no automated checks, human review only
ls docs/runbooks/
```

**Required tests:**
- [ ] Rollback procedure tested in staging
- [ ] Database restore tested from backup
- [ ] All env vars documented with descriptions
- [ ] Health check responses documented

---

### P7-023 — Production smoke test script

> **Size:** S | **Layer:** Operations | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-023, P0-029

**Allowed files:** `scripts/smoke-test.sh, scripts/smoke-test.ts`

**Build prompt:** Create an automated smoke test script that verifies a deployment is healthy. The script should: (1) Hit `/health` and verify database connectivity. (2) Attempt sign-in via Clerk API (test user). (3) Create a customer via API. (4) List customers and verify the new one appears. (5) Delete the test customer (cleanup). (6) Verify the estimate approval public page loads (`/e/test`). (7) Verify the payment page loads (`/pay/test`). (8) Report pass/fail with clear output. This script should be runnable against any environment (dev, staging, prod) via `npm run smoke-test -- --env staging`.

**Review prompt:** Verify the script cleans up after itself (no test data left behind). Verify it works against all environments. Verify it exits with non-zero on failure. Verify test user credentials are not hardcoded (use env vars). Check that the script is idempotent (can run repeatedly).

**Automated checks:**
```bash
npm run smoke-test -- --env dev
```

**Required tests:**
- [ ] Health check passes
- [ ] Auth works (Clerk test user)
- [ ] CRUD works (create + list + delete customer)
- [ ] Public pages load
- [ ] Cleanup — no test data left behind
- [ ] Failure reporting — clear output on failure

---

### P7-024 — Fix `as any` type escapes

> **Size:** XS | **Layer:** Code Quality | **AI Build:** High | **Human Review:** Light

**Dependencies:** None

**Allowed files:** `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts, packages/api/src/verticals/registry.ts, packages/api/src/proposals/execution/reschedule-handler.ts, packages/api/src/routes/notes.ts, packages/api/src/routes/jobs.ts`

**Build prompt:** Fix the 8 `as any` type escapes identified in the assessment: (1) `packages/web/src/components/dispatch/useCreateScheduleProposal.test.ts` — 4 instances, likely test mocks that need proper typing. (2) `packages/api/src/verticals/registry.ts:45` — vertical config type mismatch. (3) `packages/api/src/proposals/execution/reschedule-handler.ts` — proposal payload typing. (4) `packages/api/src/routes/notes.ts` — request body typing. (5) `packages/api/src/routes/jobs.ts` — request body typing. Replace each `as any` with the correct type, using Zod inferred types where available.

**Review prompt:** Verify all 8 `as any` instances are removed. Verify the replacement types are correct (not just `as unknown`). Verify TypeScript compilation still passes with strict mode. Check that test behavior is unchanged.

**Automated checks:**
```bash
npx tsc --noEmit
npm test
grep -r "as any" packages/api/src/ packages/web/src/ | grep -v node_modules | grep -v ".d.ts" | wc -l  # Should be 0
```

**Required tests:**
- [ ] TypeScript compiles with no errors
- [ ] All existing tests pass
- [ ] Zero `as any` instances in source code

---

### P7-025 — Load test with realistic data

> **Size:** S | **Layer:** Performance | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P0-023, P0-024

**Allowed files:** `scripts/load-test/**, packages/api/src/db/**`

**Build prompt:** Create a load test script that simulates realistic beta usage: (1) Seed a test tenant with realistic data: 500 customers, 1000 jobs, 2000 estimates, 500 invoices, 200 appointments. (2) Simulate 50 concurrent users performing: list/search customers, view job details, create estimates, approve proposals, view dispatch board. (3) Measure response times (p50, p95, p99) and error rates. (4) Identify slow queries and add indexes if needed. (5) Document the results and any performance optimizations applied. Use k6, Artillery, or a simple Node.js script with concurrent fetch calls.

**Review prompt:** Verify the test data is realistic (not just empty records). Verify 50 concurrent users is achievable without errors. Verify response times are acceptable (p95 < 500ms for list endpoints, p95 < 200ms for detail endpoints). Verify RLS doesn't create performance bottlenecks. Check that the test cleans up seeded data or uses a separate database.

**Automated checks:**
```bash
npm run load-test -- --env staging
```

**Required tests:**
- [ ] 50 concurrent users — no 500 errors
- [ ] p95 response time < 500ms for list endpoints
- [ ] p95 response time < 200ms for detail endpoints
- [ ] RLS overhead < 10ms per query
- [ ] No connection pool exhaustion
- [ ] Dispatch board query < 1s with 200 appointments
