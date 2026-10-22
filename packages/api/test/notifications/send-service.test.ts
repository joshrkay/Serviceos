import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  NotDeliveredError,
  SendService,
  TextInFlightError,
  textNotSentError,
} from '../../src/notifications/send-service';
import type { MessageBlockReason, OutboundMessaging } from '../../src/notifications/outbound-messaging';
import { ConflictError } from '../../src/shared/errors';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery, SmsSuppressedError } from '../../src/notifications/gated-message-delivery';
import { InMemoryAuditRepository } from '../../src/audit/audit';
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
import { withOutbound } from '../helpers/outbound-messaging';
import {
  createCustomerTextWording,
  InMemoryCustomerTextWordingRepository,
} from '../../src/notifications/customer-text-wording';

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

  // WS1 — the consent/DNC gate now lives in the delivery wrapper, so the
  // SendService is handed a GatedMessageDelivery (enforcement 'block') over the
  // raw in-memory double. Assertions still inspect the raw `delivery` (sentSms).
  const gatedDelivery = new GatedMessageDelivery({
    base: delivery,
    dnc,
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
  });

  const send = new SendService(withOutbound({
    delivery: gatedDelivery,
    estimateRepo: estimate,
    invoiceRepo: invoice,
    jobRepo: job,
    customerRepo: customer,
    settingsRepo: settings,
    dispatchRepo: dispatch,
    publicBaseUrl: 'https://app.example.com',
    ensureInvoicePayLink: async () => undefined,
  }));
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

  it('preserves the original sentAt on a re-send (set-once)', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    const original = new Date('2020-01-01T00:00:00Z');
    await h.estimate.update(TENANT, est.id, { sentAt: original, status: 'sent' });

    await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });

    const persisted = await h.estimate.findById(TENANT, est.id);
    expect(persisted?.sentAt?.toISOString()).toBe(original.toISOString());
  });

  it('P11-002 — localizes the SMS when the customer prefers Spanish', async () => {
    const c = makeCustomer({ preferredLanguage: 'es' });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });

    expect(h.delivery.sentSms[0].body).toContain('su presupuesto de Acme HVAC está listo');
  });

  it('P11-002 — uses the tenant default language when no customer preference', async () => {
    await h.settings.update(TENANT, { defaultLanguage: 'es' });
    const c = makeCustomer(); // no preferredLanguage
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });

    expect(h.delivery.sentSms[0].body).toContain('su presupuesto de Acme HVAC está listo');
  });

  it('P11-002 — customer preference (en) overrides a Spanish tenant default', async () => {
    await h.settings.update(TENANT, { defaultLanguage: 'es' });
    const c = makeCustomer({ preferredLanguage: 'en' });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);

    await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });

    expect(h.delivery.sentSms[0].body).toContain('your estimate from Acme HVAC is ready');
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

  // QA 2026-07-19: "Send payment link" on a still-draft invoice returned 202
  // and silently did nothing — status stayed 'draft' forever, sentAt/issuedAt
  // never got set, and no payment link could ever be minted (createInvoicePaymentLink
  // / PublicInvoiceService.getOrCreateCheckoutUrl both require status in
  // ['open', 'partially_paid']). Draft invoices have no issuedAt/dueDate, so
  // "sending" one produces a link that can never be paid — a silent no-op with
  // zero error surfaced anywhere. Fix: reject up front instead of doing a
  // fake-success dispatch.
  it('rejects sending a draft invoice with a clear, actionable error instead of a silent no-op', async () => {
    const c = makeCustomer();
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const inv = makeInvoice(j.id);
    inv.status = 'draft';
    inv.issuedAt = undefined;
    inv.dueDate = undefined;
    await h.invoice.create(inv);

    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    await expect(
      h.send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' }),
    ).rejects.toThrow(/draft/i);

    // No message was ever dispatched, and the invoice was left untouched —
    // the failure is knowable up front, before any delivery attempt.
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
    const dispatches = await h.dispatch.findByEntity(TENANT, 'invoice', inv.id);
    expect(dispatches).toHaveLength(0);
    const persisted = await h.invoice.findById(TENANT, inv.id);
    expect(persisted?.status).toBe('draft');
    expect(persisted?.sentAt).toBeUndefined();
  });

  it.each(['void', 'canceled'] as const)(
    'rejects sending a %s invoice with a clear error',
    async (status) => {
      const c = makeCustomer();
      await h.customer.create(c);
      const j = makeJob(c.id);
      await h.job.create(j);
      const inv = makeInvoice(j.id);
      inv.status = status;
      await h.invoice.create(inv);

      await expect(
        h.send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
      expect(h.delivery.sentSms).toHaveLength(0);
    },
  );
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
    const send = new SendService(withOutbound({
      delivery: failingDelivery,
      estimateRepo: h.estimate,
      invoiceRepo: h.invoice,
      jobRepo: h.job,
      customerRepo: h.customer,
      settingsRepo: h.settings,
      dispatchRepo: h.dispatch,
      publicBaseUrl: 'https://app.example.com',
      ensureInvoicePayLink: async () => undefined,
    }));

    const result = await send.sendEstimate({
      tenantId: TENANT,
      estimateId: est.id,
      channel: 'both',
    });

    // Only the email channel succeeded.
    expect(result.channelsSent).toHaveLength(1);
    expect(result.channelsSent[0].channel).toBe('email');

    // BOTH channels have a message record: the text not sent (the provider
    // refused it, retryable, its words kept) and the email sent, each linked
    // to the customer and job so the status bubble finds them.
    const { dispatches } = await h.dispatch.listByTenant(TENANT, { entityType: 'estimate' });
    expect(dispatches).toHaveLength(2);
    const failed = dispatches.find((d) => d.channel === 'sms');
    expect(failed).toMatchObject({
      status: 'blocked',
      blockReason: 'send_failed',
      blockPermanent: false,
      customerId: c.id,
      jobId: j.id,
      purpose: 'transactional',
    });
    expect(failed?.errorMessage).toContain('invalid phone');
    const succeeded = dispatches.find((d) => d.channel === 'email');
    expect(succeeded).toMatchObject({ status: 'sent', customerId: c.id, jobId: j.id, purpose: 'transactional' });
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
    // The InMemoryDeliveryProvider records the message; we expect an
    // idempotency key set. #1145 — the key now also carries the recipient
    // and a caller context (defaults to 'default' when the caller — like
    // this one — doesn't distinguish sends) so an unrelated concurrent send
    // for the same entity+channel can't collide with this one just because
    // both land in the same minute.
    expect(h.delivery.sentSms[0].idempotencyKey).toMatch(
      new RegExp(`^estimate:${est.id}:sms:\\+15555550199:default:\\d+$`)
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

    const { dispatches: rows } = await h.dispatch.listByTenant(TENANT, { entityType: 'invoice' });
    const smsRow = rows.find((r) => r.channel === 'sms');
    expect(smsRow).toMatchObject({ status: 'blocked', blockReason: 'dnc', blockPermanent: true, customerId: c.id });
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

describe('SendService edge cases (PR #1778 reviews)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedEstimate(customer: Partial<Customer> = {}) {
    const c = makeCustomer(customer);
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const est = makeEstimate(j.id);
    await h.estimate.create(est);
    return { c, j, est };
  }

  function sendServiceWith(outbound: OutboundMessaging): SendService {
    return new SendService({
      delivery: h.delivery,
      outbound,
      estimateRepo: h.estimate,
      invoiceRepo: h.invoice,
      jobRepo: h.job,
      customerRepo: h.customer,
      settingsRepo: h.settings,
      dispatchRepo: h.dispatch,
      publicBaseUrl: 'https://app.example.com',
      ensureInvoicePayLink: async () => undefined,
    });
  }

  it('a blank number override texts the number on file, and the result names that number', async () => {
    const { est } = await seedEstimate();

    const result = await h.send.sendEstimate({
      tenantId: TENANT, estimateId: est.id, channel: 'sms', recipientPhone: '   ',
    });

    expect(h.delivery.sentSms[0].to).toBe('+15555550199');
    expect(result.channelsSent[0].recipient).toBe('+15555550199');
  });

  it('does not resend, or claim "sent", a text the carrier just reported failed', async () => {
    const { est } = await seedEstimate();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T17:04:10.000Z'));
    const first = await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });
    await h.dispatch.updateStatus(TENANT, first.channelsSent[0].dispatchId!, 'failed');

    vi.setSystemTime(new Date('2026-10-22T17:04:40.000Z'));
    await expect(
      h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' }),
    ).rejects.toThrow(/carrier reported it failed/);
    expect(h.delivery.sentSms).toHaveLength(1);
  });

  it('replays an email that bounced in the same minute instead of colliding with its row', async () => {
    const { est } = await seedEstimate();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T18:04:10.000Z'));
    const first = await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'email' });
    await h.dispatch.updateStatus(TENANT, first.channelsSent[0].dispatchId!, 'bounced');

    vi.setSystemTime(new Date('2026-10-22T18:04:40.000Z'));
    const second = await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'email' });

    expect(second.channelsSent[0].dispatchId).toBe(first.channelsSent[0].dispatchId);
    expect(h.delivery.sentEmails).toHaveLength(1);
  });

  it('a send another tap is already making is a 409, not a delivery failure', async () => {
    const { est } = await seedEstimate();
    const send = sendServiceWith({
      sendText: async () => ({ status: 'blocked', reason: 'in_flight', permanent: false }),
    });

    const err = await send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.statusCode).toBe(409);
  });

  it('a send no channel delivered is a NotDeliveredError, which owner routes commit with', async () => {
    const { est } = await seedEstimate({ smsConsent: false });

    const err = await h.send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' }).catch((e) => e);

    expect(err).toBeInstanceOf(NotDeliveredError);
    expect(err.message).toMatch(/Estimate send failed on all channels: sms to \+15555550199: SMS suppressed: no_consent/);
  });

  it('tells the owner when the text provider rejected the credentials', async () => {
    const { est } = await seedEstimate();
    const send = sendServiceWith({
      sendText: async () => ({
        status: 'blocked', reason: 'send_failed', permanent: false, detail: 'Twilio 401', errorCode: 'AUTH_FAILED',
      }),
    });

    await expect(
      send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' }),
    ).rejects.toThrow(/sms to \+15555550199: delivery authentication failed/);
  });
});

