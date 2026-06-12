# PR Review Operating Plan

Use this plan for large or high-risk PRs that need a deliberately adversarial review. The goal is to produce a reproducible review range, focus effort on the riskiest changes first, and leave the author with severity-ranked findings plus explicit residual risk.

## Phase 0: Establish the Review Range

Do not start the substantive review until the exact comparison range is known.

1. Confirm the target base branch or SHA with the PR metadata.
2. Record the head SHA, base SHA, and merge-base SHA.
3. Generate the diff inventory and commit list.
4. Identify generated files, lockfiles, vendored assets, snapshots, migrations, and test-only changes.

Suggested commands:

```bash
git merge-base <base> HEAD
git log --oneline <base>..HEAD
git diff --stat <base>...HEAD
git diff --name-status <base>...HEAD
git diff --find-renames <base>...HEAD
```

Capture the review range in the review notes:

```md
Review range:
- Base:
- Head:
- Merge base:
- Commit count:
- Files changed:
- Lines added:
- Lines removed:
```

## Phase 1: Fast Validation

Run cheap checks before deep inspection so obvious failures are surfaced early. Use the touched-file inventory to decide which targeted checks are required.

Always consider:

```bash
npm run lint
npm run typecheck
npm test
```

Run API checks when backend, database, auth, webhook, provider, or shared contract code changed:

```bash
npm run test --workspace=packages/api
npm run test:integration
npm run test:rls
npm run migrate:dryrun
```

Run web checks when UI, routing, settings, forms, browser env, or shared contract consumers changed:

```bash
npm run test --workspace=packages/web
npm run build --workspace=packages/web
```

Run webhook/provider checks when external inbound events or telephony/payment flows changed:

```bash
npm run test:webhooks
```

Run corpus and voice-eval checks when prompts, voice orchestration, intent classification, slot extraction, corpus data, triage rules, transcripts, or eval thresholds changed:

```bash
npm run corpus:verify
npm run voice-eval:intent
npm run voice-eval:slot
```

If browser-visible UI changed, run the relevant app flow and capture screenshots for the review artifact.

## Phase 2: Build the Changed-File Risk Map

Before reading files linearly, classify each changed area and assign a risk score from 1 to 5. Spend the most review time where user impact, data risk, security risk, operational risk, complexity, and low test confidence overlap.

| Dimension | Review question |
| --- | --- |
| User impact | Can this break a core customer workflow? |
| Data risk | Can this corrupt, expose, delete, duplicate, or mis-associate data? |
| Security risk | Can this bypass auth, tenant boundaries, signatures, or secret handling? |
| Operational risk | Can this fail during deploy, migration, background work, provider outage, or rollback? |
| Test confidence | Are there meaningful tests for the actual behavior and negative paths? |
| Complexity | Is the change spread across layers or hard to reason about? |

Recommended artifact:

```md
| Area | Files | Runtime path? | Risk | Tests found | Manual review needed? | Reason |
| --- | ---: | --- | ---: | --- | --- | --- |
| API billing changes | 8 | Yes | 5 | test/... | Yes | Payment/customer data + provider side effects |
| Settings copy update | 2 | Yes | 1 | component test | Light | Low data/security impact |
```

## Phase 3: Blocker Hunt

Review the highest-risk categories first. A blocker is anything that should prevent merge unless explicitly remediated before release.

Blocker examples:

- Cross-tenant data access or missing tenant scope.
- Auth or role bypass.
- PII, secrets, transcripts, customer data, payment details, or provider payloads leaked to logs or browser bundles.
- Failed build, typecheck, migration, or required security test.
- Non-idempotent payment, webhook, queue, or background side effect.
- New required environment variable that is undocumented or not validated.
- Breaking API contract between web, API, shared package, external provider, or database.

High severity examples:

- Missing negative tests for high-risk behavior.
- Race condition or time-of-check/time-of-use bug.
- Operational behavior that cannot be rolled back cleanly.
- User flow broken under common failure states.

Medium and low severity findings should still be captured, but they should not distract from blocker discovery.

## Phase 4: Tenant Isolation Gate

Any backend, data, report, webhook, job, search, settings, billing, scheduling, or customer-facing change must answer these questions:

- Where does the tenant identifier come from?
- Is tenant scope derived from authenticated server-side context instead of user-controlled input?
- Are reads, writes, joins, aggregates, search queries, and exports tenant-scoped?
- Are background jobs and webhook side effects tenant-scoped?
- Do RLS policies still apply, and are tests exercising cross-tenant failures?
- Can guessed IDs, archived records, deleted users, or stale tokens cross tenant boundaries?

Required tests for tenant-sensitive changes should include at least one unauthorized or cross-tenant negative case.

## Phase 5: Contract Compatibility Review

Treat boundaries as first-class review targets.

For each changed endpoint, message, event, shared type, migration, or external provider payload, record:

```md
Contract:
- Producer:
- Consumer(s):
- Runtime validation:
- Shared TypeScript type or schema:
- Backward compatibility:
- Null/legacy data behavior:
- Tests:
```

Review these boundaries specifically:

- Web to API request and response shapes.
- API to database schema assumptions.
- API to external provider payloads and webhook events.
- Shared package types used by both web and API.
- Test fixtures versus production data.
- Browser-visible env/config versus server-only env/config.

## Phase 6: Migration and Production Data Review

For every migration, schema change, seed change, RLS policy change, or backfill, check:

- Can the migration run on production-sized data without long locks?
- Is it forward-compatible and backward-compatible during deploy?
- Are new columns nullable before application code depends on them?
- Are defaults, constraints, and indexes added safely?
- Are existing rows backfilled or tolerated?
- Does rollback leave data in a safe state?
- Does the app tolerate old and new schema versions during rolling deploy?
- Are tenant policies updated and tested?

