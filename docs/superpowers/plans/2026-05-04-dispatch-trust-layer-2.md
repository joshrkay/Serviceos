# Dispatch Trust Gap — Layer 2 (Integration Smoke Gate)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Prerequisite:** `docs/superpowers/plans/2026-05-04-dispatch-trust-layer-1-3.md` is merged. This plan extends the dispatch-story addendum schema and verify.sh; both depend on Layer 1 already shipping the `Wiring claim:` field machinery.

## Context

Layer 1 (wiring grep gate) catches "handler is registered with real deps in `app.ts`." But that's a syntactic check — it cannot tell you whether the handler actually persists to the database when called. A reviewer can pass a wiring claim by registering a stub.

Layer 2 closes that gap with a per-story integration smoke test that boots the API against a real Postgres pool, fires the proposal through the executor, and asserts the entity exists in the database.

The infra is already in place:
- `@testcontainers/postgresql` is in `packages/api/devDependencies`.
- `packages/api/vitest.integration.config.ts` exists with `pool: 'forks'`, `singleFork: true`, `testTimeout: 60000` — already configured for sequential pg-backed integration tests.
- `packages/api/test/integration/setup.ts` exists (the existing integration-test harness).
- `npm run test:integration` is wired in `packages/api/package.json`.

What's missing is the contract — the requirement that every story dispatching new wiring or persistence ships a smoke test, plus a `verify.sh` step that runs it.

**Goal:** add a `Smoke test:` required field to dispatch addendums (parallel to `Wiring claim:`), extend `verify.sh` to run the named smoke test, and seed `test/integration/smoke/` with the first three smoke tests (one per production-readiness Phase 1 wiring fix) so the gate has real test cases the day it lands.

**Architecture:** Reuses existing integration-test infra (testcontainers + vitest integration config). New: a thin `bootSmokeApp()` helper that wraps the existing setup, returns `{ app, pool, cleanup }`, and lives in `test/integration/smoke/harness.ts`. Each smoke test imports the harness, calls it once in `beforeAll`, fires HTTP requests via supertest, asserts.

**Tech stack:** vitest, supertest, pg, @testcontainers/postgresql. All already installed.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/api/test/integration/smoke/harness.ts` | `bootSmokeApp()` — spins up a testcontainers Postgres, runs migrations, constructs the express app via `createApp()`, returns `{ app, pool, tenantId, cleanup }`. |
| `packages/api/test/integration/smoke/voice-create-customer.smoke.test.ts` | Smoke for the production-readiness Phase 1 Task 1 fix (CreateCustomerExecutionHandler persistence). |
| `packages/api/test/integration/smoke/voice-create-job.smoke.test.ts` | Phase 1 Task 3 (CreateJobExecutionHandler with primary-location resolution). |
| `packages/api/test/integration/smoke/voice-draft-estimate.smoke.test.ts` | Phase 1 Task 4 (DraftEstimateExecutionHandler with jobId requirement). |
| `packages/api/test/integration/smoke/proposal-idempotency.smoke.test.ts` | Phase 3 Task 12 (IdempotencyGuard wired — same proposal key fires once not twice). |

### Modified files

| Path | Change |
|------|--------|
| `.claude/skills/dispatch-story/verify.sh` | After the Layer 1 wiring-claim block, extract the new `**Smoke test:**` field. If present, run `npm --prefix packages/api run test:integration -- <smoke-path>` from the worktree. Block the gate on test failure. |
| `.claude/skills/dispatch-story/SKILL.md` | Document the new required `Smoke test:` field. Pure-refactor / docs-only stories use `Smoke test: none (rationale: ...)`. |
| `docs/superpowers/contracts/repository-conventions.md` | Document the `Smoke test:` field with examples + expectations (boots real pg, fires the new proposal/handler/route, asserts persisted state). |
| `packages/api/package.json` | Add `test:smoke` script (`vitest run --config vitest.integration.config.ts test/integration/smoke`) so smoke tests can be run as a group locally. |
| `.github/workflows/pr-checks.yml` | Add a `smoke` job that runs `npm run test:smoke`. Required check on PRs. |

### Migration / data changes

None.

### Commit cadence

One commit per task. Smoke tests are isolated; failures don't block other tasks.

---

## Phase 1: Build the harness (foundation)

The harness is the only piece that requires careful design. Once it lands, every per-story smoke test is ~30 lines.

### Task 1: Read the existing integration setup

**Files:**
- Read: `packages/api/test/integration/setup.ts`
- Read: `packages/api/vitest.integration.config.ts`
- Read: 1-2 existing tests in `packages/api/test/integration/` to see the boot pattern

**Context:** Don't reinvent. The harness must extend, not duplicate, the existing setup. If `setup.ts` already exposes `bootApp()` or similar, the smoke harness re-exports it with a smaller contract. If not, the smoke harness becomes the canonical entry.

- [ ] **Step 1: Catalog what's already in `setup.ts` (does it spin up testcontainers? Run migrations? Construct the app?). Capture the API surface.**
- [ ] **Step 2: Decide whether `bootSmokeApp()` is a re-export, a thin wrapper, or a new entry. Document the decision in a `// Why this exists` comment at the top of the new harness file.**

