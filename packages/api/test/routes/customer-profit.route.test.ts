import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import { InMemoryTimeEntryRepository } from '../../src/time-tracking/time-entry';
import { InMemoryJobRepository, type Job } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import type { TenantSettings } from '../../src/settings/settings';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';

const TENANT = 'tenant-r1';

function job(jobId: string, customerId: string): Job {
  return {
    id: jobId,
    tenantId: TENANT,
    customerId,
    locationId: 'loc-1',
    jobNumber: `JOB-${jobId}`,
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    moneyState: 'invoiced',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Job;
}

function paidInvoice(jobId: string, totalCents: number): Invoice {
  const lineItems = [buildLineItem(`li-${jobId}`, 'work', 1, totalCents, 0, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: `inv-${jobId}`,
    tenantId: TENANT,
    jobId,
    invoiceNumber: `INV-${jobId}`,
    status: 'paid',
    lineItems,
    totals,
    amountPaidCents: totals.totalCents,
    amountDueCents: 0,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Invoice;
}

async function buildApp(opts: { wireDeps: boolean }) {
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({ tenantId: TENANT, laborRateCentsPerHour: 6000 } as unknown as TenantSettings);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/reports',
    createReportsRouter(
      opts.wireDeps
        ? {
            revenueBySourceRepo: new InMemoryRevenueBySourceRepository(),
            jobRepo,
            invoiceRepo,
            timeEntryRepo,
            expenseRepo,
            settingsRepo,
          }
        : { revenueBySourceRepo: new InMemoryRevenueBySourceRepository() },
    ),
  );
  return { app, jobRepo, invoiceRepo };
}

describe('GET /api/reports/customer-profit/:customerId', () => {
  it('returns the aggregated customer profit under data', async () => {
    const { app, jobRepo, invoiceRepo } = await buildApp({ wireDeps: true });
    await jobRepo.create(job('j1', 'cust-1'));
    await jobRepo.create(job('j2', 'cust-1'));
    await invoiceRepo.create(paidInvoice('j1', 80000));
    await invoiceRepo.create(paidInvoice('j2', 20000));

    const res = await request(app).get('/api/reports/customer-profit/cust-1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      customerId: 'cust-1',
      jobCount: 2,
      revenueCents: 100000,
      marginCents: 100000, // no labor/expenses seeded
    });
    expect(res.body.data.jobs).toHaveLength(2);
  });

  it('returns a zero report for a customer with no jobs', async () => {
    const { app } = await buildApp({ wireDeps: true });
    const res = await request(app).get('/api/reports/customer-profit/nobody');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ jobCount: 0, revenueCents: 0, marginPct: null });
  });

  it('503s when the profit deps are not configured', async () => {
    const { app } = await buildApp({ wireDeps: false });
    const res = await request(app).get('/api/reports/customer-profit/cust-1');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });
});
