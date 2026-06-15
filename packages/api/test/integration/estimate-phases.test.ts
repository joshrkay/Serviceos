import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  softDeleteEstimate,
  cloneEstimate,
  transitionEstimateStatus,
  Estimate,
} from '../../src/estimates/estimate';
import { runEstimateExpirySweep } from '../../src/workers/estimate-expiry-worker';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * End-to-end exercise of the four estimate phases against a REAL Postgres
 * (the pgvector testcontainer with migrations 125-128 applied). Each phase
 * asserts the actual on-disk effect, not just the in-memory repo behavior.
 */
describe('Postgres integration — estimate phases (real DB effects)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let settingsRepo: PgSettingsRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  async function newJob(deposit?: { requiredCents: number; paidCents: number }): Promise<string> {
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: tenant.tenantId, customerId,
      street1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701',
      country: 'USA', isPrimary: true, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: tenant.tenantId, customerId, locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: 'Test job', status: 'scheduled', priority: 'normal',
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    // Deposit columns are written by the payment webhook in production
    // (via update), not at create time — mirror that here.
    if (deposit) {
      await jobRepo.update(tenant.tenantId, jobId, {
        depositRequiredCents: deposit.requiredCents,
        depositPaidCents: deposit.paidCents,
        depositStatus: deposit.paidCents > 0 ? 'paid' : 'not_required',
        updatedAt: new Date(),
      });
    }
    return jobId;
  }

  async function seedEstimate(
    jobId: string,
    lineItems: LineItem[],
    overrides: Partial<Estimate> = {},
  ): Promise<Estimate> {
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const est = await estimateRepo.create({
      id: crypto.randomUUID(), tenantId: tenant.tenantId, jobId,
      estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
      status: 'draft', lineItems, totals, version: 1,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    if (Object.keys(overrides).length > 0) {
      return (await estimateRepo.update(tenant.tenantId, est.id, overrides))!;
    }
    return est;
  }

  /** Read the raw row bypassing the deleted_at read filter. */
  async function rawRow(id: string): Promise<Record<string, unknown> | undefined> {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      const { rows } = await client.query(`SELECT * FROM estimates WHERE id = $1`, [id]);
      return rows[0];
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Test', lastName: 'Customer',
      displayName: 'Test Customer', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('Phase 1 — soft delete', () => {
    it('hides from reads but keeps the row with deleted_at set', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)]);

      const deleted = await softDeleteEstimate(tenant.tenantId, est.id, estimateRepo, {
        auditRepo: new InMemoryAuditRepository(), actorId: tenant.userId, actorRole: 'owner',
      });
      // The mutation returns the (now soft-deleted) row so the route can emit
      // audit + refresh money state — it must NOT come back null.
      expect(deleted).not.toBeNull();
      expect(deleted!.deletedAt).toBeInstanceOf(Date);

      // Hidden from the standard read paths…
      expect(await estimateRepo.findById(tenant.tenantId, est.id)).toBeNull();
      expect(await estimateRepo.findByJob(tenant.tenantId, jobId)).toHaveLength(0);
      // …but the row physically remains with deleted_at populated.
      const row = await rawRow(est.id);
      expect(row).toBeDefined();
      expect(row!.deleted_at).not.toBeNull();
    });

    it('refuses to delete an accepted estimate', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)], { status: 'accepted' });
      await expect(softDeleteEstimate(tenant.tenantId, est.id, estimateRepo)).rejects.toThrow(/accepted/i);
      expect(await estimateRepo.findById(tenant.tenantId, est.id)).not.toBeNull();
    });
  });

  describe('Phase 1 — clone', () => {
    it('persists a fresh draft with reset state and copied tier metadata', async () => {
      const jobId = await newJob();
      const tiered: LineItem[] = [
        { ...buildLineItem(crypto.randomUUID(), 'Diagnostic', 1, 5000, 0, true) },
        { ...buildLineItem(crypto.randomUUID(), 'Good', 1, 10000, 1, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
        { ...buildLineItem(crypto.randomUUID(), 'Better', 1, 20000, 2, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      ];
      const est = await seedEstimate(jobId, tiered, { status: 'sent', viewToken: `tok-${crypto.randomUUID()}`, sentAt: new Date(), version: 3 });

      const clone = await cloneEstimate(tenant.tenantId, est.id, 'EST-CLONE', tenant.userId, estimateRepo);
      const reloaded = await estimateRepo.findById(tenant.tenantId, clone!.id);
      expect(reloaded!.status).toBe('draft');
      expect(reloaded!.version).toBe(1);
      expect(reloaded!.viewToken).toBeUndefined();
      const better = reloaded!.lineItems.find((li) => li.description === 'Better');
      expect(better?.groupKey).toBe('tier');
      expect(better?.isOptional).toBe(true);
    });
  });

  describe('Phase 1 — auto-expiry worker', () => {
    it('flips a sent estimate past valid_until to expired in the DB', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)],
        { status: 'sent', validUntil: new Date(Date.now() - 86_400_000) },
      );

      const result = await runEstimateExpirySweep({
        estimateRepo,
        auditRepo: new InMemoryAuditRepository(),
        listTenantIds: async () => [tenant.tenantId],
        logger,
      });
      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect((await estimateRepo.findById(tenant.tenantId, est.id))!.status).toBe('expired');
    });
  });

  describe('Phase 2 — convert to invoice', () => {
    it('creates a linked invoice, is idempotent, and credits a paid deposit', async () => {
      const jobId = await newJob({ requiredCents: 8000, paidCents: 8000 });
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 20000, 0, true)], { status: 'accepted' });
      const auditRepo = new InMemoryAuditRepository();

      const invoice = await convertEstimateToInvoice(tenant.tenantId, est.id, {
        estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, paymentRepo,
        actorId: tenant.userId, logger,
      });
      expect(invoice!.estimateId).toBe(est.id);
      expect(invoice!.totals.totalCents).toBe(20000);
      // Deposit credited: 20000 - 8000 = 12000 due.
      expect(invoice!.amountPaidCents).toBe(8000);
      expect(invoice!.amountDueCents).toBe(12000);

      // Idempotent: a second convert returns the same invoice, no new row.
      const again = await convertEstimateToInvoice(tenant.tenantId, est.id, {
        estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, paymentRepo,
        actorId: tenant.userId, logger,
      });
      expect(again!.id).toBe(invoice!.id);
      const linked = (await invoiceRepo.findByJob(tenant.tenantId, jobId)).filter((i) => i.estimateId === est.id);
      expect(linked).toHaveLength(1);
    });
  });

  describe('Phase 3 — good-better-best public approval', () => {
    it('recomputes the accepted total from the selection and persists accepted_selection', async () => {
      const jobId = await newJob();
      const baseId = crypto.randomUUID();
      const betterId = crypto.randomUUID();
      const goodId = crypto.randomUUID();
      const token = `selectiontoken-${crypto.randomUUID()}`;
      const tiered: LineItem[] = [
        { ...buildLineItem(baseId, 'Diagnostic', 1, 5000, 0, true) },
        { ...buildLineItem(goodId, 'Good', 1, 10000, 1, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
        { ...buildLineItem(betterId, 'Better', 1, 20000, 2, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      ];
      await seedEstimate(jobId, tiered, { status: 'sent', viewToken: token, sentAt: new Date() });

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo: new InMemoryAuditRepository(),
      });

      const view = await service.approve({ token, acceptedByName: 'Sarah J', selectedLineItemIds: [betterId] });
      expect(view.status).toBe('accepted');
      // base 5000 + better 20000 = 25000 (good tier excluded).
      expect(view.totalCents).toBe(25000);

      const row = await rawRow(view.id);
      const selection = row!.accepted_selection as string[];
      expect(selection.sort()).toEqual([baseId, betterId].sort());
    });

    it('after_approval — accepting writes the deposit onto the job and the view is payable', async () => {
      await settingsRepo.update(tenant.tenantId, {
        depositStrategy: 'percentage',
        depositPercentageBps: 2500, // 25%
        depositTimingPolicy: 'after_approval',
      });
      const jobId = await newJob();
      const token = `aftertoken-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Repair', 1, 100000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date() },
      );

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo: new InMemoryAuditRepository(),
      });

      // after_approval must NOT block acceptance on an unpaid deposit.
      const view = await service.approve({ token, acceptedByName: 'Sarah J' });
      expect(view.status).toBe('accepted');
      // The accept hook wrote the 25%-of-$1000 deposit onto the real job row.
      expect(view.depositRequiredCents).toBe(25000);
      expect(view.depositStatus).toBe('pending');
      // ...and the view exposes it as payable, computed off real columns —
      // the gap this whole change closes (no Pay-deposit path existed before).
      expect(view.depositPayable).toBe(true);

      // Persisted on the job, not just computed in the view.
      const job = await jobRepo.findById(tenant.tenantId, jobId);
      expect(job!.depositRequiredCents).toBe(25000);
      expect(job!.depositStatus).toBe('pending');
    });
  });

  describe('Phase 2 — convert race', () => {
    it('two concurrent converts yield one invoice (unique-index backstop)', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 15000, 0, true)], { status: 'accepted' });
      const auditRepo = new InMemoryAuditRepository();
      const convertDeps = { estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, paymentRepo, actorId: tenant.userId, logger };

      const [a, b] = await Promise.all([
        convertEstimateToInvoice(tenant.tenantId, est.id, convertDeps),
        convertEstimateToInvoice(tenant.tenantId, est.id, convertDeps),
      ]);
      expect(a!.id).toBe(b!.id);
      const linked = (await invoiceRepo.findByJob(tenant.tenantId, jobId)).filter((i) => i.estimateId === est.id);
      expect(linked).toHaveLength(1);
    });
  });

  describe('Phase 3 — one accepted estimate per job (atomic)', () => {
    it('two concurrent approvals on the same job yield exactly one accepted', async () => {
      const jobId = await newJob();
      const tokenA = `acc-a-${crypto.randomUUID()}`;
      const tokenB = `acc-b-${crypto.randomUUID()}`;
      await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 10000, 0, true)], { status: 'sent', viewToken: tokenA, sentAt: new Date() });
      await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 12000, 0, true)], { status: 'sent', viewToken: tokenB, sentAt: new Date() });

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo: new InMemoryAuditRepository(),
      });

      const results = await Promise.allSettled([
        service.approve({ token: tokenA, acceptedByName: 'Customer A' }),
        service.approve({ token: tokenB, acceptedByName: 'Customer B' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const onJob = await estimateRepo.findByJob(tenant.tenantId, jobId);
      expect(onJob.filter((e) => e.status === 'accepted')).toHaveLength(1);
    });
  });

  describe('Phase 4 — public view reflects validity expiry', () => {
    it('marks a lapsed sent estimate as expired and non-actionable on GET', async () => {
      const jobId = await newJob();
      const token = `viewexpiry-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date(), validUntil: new Date(Date.now() - 60_000) },
      );
      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo: new InMemoryAuditRepository(),
      });
      const view = await service.getByToken(token);
      expect(view.isExpired).toBe(true);
      expect(view.isActionable).toBe(false);
    });
  });

  describe('Phase 4 — validity expiry precedence', () => {
    it('expires (and refuses) a decline on an estimate past valid_until', async () => {
      const jobId = await newJob();
      const token = `expiretoken-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date(), validUntil: new Date(Date.now() - 60_000) },
      );

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo: new InMemoryAuditRepository(),
      });

      await expect(service.decline({ token })).rejects.toThrow(/expired/i);
    });
  });
});
