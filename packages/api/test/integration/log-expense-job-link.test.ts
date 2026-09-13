/**
 * U3 (B7.8) — the spoken expense keeps its job link, end-to-end against real
 * Postgres.
 *
 * "$40 in parts for the Henderson job" used to persist an UNLINKED expense:
 * `log_expense` was absent from JOB_REF_INTENTS so the resolver never
 * resolved the spoken job, and the task handler dropped any resolved id —
 * job P&L silently undercounted every spoken expense. This file proves the
 * closed loop with the REAL PgEntityResolver and REAL Pg repositories
 * (docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md
 * — a mocked pool is never the only proof), asserting EXECUTED EFFECTS:
 *
 *   1. The resolver resolves "the Henderson job" (name lives ONLY on the
 *      customer row) → the drafted payload carries jobId → approve → execute
 *      persists the expenses row WITH job_id + the expense.logged audit row
 *      → `lookup_job_profit` (real repos, same aggregation the route uses)
 *      counts the spoken $40 in expensesCents AND in the spoken answer.
 *   2. Ambiguous job (two Henderson jobs) → the resolver answers 'ambiguous'
 *      (the router turns exactly this into a one-tap voice_clarification —
 *      never a silent guess).
 *   3. No job mention → the expense still logs, unlinked — today's behavior
 *      preserved, and job P&L correctly does NOT count it.
 *
 * Harness mirrors test/integration/reschedule-appointment-voice.test.ts
 * (task handler → transitionProposal → ProposalExecutor with the PRODUCTION
 * registry) and test/integration/entity-resolution.test.ts (realistic seeds).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { LogExpenseTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { lookupJobProfit } from '../../src/ai/skills/lookup-job-profit';
import { TaskContext } from '../../src/ai/tasks/task-handlers';
import {
  missingFieldsFor,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  ExecutionContext,
  ExecutionResult,
  createExecutionHandlerRegistry,
} from '../../src/proposals/execution/handlers';

const SPOKEN_AMOUNT_CENTS = 4000; // "$40 in parts" — integer cents end-to-end

describe('Integration — U3 spoken expense keeps its job link (real Postgres + real resolver)', () => {
  let pool: Pool;
  let resolver: PgEntityResolver;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let expenseRepo: PgExpenseRepository;
  let invoiceRepo: PgInvoiceRepository;
  let timeEntryRepo: PgTimeEntryRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    resolver = new PgEntityResolver(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    expenseRepo = new PgExpenseRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    timeEntryRepo = new PgTimeEntryRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  interface Seed {
    tenantId: string;
    userId: string;
    customerId: string;
    jobId: string;
  }

  /**
   * Realistic seed (fixture rule from entity-resolution.test.ts): the name
   * "Henderson" lives ONLY on the customer row; the job summary says what
   * the WORK is. "the Henderson job" must resolve through customers → jobs.
   */
  async function seedHendersonJob(): Promise<Seed> {
    const t = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Pat',
      lastName: 'Henderson',
      displayName: 'Pat Henderson',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '4 Expense Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-EXP-${jobId.slice(0, 8)}`,
      summary: 'Water heater replacement',
      status: 'in_progress',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { tenantId: t.tenantId, userId: t.userId, customerId, jobId };
  }

  /** A SECOND job for the same customer — makes "the Henderson job" ambiguous. */
  async function addSecondHendersonJob(seed: Seed): Promise<string> {
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: seed.tenantId,
      customerId: seed.customerId,
      street1: '5 Expense Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: false,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: seed.tenantId,
      customerId: seed.customerId,
      locationId,
      jobNumber: `JOB-EXP-${jobId.slice(0, 8)}`,
      summary: 'Furnace tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: seed.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  function expenseContext(seed: Seed, resolvedJobId?: string): TaskContext {
    return {
      tenantId: seed.tenantId,
      userId: seed.userId,
      message: '$40 in parts for the Henderson job',
      existingEntities: {
        amount: SPOKEN_AMOUNT_CENTS,
        expenseCategory: 'materials',
        expenseDescription: 'parts for the Henderson job',
        jobReference: 'the Henderson job',
        ...(resolvedJobId ? { jobId: resolvedJobId } : {}),
      },
    };
  }

  async function approveAndExecute(draft: Proposal, userId: string): Promise<ExecutionResult> {
    let proposal = transitionProposal(draft, 'ready_for_review', userId);
    proposal = transitionProposal(proposal, 'approved', userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };

    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    // PRODUCTION registry — same construction app.ts uses.
    const handlers = createExecutionHandlerRegistry({ expenseRepo, auditRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: proposal.tenantId, executedBy: userId };
    const { result } = await executor.execute(proposal, context);
    return result;
  }

  it('"$40 in parts for the Henderson job" → resolver links the job → persisted expense row carries job_id → job P&L counts it', async () => {
    const seed = await seedHendersonJob();

    // The REAL resolver answers the spoken reference (U3 routed log_expense
    // through JOB_REF_INTENTS) — through the customer, not a planted summary.
    const annotation = await resolveVoiceEntityReferences(resolver, {
      tenantId: seed.tenantId,
      intent: 'log_expense',
      entities: { jobReference: 'the Henderson job' },
    });
    expect(annotation.kind).toBe('ok');
    if (annotation.kind !== 'ok') return;
    expect(annotation.resolved.jobId).toBe(seed.jobId);

    // Draft exactly the way the router does: the resolved id rides the context.
    const { proposal: draft } = await new LogExpenseTaskHandler().handle(
      expenseContext(seed, annotation.resolved.jobId),
    );
    expect(missingFieldsFor(draft)).toEqual([]);
    expect(draft.payload.jobId).toBe(seed.jobId);
    expect(draft.payload.amountCents).toBe(SPOKEN_AMOUNT_CENTS);

    const result = await approveAndExecute(draft, seed.userId);
    expect(result.success).toBe(true);
    const expenseId = result.resultEntityId as string;

    // Executed effect #1 — the REAL expenses row carries the job link
    // (actual column names, not a mocked pool's idea of them).
    const { rows } = await pool.query(
      `SELECT job_id, amount_cents, category FROM expenses
        WHERE tenant_id = $1 AND id = $2`,
      [seed.tenantId, expenseId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe(seed.jobId);
    expect(Number(rows[0].amount_cents)).toBe(SPOKEN_AMOUNT_CENTS);

    // Executed effect #2 — the audit trail.
    const audit = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'expense' AND entity_id = $2
          AND event_type = 'expense.logged'`,
      [seed.tenantId, expenseId],
    );
    expect(audit.rows).toHaveLength(1);

    // Executed effect #3 — job P&L counts the spoken expense, through the
    // SAME skill + aggregation the voice lookup and the report route use.
    const profit = await lookupJobProfit(
      { tenantId: seed.tenantId, jobId: seed.jobId },
      { jobRepo, settingsRepo, invoiceRepo, timeEntryRepo, expenseRepo },
    );
    expect(profit.status).toBe('found');
    if (profit.status !== 'found') return;
    expect(profit.data.expensesCents).toBe(SPOKEN_AMOUNT_CENTS);
    expect(profit.summary).toContain('$40.00 in expenses');
  });

  it('ambiguous job (two Henderson jobs) → the resolver answers ambiguous — a clarification upstream, never a guess', async () => {
    const seed = await seedHendersonJob();
    const secondJobId = await addSecondHendersonJob(seed);

    const annotation = await resolveVoiceEntityReferences(resolver, {
      tenantId: seed.tenantId,
      intent: 'log_expense',
      entities: { jobReference: 'the Henderson job' },
    });
    expect(annotation.kind).toBe('ambiguous');
    if (annotation.kind !== 'ambiguous') return;
    expect(annotation.entityKind).toBe('job');
    expect(annotation.candidates.map((c) => c.id).sort()).toEqual(
      [seed.jobId, secondJobId].sort(),
    );
  });

  it('no job mention → the expense logs UNLINKED and job P&L does NOT count it (today\'s behavior preserved)', async () => {
    const seed = await seedHendersonJob();

    const { proposal: draft } = await new LogExpenseTaskHandler().handle({
      tenantId: seed.tenantId,
      userId: seed.userId,
      message: '$40 at the supply house',
      existingEntities: { amount: SPOKEN_AMOUNT_CENTS, expenseCategory: 'materials' },
    });
    expect(missingFieldsFor(draft)).toEqual([]);
    expect(draft.payload.jobId).toBeUndefined();

    const result = await approveAndExecute(draft, seed.userId);
    expect(result.success).toBe(true);

    const { rows } = await pool.query(
      `SELECT job_id FROM expenses WHERE tenant_id = $1 AND id = $2`,
      [seed.tenantId, result.resultEntityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBeNull();

    const profit = await lookupJobProfit(
      { tenantId: seed.tenantId, jobId: seed.jobId },
      { jobRepo, settingsRepo, invoiceRepo, timeEntryRepo, expenseRepo },
    );
    expect(profit.status).toBe('found');
    if (profit.status !== 'found') return;
    expect(profit.data.expensesCents).toBe(0);
  });
});