Also test assumptions against production-like data: nulls, empty strings, old enum values, archived records, deleted users, duplicate names, long notes, large transcripts, international phone numbers, timezone boundaries, and partially configured provider state.

## Phase 7: External Integration Review

When Stripe, Twilio, Clerk, OpenAI, PostHog, Sentry, Redis, Postgres, Vapi, or similar provider behavior changes, review the integration path operationally.

Checklist:

- Signature validation and replay protection for inbound events.
- Idempotency for duplicate provider deliveries and retried requests.
- Tenant binding for provider IDs and customer/account IDs.
- Safe retry behavior with no duplicate side effects.
- Clear failure states for provider outages and partial success.
- PII-safe analytics, logs, and error reporting.
- Server-side authorization instead of frontend-only checks.
- Safe local/dev behavior when provider config is missing.

## Phase 8: Web, UX, and Accessibility Review

For browser-visible changes, verify:

- Loading, error, success, empty, disabled, and retry states.
- Form validation, cancellation, double-submit protection, and optimistic-update rollback.
- Accessible labels, button names, keyboard behavior, modal focus, and non-color-only status.
- API errors are recoverable and do not silently fall back to mock or stale data.
- State is not duplicated between local state and server truth.
- Effects do not refetch unnecessarily or use stale closures.
- New dependencies do not bloat the bundle or move server-only logic into the browser.

Capture screenshots for changed flows and include notes about untested browsers or viewport sizes.

## Phase 9: Canary Scenario Selection

Pick 5 to 10 high-value user journeys based on the diff. Map each to an existing test command or manual verification step.

Example artifact:

```md
| Canary flow | Why it matters | Verification |
| --- | --- | --- |
| New customer creation | Core CRM write path | playwright test e2e/qa-matrix/customers.spec.ts |
| Invoice lifecycle | Money movement/status transitions | playwright test e2e/qa-matrix/invoices-lifecycle.spec.ts |
| Scheduling | Timezone/conflict-sensitive workflow | playwright test e2e/qa-matrix/scheduling.spec.ts |
| Public estimate approval | Unauthenticated customer surface | targeted manual + e2e public portal spec |
```

## Phase 10: Test Quality Review

Review tests as production code. Tests should prove externally visible behavior, not merely duplicate implementation details.

Look for:

- Negative cases: unauthorized, cross-tenant, invalid payload, missing provider config, duplicate webhook, stale data, and provider failure.
- Deterministic async behavior with stable waits/selectors.
- Realistic mocks and fixtures.
- Isolation and cleanup for database-backed tests.
- No broad snapshot updates that hide behavior changes.
- No fixture changes that make tests pass while production behavior remains untested.

For bug fixes, confirm the test would fail without the fix.

## Phase 11: Diff Smell and Dependency Review

Scan for change shapes that often hide production risk:

- Removed validation or widened types.
- New `any`, double assertions, unchecked casts, or swallowed errors.
- New logs containing request bodies, customer data, transcripts, or provider payloads.
- New `console.log`, `debugger`, TODO, FIXME, or HACK in runtime code.
- New env vars without docs or validation.
- Client-side-only authorization.
- Large lockfile changes with small manifest changes.
- New dependencies with postinstall scripts, heavy transitive trees, browser bundle impact, or security exposure.

Suggested searches:

```bash
rg "TODO|FIXME|HACK|console\.log|debugger|as unknown as|process\.env|innerHTML|localStorage|tenantId|organizationId|userId"
```

When dependencies change, run focused checks such as:

```bash
npm ls <package-name>
npm explain <package-name>
npm audit --omit=dev
```

## Phase 12: Rollout, Rollback, and Observability Review

Before finalizing the review, ask whether production operators can safely deploy, detect, and roll back the change.

Checklist:

- Feature flag or staged rollout path for risky behavior.
- Rollback plan that does not lose or corrupt data.
- Forward/backward compatibility across app and database versions.
- Required env vars documented and validated.
- Logs, metrics, Sentry events, or analytics exist for critical failure points.
- Observability is PII-safe and grouped usefully.
- Background jobs shut down safely and avoid duplicate work across instances.
- Support/customer-facing impact is understood.

## Phase 13: Final Review Output

Use a severity-ranked final report. Every finding should include the concrete scenario, impact, and suggested fix.

```md
## Review Summary

### Blockers
- [ ] [Title]
  - File/line:
  - Issue:
  - Why it matters:
  - Failure scenario:
  - Suggested fix:
  - Test expectation:

### High Risk / Should Fix
- ...

### Medium Risk / Consider Fixing
- ...

### Low Risk / Nits
- ...

### Tests Run
- ...

### Untested Areas / Residual Risk
- ...

### Merge Recommendation
- Merge / do not merge / merge with accepted risk after listed remediation.
```

Always include residual risk. Examples:

- Full QA matrix was not run.
- Provider webhooks were not verified against live provider payloads.
- Migration was tested on a clean database only.
- UI was checked in Chromium only, not Safari/mobile.
- Voice eval was offline only, not live-model behavior.

## Practical Execution Order

1. Confirm base/head/merge-base and generate the diff inventory.
2. Run cheap global checks.
3. Build the changed-file risk map.
4. Review security, data, auth, tenant, payment, webhook, env, and migration-sensitive files first.
5. Review API contracts and backend logic.
6. Review shared types and frontend consumers.
7. Review UI/UX/accessibility and capture screenshots if applicable.
8. Review tests and negative-path coverage.
9. Run targeted and broader tests based on touched areas.
10. Review rollout, rollback, observability, and residual risk.
11. Produce severity-ranked findings and a merge recommendation.