### Task 2: Implement `bootSmokeApp()`

**Files:**
- Create: `packages/api/test/integration/smoke/harness.ts`

**Context:** The harness must give a smoke test everything it needs to fire a single request and verify a single mutation:
- An express app (the result of `createApp({ pool })` from `packages/api/src/app.ts`).
- A pg `Pool` connected to the testcontainers Postgres.
- A seeded tenant (one tenant is enough for smoke; multi-tenant scenarios use a second one passed explicitly).
- A `cleanup()` function that drops + recreates the schema (or destroys the container) so each test is isolated.

Keep the harness small — under 100 lines. It should NOT seed customers, jobs, or any product entities. Each smoke test seeds its own minimal fixtures via the same APIs the application uses.

- [ ] **Step 1: Implement the harness. Sketch:**

```typescript
// packages/api/test/integration/smoke/harness.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import express from 'express';
import { applyPendingMigrations } from '../../../src/db/migrate';
import { createApp } from '../../../src/app';

export interface SmokeApp {
  app: express.Application;
  pool: Pool;
  container: StartedPostgreSqlContainer;
  tenantId: string;
  cleanup: () => Promise<void>;
}

const SEED_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export async function bootSmokeApp(): Promise<SmokeApp> {
  // 1. Boot pg
  const container = await new PostgreSqlContainer('postgres:16').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  // 2. Run migrations
  await applyPendingMigrations(pool);

  // 3. Seed minimum tenant row (every multi-tenant table FKs to tenants)
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [SEED_TENANT_ID, 'Smoke Test Tenant']
  );

  // 4. Build the app with the real pool
  const app = await createApp({ pool /* + any required dev/test config */ });

  return {
    app,
    pool,
    container,
    tenantId: SEED_TENANT_ID,
    cleanup: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
```

Adjustments to make as you implement:
- `createApp` signature may differ — match it exactly. If `createApp` is sync, drop `await`.
- Match the existing migrations entry-point name (`applyPendingMigrations`, `runMigrations`, etc.).
- If tenants schema requires more columns (`createdAt`, `clerkOrgId`, etc.), add them to the seed.
- If there's a `tenant_context` GUC required before any query, set it via `SET LOCAL app.current_tenant_id`.

- [ ] **Step 2: Add a sanity test in the same file as the harness:**

```typescript
// packages/api/test/integration/smoke/harness.boot.test.ts
import { describe, expect, it } from 'vitest';
import { bootSmokeApp } from './harness';

describe('bootSmokeApp', () => {
  it('boots, accepts a pg query, and cleans up', async () => {
    const { pool, cleanup } = await bootSmokeApp();
    const result = await pool.query('SELECT 1 as one');
    expect(result.rows[0].one).toBe(1);
    await cleanup();
  }, 90_000); // generous timeout — first run pulls postgres image
});
```

- [ ] **Step 3: Run `cd packages/api && npm run test:integration -- test/integration/smoke/harness.boot.test.ts` — confirm green. First run will be slow (~30s for image pull); subsequent runs ~5s.**

- [ ] **Step 4: Commit:** `feat(test/smoke): bootSmokeApp harness for Layer 2 dispatch gate`

---

## Phase 2: Write the four seed smoke tests

These are the dogfood — Layer 2 ships with proof that it catches the bugs we know about.

### Task 3: voice-create-customer smoke

**Files:**
- Create: `packages/api/test/integration/smoke/voice-create-customer.smoke.test.ts`

**Context:** The simplest case. Fire an approved `create_customer` proposal through the executor; assert the row exists in `customers`. Without the production-readiness Phase 1 Task 1 fix landed, this test FAILS — that's the demonstration of the gate.

- [ ] **Step 1: Implement:**

