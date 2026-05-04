# ServiceOS Codebase Hardening Assessment (Baseline)

## Scope and approach
- Repository-level static assessment of architecture, test surface, and operational readiness.
- Quick health checks run from the monorepo root to identify immediate blockers.
- Focused on **hardening priorities** (reliability, security posture, observability, release safety).

## What appears to be working
1. **Monorepo structure is clear**
   - `packages/api` and `packages/web` are split cleanly and supported by workspace scripts.
2. **Significant test footprint exists**
   - API and web include many unit/integration-style tests (`*.test.ts`, `*.test.tsx`) across major domains (jobs, leads, agreements, auth, settings, dispatch, etc.).
3. **Dedicated QA assets are present**
   - `qa/`, `qa-runner/`, and `e2e/` directories indicate an intended quality pipeline and smoke/doctor orchestration.
4. **Operational concerns are represented in codebase**
   - Logging, auth/rbac, queueing, telephony, public routes, and feature flags are first-class modules.

## What is not working (or currently high-risk)
1. **Typecheck is currently failing at scale**
   - Root `npm run typecheck` fails with a large number of TS errors, including unresolved module/type declarations (`express`, `pg`, `uuid`, `twilio`, etc.) and many request-shape typing failures.
   - This blocks using TypeScript as a reliable quality gate.
2. **Test command invocation hygiene is inconsistent**
   - Attempting to pass Jest-style flags (`--runInBand`) to Vitest fails immediately (`Unknown option --runInBand`).
   - This suggests scripts/docs/dev ergonomics need standardization.
3. **Potential dependency/workspace drift**
   - Broad unresolved modules during compile strongly suggests dependency installation/versioning drift, incomplete workspace dependency declarations, or stale lockfile/state assumptions.
4. **No explicit baseline hardening dashboard in repo**
   - There is not yet a central hardening scorecard tying build health, test pass rate, vuln status, SLOs, and release gates.

## Hardening plan (phased)

## Phase 0 (48 hours): Stabilize the quality gates
**Objective:** Restore a trustworthy CI signal.

- [ ] Standardize local bootstrap
  - Enforce one package manager/version (npm currently implied).
  - Add a single bootstrap command and verify all workspace deps install reproducibly.
- [ ] Fix TypeScript gate first
  - Resolve missing runtime/type dependencies in each workspace.
  - Fix global request typing mismatches (e.g., `AuthenticatedRequest` shape).
  - Add a CI-required `typecheck` job that must pass on PRs.
- [ ] Normalize test runner usage
  - Document Vitest flags and add canonical scripts (e.g., `test:api`, `test:web`, `test:watch`).

**Exit criteria:** `npm run typecheck` and workspace unit tests pass in CI from a clean checkout.

## Phase 1 (Week 1): Security and configuration hardening
**Objective:** Eliminate low-effort/high-impact security risks.

- [ ] Secrets/config hygiene
  - Inventory all env vars used by API/web.
  - Ensure `.env.example` parity with runtime requirements.
  - Add startup validation for required env vars.
- [ ] Dependency & supply-chain checks
  - Add `npm audit` (or equivalent) to CI with severity thresholds.
  - Enable automated dependency updates (grouped, scheduled).
- [ ] AuthN/AuthZ verification sweep
  - Build route-by-route authorization matrix for `packages/api/src/routes`.
  - Add tests for denied-path behavior and tenant isolation edge-cases.

**Exit criteria:** CI includes vuln + config checks; high/critical vulns triaged; key auth flows covered by tests.

## Phase 2 (Week 2): Reliability, observability, and failure containment
**Objective:** Improve runtime resilience under real-world failure modes.

- [ ] Error-handling standards
  - Define consistent error contract and sanitization strategy across API/public routes.
- [ ] Queue and background-job resilience
  - Add retry, dead-letter, idempotency, and backoff verification tests for queue flows.
- [ ] Telemetry baseline
  - Ensure request IDs, structured logs, and key business events are emitted consistently.
  - Define golden signals (latency, error rate, saturation, queue depth).
- [ ] SLO and alert seed set
  - Define initial SLOs for API and critical async paths with actionable alerts.

**Exit criteria:** Runbook-ready telemetry and tested recovery behavior for at least top 3 critical workflows.

## Phase 3 (Week 3+): Release hardening and regression prevention
**Objective:** Reduce deployment risk and increase change confidence.

- [ ] Progressive delivery controls
  - Expand feature-flag rollout patterns and rollback playbooks.
- [ ] Contract and integration tests
  - Add API contract tests for critical public/internal endpoints.
  - Expand e2e smoke coverage for login → job flow → payment/invoice critical path.
- [ ] Quality scorecard
  - Publish a weekly hardening dashboard: typecheck status, test pass %, vuln count, MTTR, incident count.

**Exit criteria:** PRs are gated on quality/security checks and releases have measurable rollback safety.

## Suggested owners and cadence
- **Engineering Lead:** Overall program owner; weekly hardening review.
- **API owner:** Authz matrix, route tests, error contracts.
- **Platform/DevEx owner:** CI gates, dependency policy, bootstrap reliability.
- **SRE/Ops owner (or equivalent):** SLOs, alerts, runbooks.

## Immediate next actions (this week)
1. Fix dependency/typecheck baseline so CI can fail fast for real regressions.
2. Lock and document canonical test commands per workspace.
3. Create hardening issue board using the phase checklist above (P0/P1/P2 labels).
4. Add a single `hardening-status.md` tracker in-repo and update weekly.
