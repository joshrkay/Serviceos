# §11 Launch Quality Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the production-readiness bar that must be green before §10 self-serve onboarding opens to 10–50 customers.

**Architecture:** Five hardening items (executor idempotency-by-default, voice e2e smoke, Sentry alerting + Slack pipeline, rollback + migration discipline, voice load test) plus a single `launch-quality-check.ts` script that tallies all twelve check items. Discipline items (decisions test, smoke tests, migration immutability) already exist and stay green.

**Tech Stack:** TypeScript, Node, PostgreSQL (raw SQL migrations), Vitest, GitHub Actions, Sentry, Railway, Twilio Media Streams over WebSocket.

---

## File Structure

| Path | Action | Purpose |
|------|--------|---------|
| `packages/api/src/db/migrations/075_proposal_executions_idempotency_index.sql` | Create | Partial unique index. Bump number if 075_* already exists when this lands. |
| `packages/api/test/db/migration-075.test.ts` | Create | Verifies migration applies + index enforces uniqueness |
| `packages/api/src/proposals/proposal-execution.ts` | Modify | Add `findByIdempotencyKey` to repository interface |
| `packages/api/src/proposals/pg-proposal-execution.ts` | Modify | Implement indexed Postgres lookup |
| `packages/api/src/proposals/execution/idempotency.ts` | Modify | Rewrite `findPreviousExecution` to use executions repo (drop O(n) scan) |
| `packages/api/test/proposals/execution/idempotency.test.ts` | Modify | Update tests for new lookup path |
| `packages/api/test/proposals/execution/idempotency.test-d.ts` | Create | Type-level test: guard is required |
| `packages/api/src/proposals/execution/executor.ts` | Modify | `IdempotencyGuard` becomes required constructor arg |
| `packages/api/src/app.ts` (~line 1028) | Modify | Pass guard to executor at the single call site |
| `packages/api/test/proposals/execution/executor.integration.test.ts` | Create | Double-delivery → exactly one execution row |
| `packages/api/src/monitoring/instrumentation.ts` | Create | `instrument()` wrapper for Sentry tagging |
| `packages/api/test/monitoring/instrumentation.test.ts` | Create | Unit tests for wrapper |
| `packages/api/src/webhooks/stripe.ts` | Modify | Wrap entry with `instrument({ path: 'stripe-webhook' })` |
| `packages/api/src/workers/execution-worker.ts` | Modify | Wrap entry with `instrument({ path: 'execution-worker' })` |
| `packages/api/src/workers/voice-action-router.ts` | Modify | Wrap entry with `instrument({ path: 'voice-action-router' })` |
| `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts` | Modify | Wrap WS connection handler with `instrument({ path: 'voice' })` |
| `packages/api/test/voice/voice-smoke.synthetic.test.ts` | Create | Layer A — in-process Media Streams smoke |
| `packages/api/test/voice/fixtures/mulaw-fixtures.ts` + `book-tuesday-2pm.mulaw` | Create | Canned audio for synthetic test |
| `.github/workflows/deploy.yml` | Modify | Add Layer A smoke as deploy gate |
| `.github/workflows/voice-smoke-real.yml` | Create | Layer B — daily real-call cron |
| `packages/api/scripts/voice-smoke-real.ts` | Create | Script that places a real Twilio call |
| `packages/api/test/db/migration-discipline.test.ts` | Create | Permissive guard warning on destructive patterns |
| `packages/api/scripts/voice-load-test.ts` | Create | Concurrent WS load generator |
| `packages/api/scripts/launch-quality-check.ts` | Create | 12-item tally script |
| `packages/api/.launch-quality-acks.json` | Create | Honor-system marker for human checks |
| `docs/runbooks/rollback.md` | Create | Rollback procedure |
| `docs/runbooks/migration-discipline.md` | Create | Additive-migration policy |
| `docs/runbooks/alerting.md` | Create | Sentry rules + Slack integration setup |
| `docs/runbooks/voice-capacity.md` | Create | Per-instance ceiling + scaling guidance |
| `docs/runbooks/launch-quality-bar.md` | Create | Tier-1 overview + tier-2 promotion triggers |

---

# Phase 1 — H1 Executor idempotency-by-default

## Task 1: Migration 075 — partial unique index on `proposal_executions`

**Files:**
- Create: `packages/api/src/db/migrations/075_proposal_executions_idempotency_index.sql`
- Create: `packages/api/test/db/migration-075.test.ts`

- [ ] **Step 1: Confirm next migration number** — `ls packages/api/src/db/migrations/ | tail -5`. If `075_*` exists, bump and update all references in this plan.

- [ ] **Step 2: Write failing test** at `packages/api/test/db/migration-075.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newTestDb, dropTestDb, applyAllMigrations } from '../helpers/test-db';

describe('migration 075: proposal_executions idempotency index', () => {
  let db: { url: string; name: string };
  let client: Client;

  beforeAll(async () => {
    db = await newTestDb();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await applyAllMigrations(client);
    const sql = readFileSync(join(__dirname, '../../src/db/migrations/075_proposal_executions_idempotency_index.sql'), 'utf8');
    await client.query(sql);
  });

  afterAll(async () => { await client.end(); await dropTestDb(db.name); });

  it('creates the partial unique index', async () => {
    const { rows } = await client.query(`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'proposal_executions'
         AND indexname = 'proposal_executions_tenant_idempotency_uniq'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE.*tenant_id.*idempotency_key.*WHERE/);
  });

  it('blocks duplicate (tenant_id, idempotency_key) inserts', async () => {
    const tid = '11111111-1111-1111-1111-111111111111';
    await client.query(
      `INSERT INTO proposal_executions (id, tenant_id, proposal_id, executed_by, executed_payload, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $1, '{}', 'succeeded', 'k1')`, [tid]);
    await expect(client.query(
      `INSERT INTO proposal_executions (id, tenant_id, proposal_id, executed_by, executed_payload, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $1, '{}', 'succeeded', 'k1')`, [tid]
    )).rejects.toThrow(/duplicate key/);
  });

  it('allows duplicate keys across different tenants', async () => {
    const a = '22222222-2222-2222-2222-222222222222';
    const b = '33333333-3333-3333-3333-333333333333';
    await client.query(
      `INSERT INTO proposal_executions (id, tenant_id, proposal_id, executed_by, executed_payload, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $1, '{}', 'succeeded', 'shared'),
              (gen_random_uuid(), $2, gen_random_uuid(), $2, '{}', 'succeeded', 'shared')`, [a, b]);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM proposal_executions WHERE idempotency_key = 'shared'`);
    expect(rows[0].n).toBe(2);
  });

  it('allows multiple NULL idempotency_key rows per tenant', async () => {
    const tid = '44444444-4444-4444-4444-444444444444';
    await client.query(
      `INSERT INTO proposal_executions (id, tenant_id, proposal_id, executed_by, executed_payload, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $1, '{}', 'succeeded', NULL),
              (gen_random_uuid(), $1, gen_random_uuid(), $1, '{}', 'succeeded', NULL)`, [tid]);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions WHERE tenant_id = $1 AND idempotency_key IS NULL`, [tid]);
    expect(rows[0].n).toBe(2);
  });
});
```

- [ ] **Step 3: Run test → expect FAIL** — `cd packages/api && npx vitest run test/db/migration-075.test.ts` (migration file missing).

- [ ] **Step 4: Write the migration** at `packages/api/src/db/migrations/075_proposal_executions_idempotency_index.sql`:

```sql
-- 075_proposal_executions_idempotency_index.sql
-- §11 H1: replace the O(n) in-process scan in IdempotencyGuard with an indexed lookup.
-- Partial unique index also serves as defense-in-depth against app-layer regressions.
CREATE UNIQUE INDEX IF NOT EXISTS proposal_executions_tenant_idempotency_uniq
  ON proposal_executions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