```typescript
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootSmokeApp, type SmokeApp } from './harness';

describe('SMOKE: create_customer voice handler persists', () => {
  let smoke: SmokeApp;
  beforeAll(async () => { smoke = await bootSmokeApp(); }, 90_000);
  afterAll(async () => { await smoke.cleanup(); });

  it('creates a customer row when create_customer proposal is approved', async () => {
    // Step A: create a proposal (via the API the dispatcher would use)
    const createRes = await request(smoke.app)
      .post('/api/proposals')
      .set('x-tenant-id', smoke.tenantId)
      .set('x-actor-id', '00000000-0000-0000-0000-00000000000a')
      .send({
        proposalType: 'create_customer',
        payload: { name: 'Smoke Test Customer', email: 'smoke@example.com', phone: '+15555550100' },
        summary: 'Add Smoke Test Customer',
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.id ?? createRes.body.data?.id;
    expect(proposalId).toBeDefined();

    // Step B: approve + execute (path the executor takes after operator approval)
    const execRes = await request(smoke.app)
      .post(`/api/proposals/${proposalId}/approve-and-execute`)
      .set('x-tenant-id', smoke.tenantId)
      .set('x-actor-id', '00000000-0000-0000-0000-00000000000a')
      .send({});
    expect(execRes.status).toBe(200);

    // Step C: assert the persisted customer
    const dbRes = await smoke.pool.query(
      `SELECT id, first_name FROM customers WHERE tenant_id = $1 AND first_name = $2`,
      [smoke.tenantId, 'Smoke Test Customer']
    );
    expect(dbRes.rowCount).toBe(1);
    expect(dbRes.rows[0].id).toBe(execRes.body.resultEntityId ?? execRes.body.data?.resultEntityId);
  });
});
```

Adjustments while implementing:
- The exact route names (`POST /api/proposals`, `POST /api/proposals/:id/approve-and-execute`) must match what `app.ts` actually exposes. Fix path + verb to match.
- The auth header pattern (`x-tenant-id`, `x-actor-id`, or a Clerk JWT) must match what `requireAuth` middleware expects in dev mode.
- The `customers` table column names (`first_name` vs `firstName`) must match the migration in `db/schema.ts`.
- If approve and execute are separate routes, do them in two requests.

- [ ] **Step 2: Run `npm run test:integration -- test/integration/smoke/voice-create-customer.smoke.test.ts`. Expected on the current `main`: FAIL — `customers` row count is 0 because `CreateCustomerExecutionHandler` returns a synthetic UUID without writing. This is the proof Layer 2 catches the bug.**

- [ ] **Step 3: Commit:** `feat(test/smoke): voice-create-customer smoke (currently failing — exercises Phase 1 Task 1 fix)`

### Task 4: voice-create-job smoke

**Files:**
- Create: `packages/api/test/integration/smoke/voice-create-job.smoke.test.ts`

**Context:** Mirrors Task 3. Pre-seed a customer + a primary location (via the API, not raw SQL) so the handler's primary-location resolution path is exercised. Assert the resulting `jobs` row exists with the seeded `location_id`.

- [ ] **Step 1: Implement following the Task 3 shape. Pre-seed via:**
  - `POST /api/customers` to create the customer
  - `POST /api/customers/:id/locations` to add the location with `is_primary: true`
  - Then the `create_job` proposal + approve-and-execute
  - Assert `jobs` row has `customer_id` + `location_id` + `summary` matching `payload.title`

- [ ] **Step 2: Run — expect FAIL on current main (Task 3 of Phase 1 not landed → handler returns synthetic UUID).**

- [ ] **Step 3: Commit:** `feat(test/smoke): voice-create-job smoke`

### Task 5: voice-draft-estimate smoke

**Files:**
- Create: `packages/api/test/integration/smoke/voice-draft-estimate.smoke.test.ts`

**Context:** Two assertions in one test — happy path AND missing-jobId hard-fail.

- [ ] **Step 1: Implement two `it(...)` cases:**
  - **(a)** Pre-seed customer + job. Fire `draft_estimate` proposal with `jobId` + `lineItems`. Assert the persisted estimate has the auto-incremented `estimate_number` and the supplied `job_id`.
  - **(b)** Fire `draft_estimate` without `jobId`. Assert HTTP error and message contains "Estimate requires a jobId".

- [ ] **Step 2: Run — expect both to fail on current main.**

- [ ] **Step 3: Commit:** `feat(test/smoke): voice-draft-estimate smoke`

### Task 6: proposal-idempotency smoke

