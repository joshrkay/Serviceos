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
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
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
import { transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { createEstimate } from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('Postgres integration — voice update_job → approve → execute → persist + audit', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let timelineRepo: PgJobTimelineRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;
  let jobId: string;

  async function executeUpdateJob(
    payload: Record<string, unknown>,
    extraDeps: Record<string, unknown> = {},
    who: { tenantId: string; userId: string } = tenant,
  ): Promise<string> {
    // Production registry — proves the registry wires jobRepo + timelineRepo
    // (+ auditRepo) into UpdateJobExecutionHandler so a status change routes
    // through the governed transition (the B7 money-loss fix under test).
    const registry = createExecutionHandlerRegistry({ jobRepo, timelineRepo, auditRepo, ...extraDeps });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: who.tenantId,
      proposalType: 'update_job',
      payload,
      summary: 'Update job from voice',
      createdBy: who.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', who.userId);
    proposal = transitionProposal(proposal, 'approved', who.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: who.tenantId, executedBy: who.userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    return result.resultEntityId as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
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

    // Move the job onto the lifecycle (new → scheduled) so the update_job
    // status changes below are VALID governed transitions (new → in_progress
    // is not a legal move once status routes through transitionJobStatus).
    await transitionJobStatus(
      tenant.tenantId,
      jobId,
      'scheduled',
      tenant.userId,
      'owner',
      jobRepo,
      timelineRepo,
      auditRepo,
    );
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

  it('a completed transition stamps completed_at AND runs completion effects (auto-drafts an invoice proposal)', async () => {
    // Isolated tenant so its settings + money-state don't touch the shared job.
    const t = await createTestTenant(pool);
    const custId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: custId,
      tenantId: t.tenantId,
      firstName: 'Furnace',
      lastName: 'Owner',
      displayName: 'Furnace Owner',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locId,
      tenantId: t.tenantId,
      customerId: custId,
      street1: '9 Furnace Ln',
      city: 'Akron',
      state: 'OH',
      postalCode: '44301',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Opt the tenant into auto-invoice-on-completion. The create INSERT does
    // not carry the toggle column, so set it via update (which does).
    const settingsRepo = new PgSettingsRepository(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      businessName: 'Akron Heating',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.update(t.tenantId, { autoInvoiceOnCompletion: true });

    const estimateRepo = new PgEstimateRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    // The auto-invoice effect raises a draft_invoice PROPOSAL (never an
    // auto-approved invoice); capture it in a repo we can assert on.
    const completionProposalRepo = new InMemoryProposalRepository();

    const job = await createJob(
      {
        tenantId: t.tenantId,
        customerId: custId,
        locationId: locId,
        summary: 'Furnace swap',
        priority: 'normal',
        createdBy: t.userId,
      },
      jobRepo,
    );

    // Accepted estimate + eligible money-state → the job is billable.
    const est = await createEstimate(
      {
        tenantId: t.tenantId,
        jobId: job.id,
        estimateNumber: 'EST-1',
        lineItems: [buildLineItem('l1', 'Furnace', 1, 250000, 0, true)],
        createdBy: t.userId,
      },
      estimateRepo,
    );
    await estimateRepo.update(t.tenantId, est.id, { status: 'accepted' });
    await jobRepo.update(t.tenantId, job.id, { moneyState: 'estimate_accepted', updatedAt: new Date() });

    // Advance to in_progress via governed transitions so completion is a legal move.
    await transitionJobStatus(t.tenantId, job.id, 'scheduled', t.userId, 'owner', jobRepo, timelineRepo, auditRepo);
    await transitionJobStatus(t.tenantId, job.id, 'in_progress', t.userId, 'owner', jobRepo, timelineRepo, auditRepo);

    // Approve + execute the completion through the PRODUCTION registry with the
    // completion deps wired — the money-loss fix's happy path.
    await executeUpdateJob(
      { jobId: job.id, status: 'completed' },
      { estimateRepo, invoiceRepo, settingsRepo, proposalRepo: completionProposalRepo },
      t,
    );

    // 1. completed_at stamped by the governed transition (drives the sweeps).
    const { rows } = await pool.query(
      `SELECT status, completed_at FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();

    // 2. Completion effect auto-drafted the invoice proposal (mirrors
    //    maybeAutoInvoiceOnCompletion coverage — the voice path now invoices
    //    just like the route).
    const drafted = await completionProposalRepo.findByTenant(t.tenantId);
    expect(drafted.some((p) => p.proposalType === 'draft_invoice')).toBe(true);
  });
});
