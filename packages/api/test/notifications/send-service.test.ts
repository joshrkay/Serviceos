import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import {
  InMemoryCustomerRepository,
  Customer,
} from '../../src/customers/customer';
import {
  InMemoryJobRepository,
  Job,
} from '../../src/jobs/job';
import {
  InMemoryEstimateRepository,
  Estimate,
} from '../../src/estimates/estimate';
import {
  InMemoryInvoiceRepository,
  Invoice,
} from '../../src/invoices/invoice';
import {
  InMemorySettingsRepository,
} from '../../src/settings/settings';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';

const TENANT = 'tenant-test-1';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const id = overrides.id ?? uuidv4();
  return {
    id,
    tenantId: TENANT,
    firstName: 'Sarah',
    lastName: 'Johnson',
    displayName: 'Sarah Johnson',
    primaryPhone: '+15555550199',
    email: 'sarah@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJob(customerId: string): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId,
    locationId: 'loc-1',
    jobNumber: 'JOB-001',
    summary: 'AC repair',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeEstimate(jobId: string, total = 87500): Estimate {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    estimateNumber: 'EST-1042',
    status: 'draft',
    lineItems: [],
    totals: {
      subtotalCents: total,
      taxableSubtotalCents: total,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: total,
    },
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeInvoice(jobId: string, total = 125000): Invoice {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    invoiceNumber: 'INV-2042',
    status: 'open',
    lineItems: [],
    totals: {
      subtotalCents: total,
      taxableSubtotalCents: total,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: total,
    },
    amountPaidCents: 0,
    amountDueCents: total,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Harness {
  send: SendService;
  delivery: InMemoryDeliveryProvider;
  dispatch: InMemoryDispatchRepository;
  customer: InMemoryCustomerRepository;
  job: InMemoryJobRepository;
  estimate: InMemoryEstimateRepository;
  invoice: InMemoryInvoiceRepository;
  settings: InMemorySettingsRepository;
  dnc: InMemoryDncRepository;
}

async function buildHarness(): Promise<Harness> {
  const customer = new InMemoryCustomerRepository();
  const job = new InMemoryJobRepository();
  const estimate = new InMemoryEstimateRepository();
  const invoice = new InMemoryInvoiceRepository();
  const settings = new InMemorySettingsRepository();
  const dispatch = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  const dnc = new InMemoryDncRepository();

  await settings.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Los_Angeles',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const send = new SendService({
    delivery,
    estimateRepo: estimate,
    invoiceRepo: invoice,
    jobRepo: job,
    customerRepo: customer,
    settingsRepo: settings,
    dispatchRepo: dispatch,
    dncRepo: dnc,
    publicBaseUrl: 'https://app.example.com',
  });
  return { send, delivery, dispatch, customer, job, estimate, invoice, settings, dnc };
}

describe('SendService.sendEstimate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('sends SMS, creates dispatch row, transitions to sent, persists view token', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const result = await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'sms',
    });

    expect(result.channelsSent).toHaveLength(1);
    expect(result.channelsSent[0].channel).toBe('sms');
    expect(result.channelsSent[0].recipient).toBe('+15555550199');
    expect(result.viewUrl).toMatch(/^https:\/\/app\.example\.com\/e\/[A-Za-z0-9_-]+$/);

    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentSms[0].body).toContain('EST-1042');
    expect(h.delivery.sentSms[0].body).toContain(result.viewUrl);

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.viewToken).toBe(result.viewToken);
    expect(persisted?.sentAt).toBeInstanceOf(Date);
    expect(persisted?.status).toBe('sent');

    const dispatches = await h.dispatch.findByEntity(TENANT, 'estimate', est.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].channel).toBe('sms');
    expect(dispatches[0].provider).toBe('in-memory');
  });

  it('sends both SMS and email when channel=both', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const result = await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'both',
    });

    expect(result.channelsSent).toHaveLength(2);
    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentEmails).toHaveLength(1);
    expect(h.delivery.sentEmails[0].subject).toContain('EST-1042');
  });

  it('throws when channel=sms but customer has no phone', async () => {
    const c = makeCustomer({ primaryPhone: undefined });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await expect(
      h.send.sendEstimate({
        tenantId: TENANT,
        estimateId: est.id,
        channel: 'sms',
      })
    ).rejects.toThrow(/no phone number/);
  });

  it('reuses existing view token on second send', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const first = await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'sms',
    });
    const second = await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'sms',
    });

    expect(second.viewToken).toBe(first.viewToken);
    expect(second.viewUrl).toBe(first.viewUrl);
  });

  it('uses recipientPhone override when provided', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'sms',
      recipientPhone: '+15555550111',
    });

    expect(h.delivery.sentSms[0].to).toBe('+15555550111');
  });

  it('throws NotFoundError when estimate is missing', async () => {
    await expect(
      h.send.sendEstimate({
        tenantId: TENANT,
        estimateId: 'no-such-id',
        channel: 'sms',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SendService.sendInvoice', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('sends SMS, persists view token, creates dispatch row', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const inv = makeInvoice(j.id);
    inv.dueDate = new Date('2026-05-15T00:00:00.000Z');
    await h.invoice.create(inv);

    const result = await h.send.sendInvoice({
      tenantId: TENANT,
      invoiceId: inv.id,
      channel: 'sms',
    });

    expect(result.viewUrl).toMatch(/^https:\/\/app\.example\.com\/pay\/[A-Za-z0-9_-]+$/);
    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentSms[0].body).toContain('Due 2026-05-15');

    const persisted = await h.invoice.findById(TENANT, inv.id);
    expect(persisted?.viewToken).toBe(result.viewToken);
    expect(persisted?.sentAt).toBeInstanceOf(Date);
    // Invoice status is NOT auto-transitioned by send (open already)
    expect(persisted?.status).toBe('open');
  });

  it('throws NotFoundError when invoice is missing', async () => {
    await expect(
      h.send.sendInvoice({
        tenantId: TENANT,
        invoiceId: 'no-such-id',
        channel: 'sms',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SendService — failure audit and idempotency', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('writes a failed dispatch row when a channel throws', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    // Stub the delivery provider to fail SMS but succeed email.
    const failingDelivery = {
      sendSms: async () => {
        throw new Error('Twilio rejected: invalid phone');
      },
      sendEmail: async () => ({
        providerMessageId: 'sg-ok',
        provider: 'email-gateway',
        channel: 'email' as const,
      }),
    };
    const send = new SendService({
      delivery: failingDelivery,
      estimateRepo: h.estimate,
      invoiceRepo: h.invoice,
      jobRepo: h.job,
      customerRepo: h.customer,
      settingsRepo: h.settings,
      dispatchRepo: h.dispatch,
      dncRepo: h.dnc,
      publicBaseUrl: 'https://app.example.com',
    });

    const result = await send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'both',
    });

    // Only the email channel succeeded.
    expect(result.channelsSent).toHaveLength(1);
    expect(result.channelsSent[0].channel).toBe('email');

    // BOTH a failed (sms) and a sent (email) dispatch were written.
    const dispatches = await h.dispatch.findByEntity(TENANT, 'estimate', est.id);
    expect(dispatches).toHaveLength(2);
    const failed = dispatches.find((d) => d.status === 'failed');
    expect(failed?.channel).toBe('sms');
    expect(failed?.errorMessage).toContain('invalid phone');
    const succeeded = dispatches.find((d) => d.status === 'sent');
    expect(succeeded?.channel).toBe('email');
  });

  it('passes a stable idempotency key to the delivery provider', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const result = await h.send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'sms',
    });

    expect(result.channelsSent[0].channel).toBe('sms');
    // The InMemoryDeliveryProvider records the message; we expect an idempotency key set.
    expect(h.delivery.sentSms[0].idempotencyKey).toMatch(
      new RegExp(`^estimate:${est.id}:sms:\\d+$`)
    );
  });
});