**Files:**
- Create: `packages/api/test/integration/smoke/proposal-idempotency.smoke.test.ts`

**Context:** This is the smoke test for Phase 3 Task 12 (IdempotencyGuard wiring). Fire the same approved proposal twice, in quick succession, with the same `idempotencyKey`. Assert exactly one row mutation, exactly one audit-log `executed` event.

- [ ] **Step 1: Implement. The test:**
  - Pre-seed a customer.
  - Create + approve an `update_customer` proposal with `idempotencyKey: 'smoke-key-1'` and a payload that updates the customer's name.
  - POST `/api/proposals/:id/execute` twice in parallel (or back-to-back).
  - Assert: customer's `first_name` was updated exactly once (compare against an updated_at watermark or row-version).
  - Assert: `audit_events` has exactly one row of type `proposal.executed` for that proposal id.

- [ ] **Step 2: Run — expect FAIL on current main (Idempotency not wired → second call also runs).**

- [ ] **Step 3: Commit:** `feat(test/smoke): proposal-idempotency smoke`

---

## Phase 3: Wire smoke runs into verify.sh

### Task 7: Extend verify.sh with the Smoke test extraction + run

**Files:**
- Modify: `.claude/skills/dispatch-story/verify.sh`

**Context:** Same shape as the Layer 1 `Wiring claim` extraction — read a labeled block, parse, run. Insert AFTER the wiring-claim block and BEFORE the verification-gate `bash -c "$GATE_CMD"` line.

- [ ] **Step 1: Add this block after the wiring-claim handling:**

```bash
# Extract the **Smoke test:** field. Format is either:
#   **Smoke test:** packages/api/test/integration/smoke/foo.smoke.test.ts
# or:
#   **Smoke test:** none (rationale: docs-only)
SMOKE_LINE=$(awk -v id="$STORY_ID" '
  /^## / { in_block = ($0 ~ "^## " id " "); next }
  in_block && /\*\*Smoke test:\*\*/ {
    sub(/.*\*\*Smoke test:\*\*\s*/, "");
    print; exit
  }
' "$ADDENDUM_PATH")

if [[ -z "$SMOKE_LINE" ]]; then
  echo "verify: no Smoke test field for ${STORY_ID}" >&2
  echo "verify: add a 'Smoke test:' field to the addendum." >&2
  echo "verify: pure-refactor stories use 'Smoke test: none (rationale: ...)'" >&2
  exit 1
fi

if [[ "$SMOKE_LINE" =~ ^none ]]; then
  echo "verify: smoke explicitly 'none' for ${STORY_ID}, skipping smoke step"
else
  SMOKE_PATH=$(echo "$SMOKE_LINE" | awk '{print $1}')
  if [[ ! -f "$WORKTREE/$SMOKE_PATH" ]]; then
    echo "verify: smoke file not found: $SMOKE_PATH" >&2
    exit 1
  fi
  echo "verify: running smoke ${SMOKE_PATH} for ${STORY_ID}"
  cd "$WORKTREE/packages/api"
  npm run test:integration -- "../../$SMOKE_PATH"
  SMOKE_RC=$?
  cd "$WORKTREE"
  if [[ $SMOKE_RC -ne 0 ]]; then
    echo "verify: SMOKE FAIL (${STORY_ID}, exit ${SMOKE_RC})" >&2
    exit $SMOKE_RC
  fi
  echo "verify: smoke OK"
fi
```

Caveats to handle while implementing:
- `cd` into `packages/api` so `npm run test:integration` resolves to the right workspace. The relative path `../../$SMOKE_PATH` only works if smoke files always live under the worktree root — adjust if the addendum stores absolute paths.
- The test:integration script may need `--` to forward args to vitest correctly — verify the package.json invocation.

- [ ] **Step 2: Extend `verify.test.sh` (from Layer 1 plan Task 5 Step 2) with two more cases — one with a passing smoke, one missing the smoke file. Run the self-test, confirm green.**

- [ ] **Step 3: Commit:** `feat(dispatch): Layer 2 smoke gate in verify.sh`

### Task 8: Update SKILL.md and repository-conventions.md

**Files:**
- Modify: `.claude/skills/dispatch-story/SKILL.md`
- Modify: `docs/superpowers/contracts/repository-conventions.md`

**Context:** Mirror the Layer 1 docs additions.

- [ ] **Step 1: SKILL.md §1: add to the "addendum block must contain" list:**
```markdown
A `**Smoke test:**` field. Either a path under
`packages/api/test/integration/smoke/` or
`none (rationale: <one-line>)`.
```

