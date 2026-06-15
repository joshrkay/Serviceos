import { describe, it, expect } from 'vitest';
import {
  getJobProfit,
  computeLaborCents,
  computeMarginPct,
  ZERO_MATERIALS_RESOLVER,
  type GetJobProfitDeps,
  type MaterialsResolver,
} from '../../src/jobs/job-profit';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryExpenseRepository } from '../../src/expenses/expense';
import { InMemoryTimeEntryRepository } from '../../src/time-tracking/time-entry';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import type { Expense } from '../../src/expenses/expense';
import type { TimeEntry, EntryType } from '../../src/time-tracking/time-entry';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const JOB = 'job-aaaa';
const OTHER_JOB = 'job-bbbb';

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function makeInvoice(
  tenantId: string,
  jobId: string,
  totalCents: number,
  status: InvoiceStatus,
): Invoice {
  // Drive the total through the shared billing engine so the revenue figure is
  // the document total computed exactly as the rest of the app computes it.
  const lineItems = [buildLineItem(id('li'), 'work', 1, totalCents, 0, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: id('inv'),
    tenantId,
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
  };
}

function makeExpense(tenantId: string, jobId: string | undefined, amountCents: number): Expense {
  return {
    id: id('exp'),
    tenantId,
    ...(jobId ? { jobId } : {}),
    description: 'parts run',
    amountCents,
    category: 'materials',
    spentAt: new Date(),
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTimeEntry(
  tenantId: string,
  jobId: string | undefined,
  minutes: number | undefined,
  entryType: EntryType = 'job',
): TimeEntry {
  return {
    id: id('te'),
    tenantId,
    userId: 'tech1',
    ...(jobId ? { jobId } : {}),
    entryType,
    clockedInAt: new Date('2026-06-01T09:00:00Z'),
    clockedOutAt: minutes !== undefined ? new Date('2026-06-01T09:00:00Z') : undefined,
    durationMinutes: minutes,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function buildDeps(opts: {
  invoices?: Invoice[];
  expenses?: Expense[];
  timeEntries?: TimeEntry[];
  materialsResolver?: MaterialsResolver;
}): Promise<GetJobProfitDeps> {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  for (const inv of opts.invoices ?? []) await invoiceRepo.create(inv);
  for (const exp of opts.expenses ?? []) await expenseRepo.create(exp);
  for (const te of opts.timeEntries ?? []) await timeEntryRepo.create(te);
  return {
    invoiceRepo,
    expenseRepo,
    timeEntryRepo,
    ...(opts.materialsResolver ? { materialsResolver: opts.materialsResolver } : {}),
  };
}

describe('computeLaborCents', () => {
  it('converts minutes × rate/hour to integer cents', () => {
    // 180 min @ $50/hr (5000 cents) = 3 hrs × 5000 = 15000 cents
    expect(computeLaborCents(180, 5000)).toBe(15000);
  });

  it('rounds to whole cents (never a float)', () => {
    // 50 min @ $60.01/hr (6001 cents) = 6001 * 50 / 60 = 5000.83… → 5001
    const result = computeLaborCents(50, 6001);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(5001);
  });

  it('is zero for zero minutes', () => {
    expect(computeLaborCents(0, 9000)).toBe(0);
  });
});

describe('computeMarginPct', () => {
  it('returns one-decimal percentage of revenue', () => {
    expect(computeMarginPct(41000, 85000)).toBe(48.2);
  });
  it('returns null when revenue is zero (undefined percentage)', () => {
    expect(computeMarginPct(-5000, 0)).toBeNull();
  });
  it('reports a negative margin honestly', () => {
    expect(computeMarginPct(-2000, 10000)).toBe(-20);
  });
});

describe('getJobProfit', () => {
  it('priced labor + materials + expenses → cents-exact margin and pct', async () => {
    // Revenue: $850 (open) ; labor: 3h @ $40/hr = $120 ; expenses: $320 ;
    // materials: $50 (injected). margin = 85000 − 12000 − 5000 − 32000 = 36000.
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 85000, 'open')],
      expenses: [makeExpense(TENANT, JOB, 32000)],
      timeEntries: [makeTimeEntry(TENANT, JOB, 180)],
      materialsResolver: async () => 5000,
    });

    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 4000 },
      deps,
    );

    expect(profit.revenueCents).toBe(85000);
    expect(profit.laborMinutes).toBe(180);
    expect(profit.laborCents).toBe(12000);
    expect(profit.materialsCents).toBe(5000);
    expect(profit.expensesCents).toBe(32000);
    expect(profit.marginCents).toBe(36000);
    // 36000 / 85000 = 42.35…% → 42.4
    expect(profit.marginPct).toBe(42.4);
    expect(profit.laborUnpriced).toBe(false);
    // Every money field is an integer number of cents.
    for (const v of [
      profit.revenueCents,
      profit.laborCents!,
      profit.materialsCents,
      profit.expensesCents,
      profit.marginCents,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('sums revenue across open/partially_paid/paid and excludes draft/void/canceled', async () => {
    const deps = await buildDeps({
      invoices: [
        makeInvoice(TENANT, JOB, 10000, 'open'),
        makeInvoice(TENANT, JOB, 20000, 'partially_paid'),
        makeInvoice(TENANT, JOB, 30000, 'paid'),
        makeInvoice(TENANT, JOB, 99900, 'draft'), // excluded
        makeInvoice(TENANT, JOB, 88800, 'void'), // excluded
        makeInvoice(TENANT, JOB, 77700, 'canceled'), // excluded
      ],
    });

    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 5000 },
      deps,
    );

    expect(profit.revenueCents).toBe(60000);
  });

  it('no labor rate → minutes-only, laborCents null, laborUnpriced true, margin excludes labor', async () => {
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 50000, 'paid')],
      expenses: [makeExpense(TENANT, JOB, 10000)],
      timeEntries: [makeTimeEntry(TENANT, JOB, 240)],
    });

    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: null },
      deps,
    );

    expect(profit.laborUnpriced).toBe(true);
    expect(profit.laborCents).toBeNull();
    expect(profit.laborMinutes).toBe(240);
    // margin = 50000 − 0(labor) − 0(materials) − 10000 = 40000
    expect(profit.marginCents).toBe(40000);
  });

  it('treats a zero/undefined labor rate as unpriced', async () => {
    const deps = await buildDeps({
      timeEntries: [makeTimeEntry(TENANT, JOB, 60)],
    });
    const zero = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 0 },
      deps,
    );
    expect(zero.laborUnpriced).toBe(true);
    expect(zero.laborCents).toBeNull();

    const undef = await getJobProfit({ tenantId: TENANT, jobId: JOB }, deps);
    expect(undef.laborUnpriced).toBe(true);
  });

  it('no expenses → expensesCents 0', async () => {
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 20000, 'paid')],
      timeEntries: [makeTimeEntry(TENANT, JOB, 60)],
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(profit.expensesCents).toBe(0);
    // margin = 20000 − 6000(1h@$60) − 0 − 0 = 14000
    expect(profit.marginCents).toBe(14000);
  });

  it('missing job_parts table (default zero resolver) → materials 0', async () => {
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 10000, 'paid')],
      // no materialsResolver → ZERO_MATERIALS_RESOLVER default
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 5000 },
      deps,
    );
    expect(profit.materialsCents).toBe(0);
    expect(await ZERO_MATERIALS_RESOLVER(TENANT, JOB)).toBe(0);
  });

  it('a materialsResolver that throws (missing table) is treated as 0, not a crash', async () => {
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 10000, 'paid')],
      materialsResolver: async () => {
        throw new Error('relation "job_parts" does not exist');
      },
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 5000 },
      deps,
    );
    expect(profit.materialsCents).toBe(0);
  });

  it('only counts entry_type=job minutes (ignores drive/break/admin)', async () => {
    const deps = await buildDeps({
      timeEntries: [
        makeTimeEntry(TENANT, JOB, 120, 'job'),
        makeTimeEntry(TENANT, JOB, 60, 'drive'),
        makeTimeEntry(TENANT, JOB, 30, 'break'),
        makeTimeEntry(TENANT, JOB, 45, 'admin'),
      ],
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(profit.laborMinutes).toBe(120);
    expect(profit.laborCents).toBe(12000); // 2h @ $60
  });

  it('ignores open time entries (no duration yet)', async () => {
    const deps = await buildDeps({
      timeEntries: [
        makeTimeEntry(TENANT, JOB, 90, 'job'),
        makeTimeEntry(TENANT, JOB, undefined, 'job'), // still clocked in
      ],
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(profit.laborMinutes).toBe(90);
  });

  it('zero-data job → all zeros, margin 0, marginPct null', async () => {
    const deps = await buildDeps({});
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 5000 },
      deps,
    );
    expect(profit).toMatchObject({
      revenueCents: 0,
      laborCents: 0,
      laborMinutes: 0,
      materialsCents: 0,
      expensesCents: 0,
      marginCents: 0,
      marginPct: null,
      laborUnpriced: false,
    });
  });

  it('negative margin when costs exceed revenue', async () => {
    const deps = await buildDeps({
      invoices: [makeInvoice(TENANT, JOB, 10000, 'open')],
      expenses: [makeExpense(TENANT, JOB, 8000)],
      timeEntries: [makeTimeEntry(TENANT, JOB, 240)], // 4h
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 6000 },
      deps,
    );
    // margin = 10000 − 24000(4h@$60) − 0 − 8000 = -22000
    expect(profit.marginCents).toBe(-22000);
    expect(profit.marginPct).toBe(-220);
  });

  it('is tenant-scoped: never aggregates another tenant or job', async () => {
    const deps = await buildDeps({
      invoices: [
        makeInvoice(TENANT, JOB, 10000, 'paid'),
        makeInvoice(OTHER_TENANT, JOB, 99900, 'paid'), // other tenant
        makeInvoice(TENANT, OTHER_JOB, 88800, 'paid'), // other job
      ],
      expenses: [
        makeExpense(TENANT, JOB, 2000),
        makeExpense(OTHER_TENANT, JOB, 50000),
        makeExpense(TENANT, OTHER_JOB, 40000),
      ],
      timeEntries: [
        makeTimeEntry(TENANT, JOB, 60),
        makeTimeEntry(OTHER_TENANT, JOB, 600),
        makeTimeEntry(TENANT, OTHER_JOB, 600),
      ],
    });
    const profit = await getJobProfit(
      { tenantId: TENANT, jobId: JOB, laborRateCentsPerHour: 6000 },
      deps,
    );
    expect(profit.revenueCents).toBe(10000);
    expect(profit.expensesCents).toBe(2000);
    expect(profit.laborMinutes).toBe(60);
  });
});
