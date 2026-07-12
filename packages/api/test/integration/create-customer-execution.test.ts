/**
 * U4 — create_customer persistence + audit certification against real
 * Postgres.
 *
 * A spoken "add Jane Doe as a customer" becomes a create_customer proposal
 * that, once approved, runs through the PRODUCTION execution registry
 * (createExecutionHandlerRegistry) + ProposalExecutor against Pg repos.
 * Pins the real customers columns and the handler+registry audit wiring:
 * execution must persist the customer row AND emit both a `customer.created`
 * audit row (from createCustomer) and a `proposal.executed` audit row
 * (the executor's own atomic row) — mirroring
 * test/integration/create-job-execution.test.ts (U2/U3) for create_job.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';

describe('Postgres integration — voice create_customer → approve → execute → persist + audit', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  async function executeCreateCustomer(): Promise<string> {
    // Production registry → proves the registry wires auditRepo into
    // CreateCustomerVoiceExecutionHandler (the fix under test).
    const registry = createExecutionHandlerRegistry({ customerRepo, auditRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'create_customer',
      payload: { name: 'Jane Doe', email: 'jane@example.com' },
      summary: 'Create customer from voice',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    return result.resultEntityId as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = await executeCreateCustomer();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the customer row with real columns', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, first_name, last_name, email, preferred_channel
         FROM customers WHERE id = $1`,
      [customerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].first_name).toBe('Jane');
    expect(rows[0].last_name).toBe('Doe');
    expect(rows[0].email).toBe('jane@example.com');
    // No phone on the payload — the handler derives preferredChannel
    // 'email' when only an email is present (splitName/preferredChannel
    // logic in create-customer-handler.ts).
    expect(rows[0].preferred_channel).toBe('email');
  });

  it('emits exactly one customer.created audit event', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'customer' AND entity_id = $1 AND event_type = 'customer.created'`,
      [customerId],
    );
    expect(rows).toHaveLength(1);
  });

  it('emits exactly one proposal.executed audit event scoped to entity_type customer', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'customer' AND entity_id = $1 AND event_type = 'proposal.executed'`,
      [customerId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does not expose the customer to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const found = await customerRepo.findById(other.tenantId, customerId);
    expect(found).toBeNull();
  });
});