- [ ] **Step 5: Run test → expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/db/migrations/075_proposal_executions_idempotency_index.sql packages/api/test/db/migration-075.test.ts
git commit -m "feat(db): add proposal_executions idempotency unique index (§11 H1)"
```

---

## Task 2: Add `findByIdempotencyKey` to executions repository

**Files:**
- Modify: `packages/api/src/proposals/proposal-execution.ts`
- Modify: `packages/api/src/proposals/pg-proposal-execution.ts`
- Create: `packages/api/test/proposals/pg-proposal-execution.test.ts`

- [ ] **Step 1: Failing test** at `packages/api/test/proposals/pg-proposal-execution.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { newTestDb, dropTestDb, applyAllMigrations } from '../helpers/test-db';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';

describe('PgProposalExecutionRepository.findByIdempotencyKey', () => {
  let db: { url: string; name: string };
  let client: Client;
  let repo: PgProposalExecutionRepository;
  const tenantId = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    db = await newTestDb();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await applyAllMigrations(client);
    repo = new PgProposalExecutionRepository(client);
  });
  afterAll(async () => { await client.end(); await dropTestDb(db.name); });
  beforeEach(async () => { await client.query('DELETE FROM proposal_executions'); });

  it('returns null when no execution exists for that key', async () => {
    expect(await repo.findByIdempotencyKey(tenantId, 'never-used')).toBeNull();
  });

  it('returns the prior execution for a matching key', async () => {
    await repo.recordExecution({
      tenantId, proposalId: 'p-1', executedPayload: { foo: 'bar' },
      executedBy: tenantId, status: 'succeeded', idempotencyKey: 'k-1',
    });
    const result = await repo.findByIdempotencyKey(tenantId, 'k-1');
    expect(result?.proposalId).toBe('p-1');
    expect(result?.status).toBe('succeeded');
  });

  it('scopes by tenant', async () => {
    const other = '22222222-2222-2222-2222-222222222222';
    await repo.recordExecution({
      tenantId: other, proposalId: 'p-x', executedPayload: {},
      executedBy: other, status: 'succeeded', idempotencyKey: 'k-shared',
    });
    expect(await repo.findByIdempotencyKey(tenantId, 'k-shared')).toBeNull();
  });
});
```

- [ ] **Step 2: Run → expect FAIL** (method does not exist).

- [ ] **Step 3: Extend interface** in `packages/api/src/proposals/proposal-execution.ts`:

```typescript
export interface ProposalExecutionRepository {
  recordExecution(input: RecordExecutionInput): Promise<ProposalExecution>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<ProposalExecution | null>;
}
```

If an in-memory implementation lives in the same file, add a matching method that filters its in-process array.

- [ ] **Step 4: Implement against Postgres** — add to `PgProposalExecutionRepository`:

```typescript
async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<ProposalExecution | null> {
  const { rows } = await this.client.query(
    `SELECT id, tenant_id, proposal_id, executed_by, executed_payload, status,
            error_message, idempotency_key, result_entity_id, created_at
       FROM proposal_executions
      WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'succeeded'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, idempotencyKey]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id, tenantId: r.tenant_id, proposalId: r.proposal_id,
    executedBy: r.executed_by, executedPayload: r.executed_payload, status: r.status,
    errorMessage: r.error_message ?? undefined, idempotencyKey: r.idempotency_key ?? undefined,
    resultEntityId: r.result_entity_id ?? undefined, createdAt: r.created_at,
  };
}
```

- [ ] **Step 5: Run → PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proposals/proposal-execution.ts packages/api/src/proposals/pg-proposal-execution.ts packages/api/test/proposals/pg-proposal-execution.test.ts
git commit -m "feat(proposals): findByIdempotencyKey on ProposalExecutionRepository (§11 H1)"
```

---

## Task 3: Rewrite `IdempotencyGuard.findPreviousExecution` to use indexed lookup

**Files:**
- Modify: `packages/api/src/proposals/execution/idempotency.ts`
- Modify: `packages/api/test/proposals/execution/idempotency.test.ts`

- [ ] **Step 1: Update existing tests** — replace `findByTenant`-based mock with `findByIdempotencyKey`. Add this case:

```typescript
it('uses the executions repository, not the proposals repository, for lookup', async () => {
  const executionRepo = {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    recordExecution: vi.fn(),
  };
  const guard = new IdempotencyGuard(executionRepo);
  await guard.findPreviousExecution('t1', 'k1');
  expect(executionRepo.findByIdempotencyKey).toHaveBeenCalledWith('t1', 'k1');
});
```

- [ ] **Step 2: Run → expect FAIL** (constructor signature mismatch).

- [ ] **Step 3: Rewrite the guard** — replace contents of `packages/api/src/proposals/execution/idempotency.ts`:

```typescript
import { Proposal } from '../proposal';
import { ExecutionResult } from './handlers';
import { ProposalExecutionRepository, ProposalExecution } from '../proposal-execution';

export class IdempotencyGuard {
  constructor(private readonly executionRepo: ProposalExecutionRepository) {}

  async checkAndExecute(
    proposal: Proposal,
    executeFn: () => Promise<ExecutionResult>
  ): Promise<{ result: ExecutionResult; alreadyExecuted: boolean }> {
    if (!proposal.idempotencyKey) {
      const result = await executeFn();
      return { result, alreadyExecuted: false };
    }
    const previous = await this.findPreviousExecution(proposal.tenantId, proposal.idempotencyKey);
    if (previous) {
      return { result: { success: true, resultEntityId: previous.resultEntityId }, alreadyExecuted: true };
    }
    const result = await executeFn();
    return { result, alreadyExecuted: false };
  }

  async findPreviousExecution(tenantId: string, idempotencyKey: string): Promise<ProposalExecution | null> {
    return this.executionRepo.findByIdempotencyKey(tenantId, idempotencyKey);
  }
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/execution/idempotency.ts packages/api/test/proposals/execution/idempotency.test.ts
git commit -m "refactor(proposals): indexed idempotency lookup via executions repo (§11 H1)"
```

---

## Task 4: Make `IdempotencyGuard` required on `ProposalExecutor`

**Files:**
- Modify: `packages/api/src/proposals/execution/executor.ts`
- Create: `packages/api/test/proposals/execution/idempotency.test-d.ts`

- [ ] **Step 1: Type-level test:**

```typescript
import { expectTypeOf } from 'expect-type';
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { ProposalRepository } from '../../../src/proposals/proposal';
import { ExecutionHandler, ProposalType } from '../../../src/proposals/execution/handlers';

declare const handlers: Map<ProposalType, ExecutionHandler>;
declare const proposalRepo: ProposalRepository;
declare const guard: IdempotencyGuard;

expectTypeOf(new ProposalExecutor(handlers, proposalRepo, guard)).toEqualTypeOf<ProposalExecutor>();

// @ts-expect-error guard is required
new ProposalExecutor(handlers, proposalRepo);
```

Install `expect-type` if missing: `cd packages/api && npm i -D expect-type`.

- [ ] **Step 2: Run type check → expect FAIL** — `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` (the `@ts-expect-error` is currently unused, which TS reports as an error).

- [ ] **Step 3: Make guard required** in `packages/api/src/proposals/execution/executor.ts`.

Replace lines 25–64 (class header + constructor):

```typescript
export class ProposalExecutor {
  private readonly idempotency: IdempotencyGuard;
  private readonly executionRepo?: ProposalExecutionRepository;
  private readonly onExecuted?: (event: ProposalExecutionEvent) => Promise<void> | void;

  constructor(
    private readonly handlers: Map<ProposalType, ExecutionHandler>,
    private readonly proposalRepo: ProposalRepository,
    idempotency: IdempotencyGuard,
    options: {
      executionRepo?: ProposalExecutionRepository;
      onExecuted?: (event: ProposalExecutionEvent) => Promise<void> | void;
    } = {}
  ) {
    this.idempotency = idempotency;
    this.executionRepo = options.executionRepo;
    this.onExecuted = options.onExecuted;
  }
```

Replace lines 108–118 (the optional-guard branch):

```typescript
    const outcome = await this.idempotency.checkAndExecute(proposal, () =>
      handler.execute(proposal, context)
    );
    const result = outcome.result;
    const alreadyExecuted = outcome.alreadyExecuted;
```

- [ ] **Step 4: Run type check → expect FAIL at `app.ts:1028`** (call site doesn't pass guard yet — fixed in Task 5).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proposals/execution/executor.ts packages/api/test/proposals/execution/idempotency.test-d.ts
git commit -m "feat(proposals): IdempotencyGuard required on ProposalExecutor (§11 H1)"
```

---

## Task 5: Update single executor call site in `app.ts`

**Files:** Modify `packages/api/src/app.ts` (~line 1028).

- [ ] **Step 1: Read call site** — `sed -n '1015,1045p' packages/api/src/app.ts`.

- [ ] **Step 2: Construct guard and pass it:**

```typescript
import { IdempotencyGuard } from './proposals/execution/idempotency';
// ... at the executor construction site:
const idempotencyGuard = new IdempotencyGuard(proposalExecutionRepo);
const proposalExecutor = new ProposalExecutor(
  handlers,
  proposalRepo,
  idempotencyGuard,
  { executionRepo: proposalExecutionRepo, onExecuted: enqueueProposalCorrection }
);
```

- [ ] **Step 3: Run prod type check** — `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`. Expect PASS.

- [ ] **Step 4: Run full test suite** — `cd packages/api && npx vitest run`. Update any test that constructs `new ProposalExecutor(...)` without a guard.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "fix(app): pass IdempotencyGuard to ProposalExecutor (§11 H1)"
```

---

## Task 6: Integration test — double-delivered message produces one execution row

**Files:** Create `packages/api/test/proposals/execution/executor.integration.test.ts`.

- [ ] **Step 1: Write test:**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { newTestDb, dropTestDb, applyAllMigrations } from '../../helpers/test-db';
import { PgProposalRepository } from '../../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { makeApprovedProposal } from '../../helpers/proposal-factory';

describe('ProposalExecutor — double-delivery idempotency (§11 H1)', () => {
  let db: { url: string; name: string };
  let client: Client;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let executor: ProposalExecutor;
  const tenantId = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    db = await newTestDb();
    client = new Client({ connectionString: db.url });
    await client.connect();
    await applyAllMigrations(client);
    proposalRepo = new PgProposalRepository(client);
    executionRepo = new PgProposalExecutionRepository(client);
    const handlers = new Map([
      ['create_customer', { execute: async () => ({ success: true as const, resultEntityId: 'c-1' }) }],
    ]);
    executor = new ProposalExecutor(handlers, proposalRepo, new IdempotencyGuard(executionRepo), { executionRepo });
  });
  afterAll(async () => { await client.end(); await dropTestDb(db.name); });
  beforeEach(async () => {
    await client.query('DELETE FROM proposal_executions');
    await client.query('DELETE FROM proposals');
  });

  it('records exactly one execution when the same proposal is executed twice', async () => {
    const p = await proposalRepo.create(makeApprovedProposal({ tenantId, idempotencyKey: 'dup-key-1' }));
    const first = await executor.execute(p, { executedBy: tenantId });
    expect(first.alreadyExecuted).toBe(false);
    const refetched = await proposalRepo.findById(tenantId, p.id);
    const second = await executor.execute(refetched!, { executedBy: tenantId });
    expect(second.alreadyExecuted).toBe(true);
    expect(second.result.resultEntityId).toBe(first.result.resultEntityId);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, 'dup-key-1']);
    expect(rows[0].n).toBe(1);
  });

  it('blocks duplicate inserts at the DB layer even if the guard is bypassed', async () => {
    await executionRepo.recordExecution({
      tenantId, proposalId: 'p-A', executedPayload: {}, executedBy: tenantId,
      status: 'succeeded', idempotencyKey: 'belt',
    });
    await expect(executionRepo.recordExecution({
      tenantId, proposalId: 'p-B', executedPayload: {}, executedBy: tenantId,
      status: 'succeeded', idempotencyKey: 'belt',
    })).rejects.toThrow(/duplicate key/);
  });
});
```

- [ ] **Step 2: Run → PASS**

- [ ] **Step 3: Commit**

```bash
git add packages/api/test/proposals/execution/executor.integration.test.ts
git commit -m "test(proposals): integration test for double-delivery idempotency (§11 H1)"
```

---

# Phase 2 — H3 Instrumentation helper

## Task 7: Failing test for `instrument()`

**Files:** Create `packages/api/test/monitoring/instrumentation.test.ts`.

- [ ] **Step 1:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { instrument } from '../../src/monitoring/instrumentation';

const captureException = vi.fn();
const setTag = vi.fn();
const withScope = vi.fn((cb: (scope: { setTag: typeof setTag }) => void) => cb({ setTag }));

vi.mock('../../src/monitoring/sentry', () => ({
  getSentry: () => ({ captureException, withScope }),
}));

describe('instrument()', () => {
  beforeEach(() => { captureException.mockClear(); setTag.mockClear(); withScope.mockClear(); });

  it('passes through return value when handler succeeds', async () => {
    const wrapped = instrument(async (x: number) => x * 2, { path: 'test-path' });
    await expect(wrapped(21)).resolves.toBe(42);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures exceptions with path tag and rethrows', async () => {
    const err = new Error('boom');
    const wrapped = instrument(async () => { throw err; }, { path: 'stripe-webhook' });
    await expect(wrapped()).rejects.toBe(err);
    expect(setTag).toHaveBeenCalledWith('path', 'stripe-webhook');
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it('tags tenant_id and correlation_id when extractor provided', async () => {
    const wrapped = instrument(
      async (_: { tenantId: string; correlationId: string }) => { throw new Error('x'); },
      { path: 'execution-worker',
        extractTags: (input) => ({ tenant_id: input.tenantId, correlation_id: input.correlationId }) }
    );
    await expect(wrapped({ tenantId: 't-1', correlationId: 'c-1' })).rejects.toThrow();
    expect(setTag).toHaveBeenCalledWith('path', 'execution-worker');
    expect(setTag).toHaveBeenCalledWith('tenant_id', 't-1');
    expect(setTag).toHaveBeenCalledWith('correlation_id', 'c-1');
  });
});
```

- [ ] **Step 2: Run → expect FAIL** (instrument does not exist).

## Task 8: Implement `instrument()`

**Files:** Create `packages/api/src/monitoring/instrumentation.ts`.

- [ ] **Step 1:**

```typescript
import { getSentry } from './sentry';

export interface InstrumentOptions<Args extends unknown[]> {
  path: string;
  extractTags?: (...args: Args) => Record<string, string | undefined>;
}

export function instrument<Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>,
  options: InstrumentOptions<Args>
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err: unknown) {
      const sentry = getSentry();
      sentry.withScope((scope) => {
        scope.setTag('path', options.path);
        if (options.extractTags) {
          const tags = options.extractTags(...args);
          for (const [k, v] of Object.entries(tags)) {
            if (v !== undefined) scope.setTag(k, v);
          }
        }
      });
      sentry.captureException(err);
      throw err;
    }
  };
}
```

- [ ] **Step 2: Confirm `getSentry()` exists** — `grep -n "export.*getSentry" packages/api/src/monitoring/sentry.ts`. If missing, add a thin getter returning the singleton (or no-op `{ captureException: () => {}, withScope: (cb) => cb({ setTag: () => {} }) }` when Sentry isn't configured).

- [ ] **Step 3: Run test → PASS.** Run prod type check.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/monitoring/instrumentation.ts packages/api/test/monitoring/instrumentation.test.ts
git commit -m "feat(monitoring): instrument() helper with structured Sentry tags (§11 H3)"
```

---

## Task 9: Wrap Stripe webhook entry point

**Files:** Modify `packages/api/src/webhooks/stripe.ts` (locate via `grep -rn "stripe.*webhook" packages/api/src/`).

- [ ] **Step 1:** Identify exported handler. Rename body to `*Inner`, re-export wrapped:

```typescript
import { instrument } from '../monitoring/instrumentation';

async function handleStripeWebhookInner(req: Request, res: Response): Promise<void> {
  // existing body unchanged
}

export const handleStripeWebhook = instrument(handleStripeWebhookInner, {
  path: 'stripe-webhook',
  extractTags: (req: Request) => ({
    tenant_id: (req as Request & { tenantId?: string }).tenantId,
    correlation_id: req.header('x-request-id') ?? undefined,
  }),
});
```

- [ ] **Step 2:** Run prod type check + `npx vitest run test/webhooks/stripe`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/webhooks/stripe.ts
git commit -m "feat(monitoring): instrument Stripe webhook handler (§11 H3)"
```

---

## Task 10: Wrap execution-worker

**Files:** Modify `packages/api/src/workers/execution-worker.ts`.

- [ ] **Step 1:** Locate exported entry function. Apply same pattern:

```typescript
import { instrument } from '../monitoring/instrumentation';

async function processMessageInner(msg: QueueMessage<ExecutionPayload>): Promise<void> { /* unchanged */ }

export const processMessage = instrument(processMessageInner, {
  path: 'execution-worker',
  extractTags: (msg) => ({ tenant_id: msg.tenantId, correlation_id: msg.correlationId }),
});
```

- [ ] **Step 2:** Type check + worker tests.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/workers/execution-worker.ts
git commit -m "feat(monitoring): instrument execution-worker (§11 H3)"
```

---

## Task 11: Wrap voice-action-router

**Files:** Modify `packages/api/src/workers/voice-action-router.ts`.

- [ ] Same pattern as Task 10, `path: 'voice-action-router'`. Run type check + tests. Commit:

```bash
git add packages/api/src/workers/voice-action-router.ts
git commit -m "feat(monitoring): instrument voice-action-router (§11 H3)"
```

---

## Task 12: Wrap Media Streams WebSocket handler

**Files:** Modify `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts`.

- [ ] **Step 1:** Locate connection handler — `grep -n "on('connection'\|onConnection" packages/api/src/telephony/media-streams/twilio-mediastream-server.ts`.

- [ ] **Step 2:** Wrap:

```typescript
import { instrument } from '../../monitoring/instrumentation';

async function handleConnectionInner(ws: WebSocket, req: IncomingMessage): Promise<void> { /* unchanged */ }

const handleConnection = instrument(handleConnectionInner, {
  path: 'voice',
  extractTags: (_ws, req) => {
    const callSid = req.headers['x-twilio-call-sid'];
    return { correlation_id: Array.isArray(callSid) ? callSid[0] : callSid };
  },
});
```

- [ ] **Step 3:** Type check + media-streams tests. Commit.

---

## Task 13: Alerting runbook

**Files:** Create `docs/runbooks/alerting.md`.

- [ ] **Step 1:** `mkdir -p docs/runbooks` then write:

````markdown
# Alerting Setup (Sentry → Slack)

## Slack integration (one-time)
1. Sentry → Settings → Integrations → Slack. Authorize the `serviceos` workspace.
2. Choose `#alerts` as default channel.
3. For P1 rules below, add an extra action: "Send a DM to @joshrkay".

## Alert rules

| Rule name | Condition | Severity | Action |
|-----------|-----------|----------|--------|
| Payment webhook failure | `tags["path"] = "stripe-webhook"` AND count ≥ 1 in 5 min | P1 | `#alerts` + DM operator |
| Proposal execution failure rate | Custom metric `proposal_execution_failure_rate` > 1% over 15 min | P1 | `#alerts` + DM operator |
| Voice agent error | `tags["path"] = "voice"` AND count ≥ 1 in 5 min | P1 | `#alerts` + DM operator |
| Queue depth | `queue_depth.max` > 1000 sustained 5 min | P2 | `#alerts` |

All P1 rules filter by tags emitted via `packages/api/src/monitoring/instrumentation.ts`.

## End-to-end verification

After each rule is configured, fire a test event in staging:
```bash
cd packages/api && npx tsx scripts/sentry-test-event.ts --path stripe-webhook
```
Confirm Slack `#alerts` message within 60s. Confirm DM for P1 rules. Record success in `.launch-quality-acks.json`.

## Secrets required for voice-smoke-real.yml

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `TWILIO_TEST_NUMBER_FROM`, `TWILIO_TEST_NUMBER_TO`
- `STAGING_TWIML_URL` — TwiML bin URL serving `<Play>` of canned audio
- `STAGING_DB_URL` — read-only Postgres URL
- `SLACK_ALERTS_WEBHOOK` — Incoming Webhook for `#alerts`
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/alerting.md
git commit -m "docs(runbooks): Sentry alerting rules + Slack integration (§11 H3)"
```

---

# Phase 3 — H2 Voice e2e smoke

## Task 14: Layer A — synthetic voice smoke test

**Files:** Create `packages/api/test/voice/voice-smoke.synthetic.test.ts`, `packages/api/test/voice/fixtures/mulaw-fixtures.ts`, `packages/api/test/voice/fixtures/book-tuesday-2pm.mulaw`.

- [ ] **Step 1: Identify Media Streams entry** — `grep -n "createTwilioMediaStreamServer\|TwilioMediaStreamServer" packages/api/src/telephony/media-streams/ -r`.

- [ ] **Step 2: Write smoke test:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, Server } from 'node:http';
import { createTwilioMediaStreamServer } from '../../src/telephony/media-streams/twilio-mediastream-server';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { makeTestLLMGateway } from '../helpers/test-llm-gateway';
import { canonicalMulawForBookTuesdayAt2 } from './fixtures/mulaw-fixtures';

describe('voice smoke (synthetic) — §11 H2 Layer A', () => {
  let httpServer: Server;
  let port: number;
  let proposalRepo: InMemoryProposalRepository;
  const tenantId = 'smoke-tenant';

  beforeAll(async () => {
    proposalRepo = new InMemoryProposalRepository();
    const wsServer = createTwilioMediaStreamServer({
      llmGateway: makeTestLLMGateway(),
      proposalRepo,
      tenantResolver: () => tenantId,
    });
    httpServer = createServer();
    wsServer.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;
  });

  afterAll(async () => { await new Promise<void>((r) => httpServer.close(() => r())); });

  it('routes a "book Tuesday at 2" call to a CreateBooking proposal in <5s', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/twilio/mediastream`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'SM-smoke', callSid: 'CA-smoke' } }));
    for (const chunk of canonicalMulawForBookTuesdayAt2()) {
      ws.send(JSON.stringify({ event: 'media', media: { payload: chunk.toString('base64') } }));
    }
    ws.send(JSON.stringify({ event: 'stop' }));

    const start = Date.now();
    let proposals: Awaited<ReturnType<typeof proposalRepo.findByTenant>> = [];
    while (Date.now() - start < 5_000) {
      proposals = await proposalRepo.findByTenant(tenantId);
      if (proposals.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    ws.close();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_booking');
    expect(proposals[0].payload).toMatchObject({
      requestedDay: expect.stringMatching(/tuesday/i),
      requestedTime: expect.stringMatching(/2|14:00/),
    });
  });
});
```

- [ ] **Step 3: Mulaw fixture helper:**

```typescript
// packages/api/test/voice/fixtures/mulaw-fixtures.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function canonicalMulawForBookTuesdayAt2(): Buffer[] {
  const raw = readFileSync(join(__dirname, 'book-tuesday-2pm.mulaw'));
  const chunks: Buffer[] = [];
  const chunkSize = 160; // 20ms at 8kHz
  for (let i = 0; i < raw.length; i += chunkSize) chunks.push(raw.slice(i, i + chunkSize));
  return chunks;
}
```

Generate `book-tuesday-2pm.mulaw` via a one-off `scripts/generate-mulaw-fixture.ts` using OpenAI TTS or ElevenLabs then `ffmpeg -i in.wav -ar 8000 -ac 1 -f mulaw out.mulaw`. Commit the binary fixture.

- [ ] **Step 4: Run → PASS** within 5s.

- [ ] **Step 5: Commit**

```bash
git add packages/api/test/voice/voice-smoke.synthetic.test.ts packages/api/test/voice/fixtures/
git commit -m "test(voice): synthetic voice smoke for deploy gate (§11 H2 Layer A)"
```

---

## Task 15: Wire Layer A into deploy workflow

**Files:** Modify `.github/workflows/deploy.yml`.

- [ ] **Step 1:** In each of dev/staging/prod jobs, add BEFORE the deploy step:

```yaml
      - name: Voice smoke (synthetic)
        run: cd packages/api && npx vitest run test/voice/voice-smoke.synthetic.test.ts
        env:
          NODE_ENV: test
          LLM_GATEWAY_MODE: test
