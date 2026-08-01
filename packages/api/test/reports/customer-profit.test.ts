import { describe, it, expect } from 'vitest';
import { getCustomerProfit, type GetCustomerProfitDeps } from '../../src/reports/customer-profit';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryTimeEntryRepository } from '../../src/time-tracking/time-entry';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import type { Expense } from '../../src/expenses/expense';
import type { TimeEntry } from '../../src/time-tracking/time-entry';
import type { Job } from '../../src/jobs/job';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = 'cust-aaaa';
const OTHER_CUSTOMER = 'cust-bbbb';

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function makeJob(jobId: string, customerId: string): Job {
  return {
    id: jobId,
    tenantId: TENANT,
    customerId,
    locationId: id('loc'),
    jobNumber: id('JOB'),
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

function makeInvoice(jobId: string, totalCents: number, status: InvoiceStatus): Invoice {
  const lineItems = [buildLineItem(id('li'), 'work', 1, totalCents, 0, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: id('inv'),
    tenantId: TENANT,
    jobId,
    invoiceNumber: id('INV'),
    status,
    lineItems,
    totals,
    amountPaidCents: status === 'paid' ? totals.totalCents : 0,
    amountDueCents: status === 'paid' ? 0 : totals.totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Invoice;
}

function makeExpense(jobId: string, amountCents: number): Expense {
  return {
    id: id('exp'),
    tenantId: TENANT,
    jobId,
    description: 'parts',
    amountCents,
    category: 'materials',
    spentAt: new Date(),
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Expense;
}

function makeTimeEntry(jobId: string, minutes: number): TimeEntry {
  return {
    id: id('te'),
    tenantId: TENANT,
    userId: 'tech1',
    jobId,
    entryType: 'job',
    clockedInAt: new Date('2026-06-01T09:00:00Z'),
    clockedOutAt: new Date('2026-06-01T10:00:00Z'),
    durationMinutes: minutes,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TimeEntry;
}

async function buildDeps(opts: {
  jobs: Job[];
  invoices?: Invoice[];
  expenses?: Expense[];
  timeEntries?: TimeEntry[];
}): Promise<GetCustomerProfitDeps> {
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  for (const j of opts.jobs) await jobRepo.create(j);
  for (const inv of opts.invoices ?? []) await invoiceRepo.create(inv);
  for (const exp of opts.expenses ?? []) await expenseRepo.create(exp);
  for (const te of opts.timeEntries ?? []) await timeEntryRepo.create(te);
  return { jobRepo, invoiceRepo, expenseRepo, timeEntryRepo };
}

describe('getCustomerProfit', () => {
  it('aggregates per-job profit across a customer\'s jobs (priced labor)', async () => {
    const jobs = [makeJob('job-1', CUSTOMER), makeJob('job-2', CUSTOMER)];
    const deps = await buildDeps({
      jobs,
      // job-1: $1000 revenue, 60 min labor, $100 expense
      // job-2: $500 revenue (draft → excluded), $0 counted
      invoices: [
        makeInvoice('job-1', 100000, 'paid'),
        makeInvoice('job-2', 50000, 'draft'),
      ],
      expenses: [makeExpense('job-1', 10000)],
      timeEntries: [makeTimeEntry('job-1', 60)],
    });

    const result = await getCustomerProfit(
      { tenantId: TENANT, customerId: CUSTOMER, laborRateCentsPerHour: 6000 }, // $60/hr
      deps,
    );

    expect(result.jobCount).toBe(2);
    expect(result.revenueCents).toBe(100000); // draft invoice excluded
    expect(result.laborCents).toBe(6000); // 60 min @ $60/hr
    expect(result.expensesCents).toBe(10000);
    expect(result.materialsCents).toBe(0);
    // 100000 − 6000 labor − 10000 expense = 84000
    expect(result.marginCents).toBe(84000);
    expect(result.marginPct).toBe(84);
    expect(result.laborUnpriced).toBe(false);
    expect(result.jobs).toHaveLength(2);
  });

  it('marks labor unpriced and excludes it from margin when no rate is set', async () => {
    const deps = await buildDeps({
      jobs: [makeJob('job-1', CUSTOMER)],
      invoices: [makeInvoice('job-1', 50000, 'open')],
      timeEntries: [makeTimeEntry('job-1', 120)],
    });
    const result = await getCustomerProfit(
      { tenantId: TENANT, customerId: CUSTOMER, laborRateCentsPerHour: null },
      deps,
    );
    expect(result.laborUnpriced).toBe(true);
    expect(result.laborCents).toBe(0);
    expect(result.marginCents).toBe(50000); // labor excluded
  });

  it('returns a zero report for a customer with no jobs', async () => {
    const deps = await buildDeps({ jobs: [] });
    const result = await getCustomerProfit(
      { tenantId: TENANT, customerId: 'nobody', laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(result.jobCount).toBe(0);
    expect(result.revenueCents).toBe(0);
    expect(result.marginCents).toBe(0);
    expect(result.marginPct).toBeNull();
    expect(result.jobs).toEqual([]);
  });

  it('does not count another customer\'s jobs', async () => {
    const deps = await buildDeps({
      jobs: [makeJob('job-1', CUSTOMER), makeJob('job-9', OTHER_CUSTOMER)],
      invoices: [makeInvoice('job-1', 30000, 'paid'), makeInvoice('job-9', 99999, 'paid')],
    });
    const result = await getCustomerProfit(
      { tenantId: TENANT, customerId: CUSTOMER, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(result.jobCount).toBe(1);
    expect(result.revenueCents).toBe(30000); // OTHER_CUSTOMER's $999.99 not counted
  });
});
