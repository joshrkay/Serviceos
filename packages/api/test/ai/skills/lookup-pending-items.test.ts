/**
 * RV-085 — `lookup_pending_items` skill tests. Fixture repos only.
 */
import { describe, it, expect } from 'vitest';
import { lookupPendingItems } from '../../../src/ai/skills/lookup-pending-items';
import { InMemoryEstimateRepository, type Estimate } from '../../../src/estimates/estimate';
import { InMemoryInvoiceRepository, type Invoice } from '../../../src/invoices/invoice';
import { InMemoryDunningConfigRepository, defaultDunningConfig } from '../../../src/invoices/dunning-config';
import type { DocumentTotals } from '../../../src/shared/billing-engine';
import type { DroppedCallRecoveryRow } from '../../../src/sms/recovery/scheduler';

const TENANT = 'tenant-1';
const NOW = new Date('2026-06-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function totals(totalCents: number): DocumentTotals {
  return {
    subtotalCents: totalCents,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: totalCents,
    taxCents: 0,
    totalCents,
  };
}

function makeEstimate(over: Partial<Estimate>): Estimate {
  return {
    id: `est-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    jobId: 'job-1',
    estimateNumber: 'EST-0001',
    status: 'sent',
    lineItems: [],
    totals: totals(120000),
    version: 1,
    createdBy: 'u1',
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    updatedAt: new Date(NOW.getTime() - 10 * DAY),
    ...over,
  } as Estimate;
}

function makeInvoice(over: Partial<Invoice>): Invoice {
  return {
    id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    jobId: 'job-1',
    invoiceNumber: 'INV-0001',
    status: 'open',
    lineItems: [],
    totals: totals(45000),
    amountPaidCents: 0,
    amountDueCents: 45000,
    createdBy: 'u1',
    createdAt: new Date(NOW.getTime() - 20 * DAY),
    updatedAt: new Date(NOW.getTime() - 20 * DAY),
    ...over,
  } as Invoice;
}

async function fixtures(opts: { estimates?: Estimate[]; invoices?: Invoice[] } = {}) {
  const estimateRepo = new InMemoryEstimateRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  for (const e of opts.estimates ?? []) await estimateRepo.create(e);
  for (const i of opts.invoices ?? []) await invoiceRepo.create(i);
  return { estimateRepo, invoiceRepo };
}

describe('lookupPendingItems (RV-085)', () => {
  it('lists sent-but-unaccepted estimates with age in days, oldest first', async () => {
    const deps = await fixtures({
      estimates: [
        makeEstimate({ id: 'e-young', estimateNumber: 'EST-0002', sentAt: new Date(NOW.getTime() - 2 * DAY), totals: totals(30000) }),
        makeEstimate({ id: 'e-old', estimateNumber: 'EST-0001', sentAt: new Date(NOW.getTime() - 9 * DAY) }),
        makeEstimate({ id: 'e-accepted', status: 'accepted', sentAt: new Date(NOW.getTime() - 5 * DAY), acceptedAt: new Date() }),
        makeEstimate({ id: 'e-draft', status: 'draft' }),
      ],
    });

    const result = await lookupPendingItems({ tenantId: TENANT, now: NOW }, deps);

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.estimates.map((e) => e.estimateId)).toEqual(['e-old', 'e-young']);
    expect(result.data.estimates[0].ageDays).toBe(9);
    expect(result.summary).toContain('2 estimates are out waiting on a yes');
    expect(result.summary).toContain('EST-0001 for $1200.00, sent 9 days ago');
    expect(result.summary).toContain('EST-0002 for $300.00, sent 2 days ago');
  });

  it('lists open/overdue invoices, overdue first, with the dunning stage when config is wired', async () => {
    const dunningConfigRepo = new InMemoryDunningConfigRepository();
    await dunningConfigRepo.upsert({
      ...defaultDunningConfig(TENANT),
      enabled: true,
      reminderSteps: [
        { offsetDays: 3, channel: 'sms' },
        { offsetDays: 7, channel: 'email' },
        { offsetDays: 14, channel: 'sms' },
      ],
    });
    const deps = await fixtures({
      invoices: [
        makeInvoice({ id: 'i-open', invoiceNumber: 'INV-0002', dueDate: new Date(NOW.getTime() + 5 * DAY) }),
        makeInvoice({
          id: 'i-overdue',
          invoiceNumber: 'INV-0001',
          dueDate: new Date(NOW.getTime() - 8 * DAY),
          amountDueCents: 90000,
        }),
        makeInvoice({ id: 'i-paid', status: 'paid', amountDueCents: 0 }),
      ],
    });

    const result = await lookupPendingItems(
      { tenantId: TENANT, now: NOW },
      { ...deps, dunningConfigRepo },
    );

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.invoices.map((i) => i.invoiceId)).toEqual(['i-overdue', 'i-open']);
    expect(result.data.invoices[0]).toMatchObject({
      overdue: true,
      daysPastDue: 8,
      dunningStage: 'reminder 2 of 3',
    });
    expect(result.data.invoices[1].overdue).toBe(false);
    expect(result.summary).toContain('2 unpaid invoices, 1 overdue');
    expect(result.summary).toContain('INV-0001 for $900.00 (8 days overdue, reminder 2 of 3)');
    expect(result.summary).toContain('INV-0002 for $450.00 (open)');
  });

  it('omits the dunning stage when no config repo is wired', async () => {
    const deps = await fixtures({
      invoices: [makeInvoice({ id: 'i-overdue', dueDate: new Date(NOW.getTime() - 8 * DAY) })],
    });
    const result = await lookupPendingItems({ tenantId: TENANT, now: NOW }, deps);
    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.invoices[0].dunningStage).toBeUndefined();
    expect(result.summary).toContain('(8 days overdue)');
  });

  it('speaks unanswered dropped-call recovery threads via the read-only port', async () => {
    const deps = await fixtures();
    const rows: DroppedCallRecoveryRow[] = [
      {
        id: 'rec-1',
        tenantId: TENANT,
        voiceSessionId: 'vs-1',
        callerE164: '+15555550100',
        scheduledFor: new Date(NOW.getTime() - DAY),
        sentAt: new Date(NOW.getTime() - DAY),
        suppressedReason: null,
        smsMessageSid: 'SM1',
        createdAt: new Date(NOW.getTime() - DAY),
      },
      {
        // Foreign tenant rows are filtered out (explicit tenant predicate).
        id: 'rec-2',
        tenantId: 'tenant-2',
        voiceSessionId: 'vs-2',
        callerE164: '+15555550101',
        scheduledFor: new Date(NOW.getTime() - DAY),
        sentAt: new Date(NOW.getTime() - DAY),
        suppressedReason: null,
        smsMessageSid: 'SM2',
        createdAt: new Date(NOW.getTime() - DAY),
      },
    ];

    const result = await lookupPendingItems(
      { tenantId: TENANT, now: NOW },
      { ...deps, listUnansweredRecoveries: async () => rows },
    );

    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.unansweredRecoveryCount).toBe(1);
    expect(result.summary).toContain('1 dropped-call recovery text is still unanswered.');
  });

  it('a failing recovery port is non-fatal — the bucket is just omitted', async () => {
    const deps = await fixtures({
      estimates: [makeEstimate({ sentAt: new Date(NOW.getTime() - DAY) })],
    });
    const result = await lookupPendingItems(
      { tenantId: TENANT, now: NOW },
      {
        ...deps,
        listUnansweredRecoveries: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(result.status).toBe('found');
    if (result.status === 'error') throw new Error('unexpected');
    expect(result.data.unansweredRecoveryCount).toBeUndefined();
  });

  it('returns none with a clear summary when nothing is pending', async () => {
    const deps = await fixtures();
    const result = await lookupPendingItems({ tenantId: TENANT, now: NOW }, deps);
    expect(result.status).toBe('none');
    expect(result.summary).toBe(
      "You're not waiting on anything — no estimates out, no unpaid invoices.",
    );
  });

  it('never leaks another tenant\'s estimates or invoices', async () => {
    const deps = await fixtures({
      estimates: [makeEstimate({ tenantId: 'tenant-2', sentAt: new Date(NOW.getTime() - DAY) })],
      invoices: [makeInvoice({ tenantId: 'tenant-2' })],
    });
    const result = await lookupPendingItems({ tenantId: TENANT, now: NOW }, deps);
    expect(result.status).toBe('none');
  });

  it('degrades to an error summary when a repo throws', async () => {
    const deps = await fixtures();
    deps.estimateRepo.findByTenant = async () => {
      throw new Error('boom');
    };
    const result = await lookupPendingItems({ tenantId: TENANT, now: NOW }, deps);
    expect(result.status).toBe('error');
    expect(result.summary).toBe("I'm having trouble pulling up what you're waiting on right now.");
  });

  it('records a lookup_events audit row when wired', async () => {
    const deps = await fixtures({
      estimates: [makeEstimate({ sentAt: new Date(NOW.getTime() - DAY) })],
    });
    const recorded: unknown[] = [];
    await lookupPendingItems(
      { tenantId: TENANT, now: NOW, sessionId: 'sess-1' },
      {
        ...deps,
        lookupEvents: {
          record: async (input: unknown) => {
            recorded.push(input);
          },
        } as never,
      },
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: TENANT,
      intent: 'lookup_pending_items',
      sessionId: 'sess-1',
      resultStatus: 'found',
      resultCount: 1,
    });
  });
});
