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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  softDeleteEstimate,
  cloneEstimate,
  transitionEstimateStatus,
  Estimate,
} from '../../src/estimates/estimate';
import { runEstimateExpirySweep } from '../../src/workers/estimate-expiry-worker';
import { listAllTenantIds } from '../../src/tenants/list-tenant-ids';
import { convertEstimateToInvoice } from '../../src/invoices/convert-estimate';
import { PublicEstimateService } from '../../src/estimates/public-estimate-service';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';
import { ConflictError } from '../../src/shared/errors';
import { ensureTenantSettings } from '../../src/settings/settings';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/**
 * End-to-end exercise of the four estimate phases against a REAL Postgres
 * (the pgvector testcontainer with migrations 125-128 applied). Each phase
 * asserts the actual on-disk effect, not just the in-memory repo behavior —
 * INCLUDING the audit trail (PgAuditRepository, not InMemoryAuditRepository)
 * and, where the row calls for it, a second tenant proving isolation (T1).
 *
 * §8.7 G1 audit (#1008 on ticket #1012): this file previously ran every
 * mutation through InMemoryAuditRepository, so no row here had ever proved
 * an actual audit_events INSERT, and the expiry-worker case fed the sweep a
 * one-element `listTenantIds` stub instead of the real enumerator. Both are
 * fixed below — see the per-test comments for what each row now proves.
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
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  // T1 — a second tenant, provisioned once here and reused by the isolation
  // assertion in each row cluster below (soft-delete/clone/expiry, convert,
  // approval) rather than re-provisioned per test.
  let otherTenant: { tenantId: string; userId: string };
  let otherCustomerId: string;

  async function newJob(
    deposit?: { requiredCents: number; paidCents: number },
    ctx: { tenantId: string; userId: string; customerId: string } = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      customerId,
    },
  ): Promise<string> {
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId, tenantId: ctx.tenantId, customerId: ctx.customerId,
      street1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701',
      country: 'USA', isPrimary: true, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId, tenantId: ctx.tenantId, customerId: ctx.customerId, locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`, summary: 'Test job', status: 'scheduled', priority: 'normal',
      createdBy: ctx.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    // Deposit columns are written by the payment webhook in production
    // (via update), not at create time — mirror that here.
    if (deposit) {
      await jobRepo.update(ctx.tenantId, jobId, {
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
    ctx: { tenantId: string; userId: string } = { tenantId: tenant.tenantId, userId: tenant.userId },
  ): Promise<Estimate> {
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const est = await estimateRepo.create({
      id: crypto.randomUUID(), tenantId: ctx.tenantId, jobId,
      estimateNumber: `EST-${crypto.randomUUID().slice(0, 8)}`,
      status: 'draft', lineItems, totals, version: 1,
      createdBy: ctx.userId, createdAt: new Date(), updatedAt: new Date(),
    });
    if (Object.keys(overrides).length > 0) {
      return (await estimateRepo.update(ctx.tenantId, est.id, overrides))!;
    }
    return est;
  }

  /** Read the raw row bypassing the deleted_at read filter. */
  async function rawRow(id: string, tenantId: string = tenant.tenantId): Promise<Record<string, unknown> | undefined> {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
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
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    // createTestTenant only inserts tenants/users — PgSettingsRepository.update()
    // is a bare UPDATE (no upsert), so a fresh tenant needs a settings row
    // before the Tier-4 deposit-rule tests below can write depositStrategy
    // etc. onto it. Without this, those settingsRepo.update() calls silently
    // no-op (0 rows), and only pass today because an EARLIER test in this
    // file ('Phase 2 — convert to invoice') happens to create the row first
    // via ensureTenantSettings inside createInvoiceWithNextNumber — an
    // accidental ordering dependency, confirmed by re-running the
    // after_approval/7.9 tests in isolation (they fail with depositRequiredCents
    // 0 instead of the expected value when no earlier test has run). Bootstrapping
    // here explicitly makes every test in this file order-independent.
    await ensureTenantSettings(tenant.tenantId, settingsRepo);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId, tenantId: tenant.tenantId, firstName: 'Test', lastName: 'Customer',
      displayName: 'Test Customer', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: tenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });

    // T1 fixture — a second, wholly separate tenant reused by the
    // cross-tenant isolation assertion in each row cluster below.
    otherTenant = await createTestTenant(pool);
    otherCustomerId = crypto.randomUUID();
    await customerRepo.create({
      id: otherCustomerId, tenantId: otherTenant.tenantId, firstName: 'Other', lastName: 'Tenant',
      displayName: 'Other Tenant Customer', preferredChannel: 'phone', smsConsent: false, isArchived: false,
      createdBy: otherTenant.userId, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('Phase 1 — soft delete', () => {
    it('hides from reads but keeps the row with deleted_at set, and emits estimate.deleted', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)]);

      const deleted = await softDeleteEstimate(tenant.tenantId, est.id, estimateRepo, {
        auditRepo, actorId: tenant.userId, actorRole: 'owner',
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

      // §8.7 G1 — real audit_events row through PgAuditRepository, not just
      // an in-memory event object nobody ever queried back.
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', est.id);
      expect(events.map((e) => e.eventType)).toContain('estimate.deleted');
    });

    it('refuses to delete an accepted estimate', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)], { status: 'accepted' });
      await expect(softDeleteEstimate(tenant.tenantId, est.id, estimateRepo)).rejects.toThrow(/accepted/i);
      expect(await estimateRepo.findById(tenant.tenantId, est.id)).not.toBeNull();
    });
  });

  describe('Phase 1 — clone', () => {
    it('persists a fresh draft with reset state and copied tier metadata, emits estimate.cloned (T1)', async () => {
      const jobId = await newJob();
      const tiered: LineItem[] = [
        { ...buildLineItem(crypto.randomUUID(), 'Diagnostic', 1, 5000, 0, true) },
        { ...buildLineItem(crypto.randomUUID(), 'Good', 1, 10000, 1, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true, isDefaultSelected: true },
        { ...buildLineItem(crypto.randomUUID(), 'Better', 1, 20000, 2, true), groupKey: 'tier', groupLabel: 'Plan', isOptional: true },
      ];
      const est = await seedEstimate(jobId, tiered, { status: 'sent', viewToken: `tok-${crypto.randomUUID()}`, sentAt: new Date(), version: 3 });

      const clone = await cloneEstimate(tenant.tenantId, est.id, 'EST-CLONE', tenant.userId, estimateRepo, auditRepo);
      const reloaded = await estimateRepo.findById(tenant.tenantId, clone!.id);
      expect(reloaded!.status).toBe('draft');
      expect(reloaded!.version).toBe(1);
      expect(reloaded!.viewToken).toBeUndefined();
      const better = reloaded!.lineItems.find((li) => li.description === 'Better');
      expect(better?.groupKey).toBe('tier');
      expect(better?.isOptional).toBe(true);

      // §8.7 G1 — the clone path previously ran with NO auditRepo at all
      // (the call site never passed one), so estimate.cloned had never once
      // been proved to land in audit_events.
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', clone!.id);
      expect(events.map((e) => e.eventType)).toContain('estimate.cloned');

      // T1 — cross-tenant isolation: another tenant's scoped repo call
      // cannot read this tenant's clone.
      expect(await estimateRepo.findById(otherTenant.tenantId, clone!.id)).toBeNull();
    });
  });

  describe('Phase 1 — auto-expiry worker', () => {
    it('flips a sent estimate past valid_until to expired in the DB, via the REAL tenant enumerator, and stays tenant-scoped (T1)', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)],
        { status: 'sent', validUntil: new Date(Date.now() - 86_400_000) },
      );

      // T1 — a second tenant with its OWN expiring estimate, swept in the
      // SAME pass by the real enumerator, not by a second hand-picked stub.
      const otherJobId = await newJob(undefined, {
        tenantId: otherTenant.tenantId, userId: otherTenant.userId, customerId: otherCustomerId,
      });
      const otherEst = await seedEstimate(
        otherJobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 7500, 0, true)],
        { status: 'sent', validUntil: new Date(Date.now() - 86_400_000) },
        { tenantId: otherTenant.tenantId, userId: otherTenant.userId },
      );

      const result = await runEstimateExpirySweep({
        estimateRepo,
        auditRepo,
        // §8.7 G1 — the PRODUCTION tenant selector (D-032), not the
        // one-element `async () => [tenant.tenantId]` stub this test used to
        // pass, which meant `listAllTenantIds`'s own query had never run
        // under this test.
        listTenantIds: () => listAllTenantIds(pool),
        logger,
      });
      expect(result.expired).toBeGreaterThanOrEqual(2);
      expect((await estimateRepo.findById(tenant.tenantId, est.id))!.status).toBe('expired');
      expect((await estimateRepo.findById(otherTenant.tenantId, otherEst.id))!.status).toBe('expired');

      // Each tenant's expiry emitted its OWN audit event, through the real repo.
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', est.id);
      expect(events.map((e) => e.eventType)).toContain('estimate.expired');
      const otherEvents = await auditRepo.findByEntity(otherTenant.tenantId, 'estimate', otherEst.id);
      expect(otherEvents.map((e) => e.eventType)).toContain('estimate.expired');

      // T1 — cross-tenant isolation: tenant A's scoped repo call cannot
      // read tenant B's (now-expired) estimate.
      expect(await estimateRepo.findById(tenant.tenantId, otherEst.id)).toBeNull();
    });
  });

  describe('Phase 2 — convert to invoice', () => {
    it('creates a linked invoice, is idempotent, credits a paid deposit, and emits exactly one estimate.converted (T1)', async () => {
      const jobId = await newJob({ requiredCents: 8000, paidCents: 8000 });
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 20000, 0, true)], { status: 'accepted' });

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

      // §8.7 G1 — exactly one estimate.converted event even after the
      // idempotent retry (the early-return path in convertEstimateToInvoice
      // returns before the audit block, so a second call must NOT double-fire).
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', est.id);
      expect(events.filter((e) => e.eventType === 'estimate.converted')).toHaveLength(1);

      // T1 — another tenant's scoped repo call cannot read this invoice.
      expect(await invoiceRepo.findById(otherTenant.tenantId, invoice!.id)).toBeNull();
    });
  });

  describe('Phase 3 — good-better-best public approval', () => {
    it('recomputes the accepted total from the selection, persists accepted_selection, and emits public_estimate.approved', async () => {
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
        auditRepo,
      });

      const view = await service.approve({ token, acceptedByName: 'Sarah J', selectedLineItemIds: [betterId] });
      expect(view.status).toBe('accepted');
      // base 5000 + better 20000 = 25000 (good tier excluded).
      expect(view.totalCents).toBe(25000);

      const row = await rawRow(view.id);
      const selection = row!.accepted_selection as string[];
      expect(selection.sort()).toEqual([baseId, betterId].sort());

      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', view.id);
      expect(events.map((e) => e.eventType)).toContain('public_estimate.approved');

      // T1 — cross-tenant isolation: another tenant's scoped repo call
      // cannot read this accepted estimate, and sees none of its audit trail.
      expect(await estimateRepo.findById(otherTenant.tenantId, view.id)).toBeNull();
      const otherEvents = await auditRepo.findByEntity(otherTenant.tenantId, 'estimate', view.id);
      expect(otherEvents).toHaveLength(0);
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
        auditRepo,
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

      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', view.id);
      expect(events.map((e) => e.eventType)).toContain('public_estimate.approved');
    });
  });

  describe('Phase 2 — convert race', () => {
    it('two concurrent converts yield one invoice (unique-index backstop) and exactly one audit event', async () => {
      const jobId = await newJob();
      const est = await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 15000, 0, true)], { status: 'accepted' });
      const convertDeps = { estimateRepo, invoiceRepo, jobRepo, settingsRepo, auditRepo, paymentRepo, actorId: tenant.userId, logger };

      const [a, b] = await Promise.all([
        convertEstimateToInvoice(tenant.tenantId, est.id, convertDeps),
        convertEstimateToInvoice(tenant.tenantId, est.id, convertDeps),
      ]);
      expect(a!.id).toBe(b!.id);
      const linked = (await invoiceRepo.findByJob(tenant.tenantId, jobId)).filter((i) => i.estimateId === est.id);
      expect(linked).toHaveLength(1);

      // Race safety extends to the audit trail: exactly one estimate.converted
      // event, not one per racing caller that both thought they won.
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', est.id);
      expect(events.filter((e) => e.eventType === 'estimate.converted')).toHaveLength(1);
    });
  });

  describe('Phase 3 — one accepted estimate per job (atomic)', () => {
    it('two concurrent approvals on the same job yield exactly one accepted, and the loser is refused with the mapped conflict error (7.8, T1)', async () => {
      const jobId = await newJob();
      const tokenA = `acc-a-${crypto.randomUUID()}`;
      const tokenB = `acc-b-${crypto.randomUUID()}`;
      await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 10000, 0, true)], { status: 'sent', viewToken: tokenA, sentAt: new Date() });
      await seedEstimate(jobId, [buildLineItem(crypto.randomUUID(), 'Repair', 1, 12000, 0, true)], { status: 'sent', viewToken: tokenB, sentAt: new Date() });

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo,
      });

      const results = await Promise.allSettled([
        service.approve({ token: tokenA, acceptedByName: 'Customer A' }),
        service.approve({ token: tokenB, acceptedByName: 'Customer B' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      // §8.7 G1 (7.8) — inspect the REJECTED settlement's mapped outcome,
      // not just that one side won: the loser must be refused with the SAME
      // friendly ConflictError the pre-check guard throws (whether it lost
      // at the pre-check or at the DB's partial-unique-index race), never a
      // raw/unmapped 500.
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toBeDefined();
      expect(rejected!.reason).toBeInstanceOf(ConflictError);
      expect((rejected!.reason as ConflictError).message).toMatch(/already.*accepted/i);

      const onJob = await estimateRepo.findByJob(tenant.tenantId, jobId);
      const accepted = onJob.filter((e) => e.status === 'accepted');
      expect(accepted).toHaveLength(1);

      // Exactly one public_estimate.approved audit event on the winner — the
      // loser's refusal left no phantom acceptance in the audit trail either.
      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', accepted[0].id);
      expect(events.filter((e) => e.eventType === 'public_estimate.approved')).toHaveLength(1);

      // T1 — cross-tenant isolation: another tenant's scoped repo call sees
      // neither estimate on this job.
      expect(await estimateRepo.findByJob(otherTenant.tenantId, jobId)).toHaveLength(0);
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
        auditRepo,
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
        auditRepo,
      });

      await expect(service.decline({ token })).rejects.toThrow(/expired/i);
    });
  });

  describe('Phase 3 — public approval captures signature + request metadata (7.6)', () => {
    it('drives the PUBLIC route (not fixture data) and persists+reads back name, IP, user-agent and the signature canvas data', async () => {
      const jobId = await newJob();
      const token = `sigtoken-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Labor', 1, 5000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date() },
      );

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo,
      });

      const signatureData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
      const view = await service.approve({
        token,
        acceptedByName: 'Pat Signer',
        signatureData,
        ip: '203.0.113.42',
        userAgent: 'Mozilla/5.0 (integration-test)',
      });
      expect(view.status).toBe('accepted');

      // Read back from the REAL row via the public route's own write path —
      // not seeded as fixture data (the G1 finding for this row: no test
      // previously named "signature").
      const row = await rawRow(view.id);
      expect(row!.accepted_by_name).toBe('Pat Signer');
      expect(row!.accepted_by_ip).toBe('203.0.113.42');
      expect(row!.accepted_user_agent).toBe('Mozilla/5.0 (integration-test)');
      expect(row!.accepted_signature_data).toBe(signatureData);

      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', view.id);
      expect(events.map((e) => e.eventType)).toContain('public_estimate.approved');

      // T1 — cross-tenant isolation: the accepted row (signature columns
      // included) cannot be read under a second tenant id, and its audit
      // trail is invisible there too.
      expect(await estimateRepo.findById(otherTenant.tenantId, view.id)).toBeNull();
      const otherEvents = await auditRepo.findByEntity(otherTenant.tenantId, 'estimate', view.id);
      expect(otherEvents).toHaveLength(0);
    });
  });

  // 7.9 — deposit before parts. Both new tests mutate `tenant`'s settings row
  // (depositStrategy/depositTimingPolicy) and are placed LAST in this file so
  // no earlier test's assumptions about default (unset) deposit settings are
  // disturbed — every earlier test either doesn't touch deposits or sets its
  // own deposit fields explicitly before asserting.
  describe('Phase 3 — deposit rules at real Postgres (7.9)', () => {
    it('before_approval — refuses acceptance until the deposit is paid, then allows it once paid', async () => {
      await settingsRepo.update(tenant.tenantId, {
        depositStrategy: 'fixed',
        depositFixedCents: 20000,
        depositTimingPolicy: 'before_approval',
      });
      const jobId = await newJob();
      const token = `beforeapproval-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Repair', 1, 100000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date() },
      );

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo,
      });

      await expect(service.approve({ token, acceptedByName: 'Needs To Pay First' }))
        .rejects.toThrow(ConflictError);
      expect((await estimateRepo.findByViewToken!(token))!.status).toBe('sent');

      // T1 + T3 — a second, differently-configured tenant (no deposit rule
      // at all — otherTenant never had settingsRepo.update() called on it)
      // approves its OWN estimate in the very same test and is NOT refused
      // or capped by tenant A's before_approval/fixed-20000 rule above.
      const otherJobId = await newJob(undefined, {
        tenantId: otherTenant.tenantId, userId: otherTenant.userId, customerId: otherCustomerId,
      });
      const otherToken = `otherbeforeapproval-${crypto.randomUUID()}`;
      await seedEstimate(
        otherJobId,
        [buildLineItem(crypto.randomUUID(), 'Repair', 1, 100000, 0, true)],
        { status: 'sent', viewToken: otherToken, sentAt: new Date() },
        { tenantId: otherTenant.tenantId, userId: otherTenant.userId },
      );
      const otherView = await service.approve({ token: otherToken, acceptedByName: 'No Rule Here' });
      expect(otherView.status).toBe('accepted');

      // Simulate the deposit having been paid (the Stripe checkout round trip
      // is PR 3b/3c — out of scope for this row) by writing the paid amount
      // directly onto the job, mirroring what the webhook credit would do.
      await jobRepo.update(tenant.tenantId, jobId, {
        depositRequiredCents: 20000,
        depositPaidCents: 20000,
        depositStatus: 'paid',
        updatedAt: new Date(),
      });
      const view = await service.approve({ token, acceptedByName: 'Paid First' });
      expect(view.status).toBe('accepted');

      const events = await auditRepo.findByEntity(tenant.tenantId, 'estimate', view.id);
      expect(events.map((e) => e.eventType)).toContain('public_estimate.approved');
    });

    it('fixed-amount deposit rule caps the required deposit at the estimate total, never above it', async () => {
      await settingsRepo.update(tenant.tenantId, {
        depositStrategy: 'fixed',
        depositFixedCents: 999_999,
        depositTimingPolicy: 'after_approval',
      });
      const jobId = await newJob();
      const token = `fixedcap-${crypto.randomUUID()}`;
      await seedEstimate(
        jobId,
        [buildLineItem(crypto.randomUUID(), 'Small Repair', 1, 5000, 0, true)],
        { status: 'sent', viewToken: token, sentAt: new Date() },
      );

      const service = new PublicEstimateService({
        estimateRepo, jobRepo, customerRepo, locationRepo, settingsRepo,
        auditRepo,
      });

      const view = await service.approve({ token, acceptedByName: 'Cap Test' });
      expect(view.status).toBe('accepted');
      // The fixed rule asked for $9,999.99 but the estimate is only $50 — the
      // rule must never demand more deposit than the contract is worth.
      expect(view.depositRequiredCents).toBe(5000);

      const job = await jobRepo.findById(tenant.tenantId, jobId);
      expect(job!.depositRequiredCents).toBe(5000);
    });
  });
});