- [ ] **Step 2: repository-conventions.md: add a "Smoke tests" section explaining:**
  - When required (any story that adds wiring touching app.ts handler/provider registration; any story modifying executor / gateway / RLS path).
  - When `none` is acceptable (docs-only, test-only, single test refactor).
  - Test naming convention (`<feature>.smoke.test.ts`).
  - Boot-time budget (target <30s including container start; if over, refactor before merge).
  - The harness contract (use `bootSmokeApp()`, do not spin pg directly).

- [ ] **Step 3: Commit:** `docs(dispatch): document Smoke test field for Layer 2 gate`

### Task 9: CI integration

**Files:**
- Modify: `.github/workflows/pr-checks.yml`
- Modify: `packages/api/package.json`

**Context:** PR checks should fail if any smoke test fails — independent of whether the dispatcher ran verify.sh locally. This is belt-and-suspenders.

- [ ] **Step 1: Add a `test:smoke` script to `packages/api/package.json`:**
```json
"test:smoke": "vitest run --config vitest.integration.config.ts test/integration/smoke"
```

- [ ] **Step 2: Add a `smoke` job to `.github/workflows/pr-checks.yml`. It needs Docker (testcontainers requirement). Check whether the existing CI runner already has Docker — if not, switch to a `services: postgres:` block (legacy pg-action) instead and adapt the harness to read `DATABASE_URL` from env when set, falling back to testcontainers when unset.**

- [ ] **Step 3: Push a draft PR; confirm the smoke job runs and fails on the four pre-fix smoke tests; merge after the fixes land in subsequent stories.**

- [ ] **Step 4: Commit:** `ci(pr-checks): require smoke job; npm test:smoke script`

---

## Phase 4: Roll forward — backfill smoke claims for in-flight readiness work

### Task 10: Add Smoke test field to production-readiness Phase 1-3 tasks

**Files:**
- Modify: `docs/superpowers/plans/2026-04-23-production-readiness-blockers.md` (or its addendum if one exists)

**Context:** Each existing readiness task should declare its smoke test path. Match smoke files created in Phase 2 of this plan.

- [ ] **Step 1: For each readiness task, add a `Smoke test:` line:**
  - Phase 1 Task 1 → `packages/api/test/integration/smoke/voice-create-customer.smoke.test.ts`
  - Phase 1 Task 3 → `packages/api/test/integration/smoke/voice-create-job.smoke.test.ts`
  - Phase 1 Task 4 → `packages/api/test/integration/smoke/voice-draft-estimate.smoke.test.ts`
  - Phase 3 Task 12 → `packages/api/test/integration/smoke/proposal-idempotency.smoke.test.ts`
  - Other tasks (Pg repos, Noop guard) → write smokes if the wiring is non-trivial; otherwise `none (rationale: pg-repo unit tests + tsc cover this)`.

- [ ] **Step 2: Commit:** `docs(blockers): cross-reference Layer 2 smoke tests`

---

## Phase 5: End-to-end verification

### Task 11: Dogfood the gate

- [ ] **Step 1: On a branch, apply Phase 1 Task 1 of `2026-04-23-production-readiness-blockers.md` (persist `CreateCustomerExecutionHandler`).**
- [ ] **Step 2: Run `bash .claude/skills/dispatch-story/verify.sh <story-id> .` — confirm both wiring grep AND smoke pass.**
- [ ] **Step 3: Revert the fix on the branch but keep the test. Re-run verify — confirm smoke FAILS, gate exits non-zero.**
- [ ] **Step 4: Re-apply the fix. Confirm green.**
- [ ] **Step 5: Document the dogfood result in the dispatch-trust PR description as proof-of-correctness.**

---

## Out of scope

- **Multi-tenant smoke scenarios.** Single tenant per smoke is enough for the bug class we're catching. Cross-tenant isolation continues to be covered by the existing `pg-*.test.ts` unit tests.
- **Frontend (web) smoke.** Layer 2 focuses on API-side persistence + idempotency. Web-app smoke (e.g., Playwright clicks pay-invoice button → assert success) is a separate Phase 7 plan.
- **Performance gate.** Slow smoke tests degrade dispatcher cycle time; Phase 4 budget (30s/test) is informal. A real perf-budget enforcement (smoke fails if total runtime > X) is later work.
- **Smoke fixtures library.** If we end up with 20+ smoke tests duplicating "seed customer + location," extract a `seed-customer.ts` fixture helper. Premature now.