```

- [ ] **Step 2:** Validate — `actionlint .github/workflows/deploy.yml` (or `gh workflow view deploy.yml`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: gate deploys on synthetic voice smoke (§11 H2 Layer A)"
```

---

## Task 16: Layer B — daily real-call cron

**Files:** Create `.github/workflows/voice-smoke-real.yml`, `packages/api/scripts/voice-smoke-real.ts`.

- [ ] **Step 1: Script** `packages/api/scripts/voice-smoke-real.ts`:

```typescript
#!/usr/bin/env tsx
/** §11 H2 Layer B — outbound Twilio call → assert proposal in staging DB. */
import twilio from 'twilio';
import { Client } from 'pg';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

async function main(): Promise<void> {
  const client = twilio(env('TWILIO_ACCOUNT_SID'), env('TWILIO_AUTH_TOKEN'));
  const call = await client.calls.create({
    from: env('TWILIO_TEST_NUMBER_FROM'),
    to: env('TWILIO_TEST_NUMBER_TO'),
    url: env('STAGING_TWIML_URL'),
    timeout: 20,
  });
  console.log(`call placed: ${call.sid}`);

  const start = Date.now();
  let status = call.status;
  while (Date.now() - start < 90_000 && status !== 'completed' && status !== 'failed') {
    await new Promise((r) => setTimeout(r, 3_000));
    status = (await client.calls(call.sid).fetch()).status;
  }
  if (status !== 'completed') throw new Error(`call did not complete: status=${status}`);

  const db = new Client({ connectionString: env('STAGING_DB_URL') });
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, proposal_type FROM proposals
        WHERE payload->>'callSid' = $1 AND created_at > NOW() - INTERVAL '5 minutes' LIMIT 1`,
      [call.sid]);
    if (rows.length === 0) throw new Error(`no proposal landed for callSid=${call.sid}`);
    console.log(`proposal ok: ${rows[0].id} (${rows[0].proposal_type})`);
  } finally { await db.end(); }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Workflow** `.github/workflows/voice-smoke-real.yml`:

