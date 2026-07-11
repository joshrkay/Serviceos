import { describe, it, expect, beforeAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgBaseRepository } from '../../src/db/pg-base';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { AuditEvent, AuditRepository } from '../../src/audit/audit';
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
  ProposalType,
  createProposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

/**
 * WS11 — structural audit atomicity. The executor writes its execution-outcome
 * audit event (`proposal.executed` / `proposal.execution_failed`) with the SAME
 * client, inside the SAME transaction, as the handler's domain mutation and the
 * proposal status transition (executeAudited on top of the DATA-31 unit). This
 * proves the guarantee against real Postgres:
 *
 *   1. Happy path: exactly ONE `proposal.executed` audit row commits atomically
 *      with the domain mutation + status transition — real columns pinned.
 *   2. Audit-insert failure: a DB-level failure in the audit INSERT rolls back
 *      the WHOLE unit — the domain mutation is invisible, the proposal is still
 *      'approved', no idempotency marker survives, and no audit row exists. A
 *      state change CANNOT commit without its audit row.
 *   3. Handler failure: the `proposal.execution_failed` audit row commits
 *      atomically with the status transition.
 */

/** A minimal repo whose write reuses the ambient tenant-context client. */
class CustomerWriteRepo extends PgBaseRepository {
  async insertCustomer(tenantId: string, id: string, createdBy: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO customers (id, tenant_id, display_name, created_by)
         VALUES ($1, $2, $3, $4)`,
        [id, tenantId, 'WS11 Audit Test Customer', createdBy],
      );
    });
  }
}

class InsertCustomerHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';
  public invocations = 0;

  constructor(private readonly repo: CustomerWriteRepo) {}

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    this.invocations += 1;
    const customerId = (proposal.payload.customerId as string) ?? randomUUID();
    await this.repo.insertCustomer(context.tenantId, customerId, context.executedBy);
    return { success: true, resultEntityId: customerId };
  }
}

class FailingHandler implements ExecutionHandler {
  proposalType: ProposalType = 'create_customer';
  async execute(): Promise<ExecutionResult> {
    return { success: false, error: 'handler refused (WS11 failure-path test)' };
  }
}

/**
 * An audit repository whose INSERT fails at the DATABASE level (NOT NULL
 * violation on tenant_id), on the ambient tenant-context client — so inside
 * the executor's transaction the failure aborts the whole unit, exactly like
 * a real bad write (oversized value, revoked grant) would.
 */
class DbFailingAuditRepository extends PgBaseRepository implements AuditRepository {
  async create(event: AuditEvent): Promise<AuditEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [event.id, event.actorId, event.actorRole, event.eventType, event.entityType, event.entityId],
      );
      return event;
    });
  }
  async findByEntity(): Promise<AuditEvent[]> {
    return [];
  }
  async findByCorrelation(): Promise<AuditEvent[]> {
    return [];
  }
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

interface AuditRow {
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_id: string;
  actor_role: string;
  metadata: Record<string, unknown>;
}

async function auditRowsForProposal(
  pool: Pool,
  tenantId: string,
  proposalId: string,
): Promise<AuditRow[]> {
  const res = await pool.query<AuditRow>(
    `SELECT event_type, entity_type, entity_id, actor_id, actor_role, metadata
       FROM audit_events
      WHERE tenant_id = $1 AND entity_type = 'proposal' AND entity_id = $2
      ORDER BY created_at`,
    [tenantId, proposalId],
  );
  return res.rows;
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
    summary: 'ws11 audit atomicity',
    createdBy: userId,
    idempotencyKey,
  });
  proposal = transitionProposal(proposal, 'ready_for_review', 'test');
  proposal = transitionProposal(proposal, 'approved', 'test');
  // Past the 5s undo window so the executor runs immediately.
  proposal = { ...proposal, approvedAt: new Date(Date.now() - 10_000) };
  return proposalRepo.create(proposal);
}

describe('ProposalExecutor — WS11 audit-event atomicity', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let customerRepo: CustomerWriteRepo;

  function makeGuard(): IdempotencyGuard {
    return new IdempotencyGuard(
      executionRepo,
      proposalRepo,
      new PgIdempotencyLockProvider(pool),
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    customerRepo = new CustomerWriteRepo(pool);
  });

  it('happy path: exactly one proposal.executed audit row commits atomically with the state change', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new InsertCustomerHandler(customerRepo);
    const executor = new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([['create_customer', handler]]),
      proposalRepo,
      makeGuard(),
      new PgAuditRepository(pool),
      { executionRepo },
    );

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `ws11-happy-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };

