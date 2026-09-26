/**
 * #1030 — `PgEstimateRepository.create()` silently dropped every lifecycle
 * column on the `Estimate` it was handed (`viewToken`, `viewTokenExpiresAt`,
 * `sentAt`, `lastDispatchId`, `firstViewedAt`, `viewCount`, `acceptedAt`,
 * `acceptedByName`, `acceptedByIp`, `acceptedUserAgent`,
 * `acceptedSignatureData`, `rejectedAt`, `rejectedReason`, `version` beyond
 * its default, `lastRevisedAt`, `reminderCount`, `lastReminderAt`,
 * `acceptedSelection`) — its INSERT column list covered only the base
 * fields, and the method returned the INPUT object unchanged, which is
 * exactly why the bug went unnoticed: the caller's in-process object still
 * "had" the fields even though the row didn't.
 *
 * `test/integration/estimate-stale-revision.test.ts` worked around this by
 * calling `create()` then `update()` as a two-step. This test proves
 * `create()` alone now persists the full lifecycle shape by re-reading the
 * row through `findById` (a fresh read, not the trusted return value).
 *
 * Docker-gated: requires a Postgres test DB (getSharedTestDb). Runs in PR CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { Estimate } from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

describe('Postgres integration — #1030 PgEstimateRepository.create() persists lifecycle columns', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('every lifecycle field on the input Estimate round-trips through a fresh findById, not just the returned object', async () => {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Test', lastName: 'Customer',
      displayName: 'Test Customer', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId,
      street1: '1 Lifecycle Way', city: 'Austin', state: 'TX', postalCode: '78701',
      country: 'USA', isPrimary: true, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: '1030 lifecycle job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });

    const lineItems: LineItem[] = [buildLineItem(crypto.randomUUID(), 'Repair', 1, 20000, 0, true)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);

    const sentAt = new Date('2026-01-01T12:00:00.000Z');
    const viewTokenExpiresAt = new Date('2026-04-01T12:00:00.000Z');
    const firstViewedAt = new Date('2026-01-02T09:00:00.000Z');
    const acceptedAt = new Date('2026-01-03T10:00:00.000Z');
    const lastRevisedAt = new Date('2026-01-04T11:00:00.000Z');
    const lastReminderAt = new Date('2026-01-05T08:00:00.000Z');

    const estimate: Estimate = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
      status: 'sent',
      lineItems,
      totals,
      viewToken: `tok-${crypto.randomUUID()}`,
      viewTokenExpiresAt,
      sentAt,
      lastDispatchId: crypto.randomUUID(),
      firstViewedAt,
      viewCount: 3,
      acceptedAt,
      acceptedByName: 'Jane Homeowner',
      acceptedByIp: '203.0.113.7',
      acceptedUserAgent: 'IntegrationTestAgent/1.0',
      acceptedSignatureData: 'data:image/png;base64,AAAA',
      rejectedAt: undefined,
      rejectedReason: undefined,
      version: 3,
      lastRevisedAt,
      reminderCount: 2,
      lastReminderAt,
      acceptedSelection: [lineItems[0].id],
      isChangeOrder: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await estimateRepo.create(estimate);

    // Re-fetch independently — proves the DATABASE holds these values, not
    // just the object create() happened to hand back.
    const persisted = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.viewToken).toBe(estimate.viewToken);
    expect(persisted!.viewTokenExpiresAt?.toISOString()).toBe(viewTokenExpiresAt.toISOString());
    expect(persisted!.sentAt?.toISOString()).toBe(sentAt.toISOString());
    expect(persisted!.lastDispatchId).toBe(estimate.lastDispatchId);
    expect(persisted!.firstViewedAt?.toISOString()).toBe(firstViewedAt.toISOString());
    expect(persisted!.viewCount).toBe(3);
    expect(persisted!.acceptedAt?.toISOString()).toBe(acceptedAt.toISOString());
    expect(persisted!.acceptedByName).toBe('Jane Homeowner');
    expect(persisted!.acceptedByIp).toBe('203.0.113.7');
    expect(persisted!.acceptedUserAgent).toBe('IntegrationTestAgent/1.0');
    expect(persisted!.acceptedSignatureData).toBe('data:image/png;base64,AAAA');
    expect(persisted!.version).toBe(3);
    expect(persisted!.lastRevisedAt?.toISOString()).toBe(lastRevisedAt.toISOString());
    expect(persisted!.reminderCount).toBe(2);
    expect(persisted!.lastReminderAt?.toISOString()).toBe(lastReminderAt.toISOString());
    expect(persisted!.acceptedSelection).toEqual([lineItems[0].id]);
  });

  it('rejectedAt/rejectedReason also round-trip on a rejected estimate', async () => {
    const tenant = await createTestTenant(pool);
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Test', lastName: 'Customer',
      displayName: 'Test Customer', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId,
      street1: '2 Lifecycle Way', city: 'Austin', state: 'TX', postalCode: '78701',
      country: 'USA', isPrimary: true, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: '1030 rejected job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });

    const lineItems: LineItem[] = [buildLineItem(crypto.randomUUID(), 'Repair', 1, 15000, 0, true)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const rejectedAt = new Date('2026-02-01T10:00:00.000Z');

    const estimate: Estimate = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
      status: 'rejected',
      lineItems,
      totals,
      rejectedAt,
      rejectedReason: 'Too expensive',
      version: 1,
      isChangeOrder: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await estimateRepo.create(estimate);
    const persisted = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(persisted!.rejectedAt?.toISOString()).toBe(rejectedAt.toISOString());
    expect(persisted!.rejectedReason).toBe('Too expensive');
  });
});