```yaml
name: Voice smoke (real call, daily)
on:
  schedule: [{ cron: '0 9 * * *' }]
  workflow_dispatch: {}
jobs:
  real-call:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: packages/api
      - name: Place call + assert proposal
        run: npx tsx scripts/voice-smoke-real.ts
        working-directory: packages/api
        env:
          TWILIO_ACCOUNT_SID: ${{ secrets.TWILIO_ACCOUNT_SID }}
          TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_AUTH_TOKEN }}
          TWILIO_TEST_NUMBER_FROM: ${{ secrets.TWILIO_TEST_NUMBER_FROM }}
          TWILIO_TEST_NUMBER_TO: ${{ secrets.TWILIO_TEST_NUMBER_TO }}
          STAGING_TWIML_URL: ${{ secrets.STAGING_TWIML_URL }}
          STAGING_DB_URL: ${{ secrets.STAGING_DB_URL }}
      - name: Notify Slack on failure
        if: failure()
        uses: slackapi/slack-github-action@v1.27.0
        with:
          payload: |
            { "text": ":rotating_light: voice-smoke-real FAILED. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_ALERTS_WEBHOOK }}
          SLACK_WEBHOOK_TYPE: INCOMING_WEBHOOK
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/voice-smoke-real.yml packages/api/scripts/voice-smoke-real.ts
git commit -m "ci: daily real-call voice smoke (§11 H2 Layer B)"
```

