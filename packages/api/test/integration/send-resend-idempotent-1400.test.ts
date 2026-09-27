/**
 * #1400 (QA 2026-09-26 §4) — an owner re-sending the same estimate on the
 * same channel within the idempotency minute got a raw 400:
 *   "Estimate send failed on all channels: email to …: duplicate key value
 *    violates unique constraint "idx_dispatches_idempotency""
 * (evidence 1296/api/37-resend-immediate.json). A same-minute owner retry is
 * the SAME occasion (#1145's retry window), so it must be an idempotent
 * replay: no second message, no error, the original dispatch returned.
 * Exercised against the real idx_dispatches_idempotency unique index.
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

describe('Postgres integration — same-minute owner resend is an idempotent replay (#1400)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let dispatchRepo: PgDispatchRepository;
  let delivery: InMemoryDeliveryProvider;
  let sendService: SendService;
  let tenantId: string;
  let userId: string;
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    ({ tenantId, userId } = await createTestTenant(pool));

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId, firstName: 'Rhea', lastName: 'Resend', displayName: 'Rhea Resend',
      email: 'rhea@example.com', preferredChannel: 'email', smsConsent: false, isArchived: false,
      createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId, tenantId, customerId, street1: '1 Resend St', city: 'Austin', state: 'TX',
      postalCode: '78701', country: 'USA', isPrimary: true, isArchived: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId, customerId, locationId, jobNumber: 'JOB-1400', summary: 'Work',
      status: 'scheduled', priority: 'normal', createdBy: userId, createdAt: new Date(), updatedAt: new Date(),
    });

    delivery = new InMemoryDeliveryProvider();
    sendService = new SendService({
      delivery, estimateRepo, invoiceRepo: new InMemoryInvoiceRepository(), jobRepo, customerRepo,
      settingsRepo: new PgSettingsRepository(pool), dispatchRepo, publicBaseUrl: 'https://test.example.com',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a second owner send in the same minute resolves with the original dispatch and sends nothing new', async () => {
    const estimate = await createEstimate(
      { tenantId, jobId, estimateNumber: 'EST-1400-R', lineItems: [buildLineItem('li-1', 'Service', 1, 15000, 0, true, 'labor')], createdBy: userId },
      estimateRepo,
    );
    // Pin both sends inside one wall-clock minute (only Date is faked; pg keeps real timers).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T02:27:10.000Z'));

    const first = await sendService.sendEstimate({ tenantId, estimateId: estimate.id, channel: 'email', idempotencyContext: 'owner' });
    vi.setSystemTime(new Date('2026-09-27T02:27:40.000Z'));
    const second = await sendService.sendEstimate({ tenantId, estimateId: estimate.id, channel: 'email', idempotencyContext: 'owner' });

    expect(second.channelsSent.map((c) => c.dispatchId)).toEqual(first.channelsSent.map((c) => c.dispatchId));
    expect(delivery.sentEmails).toHaveLength(1);
    const rows = await dispatchRepo.findByEntity(tenantId, 'estimate', estimate.id);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(1);
  });
});
