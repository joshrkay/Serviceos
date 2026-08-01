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
import crypto from 'crypto';
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
import { buildTaskHandlers } from '../../src/ai/orchestration/handler-registry';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

function noopGateway(): LLMGateway {
  return {
    complete: async () =>
      ({
        content: '{}',
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      }) satisfies LLMResponse,
  } as unknown as LLMGateway;
}

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

/**
 * B8 (feat: voice-transcript-and-agent-paths) — create_customer draft-time
 * duplicate detection parity, pinned against REAL Postgres.
 *
 * `PgCustomerRepository.findDuplicates` is exercised through the SAME
 * `buildTaskHandlers` registry the voice worker and assistant chat use
 * (ai/orchestration/handler-registry.ts), not a mocked repo — the whole
 * point of a Docker-gated test here is that a mocked-DB unit test could not
 * have caught a real-column mismatch in the dedup SQL (the entity resolver
 * shipped with exactly that bug once — see CLAUDE.md's Code Hygiene note).
 */
describe('Postgres integration — create_customer draft-time duplicate detection (B8)', () => {
  let pool: Pool;
  let customerRepo: PgCustomerRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    tenant = await createTestTenant(pool);

    // Seed an existing customer so the draft below finds a near-duplicate
    // by phone.
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Alex',
      lastName: 'Smith',
      displayName: 'Alex Smith',
      primaryPhone: '+15551230100',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function draftContext(entities: Record<string, unknown>): TaskContext {
    return {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Add customer Alex Smith, phone 555-0100',
      existingEntities: entities,
    };
  }

  it('surfaces the advisory _meta.markers duplicate warning on the draft — status stays approvable', async () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway(), customerRepo });
    const { proposal } = await handlers
      .get('create_customer')!
      .handle(draftContext({ displayName: 'Alex Smith', phone: '+15551230100' }));

    expect(proposal.proposalType).toBe('create_customer');
    // Advisory only — never blocks. create_customer always lands 'draft'
    // (identity creation is human-gated regardless of confidence, D3).
    expect(proposal.status).toBe('draft');
    const payload = proposal.payload as Record<string, unknown>;
    const meta = payload._meta as { markers?: Array<{ path: string; reason: string }> } | undefined;
    expect(meta?.markers?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(meta!.markers!.some((m) => /duplicate|match/i.test(m.reason))).toBe(true);
  });

  it('drafts cleanly (no marker) for a genuinely new customer', async () => {
    const handlers = buildTaskHandlers({ gateway: noopGateway(), customerRepo });
    const { proposal } = await handlers.get('create_customer')!.handle(
      draftContext({ displayName: 'Someone Entirely New', phone: '+15559998888' }),
    );

    expect(proposal.proposalType).toBe('create_customer');
    const payload = proposal.payload as Record<string, unknown>;
    expect(payload._meta).toBeUndefined();
  });
});