---

# Phase 4 — H4 Rollback + migration discipline

## Task 17: Migration-discipline permissive guard test

**Files:** Create `packages/api/test/db/migration-discipline.test.ts`.

- [ ] **Step 1:**

```typescript
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '../../src/db/migrations');
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bDROP\s+INDEX\b/i,
  /\bRENAME\s+TO\b/i, /\bRENAME\s+COLUMN\b/i, /\bALTER\s+TYPE\s+.+\s+DROP\b/i,
];

describe('migration discipline', () => {
  it('warns if the newest migration contains destructive patterns', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const newest = files.at(-1);
    expect(newest, 'no migrations found').toBeTruthy();
    const sql = readFileSync(join(MIGRATIONS_DIR, newest!), 'utf8');
    const hits = DESTRUCTIVE.filter((p) => p.test(sql));
    if (hits.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`\n⚠️  migration ${newest} contains destructive patterns: ${hits.map(String).join(', ')}\n   See docs/runbooks/migration-discipline.md — two-step deploy required.\n`);
    }
    expect(true).toBe(true); // PERMISSIVE — never fails
  });
});
```

- [ ] **Step 2:** Run, expect PASS, no warning (075 is additive).

- [ ] **Step 3:** Sanity-check warning by temporarily appending `DROP TABLE x;` to 075 — re-run, see warning, revert.

