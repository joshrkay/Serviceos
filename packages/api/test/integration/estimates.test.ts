import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — estimates', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: customerId,
      street1: '123 Main St',
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
      customerId: customerId,
      locationId: locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates estimate and retrieves via findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 2, 7500, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-001',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        version: 1,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await estimateRepo.findById(tenant.tenantId, estimate.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('draft');
      expect(found!.estimateNumber).toBe('EST-001');
      expect(found!.lineItems).toHaveLength(1);
    });

    it('updates estimate and reflects in findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 5000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-002',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        version: 1,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await estimateRepo.update(tenant.tenantId, estimate.id, {
        status: 'sent',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('sent');

      const found = await estimateRepo.findById(tenant.tenantId, estimate.id);
      expect(found!.status).toBe('sent');
    });

    it('finds estimates by tenant', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 3000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-003',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        version: 1,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const estimates = await estimateRepo.findByTenant(tenant.tenantId);
      expect(estimates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Secret Labor', 1, 10000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const estimate = await estimateRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-SECRET',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        version: 1,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await estimateRepo.findById(otherTenant.tenantId, estimate.id);
      expect(found).toBeNull();
    });
  });

  // RV-042 — acceptance invalidation through the REAL Pg repo. Pins that
  // clearing `acceptedSelection` writes SQL NULL into the JSONB column —
  // not the JSON string 'null' (`to_jsonb(null)`-style bugs survive mocked
  // repos; only a real round-trip catches them) — and that every acceptance
  // field is cleared while the estimate returns to a re-sendable 'sent'.
  describe('RV-042 — acceptance invalidation clears accepted_selection to SQL NULL', () => {
    it('updateEstimate(invalidateAcceptance) → accepted_selection IS NULL, acceptance fields cleared', async () => {
      const lineItemId = crypto.randomUUID();
      const lineItems = [
        buildLineItem(lineItemId, 'Replace heater', 1, 120000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 0);
      const estimateId = crypto.randomUUID();

      await estimateRepo.create({
        id: estimateId,
        tenantId: tenant.tenantId,
        jobId: jobId,
        estimateNumber: 'EST-RV042',
        status: 'draft',
        lineItems,
        totals,
        version: 1,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Persist a REAL acceptance, including a non-empty accepted_selection.
      const accepted = await estimateRepo.update(tenant.tenantId, estimateId, {
        status: 'accepted',
        acceptedAt: new Date('2026-06-10T15:00:00Z'),
        acceptedByName: 'Jane Henderson',
        acceptedByIp: '203.0.113.9',
        acceptedUserAgent: 'Safari',
        acceptedSignatureData: 'data:image/png;base64,abc',
        acceptedSelection: [lineItemId],
      });
      expect(accepted!.status).toBe('accepted');
      expect(accepted!.acceptedSelection).toEqual([lineItemId]);

      // Pre-condition at the SQL level: a real JSONB array is stored.
      const before = await pool.query(
        `SELECT accepted_selection IS NULL AS is_sql_null,
                accepted_selection::text AS raw_text
           FROM estimates WHERE id = $1 AND tenant_id = $2`,
        [estimateId, tenant.tenantId],
      );
      expect(before.rows[0].is_sql_null).toBe(false);
      expect(before.rows[0].raw_text).toContain(lineItemId);

      // Invalidate through the domain invalidation path against the Pg repo.
      const { updateEstimate } = await import('../../src/estimates/estimate');
      const invalidated = await updateEstimate(
        tenant.tenantId,
        estimateId,
        { customerMessage: 'Revised scope' },
        estimateRepo,
        { invalidateAcceptance: true, actorId: tenant.userId, actorRole: 'owner' },
      );
      expect(invalidated!.status).toBe('sent');

      // THE pin: SQL NULL, not the JSONB string 'null'. `IS NULL` is false
      // for a stored JSON null, and ::text would render it as 'null'.
      const after = await pool.query(
        `SELECT accepted_selection IS NULL AS is_sql_null,
                accepted_selection::text AS raw_text,
                status, accepted_at, accepted_by_name, accepted_by_ip,
                accepted_user_agent, accepted_signature_data
           FROM estimates WHERE id = $1 AND tenant_id = $2`,
        [estimateId, tenant.tenantId],
      );
      const row = after.rows[0];
      expect(row.is_sql_null).toBe(true);
      expect(row.raw_text).toBeNull(); // a JSON-null column would yield 'null'
      expect(row.status).toBe('sent');
      expect(row.accepted_at).toBeNull();
      expect(row.accepted_by_name).toBeNull();
      expect(row.accepted_by_ip).toBeNull();
      expect(row.accepted_user_agent).toBeNull();
      expect(row.accepted_signature_data).toBeNull();

      // Round-trip through the repo mapping: cleared selection reads back
      // as undefined (not [] / not a phantom value).
      const reread = await estimateRepo.findById(tenant.tenantId, estimateId);
      expect(reread!.acceptedSelection).toBeUndefined();
      expect(reread!.acceptedAt).toBeUndefined();
      expect(reread!.status).toBe('sent');
    });
  });
});