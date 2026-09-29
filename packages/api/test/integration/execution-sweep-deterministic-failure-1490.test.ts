/**
 * #1490 item 1 (P1) — a proposal whose execution hits a DETERMINISTIC failure
 * must settle as a terminal `execution_failed` carrying the real reason, not
 * sit in `executing` retrying.
 *
 * Live evidence (QA re-verify 2026-09-29): a duplicate `draft_invoice` — an
 * invoice drafted from an estimate that was already invoiced — was
 * auto-approved. Its insert hit `uq_invoices_estimate` inside the executor's
 * DATA-31 transaction; the handler caught that and returned a failure, the
 * status write that followed then died on "current transaction is aborted",
 * the whole unit rolled back, and the row stayed `executing` with the masking
 * error, re-claimed on every stale-recovery cycle.
 *
 * Seam: the execution sweep's public entry (`runExecutionSweep`) over the
 * production handler registry, the Postgres advisory-lock idempotency guard
 * (the path that opens the transaction), and real Postgres. Outcomes are read
 * back through the proposal repository.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../../src/invoices/pg-invoice-schedule';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { createProposal, Proposal } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import {
  createExecutionHandlerRegistry,
  type ExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { PgBaseRepository } from '../../src/db/pg-base';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import { createInvoiceWithNextNumber } from '../../src/invoices/invoice';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Logger } from '../../src/logging/logger';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

describe('#1490 — a deterministic execution failure settles terminal with its real reason', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let settingsRepo: PgSettingsRepository;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let executor: ProposalExecutor;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const registry = createExecutionHandlerRegistry({
      customerRepo,
      jobRepo,
      timelineRepo: new PgJobTimelineRepository(pool),
      locationRepo,
      invoiceRepo,
      estimateRepo,
      settingsRepo,
      scheduleRepo: new PgInvoiceScheduleRepository(pool),
      proposalRepo,
      auditRepo,
      paymentRepo: new PgPaymentRepository(pool),
    });
    const executionRepo = new PgProposalExecutionRepository(pool);
    // The production guard: the advisory lock hands its connection to the
    // executor, which runs the handler inside ONE transaction (DATA-31).
    const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo, { executionRepo });
  });

  /** A tenant with a job, its accepted $500 estimate, and that estimate already invoiced. */
  async function seedInvoicedEstimate() {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: randomUUID(),
      tenantId,
      businessName: 'Dup Invoice Co',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Dana',
      lastName: 'Dup',
      displayName: 'Dana Dup',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1490 Retry Loop Rd',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-1490',
      summary: 'Drain cleaning',
      status: 'in_progress',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const items = [buildLineItem(randomUUID(), 'Drain cleaning', 1, 50000, 0, true, 'labor')];
    const estimateId = randomUUID();
    await estimateRepo.create({
      id: estimateId,
      tenantId,
      jobId,
      estimateNumber: 'EST-0057',
      status: 'accepted',
      lineItems: items,
      totals: calculateDocumentTotals(items, 0, 0),
      version: 1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const existing = await createInvoiceWithNextNumber(
      { tenantId, jobId, estimateId, lineItems: items, createdBy: userId },
      invoiceRepo,
      settingsRepo,
    );
    return { tenantId, userId, customerId, jobId, estimateId, existingInvoice: existing };
  }

  /** The duplicate: a draft_invoice for the SAME estimate, approved past the undo window. */
  async function approvedDuplicateDraft(s: Awaited<ReturnType<typeof seedInvoicedEstimate>>): Promise<Proposal> {
    let proposal = createProposal({
      tenantId: s.tenantId,
      proposalType: 'draft_invoice',
      payload: {
        customerId: s.customerId,
        jobId: s.jobId,
        estimateId: s.estimateId,
        lineItems: [
          { description: 'Drain cleaning', quantity: 1, unitPriceCents: 50000, totalCents: 50000 },
        ],
      },
      summary: 'Invoice the drain cleaning estimate',
      createdBy: s.userId,
    });
    proposal = transitionProposal(proposal, 'approved', s.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - 60_000) };
    return proposalRepo.create(proposal);
  }

  function sweep() {
    return runExecutionSweep({ proposalRepo, executor, logger: silentLogger, auditRepo });
  }

  it('a duplicate invoice-from-estimate fails terminally in ONE sweep, with the real cause — not the aborted-transaction mask', async () => {
    const s = await seedInvoicedEstimate();
    const proposal = await approvedDuplicateDraft(s);

    await sweep();

    const after = await proposalRepo.findById(s.tenantId, proposal.id);
    expect(after?.status).toBe('execution_failed');
    expect(after?.executionError ?? '').not.toMatch(/current transaction is aborted/i);
    expect(after?.executionError ?? '').not.toBe('');
  });

  it('the reason names the estimate and the invoice that already bills it, so the owner can act on it', async () => {
    const s = await seedInvoicedEstimate();
    const proposal = await approvedDuplicateDraft(s);

    await sweep();

    const after = await proposalRepo.findById(s.tenantId, proposal.id);
    expect(after?.status).toBe('execution_failed');
    expect(after?.executionError).toContain('EST-0057');
    expect(after?.executionError).toContain(s.existingInvoice.invoiceNumber);
    expect(after?.executionError).toMatch(/already invoiced/i);
  });

  describe('a handler that THROWS', () => {
    /** Writes a customer row through the ambient tenant client, as the real create paths do. */
    class CustomerWriteRepo extends PgBaseRepository {
      async insert(tenantId: string, id: string, createdBy: string): Promise<void> {
        await this.withTenant(tenantId, (client) =>
          client.query(
            `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
            [id, tenantId, 'Sweep 1490', createdBy],
          ),
        );
      }
    }

    function executorWith(handler: ExecutionHandler): ProposalExecutor {
      const guard = new IdempotencyGuard(
        new PgProposalExecutionRepository(pool),
        proposalRepo,
        new PgIdempotencyLockProvider(pool),
      );
      return new ProposalExecutor(new Map([[handler.proposalType, handler]]), proposalRepo, guard, auditRepo);
    }

    async function approvedCreateCustomer(tenantId: string, userId: string, customerId: string) {
      let proposal = createProposal({
        tenantId,
        proposalType: 'create_customer',
        payload: { customerId },
        summary: 'Add a customer',
        createdBy: userId,
      });
      proposal = transitionProposal(proposal, 'approved', userId);
      return proposalRepo.create({ ...proposal, approvedAt: new Date(Date.now() - 60_000) });
    }

    it('a deterministic database error (a constraint violation) is terminal on the first sweep, with its cause', async () => {
      const { tenantId, userId } = await createTestTenant(pool);
      const writes = new CustomerWriteRepo(pool);
      const customerId = randomUUID();
      await writes.insert(tenantId, customerId, userId); // the id is already taken
      const handler: ExecutionHandler = {
        proposalType: 'create_customer',
        async execute(p, ctx) {
          await writes.insert(ctx.tenantId, p.payload.customerId as string, ctx.executedBy);
          return { success: true, resultEntityId: p.payload.customerId as string };
        },
      };
      const proposal = await approvedCreateCustomer(tenantId, userId, customerId);

      await runExecutionSweep({ proposalRepo, executor: executorWith(handler), logger: silentLogger, auditRepo });

      const after = await proposalRepo.findById(tenantId, proposal.id);
      expect(after?.status).toBe('execution_failed');
      expect(after?.executionError).toMatch(/duplicate key/);
    });

    // Guard on the other side of the line: a transient failure keeps the
    // bounded stale-recovery retry (cause recorded, row still 'executing').
    it('a transient database error (serialization failure) stays retryable', async () => {
      const { tenantId, userId } = await createTestTenant(pool);
      const handler: ExecutionHandler = {
        proposalType: 'create_customer',
        async execute() {
          throw Object.assign(new Error('could not serialize access due to concurrent update'), {
            code: '40001',
          });
        },
      };
      const proposal = await approvedCreateCustomer(tenantId, userId, randomUUID());

      await runExecutionSweep({ proposalRepo, executor: executorWith(handler), logger: silentLogger, auditRepo });

      const after = await proposalRepo.findById(tenantId, proposal.id);
      expect(after?.status).toBe('executing');
      expect(after?.executionError).toMatch(/could not serialize/);
    });
  });

  // The row live QA found: 'executing', claimed long ago, carrying the masking
  // error from an earlier attempt. The fixed sweep must settle it on its own —
  // no hand-written DB repair.
  it('a row already stuck in executing with the aborted-transaction error settles terminal on the next sweep', async () => {
    const s = await seedInvoicedEstimate();
    const proposal = await approvedDuplicateDraft(s);
    // Arrange the stuck state exactly as production holds it.
    await pool.query(
      `UPDATE proposals
          SET status = 'executing', claimed_by = 'execution-worker',
              claimed_at = NOW() - INTERVAL '30 minutes', execution_retry_count = 1,
              execution_error = 'current transaction is aborted, commands ignored until end of transaction block'
        WHERE id = $1`,
      [proposal.id],
    );

    await sweep();

    const after = await proposalRepo.findById(s.tenantId, proposal.id);
    expect(after?.status).toBe('execution_failed');
    expect(after?.executionError).toMatch(/already invoiced/i);
  });
});
