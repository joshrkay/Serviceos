/**
 * D-045 — estimate and invoice texts go through outbound messaging, so each
 * one is a message record (`message_dispatches`) linked to the customer and
 * the job: what the status bubble on the job and customer pages reads
 * (`listByTenant` with `jobId` / `customerId`). Emails stay on the delivery
 * provider but carry the same links. Pinned against the real columns.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { SendService } from '../../src/notifications/send-service';
import { buildLineItem } from '../../src/shared/billing-engine';
import { createEstimate } from '../../src/estimates/estimate';
import { withOutbound } from '../helpers/outbound-messaging';

describe('Postgres integration — estimate texts and emails are message records on the job (D-045)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let customerRepo: PgCustomerRepository;
  let dispatchRepo: PgDispatchRepository;
  let delivery: InMemoryDeliveryProvider;
  let sendService: SendService;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    ({ tenantId, userId } = await createTestTenant(pool));
    delivery = new InMemoryDeliveryProvider();
    sendService = new SendService(
      withOutbound(
        {
          delivery,
          estimateRepo,
          invoiceRepo: new InMemoryInvoiceRepository(),
          jobRepo: new PgJobRepository(pool),
          customerRepo,
          settingsRepo: new PgSettingsRepository(pool),
          dispatchRepo,
          publicBaseUrl: 'https://test.example.com',
          ensureInvoicePayLink: async () => undefined,
        },
        pool,
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seed(label: string, smsConsent: boolean) {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId, firstName: 'Mara', lastName: label, displayName: `Mara ${label}`,
      email: `mara-${label}@example.com`, primaryPhone: '+15125550142', preferredChannel: 'sms',
      smsConsent, isArchived: false, createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId, customerId, street1: '9 Record Rd', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId, tenantId, customerId, locationId, jobNumber: `JOB-${label}`, summary: 'Work',
      status: 'scheduled', priority: 'normal', createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const estimate = await createEstimate(
      { tenantId, jobId, estimateNumber: `EST-${label}`, lineItems: [buildLineItem('li-1', 'Service', 1, 15000, 0, true, 'labor')], createdBy: userId },
      estimateRepo,
    );
    return { customerId, jobId, estimate };
  }

  it('a text and an email each land on the job and customer, and the estimate points at the latest', async () => {
    const { customerId, jobId, estimate } = await seed('both', true);

    const result = await sendService.sendEstimate({ tenantId, estimateId: estimate.id, channel: 'both', idempotencyContext: 'owner' });

    const { dispatches } = await dispatchRepo.listByTenant(tenantId, { jobId });
    expect(dispatches.map((d) => d.channel).sort()).toEqual(['email', 'sms']);
    for (const d of dispatches) {
      expect(d).toMatchObject({ status: 'sent', customerId, jobId, purpose: 'transactional', entityId: estimate.id });
    }
    const { dispatches: forCustomer } = await dispatchRepo.listByTenant(tenantId, { customerId });
    expect(forCustomer).toHaveLength(2);
    expect(result.channelsSent.map((c) => c.dispatchId).sort()).toEqual(dispatches.map((d) => d.id).sort());
    const saved = await estimateRepo.findById(tenantId, estimate.id);
    expect(saved?.lastDispatchId).toBe(result.channelsSent[result.channelsSent.length - 1].dispatchId);
  });

  it('a reminder to a customer who has not agreed to texts is a blocked record, replaced when the retry sends', async () => {
    const { customerId, jobId, estimate } = await seed('nudge', false);
    const reminder = {
      tenantId,
      estimateId: estimate.id,
      channel: 'sms' as const,
      quietHours: 'defer' as const,
      idempotencyContext: `estimate_nudge:${estimate.id}:v1:1`,
    };

    await expect(sendService.sendEstimate(reminder)).rejects.toThrow(/suppressed: no_consent/);
    const blocked = (await dispatchRepo.listByTenant(tenantId, { jobId })).dispatches;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      status: 'blocked', blockReason: 'no_consent', blockPermanent: true,
      purpose: 'automated_nudge', customerId, channel: 'sms',
    });

    // The customer agrees; the next sweep retries the same occurrence (a
    // later minute) under the same key, so the one record now says sent.
    await customerRepo.update(tenantId, customerId, { smsConsent: true });
    const sentBefore = delivery.sentSms.length;
    await sendService.sendEstimate(reminder);

    const after = (await dispatchRepo.listByTenant(tenantId, { jobId })).dispatches;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: blocked[0].id, status: 'sent', purpose: 'automated_nudge' });
    expect(delivery.sentSms.length).toBe(sentBefore + 1);
  });

  it('a same-minute resend of a text replays the record and texts nobody twice', async () => {
    const { jobId, estimate } = await seed('resend', true);
    const send = () => sendService.sendEstimate({ tenantId, estimateId: estimate.id, channel: 'sms', idempotencyContext: 'owner' });
    const sentBefore = delivery.sentSms.length;
    // Both sends inside one wall-clock minute (only Date is faked; pg keeps real timers).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T15:04:10.000Z'));

    const first = await send();
    vi.setSystemTime(new Date('2026-10-22T15:04:40.000Z'));
    const second = await send();

    expect(second.channelsSent[0].dispatchId).toBe(first.channelsSent[0].dispatchId);
    expect(delivery.sentSms.length).toBe(sentBefore + 1);
    expect((await dispatchRepo.listByTenant(tenantId, { jobId })).dispatches).toHaveLength(1);
  });
});
