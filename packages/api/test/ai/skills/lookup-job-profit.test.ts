import { describe, it, expect } from 'vitest';
import {
  lookupJobProfit,
  formatJobProfitSummary,
  type LookupJobProfitDeps,
} from '../../../src/ai/skills/lookup-job-profit';
import type { JobProfit } from '../../../src/jobs/job-profit';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemoryExpenseRepository } from '../../../src/expenses/expense';
import { InMemoryTimeEntryRepository } from '../../../src/time-tracking/time-entry';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemorySettingsRepository, type TenantSettings } from '../../../src/settings/settings';
import { calculateDocumentTotals, buildLineItem } from '../../../src/shared/billing-engine';
import type { Job } from '../../../src/jobs/job';
import type { Invoice } from '../../../src/invoices/invoice';

const TENANT = '33333333-3333-3333-3333-333333333333';
const JOB = 'job-profit-skill';

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function baseProfit(over: Partial<JobProfit> = {}): JobProfit {
  return {
    revenueCents: 0,
    laborCents: 0,
    laborMinutes: 0,
    materialsCents: 0,
    expensesCents: 0,
    marginCents: 0,
    marginPct: null,
    laborUnpriced: false,
    ...over,
  };
}

describe('formatJobProfitSummary', () => {
  it('reads naturally with revenue, materials, labor, and a positive margin', () => {
    const summary = formatJobProfitSummary(
      'Miller job',
      baseProfit({
        revenueCents: 85000,
        materialsCents: 32000,
        laborMinutes: 180,
        laborCents: 12000,
        marginCents: 41000,
        marginPct: 48.2,
      }),
    );
    expect(summary).toContain('The Miller job brought in $850.00');
    expect(summary).toContain('$320.00 on materials');
    expect(summary).toContain('3 hours of labor ($120.00)');
    expect(summary).toContain('about $410.00 margin (48.2%)');
    expect(summary).not.toContain('-$');
  });

  it('phrases a negative margin as a loss (grammatical, no double negative)', () => {
    const summary = formatJobProfitSummary(
      'Davis job',
      baseProfit({
        revenueCents: 10000,
        expensesCents: 8000,
        laborMinutes: 240,
        laborCents: 24000,
        marginCents: -22000,
        marginPct: -220,
      }),
    );
    expect(summary).toContain('a loss of about $220.00');
    // The magnitude is positive; the word "loss" carries the sign.
    expect(summary).not.toContain('about $-');
    expect(summary).toContain('(-220%)');
  });

  it('appends the unpriced-labor caveat and omits the labor dollar figure', () => {
    const summary = formatJobProfitSummary(
      'Smith job',
      baseProfit({
        revenueCents: 50000,
        laborMinutes: 120,
        laborCents: null,
        laborUnpriced: true,
        marginCents: 50000,
        marginPct: 100,
      }),
    );
    expect(summary).toContain('2 hours of labor');
    expect(summary).not.toContain('hours of labor ($');
    expect(summary).toContain('set one in settings');
  });

  it('handles a zero-revenue job without a misleading 0% or $ amount', () => {
    const summary = formatJobProfitSummary('Jones job', baseProfit({ marginPct: null }));
    expect(summary).toContain("hasn't brought in any revenue yet");
    expect(summary).not.toContain('%');
  });

  it('singularizes one hour', () => {
    const summary = formatJobProfitSummary(
      'Lee job',
      baseProfit({ revenueCents: 1000, laborMinutes: 60, laborCents: 5000, marginCents: -4000, marginPct: -400 }),
    );
    expect(summary).toContain('1 hour of labor');
    expect(summary).not.toContain('1 hours');
  });
});

function makeInvoice(totalCents: number): Invoice {
  const lineItems = [buildLineItem(id('li'), 'work', 1, totalCents, 0, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: id('inv'),
    tenantId: TENANT,
    jobId: JOB,
    invoiceNumber: id('INV'),
    status: 'paid',
    lineItems,
    totals,
    amountPaidCents: totals.totalCents,
    amountDueCents: 0,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function buildSkillDeps(opts: {
  job?: Job | null;
  settings?: Partial<TenantSettings>;
  invoices?: Invoice[];
}): Promise<LookupJobProfitDeps> {
  const jobRepo = new InMemoryJobRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const timeEntryRepo = new InMemoryTimeEntryRepository();
  const expenseRepo = new InMemoryExpenseRepository();

  if (opts.job !== null) {
    const job: Job = opts.job ?? {
      id: JOB,
      tenantId: TENANT,
      customerId: 'cust1',
      locationId: 'loc1',
      jobNumber: 'JOB-0042',
      summary: 'Miller',
      status: 'completed',
      priority: 'normal',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create(job);
  }
  if (opts.settings) {
    await settingsRepo.create({
      id: 'settings1',
      tenantId: TENANT,
      businessName: 'Test',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...opts.settings,
    });
  }
  for (const inv of opts.invoices ?? []) await invoiceRepo.create(inv);

  return { jobRepo, settingsRepo, invoiceRepo, timeEntryRepo, expenseRepo };
}

describe('lookupJobProfit skill', () => {
  it('returns a found result with the per-job P&L data and spoken summary', async () => {
    const deps = await buildSkillDeps({
      settings: { laborRateCentsPerHour: 6000 },
      invoices: [makeInvoice(50000)],
    });
    const result = await lookupJobProfit({ tenantId: TENANT, jobId: JOB }, deps);
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected found');
    expect(result.data.revenueCents).toBe(50000);
    expect(result.data.jobId).toBe(JOB);
    expect(result.summary).toContain('Miller job brought in $500.00');
  });

  it('falls back to minutes-only + caveat when no labor rate is set', async () => {
    const deps = await buildSkillDeps({
      // settings row exists but no labor rate
      settings: {},
      invoices: [makeInvoice(50000)],
    });
    const result = await lookupJobProfit({ tenantId: TENANT, jobId: JOB }, deps);
    if (result.status !== 'found') throw new Error('expected found');
    expect(result.data.laborUnpriced).toBe(true);
    expect(result.data.laborCents).toBeNull();
    expect(result.summary).toContain('set one in settings');
  });

  it('treats a missing settings row as unpriced labor (no crash)', async () => {
    const deps = await buildSkillDeps({ invoices: [makeInvoice(20000)] });
    const result = await lookupJobProfit({ tenantId: TENANT, jobId: JOB }, deps);
    if (result.status !== 'found') throw new Error('expected found');
    expect(result.data.laborUnpriced).toBe(true);
  });

  it('returns not_found when the job is absent / cross-tenant', async () => {
    const deps = await buildSkillDeps({ job: null });
    const result = await lookupJobProfit({ tenantId: TENANT, jobId: JOB }, deps);
    expect(result.status).toBe('not_found');
    expect(result.summary).toContain("couldn't find that job");
  });
});