describe('SendService SMS suppression (§7 phase 1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('SMS to a DNC-listed phone is blocked; email still sends; failed dispatch row recorded', async () => {
    const c = makeCustomer({ primaryPhone: '+15551234567', email: 'cust@example.com', smsConsent: true });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const inv = makeInvoice(j.id);
    await h.invoice.create(inv);
    h.dnc.add(TENANT, normalizePhone('+15551234567'));

    const result = await h.send.sendInvoice({
      tenantId: TENANT, invoiceId: inv.id, channel: 'both',
    });

    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(1);
    expect(result.channelsSent.map((c) => c.channel)).toEqual(['email']);

    const rows = await h.dispatch.findByEntity(TENANT, 'invoice', inv.id);
    const smsRow = rows.find((r) => r.channel === 'sms');
    expect(smsRow?.status).toBe('failed');
    expect(smsRow?.errorMessage ?? '').toMatch(/suppressed|DNC|opt[- ]?out/i);
  });

  it('SMS to a customer with sms_consent=false is blocked even when channel=sms only', async () => {
    const c = makeCustomer({ primaryPhone: '+15551234567', email: 'cust@example.com', smsConsent: false });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const inv = makeInvoice(j.id);
    await h.invoice.create(inv);

    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' }),
    ).rejects.toThrow(/consent|suppressed/i);
    expect(h.delivery.sentSms).toHaveLength(0);
  });

  it('SMS to a customer with consent + clean DNC sends normally', async () => {
    const c = makeCustomer({ primaryPhone: '+15551234567', email: 'cust@example.com', smsConsent: true });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const inv = makeInvoice(j.id);
    await h.invoice.create(inv);

    await h.send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' });
    expect(h.delivery.sentSms).toHaveLength(1);
  });
});
