/**
 * Collections cadence — apply_late_fee idempotency AND the cap against real Postgres.
 *
 * Regression guard (original): pg-invoice.insertLineItems replaces any non-UUID
 * line-item id with a random uuidv4, so the old human-readable
 * `late-fee:<stepKey>` id never survived a reload and the handler's
 * idempotency guard could not match — a retried/duplicate proposal appended
 * a SECOND late-fee line (double charge). The fee id is now a deterministic
 * UUID (lateFeeLineId), which the repo preserves. This test round-trips
 * through the REAL repo (the InMemory repo preserves all ids and therefore
 * cannot catch this — the exact mocked-DB trap CLAUDE.md warns about).
 *
 * Added for §8.10 of ticket #1023 (G1: "the idempotency file is single-tenant
 * with no audit; the cap is unit-only"):
 *   - the `invoice.late_fee_applied` audit row is read back through
 *     `PgAuditRepository.findByEntity` — exactly once across a re-execution;
 *   - a SECOND tenant applies its own fee in the same run, and neither
 *     tenant's invoice moves when the other's proposal executes (T1);
 *   - the CAP (`lateFeeMaxCents`) is proven on the PERSISTED invoice row:
 *     the overdue sweep clamps a 50.00 flat fee to the tenant's 20.00 cap,
 *     the clamped amount is what lands on the invoice, and a re-sweep +
 *     re-execution add no second fee line.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import {
  PgDunningConfigRepository,
  PgDunningEventRepository,
} from '../../src/invoices/pg-dunning-config';
import { defaultDunningConfig } from '../../src/invoices/dunning-config';
import { runOverdueInvoiceSweep } from '../../src/workers/overdue-invoice-worker';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import {
  ApplyLateFeeExecutionHandler,
  lateFeeLineId,
} from '../../src/proposals/execution/apply-late-fee-handler';
import { Proposal } from '../../src/proposals/proposal';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const DAY_MS = 24 * 60 * 60 * 1000;

interface SeededInvoice {
  tenantId: string;
  userId: string;
  invoiceId: string;
  jobId: string;
}

describe('Postgres integration — apply_late_fee idempotency, audit and cap', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let handler: ApplyLateFeeExecutionHandler;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;

  /** An open invoice of `amountCents`, on its own tenant, optionally overdue. */
  async function seedInvoice(
    amountCents: number,
    label: string,
    dueDate?: Date,
  ): Promise<SeededInvoice> {
    const { tenantId, userId } = await createTestTenant(pool);

    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Late',
      lastName: 'Fee',
      displayName: 'Late Fee',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Fee St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-LF-${jobId.slice(0, 8)}`,
      summary: `Late fee job ${label}`,
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const invoiceId = uuidv4();
    const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, amountCents, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId,
      jobId,
      invoiceNumber: `INV-LF-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      dueDate,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenantId, userId, invoiceId, jobId };
  }

  function makeProposal(seeded: SeededInvoice, feeCents: number): Proposal {
    return {
      id: crypto.randomUUID(),
      tenantId: seeded.tenantId,
      proposalType: 'apply_late_fee',
      status: 'approved',
      payload: { invoiceId: seeded.invoiceId, feeCents, stepKey: 'initial' },
      summary: 'Apply late fee',
      createdBy: seeded.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('re-executing the same proposal does not append a second fee line, and audits it exactly once (real DB reload)', async () => {
    const seeded = await seedInvoice(15000, 'idempotency');

    const first = await handler.execute(makeProposal(seeded, 2500), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });
    expect(first.success).toBe(true);

    // Reload proves the fee-line id was persisted as-is (a valid UUID). A
    // second, distinct proposal for the same stepKey must be a no-op.
    const second = await handler.execute(makeProposal(seeded, 2500), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });
    expect(second.success).toBe(true);

    const reloaded = await invoiceRepo.findById(seeded.tenantId, seeded.invoiceId);
    const feeLines = reloaded!.lineItems.filter(
      (li) => li.id === lateFeeLineId(seeded.invoiceId, 'initial'),
    );
    expect(feeLines).toHaveLength(1);
    // 15000 base + 2500 fee once — never 20000.
    expect(reloaded!.amountDueCents).toBe(17500);

    // The audit leg, through the production repository: one fee, one event —
    // the second (no-op) execution must not log a second application.
    const audits = await auditRepo.findByEntity(seeded.tenantId, 'invoice', seeded.invoiceId);
    const applied = audits.filter((a) => a.eventType === 'invoice.late_fee_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0].metadata).toMatchObject({
      stepKey: 'initial',
      feeCents: 2500,
      newAmountDueCents: 17500,
    });
  });

  it('T1 — a second tenant fee applies to its own invoice only, and a foreign proposal is refused', async () => {
    const tenantA = await seedInvoice(15000, 'tenant-a');
    const tenantB = await seedInvoice(80000, 'tenant-b');

    expect((await handler.execute(makeProposal(tenantA, 2500), {
      tenantId: tenantA.tenantId,
      executedBy: tenantA.userId,
    })).success).toBe(true);
    expect((await handler.execute(makeProposal(tenantB, 4000), {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    })).success).toBe(true);

    const a = await invoiceRepo.findById(tenantA.tenantId, tenantA.invoiceId);
    const b = await invoiceRepo.findById(tenantB.tenantId, tenantB.invoiceId);
    expect(a!.amountDueCents).toBe(17500);
    expect(b!.amountDueCents).toBe(84000);
    expect(a!.lineItems.filter((li) => li.description === 'Late fee')).toHaveLength(1);
    expect(b!.lineItems.filter((li) => li.description === 'Late fee')).toHaveLength(1);

    // Cross-tenant: tenant B executing a proposal that names tenant A's
    // invoice changes nothing — the tenant-scoped read cannot see the row.
    const foreign = await handler.execute(makeProposal(tenantA, 9900), {
      tenantId: tenantB.tenantId,
      executedBy: tenantB.userId,
    });
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain('not found in this tenant');
    expect((await invoiceRepo.findById(tenantA.tenantId, tenantA.invoiceId))!.amountDueCents).toBe(17500);

    // And each tenant's audit trail holds only its own application.
    const aAudit = await auditRepo.findByEntity(tenantA.tenantId, 'invoice', tenantA.invoiceId);
    expect(aAudit.filter((e) => e.eventType === 'invoice.late_fee_applied')).toHaveLength(1);
    const bAudit = await auditRepo.findByEntity(tenantB.tenantId, 'invoice', tenantB.invoiceId);
    expect(bAudit.filter((e) => e.eventType === 'invoice.late_fee_applied')).toHaveLength(1);
    expect(await auditRepo.findByEntity(tenantB.tenantId, 'invoice', tenantA.invoiceId)).toEqual([]);
  });

  // §8.10's "capped" half. computeLateFeeCents clamps to `lateFeeMaxCents`
  // (invoices/late-fee.ts:66-69) — proven only in unit tests until now. Here
  // the clamp is driven end to end by the real overdue sweep and read back
  // off the PERSISTED invoice row.
  describe('the late-fee cap, end to end at real Postgres', () => {
    it('clamps a fee above the cap on the persisted invoice, and a re-sweep adds no second fee line', async () => {
      const now = new Date('2026-08-20T12:00:00.000Z');
      const seeded = await seedInvoice(100000, 'cap', new Date(now.getTime() - 30 * DAY_MS));

      const proposalRepo = new PgProposalRepository(pool);
      const dunningEventRepo = new PgDunningEventRepository(pool);
      const dunningConfigRepo = new PgDunningConfigRepository(pool);

      // Flat 50.00 fee, capped at 20.00 — the policy the tenant persisted.
      await dunningConfigRepo.upsert({
        ...defaultDunningConfig(seeded.tenantId),
        reminderSteps: [],
        lateFeeType: 'flat',
        lateFeeValueCents: 5000,
        lateFeeGraceDays: 0,
        lateFeeMaxCents: 2000,
      });

      const sweep = () =>
        runOverdueInvoiceSweep({
          jobRepo,
          estimateRepo: new PgEstimateRepository(pool),
          invoiceRepo,
          auditRepo,
          proposalRepo,
          dunningEventRepo,
          dunningConfigRepo,
          listTenantIds: async () => [seeded.tenantId],
          now: () => now,
          logger,
        });

      await sweep();

      // The sweep recorded the CLAMPED amount in the ledger, not the 5000 policy value.
      const ledger = await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId);
      const feeEvents = ledger.filter((e) => e.kind === 'late_fee');
      expect(feeEvents).toHaveLength(1);
      expect(feeEvents[0].amountCents).toBe(2000);

      const raised = (await proposalRepo.findByStatus(seeded.tenantId, 'ready_for_review')).filter(
        (p) => p.proposalType === 'apply_late_fee',
      );
      expect(raised).toHaveLength(1);
      expect(raised[0].payload).toMatchObject({ feeCents: 2000, stepKey: 'initial' });

      // Owner approves → the handler writes the fee. The persisted invoice row
      // is the proof: 1000.00 + the capped 20.00, never 1000.00 + 50.00.
      const applied = await handler.execute(
        { ...raised[0], status: 'approved' } as Proposal,
        { tenantId: seeded.tenantId, executedBy: seeded.userId },
      );
      expect(applied.success).toBe(true);

      const withFee = await invoiceRepo.findById(seeded.tenantId, seeded.invoiceId);
      const feeLines = withFee!.lineItems.filter((li) => li.description === 'Late fee');
      expect(feeLines).toHaveLength(1);
      expect(feeLines[0].totalCents).toBe(2000);
      expect(withFee!.amountDueCents).toBe(102000);

      // A re-sweep sees 2000 already accrued against a 2000 cap → nothing more
      // is due, so no second ledger row and no second proposal…
      await sweep();
      expect(
        (await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId)).filter(
          (e) => e.kind === 'late_fee',
        ),
      ).toHaveLength(1);
      expect(
        (await proposalRepo.findByStatus(seeded.tenantId, 'ready_for_review')).filter(
          (p) => p.proposalType === 'apply_late_fee',
        ),
      ).toHaveLength(1);

      // …and re-executing the approved proposal adds no second fee line.
      expect(
        (await handler.execute({ ...raised[0], status: 'approved' } as Proposal, {
          tenantId: seeded.tenantId,
          executedBy: seeded.userId,
        })).success,
      ).toBe(true);
      const reloaded = await invoiceRepo.findById(seeded.tenantId, seeded.invoiceId);
      expect(reloaded!.lineItems.filter((li) => li.description === 'Late fee')).toHaveLength(1);
      expect(reloaded!.amountDueCents).toBe(102000);

      const audits = await auditRepo.findByEntity(seeded.tenantId, 'invoice', seeded.invoiceId);
      expect(audits.filter((a) => a.eventType === 'invoice.late_fee_applied')).toHaveLength(1);
    });
  });
});
