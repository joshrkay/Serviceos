# AI Service OS — Testing Strategy

> This document is Section 13 of the PRD. It defines the testing approach for the entire product and is cross-referenced by CLAUDE.md and every story spec. Every story must comply with these conventions.

---

## Testing Philosophy

This product handles other people's money and schedules. The cost of a billing bug or a scheduling error is customer trust — the hardest thing to rebuild in the home services market.

Testing serves two purposes:
1. **Prevent regressions in deterministic business logic** — money calculations, scheduling semantics, permissions, proposal execution
2. **Validate AI-generated proposals** — ensure AI output meets quality thresholds before the system allows execution against real operational data

The testing pyramid for AI Service OS is weighted heavier on integration tests than a typical SaaS app because the critical bugs are in the boundaries: tenant isolation at the DB layer, financial math across the billing engine, and proposal execution across service boundaries.

---

## Test Framework and Tooling

| Tool | Purpose | When Introduced |
|------|---------|----------------|
| **Vitest** | Unit and integration tests (all packages) | P0-001 |
| **Supertest** | HTTP integration tests for API routes | P0-005 |
| **Testing Library** | React component tests | P1-016 |
| **Playwright** | E2E browser tests | P7-018 (beta hardening) |
| **testcontainers** | Postgres container for integration tests | P0-004 |
| **msw (Mock Service Worker)** | API mocking for frontend tests | P1-016 |
| **Faker** | Realistic test data generation | P0-005 |

**Why Vitest over Jest:** Faster execution, native ESM support, better TypeScript integration, compatible with Vite frontend tooling. Single test runner across all packages.

---

## Test File Conventions

### Location
- **Unit tests:** Co-located next to source as `[module].test.ts`
  - `packages/api/src/customers/customer.service.ts` → `packages/api/src/customers/customer.service.test.ts`
- **Integration tests:** In `packages/api/tests/integration/[domain]/`
  - `packages/api/tests/integration/customers/customer-crud.test.ts`
- **HTTP route tests:** In `packages/api/tests/routes/[domain]/`
  - `packages/api/tests/routes/customers/customer-routes.test.ts`
- **Component tests:** Co-located next to component
  - `packages/web/src/components/proposals/ProposalCard.test.tsx`
- **E2E tests:** In `packages/web/tests/e2e/`

### Naming
- Describe blocks use story IDs for traceability: `describe('P0-004: Tenant isolation', () => { ... })`
- Test names describe behavior, not implementation: `it('rejects cross-tenant customer query')` not `it('tests RLS policy')`
- Group by behavior: `describe('when tenant A queries tenant B data', () => { ... })`

### Test Data
- **Factories** in `packages/api/tests/factories/` — one factory per entity
- Factories use Faker for realistic data with overridable defaults
- **Never use hardcoded IDs** in tests — always generate via factory
- **Tenant factory** creates isolated tenant context for each test suite
- Example factory pattern:
```typescript
// packages/api/tests/factories/customer.factory.ts
export function buildCustomer(overrides?: Partial<Customer>): Customer {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    email: faker.internet.email(),
    primaryPhone: faker.phone.number(),
    status: 'active',
    ...overrides,
  };
}
```

---

## Coverage Requirements

| Module Category | Line Coverage Minimum | Rationale |
|----------------|----------------------|-----------|
| Billing engine (`shared/billing-engine`) | 95% | Financial correctness is non-negotiable |
| Payment modules | 90% | Money movement must be thoroughly tested |
| Estimate/invoice calculations | 90% | Customer-facing financial documents |
| Proposal execution engine | 85% | Trust boundary — executes mutations |
| Auth/RBAC middleware | 85% | Security boundary |
| AI gateway + routing | 80% | Provider abstraction must be reliable |
| CRUD entities + validation | 70% | High AI-buildability, moderate risk |
| UI components | 60% | Tested for behavior, not pixel-perfect rendering |
| Analytics/reporting queries | 50% | Lower risk, higher change frequency |

**Enforcement:** Coverage thresholds are enforced in CI. PRs that drop coverage below the threshold for a module category are blocked.

