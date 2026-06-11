/**
 * RV-003 — Repository-layer cross-tenant leak integration tests.
 *
 * The existing RLS tests (rls-tenant-isolation.test.ts, rls-runtime-audit.test.ts)
 * verify DB-level RLS enforcement via raw SQL through an unprivileged role.
 * This file closes the remaining gap: it exercises the *actual repository
 * classes* (PgCustomerRepository, PgJobRepository, PgEstimateRepository,
 * PgInvoiceRepository, PgProposalRepository, PgFileRepository,
 * PgTenantFeatureFlagRepository) to confirm that each repo's own
 * `findByTenant` / `findById` methods never surface rows that belong to
 * a different tenant — and that withTenant correctly applies RLS context.
 *
 * Pattern:
 *   1. Seed tenant A + tenant B with one fixture each.
 *   2. Call the repo method scoped to tenant A, assert B's row is absent.
 *   3. Call scoped to tenant B, assert A's row is absent.
 *   4. Call findById for a B-owned id but scoped to A — expect null.
 *
 * Docker gate: the test suite runs only when the integration testcontainer
 * is available (TEST_DB_URL set by global-setup). The shared getSharedTestDb()
 * helper throws if TEST_DB_URL is missing, which causes a clear beforeAll
 * failure rather than a silent skip. This matches the pattern used by every
 * other file in test/integration/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgFileRepository } from '../../src/files/pg-file';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('repository-layer cross-tenant leak (RV-003)', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  // fixture IDs for tenant A
  let customerA: string;
  let jobA: string;
  let estimateA: string;
  let invoiceA: string;
  let proposalA: string;
  let fileA: string;

  // fixture IDs for tenant B
  let customerB: string;
  let jobB: string;
  let estimateB: string;
  let invoiceB: string;
  let proposalB: string;
  let fileB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const estimateRepo = new PgEstimateRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    const proposalRepo = new PgProposalRepository(pool);
    const fileRepo = new PgFileRepository(pool);

    // ── Seed tenant A ──────────────────────────────────────────────────────
    customerA = crypto.randomUUID();
    await customerRepo.create({
      id: customerA,
      tenantId: tenantA.tenantId,
      firstName: 'Alice',
      lastName: 'A',
      displayName: 'Alice A',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationA = crypto.randomUUID();
    await locationRepo.create({
      id: locationA,
      tenantId: tenantA.tenantId,
      customerId: customerA,
      street1: '1 A Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobA = crypto.randomUUID();
    await jobRepo.create({
      id: jobA,
      tenantId: tenantA.tenantId,
      customerId: customerA,
      locationId: locationA,
      jobNumber: 'JOB-A-001',
      summary: 'Job for tenant A',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItemsA = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 1, true, 'labor')];
    const totalsA = calculateDocumentTotals(lineItemsA, 0, 0);

    estimateA = crypto.randomUUID();
    await estimateRepo.create({
      id: estimateA,
      tenantId: tenantA.tenantId,
      jobId: jobA,
      estimateNumber: 'EST-A-001',
      status: 'draft',
      lineItems: lineItemsA,
      totals: totalsA,
      version: 1,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceA = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceA,
      tenantId: tenantA.tenantId,
      jobId: jobA,
      invoiceNumber: 'INV-A-001',
      status: 'draft',
      lineItems: lineItemsA,
      totals: totalsA,
      amountPaidCents: 0,
      amountDueCents: totalsA.totalCents,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    proposalA = crypto.randomUUID();
    await proposalRepo.create({
      id: proposalA,
      tenantId: tenantA.tenantId,
      proposalType: 'create_job',
      status: 'draft',
      payload: { test: 'a' },
      summary: 'Proposal for tenant A',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    fileA = crypto.randomUUID();
    await fileRepo.create({
      id: fileA,
      tenantId: tenantA.tenantId,
      filename: 'file-a.txt',
      contentType: 'text/plain',
      sizeBytes: 100,
      storageBucket: 'test-bucket',
      storageKey: `key-a-${fileA}`,
      uploadedBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── Seed tenant B ──────────────────────────────────────────────────────
    customerB = crypto.randomUUID();
    await customerRepo.create({
      id: customerB,
      tenantId: tenantB.tenantId,
      firstName: 'Bob',
      lastName: 'B',
      displayName: 'Bob B',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationB = crypto.randomUUID();
    await locationRepo.create({
      id: locationB,
      tenantId: tenantB.tenantId,
      customerId: customerB,
      street1: '2 B Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobB = crypto.randomUUID();
    await jobRepo.create({
      id: jobB,
      tenantId: tenantB.tenantId,
      customerId: customerB,
      locationId: locationB,
      jobNumber: 'JOB-B-001',
      summary: 'Job for tenant B',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItemsB = [buildLineItem(crypto.randomUUID(), 'Labor', 1, 8000, 1, true, 'labor')];
    const totalsB = calculateDocumentTotals(lineItemsB, 0, 0);

    estimateB = crypto.randomUUID();
    await estimateRepo.create({
      id: estimateB,
      tenantId: tenantB.tenantId,
      jobId: jobB,
      estimateNumber: 'EST-B-001',
      status: 'draft',
      lineItems: lineItemsB,
      totals: totalsB,
      version: 1,
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceB = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceB,
      tenantId: tenantB.tenantId,
      jobId: jobB,
      invoiceNumber: 'INV-B-001',
      status: 'draft',
      lineItems: lineItemsB,
      totals: totalsB,
      amountPaidCents: 0,
      amountDueCents: totalsB.totalCents,
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    proposalB = crypto.randomUUID();
    await proposalRepo.create({
      id: proposalB,
      tenantId: tenantB.tenantId,
      proposalType: 'create_job',
      status: 'draft',
      payload: { test: 'b' },
      summary: 'Proposal for tenant B',
      createdBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    fileB = crypto.randomUUID();
    await fileRepo.create({
      id: fileB,
      tenantId: tenantB.tenantId,
      filename: 'file-b.txt',
      contentType: 'text/plain',
      sizeBytes: 200,
      storageBucket: 'test-bucket',
      storageKey: `key-b-${fileB}`,
      uploadedBy: tenantB.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ── customers ──────────────────────────────────────────────────────────────
  describe('PgCustomerRepository', () => {
    it('findByTenant(A) returns A fixture and NOT B fixture', async () => {
      const repo = new PgCustomerRepository(pool);
      const rows = await repo.findByTenant(tenantA.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(customerA);
      expect(ids).not.toContain(customerB);
    });

    it('findByTenant(B) returns B fixture and NOT A fixture', async () => {
      const repo = new PgCustomerRepository(pool);
      const rows = await repo.findByTenant(tenantB.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(customerB);
      expect(ids).not.toContain(customerA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgCustomerRepository(pool);
      const found = await repo.findById(tenantA.tenantId, customerB);
      expect(found).toBeNull();
    });
  });

  // ── jobs ───────────────────────────────────────────────────────────────────
  describe('PgJobRepository', () => {
    it('findByTenant(A) returns A fixture and NOT B fixture', async () => {
      const repo = new PgJobRepository(pool);
      const rows = await repo.findByTenant(tenantA.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(jobA);
      expect(ids).not.toContain(jobB);
    });

    it('findByTenant(B) returns B fixture and NOT A fixture', async () => {
      const repo = new PgJobRepository(pool);
      const rows = await repo.findByTenant(tenantB.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(jobB);
      expect(ids).not.toContain(jobA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgJobRepository(pool);
      const found = await repo.findById(tenantA.tenantId, jobB);
      expect(found).toBeNull();
    });
  });

  // ── estimates ──────────────────────────────────────────────────────────────
  describe('PgEstimateRepository', () => {
    it('findByTenant(A) returns A fixture and NOT B fixture', async () => {
      const repo = new PgEstimateRepository(pool);
      const rows = await repo.findByTenant(tenantA.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(estimateA);
      expect(ids).not.toContain(estimateB);
    });

    it('findByTenant(B) returns B fixture and NOT A fixture', async () => {
      const repo = new PgEstimateRepository(pool);
      const rows = await repo.findByTenant(tenantB.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(estimateB);
      expect(ids).not.toContain(estimateA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgEstimateRepository(pool);
      const found = await repo.findById(tenantA.tenantId, estimateB);
      expect(found).toBeNull();
    });
  });

  // ── invoices ───────────────────────────────────────────────────────────────
  describe('PgInvoiceRepository', () => {
    it('findByTenant(A) returns A fixture and NOT B fixture', async () => {
      const repo = new PgInvoiceRepository(pool);
      const rows = await repo.findByTenant(tenantA.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(invoiceA);
      expect(ids).not.toContain(invoiceB);
    });

    it('findByTenant(B) returns B fixture and NOT A fixture', async () => {
      const repo = new PgInvoiceRepository(pool);
      const rows = await repo.findByTenant(tenantB.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(invoiceB);
      expect(ids).not.toContain(invoiceA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgInvoiceRepository(pool);
      const found = await repo.findById(tenantA.tenantId, invoiceB);
      expect(found).toBeNull();
    });
  });

  // ── proposals ──────────────────────────────────────────────────────────────
  describe('PgProposalRepository', () => {
    it('findByTenant(A) returns A fixture and NOT B fixture', async () => {
      const repo = new PgProposalRepository(pool);
      const rows = await repo.findByTenant(tenantA.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(proposalA);
      expect(ids).not.toContain(proposalB);
    });

    it('findByTenant(B) returns B fixture and NOT A fixture', async () => {
      const repo = new PgProposalRepository(pool);
      const rows = await repo.findByTenant(tenantB.tenantId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(proposalB);
      expect(ids).not.toContain(proposalA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgProposalRepository(pool);
      const found = await repo.findById(tenantA.tenantId, proposalB);
      expect(found).toBeNull();
    });
  });

  // ── files ──────────────────────────────────────────────────────────────────
  describe('PgFileRepository', () => {
    it('findById scoped to A can retrieve own row', async () => {
      const repo = new PgFileRepository(pool);
      const found = await repo.findById(tenantA.tenantId, fileA);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(fileA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgFileRepository(pool);
      const found = await repo.findById(tenantA.tenantId, fileB);
      expect(found).toBeNull();
    });

    it('findById scoped to B cannot retrieve A row', async () => {
      const repo = new PgFileRepository(pool);
      const found = await repo.findById(tenantB.tenantId, fileA);
      expect(found).toBeNull();
    });
  });

  // ── tenant_feature_flags ───────────────────────────────────────────────────
  describe('PgTenantFeatureFlagRepository (migration 159)', () => {
    const FLAG_KEY = 'rv-003-isolation-test-flag';

    it('isEnabledForTenant(A) reflects A override and NOT B override', async () => {
      const platformRepo = new InMemoryFeatureFlagRepository();
      const repo = new PgTenantFeatureFlagRepository(pool, platformRepo);

      // Write distinct overrides for each tenant
      await repo.setTenantFlag(tenantA.tenantId, FLAG_KEY, true);
      await repo.setTenantFlag(tenantB.tenantId, FLAG_KEY, false);

      // Each tenant must see only its own value
      expect(await repo.isEnabledForTenant(tenantA.tenantId, FLAG_KEY)).toBe(true);
      expect(await repo.isEnabledForTenant(tenantB.tenantId, FLAG_KEY)).toBe(false);
    });

    it('tenant A flag row is invisible to tenant B via RLS (raw query cross-check)', async () => {
      // Use a raw connection scoped to tenant B to confirm tenant A's flag row
      // is filtered by the RLS policy — not merely hidden by app-level logic.
      const client = await pool.connect();
      try {
        await client.query(
          `SELECT set_config('app.current_tenant_id', $1, false)`,
          [tenantB.tenantId],
        );
        const res = await client.query(
          `SELECT count(*)::int AS n FROM tenant_feature_flags
           WHERE tenant_id = $1 AND flag_key = $2`,
          [tenantA.tenantId, FLAG_KEY],
        );
        // Row belongs to tenant A; tenant B's GUC must filter it out entirely
        expect(res.rows[0].n).toBe(0);
      } finally {
        await client.query(`RESET app.current_tenant_id`).catch(() => {});
        client.release();
      }
    });
  });
});
