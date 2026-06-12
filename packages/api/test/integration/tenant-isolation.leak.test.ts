/**
 * RV-003 — Repository-layer cross-tenant leak integration tests.
 *
 * CANONICAL tenant-leak suite: every new tenant-scoped table MUST append a
 * case here. Some findById cross-tenant cases intentionally duplicate
 * per-entity test files — that consolidation is deliberate.
 * Policies fail CLOSED on unset GUC by erroring (no missing_ok), which is
 * stronger than the plan's "zero rows" wording — this is intentional.
 *
 * This file has two layers of coverage:
 *
 * Layer 1 — Repository API: exercises the actual repository classes
 * (PgCustomerRepository, PgJobRepository, PgEstimateRepository,
 * PgInvoiceRepository, PgProposalRepository, PgFileRepository,
 * PgTenantFeatureFlagRepository, PgAttachmentRepository) to confirm that each repo's own
 * `findByTenant` / `findById` methods never surface rows belonging to a
 * different tenant.
 *
 * Layer 2 — Raw RLS cross-checks: probes the DB-level RLS policies via an
 * unprivileged role (`rls_app_runtime`, NOBYPASSRLS) to confirm the policies
 * themselves enforce isolation — not just the application layer. The test pool
 * connects as a SUPERUSER, which bypasses RLS unconditionally, so raw probes
 * MUST run through the unprivileged role using the asTenant helper (same
 * pattern as rls-tenant-isolation.test.ts:28-45).
 *
 * Pattern:
 *   1. Seed tenant A + tenant B with one fixture each (as superuser — no RLS).
 *   2. Call the repo method scoped to tenant A, assert B's row is absent.
 *   3. Call scoped to tenant B, assert A's row is absent.
 *   4. Call findById for a B-owned id but scoped to A — expect null.
 *   5. Raw RLS cross-check through unprivileged role (asTenant).
 *   6. GUC-unset coverage: assert fail-closed behaviour when no tenant
 *      context is set (policies use current_setting without missing_ok →
 *      error thrown). Two possible error shapes:
 *        • GUC never set in session  → "unrecognized configuration parameter"
 *        • GUC set then RESET on a pooled connection → empty string →
 *          `''::uuid` cast error → "invalid input syntax for type uuid"
 *
 * Docker gate: the test suite runs only when the integration testcontainer
 * is available (TEST_DB_URL set by global-setup). The shared getSharedTestDb()
 * helper throws if TEST_DB_URL is missing, which causes a clear beforeAll
 * failure rather than a silent skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgFileRepository } from '../../src/files/pg-file';
import { PgAttachmentRepository } from '../../src/attachments/pg-attachment';
import { PgDailyDigestRepository } from '../../src/digest/pg-daily-digest';
import type { DailyDigestPayload } from '../../src/digest/digest-service';
import { PgTenantFeatureFlagRepository } from '../../src/flags/pg-tenant-feature-flags';
import { InMemoryFeatureFlagRepository } from '../../src/flags/feature-flags';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const APP_ROLE = 'rls_app_runtime';

/**
 * Run `fn` on a connection that behaves like the production app: an
 * unprivileged role (NOBYPASSRLS) with `app.current_tenant_id` set for the
 * duration of a transaction. Mirrors the pattern in
 * rls-tenant-isolation.test.ts:28-45. Always rolls back so tests are
 * side-effect free.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

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
  let attachmentA: string;

  // fixture IDs for tenant B
  let customerB: string;
  let jobB: string;
  let estimateB: string;
  let invoiceB: string;
  let proposalB: string;
  let fileB: string;
  let attachmentB: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();

    // Unprivileged role used by the raw RLS cross-checks and GUC-unset tests.
    // Idempotent — other integration test files may create the same role in
    // the same shared container. Pattern from rls-tenant-isolation.test.ts:69-75.
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const estimateRepo = new PgEstimateRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    const proposalRepo = new PgProposalRepository(pool);
    const fileRepo = new PgFileRepository(pool);
    const attachmentRepo = new PgAttachmentRepository(pool);

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

    // RV-005: attachments — pins the real column names (the repo unit test
    // mocks the pool, so this is the only proof the INSERT/SELECT shapes
    // match migration 160).
    const createdAttachmentA = await attachmentRepo.create(tenantA.tenantId, {
      fileId: fileA,
      entityType: 'job',
      entityId: jobA,
      kind: 'photo',
      category: 'before',
      caption: 'tenant A before photo',
      uploadedBy: tenantA.userId,
      source: 'app',
    });
    attachmentA = createdAttachmentA.id;

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

    const createdAttachmentB = await attachmentRepo.create(tenantB.tenantId, {
      fileId: fileB,
      entityType: 'job',
      entityId: jobB,
      kind: 'photo',
      category: 'after',
      caption: 'tenant B after photo',
      uploadedBy: tenantB.userId,
      source: 'app',
    });
    attachmentB = createdAttachmentB.id;
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

  // ── attachments (RV-005, migration 160) ────────────────────────────────────
  describe('PgAttachmentRepository', () => {
    it('listByEntity(A, job, jobA) returns A fixture and NOT B fixture', async () => {
      const repo = new PgAttachmentRepository(pool);
      const rows = await repo.listByEntity(tenantA.tenantId, 'job', jobA);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(attachmentA);
      expect(ids).not.toContain(attachmentB);
    });

    it('listByEntity(B, job, jobB) returns B fixture and NOT A fixture', async () => {
      const repo = new PgAttachmentRepository(pool);
      const rows = await repo.listByEntity(tenantB.tenantId, 'job', jobB);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(attachmentB);
      expect(ids).not.toContain(attachmentA);
    });

    it('findById scoped to A cannot retrieve B row', async () => {
      const repo = new PgAttachmentRepository(pool);
      const found = await repo.findById(tenantA.tenantId, attachmentB);
      expect(found).toBeNull();
    });

    it('archive/setPortalVisibility/pair scoped to A cannot mutate B row', async () => {
      const repo = new PgAttachmentRepository(pool);
      expect(await repo.archive(tenantA.tenantId, attachmentB)).toBeNull();
      expect(await repo.setPortalVisibility(tenantA.tenantId, attachmentB, true)).toBeNull();
      // pair() throws (rolls back) when the row is not found in this tenant —
      // confirm the call rejects and B's row is untouched.
      await expect(
        repo.pair(tenantA.tenantId, attachmentB, 'after', crypto.randomUUID(), 'before', crypto.randomUUID())
      ).rejects.toThrow();

      // B's row is untouched.
      const intact = await repo.findById(tenantB.tenantId, attachmentB);
      expect(intact).not.toBeNull();
      expect(intact!.archivedAt).toBeUndefined();
      expect(intact!.portalVisible).toBe(false);
      expect(intact!.pairGroupId).toBeUndefined();
    });

    it('tenant A attachment row is invisible to tenant B via RLS (raw query cross-check)', async () => {
      const n = await asTenant(pool, tenantB.tenantId, async (client) => {
        const res = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM attachments WHERE id = $1`,
          [attachmentA],
        );
        return res.rows[0].n;
      });
      expect(n).toBe(0);
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
      // The test pool connects as a SUPERUSER, which bypasses RLS
      // unconditionally (FORCE ROW LEVEL SECURITY does not apply to
      // superusers). Running the assertion through the shared pool would
      // always return count=1, making the check vacuously wrong.
      // Instead we use asTenant (SET LOCAL ROLE rls_app_runtime — NOBYPASSRLS)
      // which is the same pattern used by rls-tenant-isolation.test.ts:28-45.
      const n = await asTenant(pool, tenantB.tenantId, async (client) => {
        const res = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_feature_flags
           WHERE tenant_id = $1 AND flag_key = $2`,
          [tenantA.tenantId, FLAG_KEY],
        );
        return res.rows[0].n;
      });
      // Row belongs to tenant A; tenant B's GUC must filter it out entirely.
      expect(n).toBe(0);
    });
  });

  // ── daily_digests (RV-060, migration 162) ──────────────────────────────────
  describe('PgDailyDigestRepository', () => {
    const DIGEST_DATE = '2026-06-10';

    function digestPayload(revenueCents: number): DailyDigestPayload {
      return {
        date: DIGEST_DATE,
        timezone: 'America/Chicago',
        revenueCents,
        grossRevenueCents: revenueCents,
        refundsCents: 0,
        paymentsCount: 1,
        jobsCompletedCount: 0,
        tomorrow: { appointmentCount: 0, firstStartIso: null },
        pendingApprovals: { totalCount: 0, top: [] },
        overdueInvoicesCount: 0,
        unbilledJobs: [],
      };
    }

    it('upsert + findByTenantAndDate round-trips per tenant and never crosses tenants (pins real column names)', async () => {
      const repo = new PgDailyDigestRepository(pool);
      const rowA = await repo.upsert(tenantA.tenantId, DIGEST_DATE, digestPayload(100), 'narrative A');
      const rowB = await repo.upsert(tenantB.tenantId, DIGEST_DATE, digestPayload(200), 'narrative B');
      expect(rowA.id).not.toBe(rowB.id);
      expect(rowA.digestDate).toBe(DIGEST_DATE);

      const seenByA = await repo.findByTenantAndDate(tenantA.tenantId, DIGEST_DATE);
      const seenByB = await repo.findByTenantAndDate(tenantB.tenantId, DIGEST_DATE);
      expect(seenByA?.id).toBe(rowA.id);
      expect(seenByA?.narrative).toBe('narrative A');
      expect(seenByB?.id).toBe(rowB.id);
      expect(seenByB?.narrative).toBe('narrative B');
    });

    it('findLatest returns the tenant’s most recent digest and never crosses tenants', async () => {
      const repo = new PgDailyDigestRepository(pool);
      // Give tenant A an earlier and a later date; B keeps only DIGEST_DATE.
      await repo.upsert(tenantA.tenantId, '2026-06-08', digestPayload(50), 'older A');
      await repo.upsert(tenantA.tenantId, '2026-06-11', digestPayload(150), 'newest A');

      const latestA = await repo.findLatest(tenantA.tenantId);
      const latestB = await repo.findLatest(tenantB.tenantId);
      expect(latestA?.digestDate).toBe('2026-06-11');
      expect(latestA?.narrative).toBe('newest A');
      // B's latest is its own row, not A's more-recent one.
      expect(latestB?.tenantId).toBe(tenantB.tenantId);
      expect(latestB?.digestDate).toBe(DIGEST_DATE);
    });

    it('insertIfAbsent dedupes on (tenant, date) within a tenant but NOT across tenants', async () => {
      const repo = new PgDailyDigestRepository(pool);
      const again = await repo.insertIfAbsent(tenantA.tenantId, DIGEST_DATE, digestPayload(300));
      expect(again.inserted).toBe(false); // tenant A already has this date
      expect(again.digest.narrative).toBe('narrative A');
    });

    it('setSmsDispatchId scoped to A cannot claim B row (and claims only once)', async () => {
      const repo = new PgDailyDigestRepository(pool);
      const dispatchId = crypto.randomUUID();
      const claimed = await repo.setSmsDispatchId(tenantA.tenantId, DIGEST_DATE, dispatchId);
      expect(claimed?.smsDispatchId).toBe(dispatchId);
      // Second claim is a no-op (status check).
      expect(await repo.setSmsDispatchId(tenantA.tenantId, DIGEST_DATE, crypto.randomUUID())).toBeNull();
      // B's row is untouched by A's claim.
      const intactB = await repo.findByTenantAndDate(tenantB.tenantId, DIGEST_DATE);
      expect(intactB?.smsDispatchId).toBeUndefined();
    });

    it('tenant A digest row is invisible to tenant B via RLS (raw query cross-check)', async () => {
      const n = await asTenant(pool, tenantB.tenantId, async (client) => {
        const res = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM daily_digests WHERE tenant_id = $1`,
          [tenantA.tenantId],
        );
        return res.rows[0].n;
      });
      expect(n).toBe(0);
    });
  });

  // ── GUC-unset (fail-closed) coverage ──────────────────────────────────────
  //
  // Nothing in the repo previously tested what happens when no tenant context
  // is set at all. Both policies below use:
  //   current_setting('app.current_tenant_id')::UUID
  // without the `, true` (missing_ok) flag, so Postgres raises an error when
  // the GUC is unset rather than silently returning NULL / zero rows. This is
  // the correct fail-closed behaviour — the tests below pin it.
  //
  // Two possible error shapes depending on connection history:
  //   • GUC never set in this session  → "unrecognized configuration parameter"
  //   • GUC set then RESET on a pooled connection → empty string →
  //     `''::uuid` cast → "invalid input syntax for type uuid"
  // The regex below accepts both.
  describe('GUC-unset fail-closed behaviour (no app.current_tenant_id)', () => {
    it('SELECT on customers throws when GUC is not set (fail-closed policy)', async () => {
      // customers policy (schema.ts migration 014, line ~332-333):
      //   USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
      // No missing_ok → current_setting raises "unrecognized configuration
      // parameter" when the GUC has never been set in this transaction.
      // We verify the error is thrown, not that zero rows are returned.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        // Explicitly reset the GUC so it is unset within this transaction.
        await client.query(`RESET app.current_tenant_id`);
        await expect(
          client.query('SELECT count(*) FROM customers'),
        ).rejects.toThrow(/unrecognized configuration parameter|invalid input syntax for type uuid/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('SELECT on tenant_feature_flags throws when GUC is not set (fail-closed policy)', async () => {
      // tenant_feature_flags policy (schema.ts migration 159, line ~3992-3993):
      //   USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
      // No missing_ok → same fail-closed error as customers above.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await client.query(`RESET app.current_tenant_id`);
        await expect(
          client.query('SELECT count(*) FROM tenant_feature_flags'),
        ).rejects.toThrow(/unrecognized configuration parameter|invalid input syntax for type uuid/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('SELECT on attachments throws when GUC is not set (fail-closed policy)', async () => {
      // attachments policy (schema.ts migration 160):
      //   USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
      // No missing_ok → same fail-closed error as customers above.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await client.query(`RESET app.current_tenant_id`);
        await expect(
          client.query('SELECT count(*) FROM attachments'),
        ).rejects.toThrow(/unrecognized configuration parameter|invalid input syntax for type uuid/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('SELECT on daily_digests throws when GUC is not set (fail-closed policy)', async () => {
      // daily_digests policy (schema.ts migration 162):
      //   USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
      // No missing_ok → same fail-closed error as customers above.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await client.query(`RESET app.current_tenant_id`);
        await expect(
          client.query('SELECT count(*) FROM daily_digests'),
        ).rejects.toThrow(/unrecognized configuration parameter|invalid input syntax for type uuid/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });
});
