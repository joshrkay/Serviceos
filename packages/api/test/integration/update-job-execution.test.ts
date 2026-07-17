/**
 * B7 (feat: voice-transcript-and-agent-paths) — voice/assistant `update_job`
 * end-to-end against real Postgres.
 *
 * A spoken "mark the job in progress and bump the priority" becomes an
 * update_job proposal that, once approved, runs through the PRODUCTION
 * execution registry + ProposalExecutor against Pg repos. Pins the real
 * jobs.status / jobs.priority / jobs.summary / jobs.problem_description
 * columns and the job.updated audit event — the same regression class
 * create-job-execution.test.ts guards for create_job.
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
import { createJob } from '../../src/jobs/job';

describe('Postgres integration — voice update_job → approve → execute → persist + audit', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;
  let jobId: string;

  async function executeUpdateJob(payload: Record<string, unknown>): Promise<string> {
    // Production registry — proves the registry wires jobRepo + auditRepo
    // into UpdateJobExecutionHandler (the B7 fix under test).
    const registry = createExecutionHandlerRegistry({ jobRepo, auditRepo });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'update_job',
      payload,
      summary: 'Update job from voice',
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

    const job = await createJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        locationId,
        summary: 'No AC, not cooling',
        priority: 'normal',
        createdBy: tenant.userId,
      },
      jobRepo,
    );
    jobId = job.id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('changes the real job row status + priority via the production registry', async () => {
    await executeUpdateJob({ jobId, status: 'in_progress', priority: 'urgent' });

    const { rows } = await pool.query(
      `SELECT status, priority, summary, problem_description FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].priority).toBe('urgent');
    // Untouched fields survive the partial update.
    expect(rows[0].summary).toBe('No AC, not cooling');
  });

  it('changes the real job row title + description', async () => {
    await executeUpdateJob({
      jobId,
      title: 'No AC, not cooling — 2nd visit',
      description: 'Compressor replaced, monitoring for a week',
    });

    const { rows } = await pool.query(
      `SELECT summary, problem_description FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('No AC, not cooling — 2nd visit');
    expect(rows[0].problem_description).toBe('Compressor replaced, monitoring for a week');
  });

  it('emits a job.updated audit event (regression guard for handler+registry audit wiring)', async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.updated'`,
      [jobId],
    );
    const countBefore = before.rows[0].n as number;

    await executeUpdateJob({ jobId, status: 'completed' });

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.updated'`,
      [jobId],
    );
    expect(after.rows[0].n as number).toBe(countBefore + 1);
  });

  it('does not expose the job to another tenant (scoped read) and a cross-tenant jobId fails cleanly', async () => {
    const other = await createTestTenant(pool);
    const found = await jobRepo.findById(other.tenantId, jobId);
    expect(found).toBeNull();

    const registry = createExecutionHandlerRegistry({ jobRepo, auditRepo });
    const handler = registry.get('update_job')!;
    const result = await handler.execute(
      {
        id: crypto.randomUUID(),
        tenantId: other.tenantId,
        proposalType: 'update_job',
        status: 'approved',
        payload: { jobId, status: 'canceled' },
        summary: 'cross-tenant attempt',
        createdBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Proposal,
      { tenantId: other.tenantId, executedBy: other.userId },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    // The row is untouched — no cross-tenant write leaked through.
    const { rows } = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(rows[0].status).not.toBe('canceled');
  });
});