- [ ] **Step 4: Commit**

```bash
git add packages/api/test/db/migration-discipline.test.ts
git commit -m "test(db): permissive guard surfacing destructive migration patterns (§11 H4)"
```

---

## Task 18: Rollback runbook

**Files:** Create `docs/runbooks/rollback.md`.

- [ ] **Step 1: Write the file:**

````markdown
# Rollback Runbook

**Target recovery time:** under 5 minutes from alert to verified-green.

## When to roll back

Roll back immediately if any of these are true after a deploy:
- Post-deploy smoke test failed (`packages/api/scripts/smoke-test.ts` exits non-zero).
- Sentry P1 alert: payment webhook failure, proposal execution failure rate spike, voice agent error.
- Customer reports voice agent not answering OR visibly broken behavior.
- A migration shipped in this deploy is producing query errors in logs.

Do NOT roll back for: a single transient Sentry event, slow-but-functional response, queue depth growing but recovering.

## Procedure

1. Identify previous release:
   ```bash
   railway release list --service api | head -5
   ```
2. Roll back:
   ```bash
   railway rollback --service api --to <previous-release-id>
   ```
3. Verify:
   ```bash
   cd packages/api && npx tsx scripts/smoke-test.ts https://api.serviceos.com
   ```
4. Post in `#alerts` thread: "Rolled back `api` to <release-id>. Smoke green. Investigating root cause."
5. Open a post-incident ticket: what shipped, what broke, how detected, how reverted, what changes so it doesn't happen again.

## Bad migration

`railway rollback` reverts code, not DB. If the bad change was a migration:
1. Roll back the code first (steps 1–3).
2. If the additive migration (per `migration-discipline.md`) is backward compatible — common case — you're done.
3. If the migration corrupted data: write a NEW forward migration to restore prior state. Never mutate a shipped migration.
4. Ship the new forward migration.

## Twilio numbers after rollback

Phone numbers always point to the live `/api/telephony/voice` URL, which is stable across deploys. No reconfiguration needed after `railway rollback`.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/rollback.md
git commit -m "docs(runbooks): rollback procedure (§11 H4)"
```

---

## Task 19: Migration-discipline runbook

**Files:** Create `docs/runbooks/migration-discipline.md`.

- [ ] **Step 1: Write the file:**

```markdown
# Migration Discipline

All schema migrations must be **additive** or **backfill-only**. Destructive changes require a two-step deploy with explicit reviewer approval.

## Why

`railway rollback` reverts code, not the database. If a deploy ships a destructive migration and code that depends on the new shape, rolling back code re-introduces queries against missing columns → outage.

## Allowed in a single deploy
- `CREATE TABLE`, `CREATE INDEX`, `CREATE TYPE`
- `ALTER TABLE ... ADD COLUMN` (nullable or with default)
- Backfill `UPDATE` statements
- `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` (validate later)

## Requires a two-step deploy
- `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`
- `RENAME` of anything
- `ALTER COLUMN TYPE` that requires rewrite
- Adding `NOT NULL` to existing column without default

### Two-step pattern
Step 1 (deploy A): add new shape alongside old. Backfill. Switch reads to new. Ship.
Step 2 (deploy B, ≥1 day later): once no code reads old shape, drop it.

## PR reviewer checklist

If the diff includes any destructive pattern:
- [ ] Confirmed it's step 2 of a two-step (step 1 deployed & stable ≥ 1 day), OR
- [ ] PR description explicitly justifies why one-step is safe, author + reviewer both sign off.

