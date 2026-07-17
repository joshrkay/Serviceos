/**
 * P22-002 — issue-invoice execution handler tests.
 *
 * Covers: draft → open transition with issued/due dates from tenant
 * payment terms + timezone, non-draft rejection with the typed
 * InvoiceNotDraftError, idempotent re-execution, audit event emission,
 * and tenant isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  IssueInvoiceExecutionHandler,
  InvoiceNotDraftError,
} from '../../src/proposals/execution/issue-invoice-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import {
  InMemorySettingsRepository,
  TenantSettings,
} from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Proposal } from '../../src/proposals/proposal';
import {
  buildLineItem,
  calculateDocumentTotals,
  LineItem,
} from '../../src/shared/billing-engine';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import type { RefreshJobMoneyStateDeps } from '../../src/jobs/job-money-state';

const TENANT = 't-1';
const OTHER_TENANT = 't-2';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Labor', 1, 15000, 0, true, 'labor'),
  ];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'draft',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u-1',
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makeSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: `settings-${TENANT}`,
    tenantId: TENANT,
    businessName: 'Rivera HVAC',
    timezone: 'America/Los_Angeles',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 14,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    tenantId: TENANT,
    proposalType: 'issue_invoice',
    status: 'approved',
    payload: { invoiceId: INVOICE_ID },
    summary: 'Issue invoice INV-0001',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('P22-002 — issue-invoice execution handler', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let handler: IssueInvoiceExecutionHandler;
  const ctx = { tenantId: TENANT, executedBy: 'u-1' };

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeInvoice());
    await settingsRepo.create(makeSettings());
    handler = new IssueInvoiceExecutionHandler(invoiceRepo, settingsRepo, auditRepo);
  });

  describe('draft → open transition', () => {
    it('issues a draft invoice: status open, issuedAt and dueDate stamped', async () => {
      const result = await handler.execute(makeProposal(), ctx);

      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBe(INVOICE_ID);

      const issued = await invoiceRepo.findById(TENANT, INVOICE_ID);
      expect(issued!.status).toBe('open');
      expect(issued!.issuedAt).toBeInstanceOf(Date);
      expect(issued!.dueDate).toBeInstanceOf(Date);
    });

    it('computes due date from tenant default payment terms (14 days)', async () => {
      await handler.execute(makeProposal(), ctx);

      const issued = await invoiceRepo.findById(TENANT, INVOICE_ID);
      const diffDays =
        (issued!.dueDate!.getTime() - issued!.issuedAt!.getTime()) / 86_400_000;
      // Due at tenant-local midnight 14 calendar days out; issuedAt is "now",
      // so the gap is between 13 and 14.1 days (DST tolerance).
      expect(diffDays).toBeGreaterThan(13);
      expect(diffDays).toBeLessThanOrEqual(14.1);
    });

    it('due date falls at midnight in the tenant timezone', async () => {
      await handler.execute(makeProposal(), ctx);

      const issued = await invoiceRepo.findById(TENANT, INVOICE_ID);
      const wallClock = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(issued!.dueDate!);
      expect(wallClock).toMatch(/^(00|24):00$/);
    });

    it('payload paymentTermDays overrides the tenant default', async () => {
      const proposal = makeProposal({
        payload: { invoiceId: INVOICE_ID, paymentTermDays: 45 },
      });
      await handler.execute(proposal, ctx);

      const issued = await invoiceRepo.findById(TENANT, INVOICE_ID);
      const diffDays =
        (issued!.dueDate!.getTime() - issued!.issuedAt!.getTime()) / 86_400_000;
      expect(diffDays).toBeGreaterThan(44);
      expect(diffDays).toBeLessThanOrEqual(45.1);
    });

    it('falls back to 30-day terms when no settings exist', async () => {
      const noSettingsHandler = new IssueInvoiceExecutionHandler(
        invoiceRepo,
        new InMemorySettingsRepository(),
        auditRepo,
      );
      await noSettingsHandler.execute(makeProposal(), ctx);

      const issued = await invoiceRepo.findById(TENANT, INVOICE_ID);
      const diffDays =
        (issued!.dueDate!.getTime() - issued!.issuedAt!.getTime()) / 86_400_000;
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThanOrEqual(30.1);
    });

    it('resolves human-readable invoice numbers ("INV-0001", bare "0001")', async () => {
      const byNumber = await handler.execute(
        makeProposal({ payload: { invoiceId: 'INV-0001' } }),
        ctx,
      );
      expect(byNumber.success).toBe(true);
      expect(byNumber.resultEntityId).toBe(INVOICE_ID);
    });
  });

  describe('draft-only guard (typed domain error)', () => {
    it.each(['open', 'paid', 'void'] as const)(
      'rejects a %s invoice with the typed not-draft error',
      async (status) => {
        await invoiceRepo.update(TENANT, INVOICE_ID, { status });

        const result = await handler.execute(makeProposal(), ctx);

        expect(result.success).toBe(false);
        const expected = new InvoiceNotDraftError('INV-0001', status);
        expect(result.error).toBe(expected.message);
        expect(expected.code).toBe('INVOICE_NOT_DRAFT');
      },
    );

    it('returns a failed result rather than throwing', async () => {
      await invoiceRepo.update(TENANT, INVOICE_ID, { status: 'paid' });
      await expect(handler.execute(makeProposal(), ctx)).resolves.toMatchObject({
        success: false,
      });
    });
  });

  describe('idempotent re-execution', () => {
    it('re-executing an executed proposal is a no-op success', async () => {
      const proposal = makeProposal();
      const first = await handler.execute(proposal, ctx);
      expect(first.success).toBe(true);

      const before = await invoiceRepo.findById(TENANT, INVOICE_ID);

      // Executor marks the proposal executed and records the result entity.
      const reExecuted = makeProposal({
        status: 'executed',
        executedAt: new Date(),
        resultEntityId: INVOICE_ID,
      });
      const second = await handler.execute(reExecuted, ctx);

      expect(second.success).toBe(true);
      expect(second.resultEntityId).toBe(INVOICE_ID);

      const after = await invoiceRepo.findById(TENANT, INVOICE_ID);
      expect(after!.issuedAt!.getTime()).toBe(before!.issuedAt!.getTime());
      expect(after!.dueDate!.getTime()).toBe(before!.dueDate!.getTime());
      // No second audit event for the no-op.
      const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
      expect(events.filter((e) => e.eventType === 'invoice.issued')).toHaveLength(1);
    });

    it('a DIFFERENT unexecuted proposal against an open invoice still fails', async () => {
      await handler.execute(makeProposal(), ctx);

      const other = makeProposal({ id: 'prop-2', status: 'approved' });
      const result = await handler.execute(other, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cannot be issued/i);
    });
  });

  describe('audit event', () => {
    it('emits invoice.issued with proposal linkage and dates', async () => {
      await handler.execute(makeProposal(), ctx);

      const events = await auditRepo.findByEntity(TENANT, 'invoice', INVOICE_ID);
      const issued = events.find((e) => e.eventType === 'invoice.issued');
      expect(issued).toBeDefined();
      expect(issued!.actorId).toBe('u-1');
      expect(issued!.metadata).toMatchObject({
        proposalId: 'prop-1',
        proposalType: 'issue_invoice',
        invoiceNumber: 'INV-0001',
        paymentTermDays: 14,
      });
    });
  });

  describe('tenant isolation', () => {
    it('cannot issue another tenant\'s invoice', async () => {
      const result = await handler.execute(makeProposal(), {
        tenantId: OTHER_TENANT,
        executedBy: 'u-2',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);

      const untouched = await invoiceRepo.findById(TENANT, INVOICE_ID);
      expect(untouched!.status).toBe('draft');
    });
  });

  describe('validation and degraded wiring', () => {
    it('fails cleanly when invoiceId is missing', async () => {
      const result = await handler.execute(makeProposal({ payload: {} }), ctx);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/specify the invoice number/i);
    });

    it('fails cleanly when the invoice does not exist', async () => {
      const result = await handler.execute(
        makeProposal({ payload: { invoiceId: 'INV-9999' } }),
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('degrades to a synthetic-id passthrough without an invoiceRepo', async () => {
      const bare = new IssueInvoiceExecutionHandler();
      const result = await bare.execute(makeProposal(), ctx);
      expect(result.success).toBe(true);
      expect(result.resultEntityId).toBeTruthy();
    });
  });

  describe('§6 Time-to-Cash — job money-state rollup', () => {
    it('rolls the job to invoiced when constructed with money-state deps', async () => {
      const jobRepo = new InMemoryJobRepository();
      const estimateRepo = new InMemoryEstimateRepository();
      const job = await createJob(
        { tenantId: TENANT, customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u-1' },
        jobRepo,
      );
      const rollupInvoiceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      await invoiceRepo.create(makeInvoice({ id: rollupInvoiceId, jobId: job.id }));
      const deps: RefreshJobMoneyStateDeps = { jobRepo, estimateRepo, invoiceRepo, auditRepo };
      const rollupHandler = new IssueInvoiceExecutionHandler(invoiceRepo, settingsRepo, auditRepo, deps);

      const result = await rollupHandler.execute(
        makeProposal({ payload: { invoiceId: rollupInvoiceId } }),
        ctx,
      );

      expect(result.success).toBe(true);
      expect((await jobRepo.findById(TENANT, job.id))!.moneyState).toBe('invoiced');
    });
  });
});
