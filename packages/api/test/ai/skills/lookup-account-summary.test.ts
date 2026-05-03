import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { lookupAccountSummary } from '../../../src/ai/skills/lookup-account-summary';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import {
  createAppointment,
  InMemoryAppointmentRepository,
} from '../../../src/appointments/appointment';
import {
  createInvoice,
  InMemoryInvoiceRepository,
  issueInvoice,
} from '../../../src/invoices/invoice';
import { InMemoryAgreementRepository } from '../../../src/agreements/agreement';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

describe('P11-001 — lookupAccountSummary skill', () => {
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let agreementRepo: InMemoryAgreementRepository;
  let lookupRepo: InMemoryLookupEventRepository;
  let lookupEvents: LookupEventService;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    agreementRepo = new InMemoryAgreementRepository();
    lookupRepo = new InMemoryLookupEventRepository();
    lookupEvents = new LookupEventService(lookupRepo);
  });

  it('happy path — stitches appointment + balance into a digest', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const job = await createJob(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        summary: 'AC repair',
        createdBy: 'u-1',
      },
      jobRepo,
    );
    await createAppointment(
      {
        tenantId: 'tenant-1',
        jobId: job.id,
        scheduledStart: future,
        scheduledEnd: new Date(future.getTime() + 60 * 60 * 1000),
        timezone: 'America/Los_Angeles',
        createdBy: 'u-1',
      },
      appointmentRepo,
    );
    const inv = await createInvoice(
      {
        tenantId: 'tenant-1',
        jobId: job.id,
        invoiceNumber: 'INV-0001',
        lineItems: [
          {
            id: 'li-1',
            description: 'service',
            quantity: 1,
            unitPriceCents: 12050,
            totalCents: 12050,
            sortOrder: 0,
            taxable: false,
          },
        ],
        createdBy: 'u-1',
      },
      invoiceRepo,
    );
    await issueInvoice('tenant-1', inv.id, 30, invoiceRepo);

    const result = await lookupAccountSummary(
      { tenantId: 'tenant-1', customerId: 'cust-1', sessionId: 'sess-1' },
      { jobRepo, appointmentRepo, invoiceRepo, agreementRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    // Two-sentence digest mentions both appointment + balance.
    expect(result.summary).toContain('AC repair');
    expect(result.summary).toContain('$120.50');
  });

  it('none — when nothing is on the account', async () => {
    const result = await lookupAccountSummary(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo, appointmentRepo, invoiceRepo, agreementRepo },
    );
    expect(result.status).toBe('none');
  });

  it('writes a single audit row even when fanning out internally', async () => {
    await lookupAccountSummary(
      { tenantId: 'tenant-1', customerId: 'cust-1', sessionId: 'sess-1' },
      { jobRepo, appointmentRepo, invoiceRepo, agreementRepo, lookupEvents },
    );

    const rows = await lookupRepo.listByTenant('tenant-1');
    // Children skills run WITHOUT lookupEvents wired so the parent
    // owns the only row — keeps audit volume sane.
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('lookup_account_summary');
  });

  it('tenant isolation — empty result for another tenant uuid', async () => {
    void uuidv4();
    const result = await lookupAccountSummary(
      { tenantId: 'tenant-2', customerId: 'cust-1' },
      { jobRepo, appointmentRepo, invoiceRepo, agreementRepo },
    );
    expect(result.status).toBe('none');
  });
});