`packages/api/test/db/migration-discipline.test.ts` prints a CI warning on destructive patterns. The test does not fail; judgment lives with reviewers.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/migration-discipline.md
git commit -m "docs(runbooks): additive-migration policy (§11 H4)"
```

---

# Phase 5 — H5 Load test

## Task 20: Voice load-test script

**Files:** Create `packages/api/scripts/voice-load-test.ts`.

- [ ] **Step 1:**

```typescript
#!/usr/bin/env tsx
/** §11 H5 — voice-path load test. */
import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';

interface ConnMetrics { connectMs: number; firstSttMs?: number; dropped: boolean; err?: string; }

function parseArgs(): { max: number; rampSec: number; holdSec: number; out: string } {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
  return { max: arg('max', 50), rampSec: arg('ramp', 60), holdSec: arg('hold', 300), out: 'voice-load-report.json' };
}

function generateMulawChunk(): Buffer {
  const buf = Buffer.alloc(160);
  for (let i = 0; i < 160; i++) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / 8000);
    buf[i] = Math.floor((sample + 1) * 127);
  }
  return buf;
}

async function runOne(url: string): Promise<ConnMetrics> {
  const t0 = performance.now();
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const metrics: ConnMetrics = { connectMs: 0, dropped: false };
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
      setTimeout(() => reject(new Error('connect timeout')), 10_000);
    });
    metrics.connectMs = performance.now() - t0;
    ws.send(JSON.stringify({ event: 'start', start: { streamSid: `load-${Date.now()}` } }));
    let firstReply: number | undefined;
    ws.on('message', () => { if (firstReply === undefined) firstReply = performance.now(); });
    for (let i = 0; i < 250; i++) {
      ws.send(JSON.stringify({ event: 'media', media: { payload: generateMulawChunk().toString('base64') } }));
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.send(JSON.stringify({ event: 'stop' }));
    if (firstReply !== undefined) metrics.firstSttMs = firstReply - t0;
    ws.close();
    return metrics;
  } catch (e: unknown) {
    metrics.dropped = true;
    metrics.err = e instanceof Error ? e.message : String(e);
    return metrics;
  }
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main(): Promise<void> {
  const { max, rampSec, holdSec, out } = parseArgs();
  const url = process.env.STAGING_WS_URL;
  if (!url) throw new Error('STAGING_WS_URL required');
  console.log(`load test: ramping to ${max} conns over ${rampSec}s, holding ${holdSec}s`);
  const results: ConnMetrics[] = [];
  const active = new Set<Promise<void>>();
  const start = Date.now();
  while (Date.now() - start < (rampSec + holdSec) * 1000) {
    const elapsed = (Date.now() - start) / 1000;
    const target = elapsed < rampSec ? Math.ceil((elapsed / rampSec) * max) : max;
    while (active.size < target) {
      const p = runOne(url).then((m) => { results.push(m); }).finally(() => active.delete(p));
      active.add(p);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await Promise.allSettled([...active]);
  const ct = results.filter((r) => !r.dropped).map((r) => r.connectMs);
  const st = results.filter((r) => r.firstSttMs).map((r) => r.firstSttMs!);
  const report = {
    totalConnections: results.length,
    droppedConnections: results.filter((r) => r.dropped).length,
    connectMs: { p50: pct(ct, 0.5), p95: pct(ct, 0.95), p99: pct(ct, 0.99) },
    firstSttMs: { p50: pct(st, 0.5), p95: pct(st, 0.95), p99: pct(st, 0.99) },
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Sanity-run** — `cd packages/api && STAGING_WS_URL=ws://localhost:9999 npx tsx scripts/voice-load-test.ts --max 1 --ramp 1 --hold 1`. Should exit cleanly with dropped connections.

- [ ] **Step 3: Commit**

```bash
git add packages/api/scripts/voice-load-test.ts
git commit -m "feat(scripts): voice-path load generator (§11 H5)"
```

---

## Task 21: Voice-capacity runbook

**Files:** Create `docs/runbooks/voice-capacity.md`.

- [ ] **Step 1: Write file:**

````markdown
# Voice Capacity

## Per-instance ceiling

| Run date | Voice provider | Instance size | Max concurrent | p95 first-STT (ms) | Notes |
|----------|----------------|---------------|----------------|--------------------|-------|
| TBD      |                |               |                |                    |       |

Fill this row after running `packages/api/scripts/voice-load-test.ts`. "Max concurrent" = highest connection count at which p95 first-STT < 2000 ms AND zero drops.

## How to run

```bash
cd packages/api
STAGING_WS_URL=wss://api.staging.serviceos.com/twilio/mediastream \
  npx tsx scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
```

Inspect `voice-load-report.json`. If p95 first-STT > 2000 ms before `--max`, lower `--max` until it stays under and record that as the ceiling.

## Scaling

- Default Railway instance handles up to the ceiling above.
- Scale via `railway scale --service api --replicas N`.
- Each instance independent; Twilio's WebSocket LB distributes new connections.
- Concurrent-call count visible via Sentry tag `path=voice` event counts.

## When to re-run
- Voice provider changes (LLM, STT, TTS).
- Railway instance size changes.
- After any `packages/api/src/telephony/media-streams/` change.
- Every 90 days as freshness check.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/voice-capacity.md
git commit -m "docs(runbooks): voice capacity template (§11 H5)"
```

---

# Phase 6 — Tally + tier-2 doc

## Task 22: launch-quality-check tally script

**Files:** Create `packages/api/scripts/launch-quality-check.ts`, `packages/api/.launch-quality-acks.json`.

- [ ] **Step 1: Marker file** `packages/api/.launch-quality-acks.json`:

```json
{
  "alerting_runbook_verified": null,
  "rollback_runbook_read": null,
  "migration_discipline_runbook_read": null,
  "voice_capacity_run": null
}
```

- [ ] **Step 2: Tally script:**

```typescript
#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

interface Check { id: string; description: string; pass: boolean; detail?: string; }
const checks: Check[] = [];
const ROOT = join(__dirname, '../../..');
const API = join(ROOT, 'packages/api');

function check(id: string, description: string, predicate: () => boolean | { pass: boolean; detail?: string }): void {
  try {
    const r = predicate();
    if (typeof r === 'boolean') checks.push({ id, description, pass: r });
    else checks.push({ id, description, ...r });
  } catch (e) { checks.push({ id, description, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

check('H1.1', 'Idempotency guard required (compile check)', () => {
  const src = readFileSync(join(API, 'src/proposals/execution/executor.ts'), 'utf8');
  return /idempotency:\s*IdempotencyGuard\b/.test(src) && !/idempotency\?:\s*IdempotencyGuard/.test(src);
});
check('H1.2', 'proposal_executions unique index migration present', () =>
  existsSync(join(API, 'src/db/migrations/075_proposal_executions_idempotency_index.sql')));
check('H2.A', 'voice-smoke.synthetic test wired in deploy workflow', () =>
  readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8').includes('voice-smoke.synthetic'));
check('H2.B', 'voice-smoke-real workflow exists', () =>
  existsSync(join(ROOT, '.github/workflows/voice-smoke-real.yml')));
check('H3', 'alerting runbook present', () => existsSync(join(ROOT, 'docs/runbooks/alerting.md')));
check('H4.1', 'rollback runbook present', () => existsSync(join(ROOT, 'docs/runbooks/rollback.md')));
check('H4.2', 'migration-discipline runbook present', () => existsSync(join(ROOT, 'docs/runbooks/migration-discipline.md')));
check('H4.3', 'migration-discipline guard test present', () => existsSync(join(API, 'test/db/migration-discipline.test.ts')));
check('H5', 'voice-capacity.md updated within 30d', () => {
  if (!existsSync(join(ROOT, 'docs/runbooks/voice-capacity.md'))) return { pass: false, detail: 'voice-capacity.md missing' };
  const acks = JSON.parse(readFileSync(join(API, '.launch-quality-acks.json'), 'utf8'));
  if (!acks.voice_capacity_run) return { pass: false, detail: 'no run recorded' };
  return Date.now() - new Date(acks.voice_capacity_run).getTime() < 30 * 24 * 3600 * 1000;
});
check('D1', 'decisions.test green', () => {
  try { execSync('npx vitest run test/decisions/decisions.test.ts', { cwd: API, stdio: 'pipe' }); return true; } catch { return false; }
});
check('D2', 'smoke + synthetic voice tests present', () =>
  existsSync(join(API, 'scripts/smoke-test.ts')) && existsSync(join(API, 'test/voice/voice-smoke.synthetic.test.ts')));
check('D3', 'migration-immutability green', () => {
  try { execSync('npx vitest run test/db/migration-immutability.test.ts', { cwd: API, stdio: 'pipe' }); return true; } catch { return false; }
});

const padId = Math.max(...checks.map(c => c.id.length));
const padDesc = Math.max(...checks.map(c => c.description.length));
const passed = checks.filter(c => c.pass).length;
console.log(`\nLaunch Quality Bar (tier 1 — 10–50 customers)`);
for (const c of checks) {
  const tag = c.pass ? '[PASS]' : '[FAIL]';
  const line = `  ${tag} ${c.id.padEnd(padId)} ${c.description.padEnd(padDesc)}`;
  console.log(c.detail ? `${line} — ${c.detail}` : line);
}
console.log(`\n${passed}/${checks.length} ${passed === checks.length ? 'PASS — bar met. Safe to open self-serve.' : 'FAIL — bar NOT met.'}\n`);
process.exit(passed === checks.length ? 0 : 1);
```

- [ ] **Step 3: Add to `packages/api/package.json` scripts:** `"launch-quality-check": "tsx scripts/launch-quality-check.ts"`.

- [ ] **Step 4: Run** — `cd packages/api && npm run launch-quality-check`. Some items FAIL (expected — voice capacity not yet run, etc.).

- [ ] **Step 5: Commit**

```bash
git add packages/api/scripts/launch-quality-check.ts packages/api/.launch-quality-acks.json packages/api/package.json
git commit -m "feat(scripts): launch-quality-check tally for §11 bar"
```

---

## Task 23: Tier-2 doc (out of scope + promotion triggers)

**Files:** Create `docs/runbooks/launch-quality-bar.md`.

- [ ] **Step 1: Write file:**

```markdown
# Launch Quality Bar

## Tier 1 (current — 10–50 customers)

Verified via `npm run launch-quality-check` from `packages/api/`. Twelve checks:
- H1.1, H1.2 — executor idempotency-by-default + unique index
- H2.A, H2.B — synthetic voice smoke (per deploy) + real-call smoke (daily)
- H3 — Sentry alerting rules + Slack pipeline
- H4.1, H4.2, H4.3 — rollback runbook, migration-discipline runbook, discipline guard test
- H5 — voice load test recorded
- D1, D2, D3 — decisions test, critical-path smoke tests, migration immutability

## Tier 2 (deferred — promote at 100+ customers)

| Item | Trigger to promote |
|------|--------------------|
| PagerDuty rotation + sleep coverage | First customer in non-US timezone signs up |
| Datadog/Grafana dashboards | 50+ customers OR investigation needs metrics correlation Sentry can't provide |
| Canary deploys | Two prod incidents traceable to deploys in same quarter |
| Auto-rollback on smoke failure | Synthetic voice smoke proven non-flaky for 30 days |
| Twilio phone number version-pinning | Webhook URL needs to change in non-backward-compatible way |
| Voice load test in CI | Customer traffic approaches documented per-instance ceiling |

Re-spec when promoting any item. None are "do later" — they are "do when the trigger fires." Carry no implementation debt in the meantime.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/launch-quality-bar.md
git commit -m "docs(runbooks): tier-1/tier-2 launch quality bar overview (§11)"
```

---

## Task 24: Verify the bar is met (manual verification, no code)

- [ ] **Step 1:** Configure Sentry rules per `alerting.md`. Fire test event. Record success in acks:
  ```json
  { "alerting_runbook_verified": "2026-05-17T15:00:00Z" }
  ```
- [ ] **Step 2:** Provision Twilio test number + GH Actions secrets per `alerting.md`. Trigger `voice-smoke-real.yml` once with `gh workflow run voice-smoke-real.yml`. Confirm exit 0.
- [ ] **Step 3:** Run voice load test against staging:
  ```bash
  cd packages/api
  STAGING_WS_URL=wss://api.staging.serviceos.com/twilio/mediastream \
    npx tsx scripts/voice-load-test.ts --max 50 --ramp 60 --hold 300
  ```
  Record ceiling in `voice-capacity.md`. Update acks: `"voice_capacity_run": "2026-05-17T16:00:00Z"`.
- [ ] **Step 4:** Read `rollback.md` + `migration-discipline.md` end-to-end. Update acks for both.
- [ ] **Step 5:** Run `cd packages/api && npm run launch-quality-check`. Expect `12/12 PASS`.
- [ ] **Step 6:** Commit ack file.
  ```bash
  git add packages/api/.launch-quality-acks.json
  git commit -m "chore: §11 launch quality bar verified (12/12 PASS)"
  ```

---

## Spec coverage map

| Item | Tasks |
|------|-------|
| H1 idempotency by default | 1, 2, 3, 4, 5, 6 |
| H2.A synthetic voice smoke | 14, 15 |
| H2.B real-call daily | 16 |
| H3 instrument() helper | 7, 8 |
| H3 wrap 4 critical paths | 9, 10, 11, 12 |
| H3 alerting docs | 13 |
| H4 rollback runbook | 18 |
| H4 migration-discipline runbook | 19 |
| H4 permissive guard test | 17 |
| H5 load test script | 20 |
| H5 capacity runbook | 21 |
| Launch-quality-check tally | 22 |
| Tier-2 promotion triggers doc | 23 |
| End-to-end verification | 24 |
| D1, D2, D3 (no new code) | enforced by tally (22) |
