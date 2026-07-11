import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import {
  createProposal,
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../../src/proposals/execution/idempotency';
import { IdempotencyLockProvider } from '../../../src/proposals/execution/idempotency-lock';
import {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from '../../../src/proposals/execution/handlers';

/**
 * PR #666 (Gemini HIGH) — routing unit test.
 *
 * The executor must run a DB-only handler's execute() INSIDE the executor
 * transaction (between BEGIN and COMMIT on the advisory-lock connection), and an
 * external-I/O handler's execute() OUTSIDE it (before BEGIN), wrapping only the
 * idempotency record + status transition in the transaction.
 *
 * We prove the routing by handing the guard a lock provider whose connection
 * records BEGIN/COMMIT/ROLLBACK, and having the stub handlers record when
 * execute() runs, into ONE shared event log. The RELATIVE position of
 * `handler.execute` vs `BEGIN` is the observable difference between the two
 * paths — no real Postgres required.
 */

const events: string[] = [];

/** Records only the transaction-control statements the executor issues. */
class RecordingClient {
  async query(sql: unknown): Promise<{ rows: unknown[] }> {
    if (typeof sql === 'string') {
      const s = sql.trim().toUpperCase();
      if (s.startsWith('BEGIN')) events.push('BEGIN');
      else if (s.startsWith('COMMIT')) events.push('COMMIT');
      else if (s.startsWith('ROLLBACK')) events.push('ROLLBACK');
    }
    return { rows: [] };
  }
  release(): void {
    /* no-op */
  }
}

/** Lock provider that OWNS a (fake) connection, exercising the tx paths. */
class RecordingLockProvider implements IdempotencyLockProvider {
  async withLock<T>(
    _tenantId: string,
    _idempotencyKey: string,
    fn: (client?: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = new RecordingClient() as unknown as PoolClient;
    return fn(client);
  }
}

class DbOnlyStubHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';
  public invocations = 0;
  async execute(): Promise<ExecutionResult> {
    this.invocations += 1;
    events.push('handler.execute');
    return { success: true, resultEntityId: 'entity-db-only' };
  }
}

class ExternalIoStubHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';
  performsExternalIo = true;
  public invocations = 0;
  async execute(): Promise<ExecutionResult> {
    this.invocations += 1;
    events.push('handler.execute');
    return { success: true, resultEntityId: 'entity-external-io' };
  }
}

function makeApprovedProposal(tenantId: string): Proposal {
  let proposal = createProposal({
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'Routing Test' },
    summary: 'routing',
    createdBy: 'user-1',
    idempotencyKey: `routing-${randomUUID()}`,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
  proposal = transitionProposal(proposal, 'approved', 'user-1');
  return { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
}

async function runWith(handler: ExecutionHandler): Promise<Proposal> {
  const tenantId = randomUUID();
  const repo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const guard = new IdempotencyGuard(
    executionRepo,
    repo,
    new RecordingLockProvider(),
  );
  const executor = new ProposalExecutor(
    new Map<ProposalType, ExecutionHandler>([['create_customer', handler]]),
    repo,
    guard,
    { executionRepo },
  );
  const proposal = makeApprovedProposal(tenantId);
  await repo.create(proposal);
  const ctx: ExecutionContext = { tenantId, executedBy: 'user-1' };
  const { proposal: after } = await executor.execute(proposal, ctx);
  return after;
}

describe('ProposalExecutor — DB-only vs external-I/O routing (PR #666)', () => {
  beforeEach(() => {
    events.length = 0;
  });

  it('DB-only handler: execute() runs INSIDE the executor transaction (between BEGIN and COMMIT)', async () => {
    const handler = new DbOnlyStubHandler();
    const after = await runWith(handler);

    expect(after.status).toBe('executed');
    expect(handler.invocations).toBe(1);

    const begin = events.indexOf('BEGIN');
    const exec = events.indexOf('handler.execute');
    const commit = events.indexOf('COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    // Handler ran inside the single DATA-31 transaction.
    expect(exec).toBeGreaterThan(begin);
    expect(exec).toBeLessThan(commit);
  });

  it('external-I/O handler: execute() runs OUTSIDE the executor transaction (before BEGIN)', async () => {
    const handler = new ExternalIoStubHandler();
    const after = await runWith(handler);

    expect(after.status).toBe('executed');
    expect(handler.invocations).toBe(1);

    const begin = events.indexOf('BEGIN');
    const exec = events.indexOf('handler.execute');
    const commit = events.indexOf('COMMIT');
    // The handler (its external send + domain writes) ran BEFORE the executor
    // opened its marker/status transaction.
    expect(exec).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(exec);
    // Exactly one transaction, wrapping ONLY the marker + status write.
    expect(commit).toBeGreaterThan(begin);
    expect(events.filter((e) => e === 'BEGIN')).toHaveLength(1);
  });
});