---

## Required Test Categories by Story Type

### Every story must include:

1. **Happy path test** — the primary use case works
2. **Validation test** — invalid input is rejected with clear errors
3. **Tenant isolation test** — cross-tenant data is inaccessible (for any story touching the DB)

### Financial stories (estimates, invoices, payments) additionally require:

4. **Zero amount edge case** — system handles $0.00 correctly
5. **Rounding boundary test** — calculations that produce fractional cents round correctly (half-up)
6. **Large amount test** — amounts > $100,000 don't overflow or lose precision
7. **Negative amount test** — system rejects or handles negative amounts appropriately
8. **100% discount test** — document with full discount calculates to $0.00 total
9. **Partial payment arithmetic test** — amount_due = total - sum(payments) after each payment

### Permission stories additionally require:

10. **Role escalation test** — lower-privilege role cannot access higher-privilege endpoints
11. **Missing auth test** — unauthenticated requests return 401
12. **Wrong tenant test** — authenticated user cannot access other tenant's resources

### Proposal stories additionally require:

13. **Invalid transition test** — rejected status transitions return clear errors
14. **Stale context test** — proposals against changed entities are caught
15. **Idempotency test** — duplicate approval does not create duplicate entities
16. **Execution failure test** — system state is consistent after partial failure

### AI/LLM stories additionally require:

17. **Mock provider test** — full workflow works with stub/mock LLM provider
18. **Malformed AI output test** — invalid LLM responses are caught and routed to safe failure
19. **Timeout test** — LLM timeout is handled gracefully
20. **Provider swap test** — changing provider config doesn't break the calling code

---

## Integration Test Infrastructure

### Database Tests (introduced in P0-004)

Use testcontainers to spin up a real Postgres instance for integration tests. Each test suite:

1. Creates a fresh test database with RLS policies applied
2. Runs migrations
3. Creates an isolated tenant via factory
4. Executes tests within that tenant context
5. Tears down after suite completion

```typescript
// packages/api/tests/setup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer().start();
  // Run migrations against container
  await runMigrations(container.getConnectionUri());
});

afterAll(async () => {
  await container.stop();
});
```

**Why real Postgres, not SQLite:** RLS policies, tenant isolation, and timezone behavior are Postgres-specific. Mocking these gives false confidence.

### API Route Tests (introduced in P0-005)

Use Supertest against the Express app with:
- Mocked Clerk auth (inject tenant context directly)
- Real database (via testcontainers)
- Assertions on status codes, response body structure, and side effects

### AI Gateway Tests (introduced in P2-027)

Use the mock provider adapter for all AI gateway tests:
- Mock provider returns configurable responses (valid proposal, malformed output, timeout)
- Tests verify routing, logging, caching, and failover behavior
- No real LLM calls in CI — all provider tests use mocks

### Real-Postgres Playwright locally (wayfinder #1025)