    const { proposal: after, result } = await executor.execute(proposal, ctx);

    expect(after.status).toBe('executed');
    expect(await countCustomers(pool, tenant.tenantId)).toBe(1);

    // Real columns pinned: the executor's execution-outcome audit event.
    const rows = await auditRowsForProposal(pool, tenant.tenantId, proposal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('proposal.executed');
    expect(rows[0].entity_type).toBe('proposal');
    expect(rows[0].entity_id).toBe(proposal.id);
    expect(rows[0].actor_id).toBe(tenant.userId);
    expect(rows[0].actor_role).toBe('system');
    expect(rows[0].metadata).toMatchObject({
      proposalType: 'create_customer',
      status: 'executed',
      resultEntityId: result.resultEntityId,
    });
  });

  it('audit-insert failure rolls back the WHOLE unit: no state change commits without its audit row', async () => {
    const tenant = await createTestTenant(pool);
    const handler = new InsertCustomerHandler(customerRepo);
    const executor = new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([['create_customer', handler]]),
      proposalRepo,
      makeGuard(),
      new DbFailingAuditRepository(pool),
      { executionRepo },
    );

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `ws11-audit-fail-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };

    // The NULL tenant_id insert aborts the shared transaction. Which error
    // fires depends on the role: under RLS_RUNTIME_ROLE the row dies on the
    // audit_events RLS WITH CHECK policy (Postgres evaluates RLS before
    // column constraints); without it, on the NOT NULL constraint.
    await expect(executor.execute(proposal, ctx)).rejects.toThrow(
      /null value|not-null|row-level security/i,
    );

    // The handler RAN — but nothing it did survived the rollback.
    expect(handler.invocations).toBe(1);
    expect(await countCustomers(pool, tenant.tenantId)).toBe(0);

    // The proposal is still 'approved' — not stranded half-executed.
    const stranded = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(stranded?.status).toBe('approved');

    // No idempotency marker survived, so a retry re-executes cleanly.
    const marker = await executionRepo.findByIdempotencyKey(
      tenant.tenantId,
      proposal.idempotencyKey!,
    );
    expect(marker).toBeNull();

    // And of course: no audit row.
    expect(await auditRowsForProposal(pool, tenant.tenantId, proposal.id)).toHaveLength(0);
  });

  it('handler failure commits the proposal.execution_failed audit row atomically with the status write', async () => {
    const tenant = await createTestTenant(pool);
    const executor = new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([['create_customer', new FailingHandler()]]),
      proposalRepo,
      makeGuard(),
      new PgAuditRepository(pool),
      { executionRepo },
    );

    const proposal = await makeApprovedProposal(
      proposalRepo,
      tenant.tenantId,
      tenant.userId,
      `ws11-handler-fail-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };

    const { proposal: after, result } = await executor.execute(proposal, ctx);
    expect(result.success).toBe(false);
    expect(after.status).toBe('execution_failed');

    const persisted = await proposalRepo.findById(tenant.tenantId, proposal.id);
    expect(persisted?.status).toBe('execution_failed');

    const rows = await auditRowsForProposal(pool, tenant.tenantId, proposal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('proposal.execution_failed');
    expect(rows[0].metadata).toMatchObject({
      proposalType: 'create_customer',
      status: 'execution_failed',
      executionError: 'handler refused (WS11 failure-path test)',
    });
  });
});
