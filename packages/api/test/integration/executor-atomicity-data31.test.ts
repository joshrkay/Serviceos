import { describe, it, expect, beforeAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgBaseRepository } from '../../src/db/pg-base';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from '../../src/proposals/execution/handlers';
import {
  Proposal,
  ProposalRepository,
  ProposalType,
  createProposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

/**
 * DATA-31 — the handler domain mutation, the idempotency record, and the
 * proposal status transition must commit atomically inside ONE transaction on
 * the advisory lock's own connection. This proves:
 *   1. Happy path: the domain mutation is applied AND the proposal is 'executed'
 *      exactly once.
 *   2. Crash between: a throw during updateStatus (after the mutation write)
 *      rolls back the WHOLE unit — the mutation is NOT visible and the proposal
 *      is still 'approved' (not stranded half-done) — and a clean retry then
 *      re-executes to a consistent 'executed'.
 *   3. Idempotency preserved: a genuine duplicate execution no-ops (no second
 *      domain mutation).
 *
 * The domain mutation under test is a real, RLS-scoped INSERT into `customers`
 * performed by the handler through a PgBaseRepository — so it only lands if it
 * joins the executor's transaction via the ambient tenant-context client.
 */

/** A minimal repo whose write reuses the ambient tenant-context client. */
class CustomerWriteRepo extends PgBaseRepository {
  async insertCustomer(
    tenantId: string,
    id: string,
    createdBy: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO customers (id, tenant_id, display_name, created_by)
         VALUES ($1, $2, $3, $4)`,
        [id, tenantId, 'DATA-31 Test Customer', createdBy],
      );
    });
  }
}

/** DB-only handler: inserts a customer row, mirroring the real create paths. */
class InsertCustomerHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';
  public invocations = 0;

  constructor(private readonly repo: CustomerWriteRepo) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    this.invocations += 1;
    const customerId = (proposal.payload.customerId as string) ?? randomUUID();
    await this.repo.insertCustomer(context.tenantId, customerId, context.executedBy);
    return { success: true, resultEntityId: customerId };
  }
}

/**
 * Wrap a ProposalRepository so `updateStatus` throws while `shouldFail()` is
 * true — simulates a crash AFTER the handler's domain write but DURING the
 * status transition, inside the executor's transaction.
 */
function withFailingUpdateStatus(
  real: ProposalRepository,
  shouldFail: () => boolean,
): ProposalRepository {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'updateStatus') {
        return async (...args: unknown[]) => {
          if (shouldFail()) {
            throw new Error('injected updateStatus failure (DATA-31 crash simulation)');
          }
          return (target as unknown as Record<string, (...a: unknown[]) => unknown>)
            .updateStatus(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ProposalRepository;
}

async function countCustomers(pool: Pool, tenantId: string): Promise<number> {
  const client: PoolClient = await pool.connect();
  try {
    // customers has FORCE RLS — the GUC must be set to read the rows.
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
    const res = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1',
      [tenantId],
    );
    return res.rows[0].n;
  } finally {
    await client.query('RESET app.current_tenant_id').catch(() => undefined);
    client.release();
  }
}

async function makeApprovedProposal(
  proposalRepo: PgProposalRepository,
  tenantId: string,
  userId: string,
  idempotencyKey: string,
): Promise<Proposal> {
  let proposal = createProposal({
    tenantId,
    proposalType: 'create_customer',
    payload: { customerId: randomUUID() },
    summary: 'data-31 atomicity',
    createdBy: userId,
    idempotencyKey,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'test');
  proposal = transitionProposal(proposal, 'approved', 'test');
  // Past the 5s undo window so the executor runs immediately.
  proposal = { ...proposal, approvedAt: new Date(Date.now() - 10_000) };
  // Persist in the approved state so the DB row matches what the executor sees;
  // after a rollback the row must still read 'approved' (not stranded).
  return proposalRepo.create(proposal);
}

describe('ProposalExecutor — DATA-31 transactional atomicity', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let customerRepo: CustomerWriteRepo;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    customerRepo = new CustomerWriteRepo(pool);
  });

  it('happy path: domain mutation applied AND proposal executed, exactly once', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new InsertCustomerHandler(customerRepo);
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', handler],
    ]);
    const guard = new IdempotencyGuard(
      executionRepo,
      proposalRepo,
      new PgIdempotencyLockProvider(pool),
    );
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, {
      executionRepo,
    });

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `data31-happy-${randomUUID()}`,
    );
    const ctx: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };

    const { proposal: after } = await executor.execute(proposal, ctx);

    expect(handler.invocations).toBe(1);
    expect(after.status).toBe('executed');
    expect(await countCustomers(pool, tenant.tenantId)).toBe(1);

    const persisted = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(persisted?.status).toBe('executed');
  });

  it('crash between mutation and status: whole tx rolls back, retry re-executes cleanly', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new InsertCustomerHandler(customerRepo);
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', handler],
    ]);

    // Toggle: fail the status write on the first execution only.
    let failStatusWrite = true;
    const flakyProposalRepo = withFailingUpdateStatus(
      proposalRepo,
      () => failStatusWrite,
    );
    const guard = new IdempotencyGuard(
      executionRepo,
      proposalRepo, // guard reads via the real repo
      new PgIdempotencyLockProvider(pool),
    );
    const executor = new ProposalExecutor(handlers, flakyProposalRepo, guard, {
      executionRepo,
    });

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `data31-crash-${randomUUID()}`,
    );
    const ctx: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };

    // First run: the injected failure aborts the transaction.
    await expect(executor.execute(proposal, ctx)).rejects.toThrow(
      /crash simulation/,
    );

    // Atomicity: the domain mutation must NOT be visible, and the proposal must
    // still be 'approved' — not stranded half-done.
    expect(handler.invocations).toBe(1);
    expect(await countCustomers(pool, tenant.tenantId)).toBe(0);
    const stranded = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(stranded?.status).toBe('approved');

    // No idempotency marker should have survived the rollback, so a retry runs
    // the handler again (rather than short-circuiting on a phantom success).
    const markerAfterCrash = await executionRepo.findByIdempotencyKey(
      tenant.tenantId,
      proposal.idempotencyKey!,
    );
    expect(markerAfterCrash).toBeNull();

    // Clean retry: status write now succeeds → consistent 'executed'.
    failStatusWrite = false;
    const retryProposal =
      (await proposalRepo.findById(tenant.tenantId, proposal.id)) ?? proposal;
    const retryReady = { ...retryProposal, approvedAt: new Date(Date.now() - 10_000) };

    const { proposal: after } = await executor.execute(retryReady, ctx);

    expect(handler.invocations).toBe(2);
    expect(after.status).toBe('executed');
    expect(await countCustomers(pool, tenant.tenantId)).toBe(1);
    const persisted = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(persisted?.status).toBe('executed');
  });

  it('idempotency preserved: a genuine duplicate execution no-ops (no double mutation)', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new InsertCustomerHandler(customerRepo);
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', handler],
    ]);
    const guard = new IdempotencyGuard(
      executionRepo,
      proposalRepo,
      new PgIdempotencyLockProvider(pool),
    );
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, {
      executionRepo,
    });

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `data31-dup-${randomUUID()}`,
    );
    const ctx: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };

    const first = await executor.execute(proposal, ctx);
    expect(first.alreadyExecuted).toBeFalsy();

    // Re-run the SAME proposal (same idempotency key, prior success).
    const second = await executor.execute(proposal, ctx);
    expect(second.alreadyExecuted).toBe(true);

    // Handler ran once; exactly one customer row exists.
    expect(handler.invocations).toBe(1);
    expect(await countCustomers(pool, tenant.tenantId)).toBe(1);
  });
});