The `e2e/journeys/*.hermetic.spec.ts` journeys normally run against the API's
in-memory repositories. To run one against a real Postgres instance instead
(closer to production, and the only way to exercise Postgres-backed
onboarding-gate/derived-status behavior), run these from the repo root with
[colima](https://github.com/abiosoft/colima) providing Docker and no more
than ~3 minutes total:

```bash
# 1. Point Docker at colima (not needed if colima is your only Docker context).
export DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock

# 2. Start a disposable Postgres testcontainer FIRST, before Playwright.
#    Prints `export DATABASE_URL=postgres://test:test@localhost:<port>/serviceos_e2e_test`.
TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts

# 3. Run a journey spec against it.
DB_SSL=false DATABASE_URL=<url from step 2> \
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
  npx playwright test e2e/journeys/signup-to-first-estimate.hermetic.spec.ts \
    --project=chromium --reporter=line

# 4. Tear the container down when done.
npm run e2e:db:teardown
```

Why each piece is load-bearing:

- **`TESTCONTAINERS_RYUK_DISABLED=true`** — the CLI process (step 2) exits
  after printing the URL; without this flag, Ryuk (testcontainers' reaper)
  sees that process die and immediately kills the container out from under
  the Playwright run that's about to use it.
- **`DB_SSL=false`** — `packages/api/src/db/pool.ts` forces
  `ssl: { rejectUnauthorized: false }` on any `DATABASE_URL` unless
  `DB_SSL === 'false'`. The testcontainer speaks plain TCP, so without this
  every query fails with "The server does not support SSL connections".
- **Container FIRST, then Playwright** — Playwright starts the API/Vite
  `webServer` processes *before* running `globalSetup`, and
  `webServerEnv` captures `process.env.DATABASE_URL` at config load time. If
  `DATABASE_URL` isn't already in the shell when `npx playwright test`
  starts, the API boots with `InMemoryProposalRepository` regardless of what
  `globalSetup` does afterward.
- **The placeholder `VITE_CLERK_PUBLISHABLE_KEY`** — a hermetic journey's
  `hasViteClerkKey()` guard just needs *some* value to not skip itself; it's
  the same placeholder `playwright.config.ts` uses for the devauth project.

Add `E2E_USE_TEST_DB=true` to step 3 to also exercise the `global-setup.ts`
ephemeral-DB bootstrap (mode 1: it adopts the already-set `DATABASE_URL`,
runs migrations idempotently, and seeds journey fixtures) — useful when
testing that bootstrap path itself, but note it truncates all tables in
`global-teardown.ts` at the end of the run, so omit it if you want to inspect
rows in the container afterward (e.g. `docker exec <container> psql -U test
-d serviceos_e2e_test -c 'select * from estimates'`).

**Teardown footgun.** After a run with `E2E_USE_TEST_DB=true`, `global-setup.ts` rewrites
`e2e/fixtures/.test-db-state.json` with `ownsContainer: false` (it *adopted* your
`DATABASE_URL`), so `npm run e2e:db:teardown` **truncates the tables and leaves the
container running**. Stop it yourself:
`docker ps --filter ancestor=pgvector/pgvector:pg16 -q | xargs docker rm -f`.
Run teardown *before* the Playwright run if you want the container stopped by the
script, or just remove it by id.

This is one of three distinct e2e runners, not two — don't conflate them:

- **`chromium`/`chromium-devauth`** (no `DATABASE_URL`) — in-memory only,
  runs on every PR, fastest.
- **This recipe** — real Postgres, fully local and hermetic (no secrets, no
  deployed environment), for rung-5 reachability specs that need
  Postgres-derived behavior (e.g. `deriveOnboardingStatus`).
- **`qa-matrix`** — also real Postgres, but *not* hermetic: its precheck
  (`e2e/qa-matrix/precheck.spec.ts`) requires `E2E_BASE_URL`, `E2E_API_URL`,
  `E2E_DB_URL_READONLY`/`READWRITE`, `E2E_CLERK_HMAC_SECRET`, and seeded
  tenant A/B ids — i.e. a deployed Railway dev environment (see
  `qa/README.md`), not a disposable local container.

---

## AI-Specific Testing

### Proposal Quality Thresholds

These are the measurable targets that determine whether AI features are beta-ready:

| Metric | Threshold for Beta | Measured By |
|--------|-------------------|-------------|
| Estimate proposal approval rate | ≥ 60% approved or approved-with-edits | P2-019 analytics |
| Estimate proposal rejection rate for wrong_entity | < 5% | P2-018 rejection reasons |
| Estimate line-item edit rate | < 40% of line items edited before approval | P2-017 edit tracking |
| Intent classification accuracy | ≥ 85% correct intent on test dataset | P2-020 eval hooks |
| Transcript normalization accuracy | ≥ 90% on test audio samples | P0-012 transcription tests |
| Mean time to first proposal | < 15 seconds from input to proposal card | P2-007 orchestration timing |
| AI response validation pass rate | ≥ 95% of LLM outputs pass schema validation | P2-027 gateway validation |

**These thresholds are checked before promoting from Phase 4 to Phase 5.** If estimate proposal quality doesn't meet thresholds, iterate on prompts and context assembly before proceeding to invoice AI.

### Evaluation Dataset Management (P2-020)

- Store input/output/outcome triples for every proposal task
- Tag with prompt version and model identifier
- Run offline evaluation when prompts or models change
- Compare new results against baseline: if approval rate drops > 5%, block the change

### Shadow Comparison Testing (P2-030)

- Run shadow comparisons at 10% sampling rate in staging
- Compare primary and shadow outputs on: schema validity, line-item count, total amount variance, and category accuracy
- Promote a new model to primary only when shadow quality meets or exceeds current primary on all metrics

---

## Test Execution in CI

### Pull Request Checks (all PRs)

```yaml
# .github/workflows/pr-checks.yml
steps:
  - name: Type check
    run: npx tsc --noEmit
  
  - name: Lint
    run: npm run lint
  
  - name: Unit tests
    run: npm test -- --reporter=verbose
  
  - name: Integration tests
    run: npm run test:integration
    env:
      TEST_DB: testcontainers  # Uses Postgres container
  
  - name: Coverage check
    run: npm run test:coverage
    # Fails if module coverage drops below threshold
```

### Staging Deploy Checks (merge to main)

```yaml
steps:
  - name: All PR checks (above)
  - name: CDK synth
    run: cd infra && npx cdk synth
  - name: Migration dry-run
    run: npm run migrate:dryrun
  - name: Deploy to staging
    run: npm run deploy:staging
  - name: Staging smoke tests
    run: npm run test:smoke -- --env=staging
```

### Pre-Beta Quality Gate (Phase 4 → Phase 5 transition)

- Run full eval dataset against current prompts and models
- Verify all AI quality thresholds are met
- Run full integration test suite against staging
- Verify all financial calculation tests pass
- Human review of 20 randomly sampled estimate proposals for quality

---

## Test Data Strategy

### Seed Data (introduced in P0-005)

The `seed` command (`packages/api/scripts/seed.ts`) populates a database via the
production repositories — every row passes the same validation and RLS as live
data. The plan is computed by `src/seed/seed-plan.ts` and inserted by
`src/seed/seed-runner.ts`. Defaults (10 tenants × 20 customers) create, per
tenant, a customer → service location → job → estimate → appointment chain:

- **10 tenants**, each with an owner user
- **200 customers** (20 per tenant), each with a service location
- **200 jobs** (one per customer)
- **200 estimates** (one per customer)
- **200 appointments** — every one on a **separate calendar day at a separate
  time** (no two share a start instant or a date), so the demo schedule is
  spread out rather than stacked

```bash
DATABASE_URL=… npm run seed                       # 10 tenants × 20 → 200 of each
DATABASE_URL=… npm run seed -- --tenant-count=3   # smaller multi-tenant set
DATABASE_URL=… npm run seed -- --per-tenant=50    # 10 × 50 → 500 of each
DATABASE_URL=… npm run seed -- --timezone=America/Chicago
DATABASE_URL=… npm run seed:clean                 # remove seeded demo tenants
```

`seed:clean` removes only tenants this seeder created (matched by their
`owner@seed-tenant-*` owner email), child rows first, so real data is untouched.
The headline guarantee is unit-tested in `test/seed/seed-plan.test.ts` and the
DB insertion (counts, tenant isolation, day-distinct appointments) in the
Docker-gated `test/integration/seed-runner.test.ts`.

### Fixture Data for AI Testing

Create a `fixtures/ai/` directory with:
- 20 sample voice transcripts (text-based, representing common HVAC/plumbing service calls)
- 10 sample conversation contexts for estimate generation
- 5 golden estimate proposals (manually verified correct output)
- Known-good and known-bad LLM outputs for validation testing

---

## Story-Level Test Checklist

Every story PR must include a comment confirming:

```markdown
## Test Checklist for [STORY-ID]
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated (if DB-touching)
- [ ] Tenant isolation test included (if new entity/query)
- [ ] Financial edge cases covered (if money-related)
- [ ] Permission tests included (if new endpoint)
- [ ] All existing tests still pass
- [ ] Coverage thresholds maintained
- [ ] Test factories updated for new entities
```
