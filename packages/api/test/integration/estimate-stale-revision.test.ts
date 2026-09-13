import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { reviseEstimate, Estimate } from '../../src/estimates/estimate';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import { ConflictError } from '../../src/shared/errors';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

/**
 * §8.7 G1 audit (#1008 on ticket #1012), row 7.7 — the stale-revision guard
 * ("As M, I want a customer who approves an old version to be stopped, so
 * nobody holds me to a price I already changed") had unit coverage only
 * (test/estimates/estimate-revise-lock.test.ts,
 * test/estimates/public-estimate-service.test.ts — both against
 * InMemoryEstimateRepository) and had never met a real database.
 *
 * This file proves the SAME guard at real Postgres: an estimate revised to
 * version 2 refuses a public-approval attempt carrying the stale
 * `expectedVersion: 1`, with the mapped ConflictError, no state change, and
 * no phantom `public_estimate.approved` audit event — for two independent
 * tenants (T1), so the guard is proven per-tenant rather than global.
 */
describe('Postgres integration — estimate stale-revision guard (7.7)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Provision a tenant + customer + job + a v1 SENT estimate, then revise
   *  it once through the REAL reviseEstimate path so it lands at version 2
   *  with a genuine estimate.revised audit event — not a hand-set column. */
  async function seedRevisedEstimate(lineItemCents: number): Promise<{
    tenant: { tenantId: string; userId: string };
    token: string;
    estimate: Estimate;
  }> {
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
      street1: '1 Stale St', city: 'Austin', state: 'TX', postalCode: '78701',
      country: 'USA', isPrimary: true, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: 'Stale-revision job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });

    const token = `stale-${crypto.randomUUID()}`;
    const lineItems: LineItem[] = [buildLineItem(crypto.randomUUID(), 'Repair', 1, lineItemCents, 0, true)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const inserted = await estimateRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, jobId,
      estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
      status: 'sent', lineItems, totals, version: 1,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    // create() only inserts the base columns (mirrors estimate-phases.test.ts's
    // seedEstimate helper) — viewToken/sentAt are lifecycle columns set via a
    // follow-up update(), same as the real send flow would.
    const created = (await estimateRepo.update(tenant.tenantId, inserted.id, {
      viewToken: token,
      sentAt: new Date(),
    }))!;

    // Bump to version 2 through the PRODUCTION revise path — the customer's
    // page was showing version 1 and the price just changed under them.
    const revised = await reviseEstimate(
      tenant.tenantId,
      created.id,
      {
        lineItems: [buildLineItem(crypto.randomUUID(), 'Repair (revised price)', 1, lineItemCents + 5000, 0, true)],
        expectedVersion: 1,
      },
      estimateRepo,
      { auditRepo, actorId: tenant.userId, actorRole: 'owner' },
    );
    expect(revised).not.toBeNull();
    expect(revised!.version).toBe(2);

    return { tenant, token, estimate: revised! };
  }

  it('expectedVersion 1 vs current 2 — the stale accept is refused with the mapped error, no state change, and no phantom accept audit event', async () => {
    const { tenant, token, estimate } = await seedRevisedEstimate(10000);

    const service = new PublicEstimateService({
      estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo, auditRepo,
    });

    // The customer's page loaded at version 1 (before the revise); their
    // accept click still carries that stale expectedVersion.
    await expect(
      service.approve({ token, acceptedByName: 'Stale Customer', expectedVersion: 1 }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.approve({ token, acceptedByName: 'Stale Customer', expectedVersion: 1 }),
    ).rejects.toThrow(/updated/i);

    // No state change: still sent at version 2, never accepted.
    const after = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(after!.status).toBe('sent');
    expect(after!.version).toBe(2);
    expect(after!.acceptedAt).toBeUndefined();
    expect(after!.acceptedByName).toBeUndefined();

    // Audit: the ORIGINAL revise event is there (proving the audit repo is
    // real and wired); the refused accept attempts left no
    // public_estimate.approved event behind — a stale accept must never
    // look, from the audit trail, like it succeeded.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', estimate.id);
    expect(events.map((e) => e.eventType)).toContain('estimate.revised');
    expect(events.filter((e) => e.eventType === 'public_estimate.approved')).toHaveLength(0);
  });

  it('the SAME guard is enforced independently for a second tenant (T1) — one tenant cannot read or approve past another tenant\'s stale-revision estimate', async () => {
    // T1 — two wholly separate tenants, each with their OWN version-2
    // estimate and their OWN stale (version-1) accept attempt, proven in
    // the same run so a guard that accidentally shared state across
    // tenants (e.g. a global version counter) would be caught.
    const a = await seedRevisedEstimate(8000);
    const b = await seedRevisedEstimate(15000);

    const service = new PublicEstimateService({
      estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo, auditRepo,
    });

    await expect(
      service.approve({ token: a.token, acceptedByName: 'Tenant A Customer', expectedVersion: 1 }),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.approve({ token: b.token, acceptedByName: 'Tenant B Customer', expectedVersion: 1 }),
    ).rejects.toThrow(ConflictError);

    // Neither tenant's estimate moved.
    expect((await estimateRepo.findById(a.tenant.tenantId, a.estimate.id))!.status).toBe('sent');
    expect((await estimateRepo.findById(b.tenant.tenantId, b.estimate.id))!.status).toBe('sent');

    // Cross-tenant isolation: tenant A's scoped repo call cannot read
    // tenant B's estimate, and vice versa — the "other tenant" in this
    // pair is a real, differently-provisioned tenant, not a fixture alias.
    expect(await estimateRepo.findById(a.tenant.tenantId, b.estimate.id)).toBeNull();
    expect(await estimateRepo.findById(b.tenant.tenantId, a.estimate.id)).toBeNull();

    // Each tenant's own audit trail is scoped to itself — tenant A's events
    // never include tenant B's revise, and no accept event exists for either.
    const aEvents = await auditRepo.findByEntity(a.tenant.tenantId, 'estimate', a.estimate.id);
    const bEvents = await auditRepo.findByEntity(b.tenant.tenantId, 'estimate', b.estimate.id);
    expect(aEvents.map((e) => e.eventType)).toContain('estimate.revised');
    expect(bEvents.map((e) => e.eventType)).toContain('estimate.revised');
    expect(aEvents.filter((e) => e.eventType === 'public_estimate.approved')).toHaveLength(0);
    expect(bEvents.filter((e) => e.eventType === 'public_estimate.approved')).toHaveLength(0);
  });
});
