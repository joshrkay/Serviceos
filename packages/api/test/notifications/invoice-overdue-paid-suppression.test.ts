import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { TransactionalCommsService } from '../../src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryCustomerRepository, Customer } from '../../src/customers/customer';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { createLogger } from '../../src/logging/logger';

/**
 * RIVET invariant I10 — send-time state re-evaluation for payment reminders.
 *
 * "A paid invoice must never receive a payment reminder." A reminder is
 * scheduled/raised against the invoice state at sweep time, but payment can
 * land in the interim. `notifyInvoiceOverdue` must re-check the LIVE invoice at
 * the moment of firing and suppress the send when the invoice is paid, void, or
 * has a zero balance — closing the payment-lands-between-raise-and-fire race
 * for both the automated dunning sweep and an owner-approved reminder proposal.
 */

const TENANT = 'tenant-i10';

function makeCustomer(): Customer {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Marcus',
    lastName: 'Henderson',
    displayName: 'Marcus Henderson',
    primaryPhone: '+15557654321',
    email: 'marcus@example.test',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeJob(customerId: string): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId,
    locationId: 'loc-1',
    jobNumber: 'JOB-100',
    summary: 'HVAC repair',
    status: 'completed',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(
  jobId: string,
  status: InvoiceStatus,
  amountDueCents: number,
): Invoice {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    invoiceNumber: 'INV-1043',
    status,
    lineItems: [],
    totals: {
      subtotalCents: 420000,
      taxCents: 0,
      totalCents: 420000,
      discountCents: 0,
    } as Invoice['totals'],
    amountPaidCents: 420000 - amountDueCents,
    amountDueCents,
    dueDate: new Date('2026-07-01T00:00:00Z'),
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Harness {
  comms: TransactionalCommsService;
  delivery: InMemoryDeliveryProvider;
  invoiceRepo: InMemoryInvoiceRepository;
  customerId: string;
  jobId: string;
}

async function buildHarness(): Promise<Harness> {
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const dispatchRepo = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();

  await settingsRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Chicago',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
  } as Parameters<InMemorySettingsRepository['create']>[0]);

  const customer = makeCustomer();
  await customerRepo.create(customer);
  const job = makeJob(customer.id);
  await jobRepo.create(job);

  const comms = new TransactionalCommsService({
    appointmentRepo: new InMemoryAppointmentRepository(),
    jobRepo,
    customerRepo,
    settingsRepo,
    invoiceRepo,
    delivery,
    dispatchRepo,
    pool: null,
    logger: createLogger({ service: 'test', environment: 'test' }),
  });

  return { comms, delivery, invoiceRepo, customerId: customer.id, jobId: job.id };
}

describe('notifyInvoiceOverdue — I10 send-time re-evaluation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('SUPPRESSES the reminder when the invoice is already paid', async () => {
    const invoice = await h.invoiceRepo.create(makeInvoice(h.jobId, 'paid', 0));
    const outcome = await h.comms.notifyInvoiceOverdue(TENANT, invoice.id, 'manual');
    expect(outcome).toEqual({ status: 'suppressed', reason: 'paid' });
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
  });

  it('SUPPRESSES the reminder when the balance is zero (fully settled, status still open)', async () => {
    const invoice = await h.invoiceRepo.create(makeInvoice(h.jobId, 'open', 0));
    await h.comms.notifyInvoiceOverdue(TENANT, invoice.id, 'manual');
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
  });

  it('SUPPRESSES the reminder when the invoice was voided', async () => {
    const invoice = await h.invoiceRepo.create(makeInvoice(h.jobId, 'void', 420000));
    await h.comms.notifyInvoiceOverdue(TENANT, invoice.id, 'manual');
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
  });

  it('SENDS the reminder when the invoice is still open with a balance due', async () => {
    const invoice = await h.invoiceRepo.create(makeInvoice(h.jobId, 'open', 420000));
    await h.comms.notifyInvoiceOverdue(TENANT, invoice.id, 'manual');
    // At least one channel delivered (consent is on for the seeded customer).
    expect(h.delivery.sentSms.length + h.delivery.sentEmails.length).toBeGreaterThan(0);
  });

  it('SUPPRESSES at the send boundary when payment lands AFTER the entry read (Codex): no SMS, no false "sent"', async () => {
    const invoice = await h.invoiceRepo.create(makeInvoice(h.jobId, 'open', 420000));
    // Simulate the payment-during-send race: the invoice is open when
    // notifyInvoiceOverdue's entry/`fresh` reads run, then a webhook settles it
    // in the async window before the provider dispatch. The eligibilityCheck
    // (which runs inside the claim, right before send) reloads and must catch
    // it. We trip the mutation on the provider call itself.
    // Mutate the invoice to paid on the eligibilityCheck's read (the 3rd read:
    // entry + `fresh` both saw OPEN), then have the payment STICK for all
    // subsequent reads (email channel included), mirroring a real webhook.
    const realFindById = h.invoiceRepo.findById.bind(h.invoiceRepo);
    let reads = 0;
    let paid = false;
    h.invoiceRepo.findById = (async (t: string, id: string) => {
      const row = await realFindById(t, id);
      reads++;
      if (id === invoice.id && reads >= 3) paid = true;
      if (paid && row && id === invoice.id) {
        return { ...row, status: 'paid' as InvoiceStatus, amountDueCents: 0, amountPaidCents: 420000 };
      }
      return row;
    }) as typeof realFindById;

    const outcome = await h.comms.notifyInvoiceOverdue(TENANT, invoice.id, 'manual');

    // Nothing was dunned, and the outcome is suppression — NOT a false "sent".
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
    expect(outcome).toEqual({ status: 'suppressed', reason: 'paid' });
  });
});
