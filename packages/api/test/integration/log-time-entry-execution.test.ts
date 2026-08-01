/**
 * B6.3 (rivet-voice-19) — "Clock 2 hours on the Patel job" against REAL
 * Postgres.
 *
 * Today the chain was probe-verified (approvable + executes) but had no
 * rung-4 proof. This certifies the full chain against real rows:
 *
 *   REAL LogTimeEntryTaskHandler.handle() (the same handler
 *   handler-registry.ts:252 wires for both the voice worker and the
 *   assistant chat route) drafts a log_time_entry proposal for the fixture
 *   sentence, consuming the router's resolver-style existingEntities
 *   (jobId already resolved from "the Patel job", as the entity resolver
 *   would leave it on context.existingEntities.jobId — see
 *   voice-extended-tasks.ts:1260-1265) → approveProposal
 *   (proposals/actions.ts) → the PRODUCTION execution registry
 *   (createExecutionHandlerRegistry, handlers.ts:1325) + ProposalExecutor
 *   → a real `time_entries` row with durationMinutes 120 and the resolved
 *   jobId, plus exactly one `time_entry.logged_completed` audit event
 *   (time-entry-service.ts's logCompleted, the retroactive-capture path —
 *   see voice-extended-tasks.ts:1246-1257) with actor attribution.
 *
 * Also pins the P&L linkage (P22-005 / U7): the persisted entry is counted
 * by `getJobProfit`'s labor-minutes rollup for that job.
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
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { TimeEntryService } from '../../src/time-tracking/time-entry-service';
import { getJobProfit } from '../../src/jobs/job-profit';
import { missingFieldsFor, Proposal } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { LogTimeEntryTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

describe('Postgres integration — voice log_time_entry ("Clock 2 hours on the Patel job") → approve → execute → persist + audit', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let auditRepo: PgAuditRepository;
  let timeEntryRepo: PgTimeEntryRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;
  let entryId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    timeEntryRepo = new PgTimeEntryRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Patel',
      lastName: 'Household',
      displayName: 'Patel Household',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '9 Patel Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-PATEL-1',
      summary: 'Patel — water heater',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Production registry — proves the registry wires TimeEntryService
    // (built from the real Pg repo + auditRepo) into
    // LogTimeEntryExecutionHandler exactly the way app.ts does.
    const timeEntryService = new TimeEntryService(timeEntryRepo, auditRepo);
    const registry = createExecutionHandlerRegistry({ timeEntryService, auditRepo });
    const executionRepo = new PgProposalExecutionRepository(pool);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    // 1) Draft via the REAL LogTimeEntryTaskHandler for the fixture
    // sentence. `existingEntities.jobId` is what the router's entity
    // resolver (P8) would have already resolved "the Patel job" to
    // (voice-extended-tasks.ts:1260-1265 reads context.existingEntities.jobId
    // directly, NOT a hand-built payload); durationMinutes/jobReference are
    // what the classifier extracts (entitiesFrom reads the same
    // existingEntities bag — voice-extended-tasks.ts:45-47).
    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Clock 2 hours on the Patel job',
      existingEntities: {
        jobId,
        jobReference: 'the Patel job',
        durationMinutes: 120,
      },
    };
    const handler = new LogTimeEntryTaskHandler();
    const { proposal: draftedProposal } = await handler.handle(taskContext);

    expect(draftedProposal.proposalType).toBe('log_time_entry');
    const draftedPayload = draftedProposal.payload as Record<string, unknown>;
    expect(draftedPayload.jobId).toBe(jobId);
    expect(draftedPayload.durationMinutes).toBe(120);
    // Resolved jobId ⇒ nothing gates the proposal for review.
    expect(missingFieldsFor(draftedProposal)).toEqual([]);
    // Capture-class, no sourceTrustTier ⇒ decideInitialStatus lands 'draft'
    // (a human always confirms before LogTimeEntryExecutionHandler clocks
    // anyone in — RV-051).
    expect(draftedProposal.status).toBe('draft');

    await proposalRepo.create(draftedProposal);

    // 2) Approve via the PRODUCTION approveProposal helper (proposals/actions.ts).
    const approved: Proposal = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      draftedProposal.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    expect(approved.status).toBe('approved');

    // Backdate past the 5-second undo window so execution isn't refused.
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };

    // 3) Execute via the registered execution handler.
    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(backdated, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    entryId = result.resultEntityId as string;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the time_entries row with durationMinutes 120 and the resolved jobId', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, user_id, job_id, entry_type, duration_minutes
         FROM time_entries WHERE id = $1`,
      [entryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].user_id).toBe(tenant.userId);
    expect(rows[0].job_id).toBe(jobId);
    expect(rows[0].entry_type).toBe('job');
    expect(rows[0].duration_minutes).toBe(120);
  });

  it('emits exactly one time-entry audit event with actor attribution', async () => {
    const { rows } = await pool.query(
      `SELECT event_type, actor_id, entity_type FROM audit_events
        WHERE entity_type = 'time_entry' AND entity_id = $1`,
      [entryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('time_entry.logged_completed');
    expect(rows[0].actor_id).toBe(tenant.userId);
  });

  it('does not expose the entry to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const found = await timeEntryRepo.findById(other.tenantId, entryId);
    expect(found).toBeNull();
  });

  it('is counted by the job-profit query for the resolved job (P&L linkage)', async () => {
    const invoiceRepo = new PgInvoiceRepository(pool);
    const expenseRepo = new PgExpenseRepository(pool);

    const profit = await getJobProfit(
      { tenantId: tenant.tenantId, jobId, laborRateCentsPerHour: null },
      { invoiceRepo, timeEntryRepo, expenseRepo },
    );
    // The voice-logged 120 minutes is the only labor tracked on this job —
    // entry_type 'job' is exactly what getJobProfit sums.
    expect(profit.laborMinutes).toBe(120);
  });
});
