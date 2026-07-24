/**
 * Collections cadence — MANUAL send_payment_reminder dedup against real Postgres.
 *
 * The voice/manual on-ramp and the autonomous dunning sweep can both raise a
 * reminder for the same invoice. Both execute through the ONE
 * SendPaymentReminderExecutionHandler, which — for MANUAL proposals — does a
 * record-first write to the invoice_dunning_events ledger (UNIQUE on
 * tenant+invoice+kind+step_key) and a 72h cooldown refusal. This test round-
 * trips through the PRODUCTION createExecutionHandlerRegistry + a real
 * PgDunningEventRepository so the ledger columns and the UNIQUE constraint are
 * pinned against the real schema (the InMemory repo cannot catch a column/
 * constraint drift — the mocked-DB trap CLAUDE.md warns about).
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgDunningEventRepository } from '../../src/invoices/pg-dunning-config';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
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
import { manualReminderStepKey } from '../../src/invoices/dunning-config';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';

/** Records every outbound reminder send so we can assert exactly-once. */
class RecordingComms {
  sends: Array<{ tenantId: string; invoiceId: string }> = [];
  async notifyInvoiceOverdue(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ status: 'sent' }> {
    this.sends.push({ tenantId, invoiceId });
    return { status: 'sent' };
  }
}

describe('Postgres integration — manual send_payment_reminder dedup', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;
  let dunningEventRepo: PgDunningEventRepository;
  let comms: RecordingComms;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let invoiceId: string;
  let firstProposalId: string;

  function buildExecutor() {
    // PRODUCTION registry — proves the registry threads dunningEventRepo +
    // transactionalComms into SendPaymentReminderExecutionHandler.
    const registry = createExecutionHandlerRegistry({
      invoiceRepo,
      jobRepo,
      estimateRepo,
      auditRepo,
      dunningEventRepo,
      transactionalComms: comms as unknown as TransactionalCommsService,
    });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);
    return { executor, proposalRepo };
  }

  async function executeManualReminder(): Promise<{ proposal: Proposal; success: boolean; error?: string }> {
    const { executor, proposalRepo } = buildExecutor();
    const input: CreateProposalInput = {
      tenantId: tenant.tenantId,
      proposalType: 'send_payment_reminder',
      payload: { invoiceId, stepKey: 'manual', offsetDays: 0, channel: 'sms' },
      summary: 'Chase the overdue invoice',
      createdBy: tenant.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', tenant.userId);
    proposal = transitionProposal(proposal, 'approved', tenant.userId);
    // Backdate past the undo window so execution proceeds immediately.
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(proposal, context);
    return { proposal, success: result.success, error: result.error };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    dunningEventRepo = new PgDunningEventRepository(pool);
    comms = new RecordingComms();
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Reminder',
      lastName: 'Dedup',
      displayName: 'Reminder Dedup',
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
      street1: '9 Overdue Ave',
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
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-PR-1',
      summary: 'Payment reminder job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 15000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-PR-0001',
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      // Past due → an overdue invoice a manual reminder would chase.
      dueDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('records the ledger row (real columns) and sends exactly once for the first manual reminder', async () => {
    const first = await executeManualReminder();
    firstProposalId = first.proposal.id;
    expect(first.success).toBe(true);
    expect(comms.sends).toHaveLength(1);

    const { rows } = await pool.query(
      `SELECT tenant_id, invoice_id, kind, step_key, channel, sent_at
         FROM invoice_dunning_events WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].invoice_id).toBe(invoiceId);
    expect(rows[0].kind).toBe('reminder');
    expect(rows[0].step_key).toBe(manualReminderStepKey(firstProposalId));
    expect(rows[0].channel).toBe('sms');
    expect(rows[0].sent_at).toBeInstanceOf(Date);
  });

  it('refuses a SECOND manual reminder inside the 72h window — no second send', async () => {
    const second = await executeManualReminder();
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/72h/);
    // Still exactly one customer send across both executions.
    expect(comms.sends).toHaveLength(1);
    // No extra ledger row was written for the refused proposal.
    const { rows } = await pool.query(
      `SELECT id FROM invoice_dunning_events WHERE invoice_id = $1 AND kind = 'reminder'`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a direct duplicate insert of the same ledger key (UNIQUE violation)', async () => {
    await expect(
      dunningEventRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        invoiceId,
        kind: 'reminder',
        stepKey: manualReminderStepKey(firstProposalId),
        channel: 'sms',
        sentAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('emits an invoice.reminder_sent audit row for the delivered reminder', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'invoice' AND entity_id = $1 AND event_type = 'invoice.reminder_sent'`,
      [invoiceId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('scopes the ledger to the tenant — another tenant sees no events', async () => {
    const other = await createTestTenant(pool);
    const events = await dunningEventRepo.findByInvoice(other.tenantId, invoiceId);
    expect(events).toHaveLength(0);
  });
});
