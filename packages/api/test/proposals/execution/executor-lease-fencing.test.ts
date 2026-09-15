import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
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
import type { IdempotencyLockProvider } from '../../../src/proposals/execution/idempotency-lock';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import type { ExecutionHandler, ExecutionResult } from '../../../src/proposals/execution/handlers';
import {
  runWithSessionLease,
  watchSessionLease,
  type SessionLease,
} from '../../../src/db/session-lease';

/**
 * #1125 — ProposalExecutor Path B fences on the idempotency lock's lease.
 * Unit-level pins of the two explicit fence points (the real-Postgres
 * reproduction is test/integration/advisory-lock-fencing-1125.test.ts):
 *   - never start the external call once the lock is gone;
 *   - never write the idempotency record / status transition once it is gone.
 */

/** A lock connection that can "die": emits 'error' like pg's client does. */
class DyingLockClient extends EventEmitter {
  readonly statements: string[] = [];
  async query(sql: unknown): Promise<{ rows: unknown[] }> {
    if (typeof sql === 'string') this.statements.push(sql.trim().split(/\s+/)[0].toUpperCase());
    return { rows: [] };
  }
  release(): void {
    /* no-op */
  }
  kill(): void {
    this.emit('error', new Error('terminating connection due to administrator command'));
  }
}

/** Mirrors PgIdempotencyLockProvider's contract: client + lease, lease ambient. */
class LeasingLockProvider implements IdempotencyLockProvider {
  readonly client = new DyingLockClient();
  async withLock<T>(
    _tenantId: string,
    idempotencyKey: string,
    fn: (client?: PoolClient, lease?: SessionLease) => Promise<T>,
  ): Promise<T> {
    const client = this.client as unknown as PoolClient;
    const { lease, stopWatching } = watchSessionLease(client, `test lock ${idempotencyKey}`);
    try {
      return await runWithSessionLease(lease, () => fn(client, lease));
    } finally {
      stopWatching();
    }
  }
}

function approvedProposal(tenantId: string): Proposal {
  let proposal = createProposal({
    tenantId,
    proposalType: 'create_customer',
    payload: { name: 'Lease Test' },
    summary: 'lease',
    createdBy: 'user-1',
    idempotencyKey: `lease-${randomUUID()}`,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
  proposal = transitionProposal(proposal, 'approved', 'user-1');
  return { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
}

async function setup(handler: ExecutionHandler, lock: LeasingLockProvider) {
  const tenantId = randomUUID();
  const repo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const executor = new ProposalExecutor(
    new Map<ProposalType, ExecutionHandler>([['create_customer', handler]]),
    repo,
    new IdempotencyGuard(executionRepo, repo, lock),
    new InMemoryAuditRepository(),
    { executionRepo },
  );
  const proposal = approvedProposal(tenantId);
  await repo.create(proposal);
  return { tenantId, repo, executionRepo, executor, proposal, ctx: { tenantId, executedBy: 'user-1' } };
}

describe('#1125 — ProposalExecutor Path B fences on the idempotency lock lease', () => {
  it('lease already lost before handler.execute(): the external call never starts and nothing is recorded', async () => {
    const lock = new LeasingLockProvider();
    let calls = 0;
    const handler: ExecutionHandler = {
      proposalType: 'create_customer',
      performsExternalIo: true,
      async execute(): Promise<ExecutionResult> {
        calls += 1;
        return { success: true, resultEntityId: 'sent' };
      },
    };
    // The guard's idempotency lookup is the last thing before the handler:
    // kill the lock connection right after it.
    const { executionRepo, executor, proposal, ctx, repo, tenantId } = await setup(handler, lock);
    const lookup = executionRepo.findByIdempotencyKey.bind(executionRepo);
    executionRepo.findByIdempotencyKey = async (t, k) => {
      const found = await lookup(t, k);
      lock.client.kill();
      return found;
    };

    await expect(executor.execute(proposal, ctx)).rejects.toMatchObject({ code: 'SESSION_LEASE_LOST' });
    expect(calls).toBe(0);
    expect(await executionRepo.listByProposal(tenantId, proposal.id)).toEqual([]);
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('approved');
    expect(lock.client.statements).not.toContain('BEGIN');
  });

  it('lease lost while the external call runs: the outcome is NOT written — no idempotency record, no status transition, no transaction on the dead lock connection', async () => {
    const lock = new LeasingLockProvider();
    let calls = 0;
    const handler: ExecutionHandler = {
      proposalType: 'create_customer',
      performsExternalIo: true,
      async execute(): Promise<ExecutionResult> {
        calls += 1;
        lock.client.kill(); // the lock's backend dies mid-send
        return { success: true, resultEntityId: 'sent' };
      },
    };
    const { executionRepo, executor, proposal, ctx, repo, tenantId } = await setup(handler, lock);

    await expect(executor.execute(proposal, ctx)).rejects.toMatchObject({ code: 'SESSION_LEASE_LOST' });
    expect(calls).toBe(1);
    expect(await executionRepo.listByProposal(tenantId, proposal.id)).toEqual([]);
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('approved');
    expect(lock.client.statements).not.toContain('BEGIN');
  });

  it('lease held throughout: Path B is unchanged — one handler call, one succeeded record, executed', async () => {
    const lock = new LeasingLockProvider();
    let calls = 0;
    const handler: ExecutionHandler = {
      proposalType: 'create_customer',
      performsExternalIo: true,
      async execute(): Promise<ExecutionResult> {
        calls += 1;
        return { success: true, resultEntityId: 'sent' };
      },
    };
    const { executionRepo, executor, proposal, ctx, repo, tenantId } = await setup(handler, lock);

    const { result } = await executor.execute(proposal, ctx);
    expect(result.success).toBe(true);
    expect(calls).toBe(1);
    const rows = await executionRepo.listByProposal(tenantId, proposal.id);
    expect(rows.map((r) => r.status)).toEqual(['succeeded']);
    expect((await repo.findById(tenantId, proposal.id))!.status).toBe('executed');
    // The record + status + audit committed in one transaction on the lock's connection.
    expect(lock.client.statements[0]).toBe('BEGIN');
    expect(lock.client.statements[lock.client.statements.length - 1]).toBe('COMMIT');
  });
});
