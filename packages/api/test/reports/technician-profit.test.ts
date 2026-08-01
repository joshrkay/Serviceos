import { describe, it, expect } from 'vitest';
import { getTechnicianProfit, type GetTechnicianProfitDeps } from '../../src/reports/technician-profit';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryTimeEntryRepository } from '../../src/time-tracking/time-entry';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import type { TimeEntry } from '../../src/time-tracking/time-entry';
import type { Job } from '../../src/jobs/job';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH_A = 'tech-aaaa';
const TECH_B = 'tech-bbbb';

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function makeJob(jobId: string, technicianId: string | undefined): Job {
  return {
    id: jobId,
    tenantId: TENANT,
    customerId: id('cust'),
    locationId: id('loc'),
    jobNumber: id('JOB'),
    summary: 'AC repair',
    status: 'completed',
    priority: 'normal',
    ...(technicianId ? { assignedTechnicianId: technicianId } : {}),
    depositRequiredCents: 0,
    depositPaidCents: 0,
    depositStatus: 'not_required',
    moneyState: 'invoiced',
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Job;
}

function paidInvoice(jobId: string, totalCents: number, status: InvoiceStatus = 'paid'): Invoice {
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

function timeEntry(jobId: string, minutes: number): TimeEntry {
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
  timeEntries?: TimeEntry[];
}): Promise<GetTechnicianProfitDeps> {
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  for (const j of opts.jobs) await jobRepo.create(j);
  for (const inv of opts.invoices ?? []) await invoiceRepo.create(inv);
  for (const te of opts.timeEntries ?? []) await timeEntryRepo.create(te);
  return { jobRepo, invoiceRepo, expenseRepo, timeEntryRepo };
}

describe('getTechnicianProfit', () => {
  it('aggregates only the jobs assigned to the technician', async () => {
    const deps = await buildDeps({
      jobs: [makeJob('j1', TECH_A), makeJob('j2', TECH_A), makeJob('j9', TECH_B)],
      invoices: [
        paidInvoice('j1', 60000),
        paidInvoice('j2', 40000),
        paidInvoice('j9', 99999), // TECH_B's job — must not count
      ],
      timeEntries: [timeEntry('j1', 60)],
    });

    const result = await getTechnicianProfit(
      { tenantId: TENANT, technicianId: TECH_A, laborRateCentsPerHour: 6000 },
      deps,
    );

    expect(result.technicianId).toBe(TECH_A);
    expect(result.jobCount).toBe(2);
    expect(result.revenueCents).toBe(100000); // TECH_B excluded
    expect(result.laborCents).toBe(6000); // 60 min @ $60/hr
    expect(result.marginCents).toBe(94000); // 100000 − 6000
    expect(result.marginPct).toBe(94);
    expect(result.jobs).toHaveLength(2);
  });

  it('excludes a draft invoice from revenue', async () => {
    const deps = await buildDeps({
      jobs: [makeJob('j1', TECH_A)],
      invoices: [paidInvoice('j1', 50000, 'draft')],
    });
    const result = await getTechnicianProfit(
      { tenantId: TENANT, technicianId: TECH_A, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(result.revenueCents).toBe(0);
  });

  it('returns a zero report for a technician with no assigned jobs', async () => {
    const deps = await buildDeps({ jobs: [makeJob('j1', TECH_A)] });
    const result = await getTechnicianProfit(
      { tenantId: TENANT, technicianId: 'nobody', laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(result.jobCount).toBe(0);
    expect(result.revenueCents).toBe(0);
    expect(result.marginPct).toBeNull();
    expect(result.jobs).toEqual([]);
  });

  it('marks labor unpriced when no rate is set', async () => {
    const deps = await buildDeps({
      jobs: [makeJob('j1', TECH_A)],
      invoices: [paidInvoice('j1', 30000, 'open')],
      timeEntries: [timeEntry('j1', 120)],
    });
    const result = await getTechnicianProfit(
      { tenantId: TENANT, technicianId: TECH_A, laborRateCentsPerHour: null },
      deps,
    );
    expect(result.laborUnpriced).toBe(true);
    expect(result.laborCents).toBe(0);
    expect(result.marginCents).toBe(30000);
  });
});
