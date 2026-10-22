/**
 * The automatic estimate reminder is a non-transactional nudge: outside the
 * recipient-local window it is DEFERRED — not texted, not recorded as a failed
 * dispatch, the reminder count not advanced — and the next in-window sweep
 * sends it.
 *
 * Seam: runEstimateReminderSweep over a real SendService + gated in-memory
 * delivery (tenant zone America/Phoenix, UTC-7).
 */
import { describe, it, expect } from 'vitest';
import { runEstimateReminderSweep } from '../../src/workers/estimate-reminder-worker';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildCustomer } from '../factories/customer.factory';
import { buildJob } from '../factories/job.factory';
import { buildEstimate } from '../factories/estimate.factory';
import { SendService } from '../../src/notifications/send-service';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { createRecipientLocaleResolver } from '../../src/notifications/recipient-locale';
import { createLogger } from '../../src/logging/logger';

const TENANT = '11111111-1111-4111-8111-111111117001';
const CUSTOMER = '33333333-3333-4333-8333-333333337001';
const JOB = '44444444-4444-4444-8444-444444447001';
const ESTIMATE = '55555555-5555-4555-8555-555555557001';
const LATE = new Date('2026-10-14T05:30:00Z'); // 22:30 MST, Oct 13
const MORNING = new Date('2026-10-14T17:00:00Z'); // 10:00 MST, Oct 14
const SENT_AT = new Date('2026-10-08T17:00:00Z');

async function world(opts: { email?: string; channel?: 'both' }) {
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const estimateRepo = new InMemoryEstimateRepository();
  await customerRepo.create(
    buildCustomer({
      id: CUSTOMER,
      tenantId: TENANT,
      displayName: 'Pat Phone',
      primaryPhone: '+16025550142',
      email: opts.email,
      smsConsent: true,
    }),
  );
  await jobRepo.create(buildJob({ id: JOB, tenantId: TENANT, customerId: CUSTOMER }));
  await estimateRepo.create(
    buildEstimate({
      id: ESTIMATE,
      tenantId: TENANT,
      jobId: JOB,
      estimateNumber: 'EST-7001',
      status: 'sent',
      sentAt: SENT_AT,
    }),
  );
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({
    id: '66666666-6666-4666-8666-666666667001',
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Phoenix',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    createdAt: SENT_AT,
    updatedAt: SENT_AT,
  });
  const dispatchRepo = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  let clock = LATE;
  const sendService = new SendService({
    delivery: new GatedMessageDelivery({
      base: delivery,
      dnc: new InMemoryDncRepository(),
      auditRepo: new InMemoryAuditRepository(),
      enforcement: 'block',
      quietHours: {
        resolveRecipientLocale: createRecipientLocaleResolver({
          settingsRepo,
          locationRepo: new InMemoryLocationRepository(),
        }),
        now: () => clock,
      },
      logger: { info: () => undefined },
    }),
    estimateRepo,
    invoiceRepo: new InMemoryInvoiceRepository(),
    jobRepo,
    customerRepo,
    settingsRepo,
    dispatchRepo,
    publicBaseUrl: 'https://app.example.com',
    ensureInvoicePayLink: async () => undefined,
  });
  const sweep = () =>
    runEstimateReminderSweep({
      estimateRepo,
      sendService,
      pool: null,
      listTenantIds: async () => [TENANT],
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
      now: () => clock,
      ...(opts.channel ? { channel: opts.channel } : {}),
    });
  return {
    sweep,
    delivery,
    dispatchRepo,
    estimateRepo,
    setClock: (d: Date) => {
      clock = d;
    },
  };
}

describe('estimate-reminder sweep — recipient quiet hours', () => {
  it('defers a 22:30 reminder — no text, no failed dispatch, count unchanged — and sends it on the next in-window sweep', async () => {
    const { sweep, delivery, dispatchRepo, estimateRepo, setClock } = await world({});

    const night = await sweep();

    expect(delivery.sentSms).toHaveLength(0);
    expect(night).toEqual({ tenants: 1, reminders: 0, failed: 0, deferred: 1 });
    expect(await dispatchRepo.findByEntity(TENANT, 'estimate', ESTIMATE)).toHaveLength(0);
    expect((await estimateRepo.findById(TENANT, ESTIMATE))?.reminderCount ?? 0).toBe(0);

    setClock(MORNING);
    const next = await sweep();

    expect(next).toEqual({ tenants: 1, reminders: 1, failed: 0, deferred: 0 });
    expect(delivery.sentSms.map((m) => m.to)).toEqual(['+16025550142']);
    expect((await estimateRepo.findById(TENANT, ESTIMATE))?.reminderCount).toBe(1);
  });

  it("a two-channel reminder is deferred whole: no email goes out alone while its text waits", async () => {
    const { sweep, delivery, estimateRepo, setClock } = await world({ email: 'pat@example.com', channel: 'both' });

    const night = await sweep();

    expect(delivery.sentEmails).toHaveLength(0);
    expect(delivery.sentSms).toHaveLength(0);
    expect(night).toMatchObject({ reminders: 0, deferred: 1 });
    expect((await estimateRepo.findById(TENANT, ESTIMATE))?.reminderCount ?? 0).toBe(0);

    setClock(MORNING);
    await sweep();

    expect(delivery.sentSms).toHaveLength(1);
    expect(delivery.sentEmails).toHaveLength(1);
  });
});
