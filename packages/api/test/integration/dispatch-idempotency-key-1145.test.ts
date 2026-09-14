/**
 * Postgres integration — #1145. `SendService.buildIdempotencyKey`
 * (`packages/api/src/notifications/send-service.ts:575-583` on `main`) keys
 * `message_dispatches.idempotency_key` on `${entityType}:${entityId}:${channel}:${minute}`
 * alone — no distinction between WHY a send is happening. `idx_dispatches_idempotency`
 * is `UNIQUE (tenant_id, idempotency_key)`, so two legitimate sends for the
 * SAME estimate+channel within the same wall-clock minute — e.g. an owner's
 * manual "Send Estimate" and the automatic reminder sweep's nudge — collide:
 * the second write trips the unique index and `sendEstimate` reports the
 * whole send as failed (`sent.length === 0` after `Promise.allSettled`),
 * even though the point of both sends was to reach the customer.
 *
 * Exercises the REAL production call shapes: a direct `sendService.sendEstimate()`
 * call (mirrors `routes/estimates.ts`'s owner-triggered "Send Estimate" route)
 * followed by the real `dispatchEstimateNudge()` composition function (mirrors
 * the automatic estimate-reminder sweep / `send_estimate_nudge` proposal
 * handler), both within the same minute, against a real `PgDispatchRepository`
 * so the real `idx_dispatches_idempotency` unique index is exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { dispatchEstimateNudge } from '../../src/estimates/estimate-nudge';

describe('Postgres integration — #1145 dispatch idempotency key collision', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let dispatchRepo: PgDispatchRepository;
  let sendService: SendService;
  let delivery: InMemoryDeliveryProvider;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const settingsRepo = new PgSettingsRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Nora',
      lastName: 'Nudge',
      displayName: 'Nora Nudge',
      primaryPhone: '+15555550188',
      email: 'nora@example.com',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Nudge St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-1145',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    delivery = new InMemoryDeliveryProvider();
    sendService = new SendService({
      delivery,
      estimateRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
      publicBaseUrl: 'https://test.example.com',
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an owner send and an automatic estimate-reminder nudge for the same estimate within one minute both dispatch — two distinct message_dispatches rows, no thrown error', async () => {
    const items = [buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor')];
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: 'EST-1145-1',
        lineItems: items,
        createdBy: tenant.userId,
      },
      estimateRepo,
    );

    // Leg 1 — owner's manual "Send Estimate" (mirrors routes/estimates.ts).
    await sendService.sendEstimate({
      tenantId: tenant.tenantId,
      estimateId: estimate.id,
      channel: 'sms',
      idempotencyContext: 'owner',
    });

    // Leg 2 — the automatic reminder sweep's nudge, moments later, well
    // within the same wall-clock minute (mirrors estimate-reminder-worker /
    // the send_estimate_nudge proposal handler via dispatchEstimateNudge).
    // Must NOT throw: a legitimate second send is not the same occasion as
    // the owner's send and must not be treated as a duplicate.
    const sentEstimate = (await estimateRepo.findById(tenant.tenantId, estimate.id))!;
    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      {
        tenantId: tenant.tenantId,
        estimate: sentEstimate,
        channel: 'sms',
        asOf: new Date(),
        actorId: 'system:estimate-reminder-worker',
      },
    );

    // Two distinct real SMS sends should have gone out.
    expect(delivery.sentSms).toHaveLength(2);

    // Two distinct message_dispatches rows for this estimate+channel — not
    // one dropped as a duplicate of the other.
    const dispatches = await dispatchRepo.findByEntity(tenant.tenantId, 'estimate', estimate.id);
    const smsDispatches = dispatches.filter((d) => d.channel === 'sms' && d.status === 'sent');
    expect(smsDispatches).toHaveLength(2);

    // Distinct idempotency keys — the whole point of the fix.
    const keys = new Set(smsDispatches.map((d) => d.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it('a genuine duplicate retry (same owner send re-invoked immediately) still dedupes at the provider/DB layer', async () => {
    const items = [buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor')];
    const estimate = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: 'EST-1145-2',
        lineItems: items,
        createdBy: tenant.userId,
      },
      estimateRepo,
    );

    await sendService.sendEstimate({
      tenantId: tenant.tenantId,
      estimateId: estimate.id,
      channel: 'sms',
      idempotencyContext: 'owner',
    });

    // Identical retry: same owner-send context, same estimate, same channel,
    // same minute — this SHOULD dedupe (it's the same occasion, not a new one).
    await expect(
      sendService.sendEstimate({
        tenantId: tenant.tenantId,
        estimateId: estimate.id,
        channel: 'sms',
        idempotencyContext: 'owner',
      }),
    ).rejects.toThrow();

    const dispatches = await dispatchRepo.findByEntity(tenant.tenantId, 'estimate', estimate.id);
    const smsDispatches = dispatches.filter((d) => d.channel === 'sms' && d.status === 'sent');
    expect(smsDispatches).toHaveLength(1);
  });
});
