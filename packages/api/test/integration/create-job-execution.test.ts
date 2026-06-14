/**
 * U3 — voice `create_job` end-to-end against real Postgres.
 *
 * A spoken "open a job for Alvarez, no AC" becomes a create_job proposal that,
 * once approved, runs through the PRODUCTION execution registry +
 * ProposalExecutor against Pg repos. Pins the real jobs columns and guards the
 * handler+registry audit wiring fix: before it, the executed job persisted but
 * emitted NO job.created event (customers + appointments did emit theirs).
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
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

describe('Postgres integration — voice create_job → approve → execute → persist + audit', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;
  let jobId: string;

  async function executeCreateJob(): Promise<string> {
    const locationRepo = new PgLocationRepository(pool);
    // Production registry → proves the registry wires auditRepo into
    // CreateJobExecutionHandler (the fix under test). locationRepo must be
    // present or the handler degrades to a synthetic-id passthrough.
    const registry = createExecutionHandlerRegistry({ jobRepo, locationRepo, auditRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard);

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'create_job',
      payload: { customerId, locationId, title: 'No AC, not cooling' },
      summary: 'Open a job from voice',
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
    jobRepo = new PgJobRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Job',
      lastName: 'Customer',
      displayName: 'Job Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '12 Lakeshore',
      city: 'Cleveland',
      state: 'OH',
      postalCode: '44113',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = await executeCreateJob();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the job row with real columns', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, customer_id, location_id, job_number, summary, status
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].customer_id).toBe(customerId);
    expect(rows[0].location_id).toBe(locationId);
    expect(rows[0].summary).toBe('No AC, not cooling');
    expect(rows[0].status).toBe('new');
    expect(rows[0].job_number).toMatch(/^JOB-/);
  });

  it('emits exactly one job.created audit event (regression guard for handler+registry audit wiring)', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.created'`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
  });

  it('does not expose the job to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const found = await jobRepo.findById(other.tenantId, jobId);
    expect(found).toBeNull();
  });
});
