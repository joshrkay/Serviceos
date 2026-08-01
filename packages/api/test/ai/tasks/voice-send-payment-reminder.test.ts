/**
 * Wave B follow-up — send_payment_reminder voice on-ramp (task-handler level).
 *
 * The SendPaymentReminderExecutionHandler already exists (delivers the overdue
 * notice). Its payload was built for the dunning sweep (stepKey/offsetDays/
 * channel), but those are audit-only metadata — the handler only acts on
 * invoiceId. The voice handler stamps manual defaults for the cadence fields
 * and flags invoiceId missing for the review UI, so an ad-hoc "chase the Smith
 * invoice" works without changing the execution schema the sweep depends on.
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { SendPaymentReminderTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { sendPaymentReminderPayloadSchema } from '../../../src/proposals/contracts/send-payment-reminder';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../../src/invoices/invoice';
import {
  DunningEventRepository,
  InMemoryDunningEventRepository,
} from '../../../src/invoices/dunning-config';
import type { DocumentTotals } from '../../../src/shared/billing-engine';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('SendPaymentReminderTaskHandler', () => {
  it('carries the invoice reference, stamps manual cadence defaults, stays in draft', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Smith invoice' } }),
    );
    expect(res.proposal.proposalType).toBe('send_payment_reminder');
    expect(res.proposal.payload.invoiceReference).toBe('the Smith invoice');
    expect(res.proposal.payload.stepKey).toBe('manual');
    expect(res.proposal.payload.offsetDays).toBe(0);
    expect(res.proposal.payload.channel).toBe('sms');
    // invoiceId always flagged missing → approval gate holds until resolved.
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
    expect(res.proposal.status).toBe('draft'); // comms never auto-approves
  });

  it('once invoiceId is resolved, the payload satisfies the execution schema', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Smith', sendChannel: 'email' } }),
    );
    // The review UI resolves the reference → invoiceId; the resulting payload
    // must parse against the schema the execution handler enforces.
    const resolved = {
      ...res.proposal.payload,
      invoiceId: '11111111-1111-1111-1111-111111111111',
    };
    expect(sendPaymentReminderPayloadSchema.safeParse(resolved).success).toBe(true);
    expect(res.proposal.payload.channel).toBe('email');
  });

  it('flags invoiceId missing when no reference was extracted', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });
});

// Layer 3 (best-effort) — draft-time duplicate-reminder marker.
describe('SendPaymentReminderTaskHandler — duplicate-reminder marker', () => {
  const TENANT = 't-1';
  const CUSTOMER_ID = 'cust-1';
  const NOW = new Date('2026-05-14T12:00:00Z');
  const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
  const TWENTY_DAYS_AGO = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);

  const ZERO_TOTALS: DocumentTotals = {
    subtotalCents: 0,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: 0,
    taxCents: 0,
    totalCents: 10000,
  };

  async function seedUnpaidInvoice(
    jobRepo: InMemoryJobRepository,
    invoiceRepo: InMemoryInvoiceRepository,
    status: InvoiceStatus = 'open',
  ): Promise<Invoice> {
    const job = await createJob(
      { tenantId: TENANT, customerId: CUSTOMER_ID, locationId: 'l1', summary: 'Job', createdBy: 'u1' },
      jobRepo,
    );
    const invoice: Invoice = {
      id: uuidv4(),
      tenantId: TENANT,
      jobId: job.id,
      invoiceNumber: 'INV-0001',
      status,
      lineItems: [],
      totals: ZERO_TOTALS,
      amountPaidCents: 0,
      amountDueCents: 10000,
      dueDate: TWENTY_DAYS_AGO,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return invoiceRepo.create(invoice);
  }

  function handlerWith(
    jobRepo: InMemoryJobRepository,
    invoiceRepo: InMemoryInvoiceRepository,
    dunningEventRepo: DunningEventRepository,
  ): SendPaymentReminderTaskHandler {
    return new SendPaymentReminderTaskHandler({ dunningEventRepo, invoiceRepo, jobRepo });
  }

  function markers(payload: Record<string, unknown>): Array<{ path: string; reason: string }> {
    const meta = payload._meta as { markers?: Array<{ path: string; reason: string }> } | undefined;
    return meta?.markers ?? [];
  }

  it('attaches a medium-confidence invoiceId marker when a recent reminder exists', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const ledger = new InMemoryDunningEventRepository();
    const invoice = await seedUnpaidInvoice(jobRepo, invoiceRepo);
    await ledger.create({
      id: uuidv4(),
      tenantId: TENANT,
      invoiceId: invoice.id,
      kind: 'reminder',
      stepKey: '3:sms',
      channel: 'sms',
      sentAt: TWO_DAYS_AGO,
    });

    const res = await handlerWith(jobRepo, invoiceRepo, ledger).handle(
      ctx({ customerId: CUSTOMER_ID, now: NOW, existingEntities: { customerName: 'Smith' } }),
    );

    const meta = res.proposal.payload._meta as { overallConfidence?: string };
    expect(meta?.overallConfidence).toBe('medium');
    const m = markers(res.proposal.payload);
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('invoiceId');
    expect(m[0].reason).toMatch(/2 day\(s\) ago/);
    expect(m[0].reason).toMatch(/sms/);
  });

  it('no marker when the ledger is clean (no prior reminders)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const ledger = new InMemoryDunningEventRepository();
    await seedUnpaidInvoice(jobRepo, invoiceRepo);

    const res = await handlerWith(jobRepo, invoiceRepo, ledger).handle(
      ctx({ customerId: CUSTOMER_ID, now: NOW, existingEntities: {} }),
    );
    expect(res.proposal.payload._meta).toBeUndefined();
  });

  it('no marker when the most recent reminder is outside the 14-day window', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const ledger = new InMemoryDunningEventRepository();
    const invoice = await seedUnpaidInvoice(jobRepo, invoiceRepo);
    await ledger.create({
      id: uuidv4(),
      tenantId: TENANT,
      invoiceId: invoice.id,
      kind: 'reminder',
      stepKey: '3:sms',
      channel: 'sms',
      sentAt: TWENTY_DAYS_AGO,
    });

    const res = await handlerWith(jobRepo, invoiceRepo, ledger).handle(
      ctx({ customerId: CUSTOMER_ID, now: NOW, existingEntities: {} }),
    );
    expect(res.proposal.payload._meta).toBeUndefined();
  });

  it('no marker when there is no resolved customerId', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const ledger = new InMemoryDunningEventRepository();
    const invoice = await seedUnpaidInvoice(jobRepo, invoiceRepo);
    await ledger.create({
      id: uuidv4(),
      tenantId: TENANT,
      invoiceId: invoice.id,
      kind: 'reminder',
      stepKey: '3:sms',
      channel: 'sms',
      sentAt: TWO_DAYS_AGO,
    });

    const res = await handlerWith(jobRepo, invoiceRepo, ledger).handle(
      ctx({ now: NOW, existingEntities: { customerName: 'Smith' } }),
    );
    expect(res.proposal.payload._meta).toBeUndefined();
  });

  it('no marker when deps are absent (legacy construction)', async () => {
    const res = await new SendPaymentReminderTaskHandler().handle(
      ctx({ customerId: CUSTOMER_ID, now: NOW, existingEntities: { customerName: 'Smith' } }),
    );
    expect(res.proposal.payload._meta).toBeUndefined();
  });

  it('drafts without a marker when a repo throws (best-effort, never blocks)', async () => {
    const jobRepo = new InMemoryJobRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    await seedUnpaidInvoice(jobRepo, invoiceRepo);
    const throwingLedger: DunningEventRepository = {
      create: async () => {
        throw new Error('unused');
      },
      findByInvoice: async () => {
        throw new Error('ledger down');
      },
    };

    const res = await handlerWith(jobRepo, invoiceRepo, throwingLedger).handle(
      ctx({ customerId: CUSTOMER_ID, now: NOW, existingEntities: { customerName: 'Smith' } }),
    );
    expect(res.proposal.proposalType).toBe('send_payment_reminder');
    expect(res.proposal.payload._meta).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });
});
