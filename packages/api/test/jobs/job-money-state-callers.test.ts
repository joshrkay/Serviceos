import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, TestApp, TEST_TENANT_ID, TEST_USER_ID } from '../routes/test-app';
import { createJob, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { IssueInvoiceExecutionHandler } from '../../src/proposals/handlers/issue-invoice';
import { RecordPaymentExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import type { RefreshJobMoneyStateDeps } from '../../src/jobs/job-money-state';
import type { Proposal } from '../../src/proposals/proposal';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';
import type { DocumentTotals } from '../../src/shared/billing-engine';

const ZERO_TOTALS: DocumentTotals = {
  subtotalCents: 10000,
  discountCents: 0,
  taxRateBps: 0,
  taxableSubtotalCents: 10000,
  taxCents: 0,
  totalCents: 10000,
};

function makeInvoice(jobId: string, status: InvoiceStatus): Invoice {
  return {
    id: uuidv4(),
    tenantId: 't1',
    jobId,
    invoiceNumber: 'INV-0001',
    status,
    lineItems: [],
    totals: ZERO_TOTALS,
    amountPaidCents: 0,
    amountDueCents: 10000,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('money-state — remaining caller wiring', () => {
  describe('IssueInvoiceExecutionHandler', () => {
    it('rolls the job to invoiced when constructed with money-state deps', async () => {
      const jobRepo = new InMemoryJobRepository();
      const estimateRepo = new InMemoryEstimateRepository();
      const invoiceRepo = new InMemoryInvoiceRepository();
      const auditRepo = new InMemoryAuditRepository();
      const job = await createJob(
        { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
        jobRepo,
      );
      const invoice = await invoiceRepo.create(makeInvoice(job.id, 'draft'));
      const deps: RefreshJobMoneyStateDeps = { jobRepo, estimateRepo, invoiceRepo, auditRepo };
      const handler = new IssueInvoiceExecutionHandler(invoiceRepo, deps);

      const result = await handler.execute(
        { payload: { invoiceId: invoice.id } } as unknown as Proposal,
        { tenantId: 't1', executedBy: 'u1' } as ExecutionContext,
      );

      expect(result.success).toBe(true);
      expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('invoiced');
    });
  });

  describe('RecordPaymentExecutionHandler', () => {
    it('rolls the job to paid when constructed with money-state deps', async () => {
      const jobRepo = new InMemoryJobRepository();
      const estimateRepo = new InMemoryEstimateRepository();
      const invoiceRepo = new InMemoryInvoiceRepository();
      const paymentRepo = new InMemoryPaymentRepository();
      const auditRepo = new InMemoryAuditRepository();
      const job = await createJob(
        { tenantId: 't1', customerId: 'c1', locationId: 'l1', summary: 'Job', createdBy: 'u1' },
        jobRepo,
      );
      const invoice = await invoiceRepo.create(makeInvoice(job.id, 'open'));
      const deps: RefreshJobMoneyStateDeps = { jobRepo, estimateRepo, invoiceRepo, auditRepo };
      const handler = new RecordPaymentExecutionHandler(paymentRepo, invoiceRepo, deps);

      const result = await handler.execute(
        {
          payload: { invoiceId: invoice.id, amountCents: 10000, paymentMethod: 'cash' },
        } as unknown as Proposal,
        { tenantId: 't1', executedBy: 'u1' } as ExecutionContext,
      );

      expect(result.success).toBe(true);
      expect((await jobRepo.findById('t1', job.id))!.moneyState).toBe('paid');
    });
  });

  describe('POST /api/payments', () => {
    let ctx: TestApp;

    beforeEach(async () => {
      ctx = await buildTestApp();
    });

    it('rolls the job to paid when a payment is recorded via the payments route', async () => {
      const job = await ctx.jobRepo.create({
        id: uuidv4(),
        tenantId: TEST_TENANT_ID,
        customerId: uuidv4(),
        locationId: uuidv4(),
        jobNumber: 'JOB-0001',
        summary: 'AC repair',
        status: 'new',
        priority: 'normal',
        moneyState: 'no_estimate',
        createdBy: TEST_USER_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const invoice = await ctx.invoiceRepo.create({
        ...makeInvoice(job.id, 'open'),
        tenantId: TEST_TENANT_ID,
      });

      const res = await request(ctx.app)
        .post('/api/payments')
        .send({ invoiceId: invoice.id, amountCents: 10000, method: 'cash' });
      expect(res.status).toBe(201);

      const reloaded = await ctx.jobRepo.findById(TEST_TENANT_ID, job.id);
      expect(reloaded!.moneyState).toBe('paid');
    });
  });
});