describe('textNotSentError', () => {
  const block = (reason: MessageBlockReason, extra: Partial<{ errorCode: string }> = {}) =>
    textNotSentError({ status: 'blocked', reason, permanent: false, ...extra });

  it('turns every gate refusal into a suppression, so an auto send can fall back to email', () => {
    for (const reason of [
      'no_consent', 'dnc', 'missing_consent_context', 'revoked', 'channel_disabled', 'recipient_volume_cap',
    ] as const) {
      const err = block(reason);
      expect(err).toBeInstanceOf(SmsSuppressedError);
      expect((err as SmsSuppressedError).reason).toBe(reason);
    }
  });

  it('names the other reasons plainly', () => {
    expect(block('in_flight')).toBeInstanceOf(TextInFlightError);
    expect(block('send_failed')).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(block('send_failed', { errorCode: 'AUTH_FAILED' })).toMatchObject({ code: 'AUTH_FAILED' });
    expect(block('lookup_failed').message).toMatch(/couldn't be checked/);
    expect(block('no_phone').message).toBe('text not sent: no phone');
  });
});

describe("SendService — the owner's own text wording (D-045)", () => {
  let h: Harness;
  let wordingRepo: InMemoryCustomerTextWordingRepository;
  let send: SendService;
  beforeEach(async () => {
    h = await buildHarness();
    wordingRepo = new InMemoryCustomerTextWordingRepository();
    send = new SendService(
      withOutbound({
        delivery: h.delivery,
        estimateRepo: h.estimate,
        invoiceRepo: h.invoice,
        jobRepo: h.job,
        customerRepo: h.customer,
        settingsRepo: h.settings,
        dispatchRepo: h.dispatch,
        publicBaseUrl: 'https://app.example.com',
        ensureInvoicePayLink: async () => undefined,
        wording: createCustomerTextWording({ repo: wordingRepo, logger: { warn: () => {} } }),
      }),
    );
  });

  async function seedJob(customer: Partial<Customer> = {}) {
    const c = makeCustomer(customer);
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    return { c, j };
  }

  it("an estimate text uses the owner's wording, with the per-send note on the second line", async () => {
    const { j } = await seedJob();
    const est = makeEstimate(j.id);
    await h.estimate.create(est);
    await wordingRepo.save(TENANT, 'estimate_text', 'Hi {{customer_name}}! {{business_name}} quote {{number}}: {{total}}\n{{link}}', 'en', 'user-1');

    await send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms', customMessage: 'Good for 30 days' });

    const body = h.delivery.sentSms[0].body;
    expect(body).toMatch(/^Hi Sarah Johnson! Acme HVAC quote EST-1042: \$875\.00\nGood for 30 days\nhttps:\/\/app\.example\.com\/e\/[\w-]+$/);
  });

  it('reads the wording once, before any channel goes out (channels share the request connection)', async () => {
    const { j } = await seedJob();
    const est = makeEstimate(j.id);
    await h.estimate.create(est);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sendEmail = vi.spyOn(h.delivery, 'sendEmail');
    sendEmail.mockImplementation(async () => {
      events.push('email');
      return { provider: 'mem', providerMessageId: 'e-1', channel: 'email' } as never;
    });
    const ordered = new SendService(
      withOutbound({
        delivery: h.delivery,
        estimateRepo: h.estimate,
        invoiceRepo: h.invoice,
        jobRepo: h.job,
        customerRepo: h.customer,
        settingsRepo: h.settings,
        dispatchRepo: h.dispatch,
        publicBaseUrl: 'https://app.example.com',
        ensureInvoicePayLink: async () => undefined,
        wording: {
          textFor: async (args) => {
            events.push('wording:start');
            await gate;
            events.push('wording:end');
            return args.builtIn();
          },
        },
      }),
    );

    const sending = ordered.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'both' });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['wording:start']);
    release();
    await sending;

    expect(events.slice(0, 3)).toEqual(['wording:start', 'wording:end', 'email']);
  });

  it('the email is untouched by the text wording', async () => {
    const { j } = await seedJob();
    const est = makeEstimate(j.id);
    await h.estimate.create(est);
    await wordingRepo.save(TENANT, 'estimate_text', 'OWNER {{link}}', 'en', 'user-1');

    await send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'email' });

    expect(h.delivery.sentEmails[0].text).not.toContain('OWNER');
  });

  it('a customer who reads Spanish gets our Spanish text, not the English wording', async () => {
    const { j } = await seedJob({ preferredLanguage: 'es-MX' });
    const est = makeEstimate(j.id);
    await h.estimate.create(est);
    await wordingRepo.save(TENANT, 'estimate_text', 'OWNER {{link}}', 'en', 'user-1');

    await send.sendEstimate({ tenantId: TENANT, estimateId: est.id, channel: 'sms' });

    expect(h.delivery.sentSms[0].body).not.toContain('OWNER');
    expect(h.delivery.sentSms[0].body).toMatch(/estimado|presupuesto|cotizaci/i);
  });

  it("an invoice paid in person keeps our in-person line after the owner's wording", async () => {
    await h.settings.update(TENANT, { paymentCollectionMode: 'collect_on_site' });
    const { j } = await seedJob();
    const inv = makeInvoice(j.id);
    await h.invoice.create(inv);
    await wordingRepo.save(TENANT, 'invoice_text', 'Invoice {{number}} for {{total}}: {{link}}', 'en', 'user-1');

    await send.sendInvoice({ tenantId: TENANT, invoiceId: inv.id, channel: 'sms' });

    const lines = h.delivery.sentSms[0].body.split('\n');
    expect(lines[0]).toMatch(/^Invoice INV-2042 for \$1250\.00: https:\/\/app\.example\.com\/pay\//);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Acme HVAC/);
  });

  it('a portal-link text uses the owner wording with the portal link', async () => {
    const { c } = await seedJob();
    await wordingRepo.save(TENANT, 'portal_link_text', 'Your {{business_name}} account: {{link}}', 'en', 'user-1');

    await send.sendPortalLink({
      tenantId: TENANT,
      customerId: c.id,
      portalSessionId: uuidv4(),
      portalUrl: 'https://app.example.com/portal/tok',
      channel: 'sms',
    });

    expect(h.delivery.sentSms[0].body).toBe('Your Acme HVAC account: https://app.example.com/portal/tok');
  });
});
