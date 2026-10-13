/**
 * #10 — apply_credit / apply_late_fee against REAL Postgres, under a
 * deterministic lost-update interleave.
 *
 * Both handlers read the invoice, compute the adjusted balance, then write.
 * A Stripe webhook payment (incrementAmountPaidAtomic, its own committed
 * transaction) can land between that read and that write. The write must
 * therefore derive amount_due from the row's LIVE amount_paid inside one
 * guarded UPDATE — an absolute amount_due computed from the snapshot leaves
 * the row inconsistent (paid > 0 yet amount_due still the pre-payment
 * figure). The InMemory repo cannot prove the SQL, so this pins it.
 *
 * The interleave is injected at the repository seam: the subclass serves the
 * handler its snapshot, then commits the concurrent mutation through the real
 * repo before returning.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { Invoice } from '../../src/invoices/invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { ApplyCreditExecutionHandler } from '../../src/proposals/execution/apply-credit-handler';
import {
  ApplyLateFeeExecutionHandler,
  lateFeeLineId,
} from '../../src/proposals/execution/apply-late-fee-handler';
import { Proposal } from '../../src/proposals/proposal';

type ConcurrentMutation = (repo: PgInvoiceRepository, tenantId: string, id: string) => Promise<void>;

/** Commits `pending` through the real repo right after serving the snapshot. */
class InterleavingInvoiceRepository extends PgInvoiceRepository {
  private pending: ConcurrentMutation | null = null;

  arm(mutation: ConcurrentMutation): void {
    this.pending = mutation;
  }

  async findById(tenantId: string, id: string): Promise<Invoice | null> {
    const snapshot = await super.findById(tenantId, id);
    if (snapshot && this.pending) {
      const mutation = this.pending;
      this.pending = null;
      await mutation(this, tenantId, id);
    }
    return snapshot;
  }
}

const concurrentPayment =
  (cents: number): ConcurrentMutation =>
  async (repo, tenantId, id) => {
    const paid = await repo.incrementAmountPaidAtomic(tenantId, id, cents, new Date());
    expect(paid).not.toBeNull();
  };

interface Seeded {
  tenantId: string;
  userId: string;
  invoiceId: string;
}

describe('Postgres integration — apply_credit / apply_late_fee are atomic against a concurrent payment', () => {
  let pool: Pool;
  let invoiceRepo: InterleavingInvoiceRepository;
  let readRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;

  async function seedOpenInvoice(amountCents: number): Promise<Seeded> {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Race',
      lastName: 'Window',
      displayName: 'Race Window',
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
      street1: '1 Race St',
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
      jobNumber: `JOB-RACE-${jobId.slice(0, 8)}`,
      summary: 'Race window job',
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const invoiceId = uuidv4();
    const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, amountCents, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await readRepo.create({
      id: invoiceId,
      tenantId,
      jobId,
      invoiceNumber: `INV-RACE-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenantId, userId, invoiceId };
  }

  function creditProposal(seeded: Seeded, amountCents: number): Proposal {
    return {
      id: uuidv4(),
      tenantId: seeded.tenantId,
      proposalType: 'apply_credit',
      status: 'approved',
      payload: { invoiceId: seeded.invoiceId, amountCents },
      summary: 'Apply credit',
      createdBy: seeded.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new InterleavingInvoiceRepository(pool);
    readRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('apply_credit: a payment committing mid-execution is not lost — amount_due = new total − LIVE paid', async () => {
    const seeded = await seedOpenInvoice(30000);
    invoiceRepo.arm(concurrentPayment(10000));
    const handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(creditProposal(seeded, 5000), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });

    expect(result.success).toBe(true);
    const row = await readRepo.findById(seeded.tenantId, seeded.invoiceId);
    expect(row!.totals.totalCents).toBe(25000);
    expect(row!.totals.subtotalCents).toBe(25000);
    expect(row!.amountPaidCents).toBe(10000);
    expect(row!.amountDueCents).toBe(15000);
    expect(row!.status).toBe('partially_paid');
    expect(row!.lineItems.map((li) => li.totalCents)).toEqual([30000, -5000]);
  });

  it('apply_late_fee: a payment committing mid-execution is not lost — amount_due = new total − LIVE paid', async () => {
    const seeded = await seedOpenInvoice(15000);
    invoiceRepo.arm(concurrentPayment(5000));
    const handler = new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(
      {
        ...creditProposal(seeded, 0),
        proposalType: 'apply_late_fee',
        payload: { invoiceId: seeded.invoiceId, feeCents: 2500, stepKey: 'initial' },
      },
      { tenantId: seeded.tenantId, executedBy: seeded.userId },
    );

    expect(result.success).toBe(true);
    const row = await readRepo.findById(seeded.tenantId, seeded.invoiceId);
    expect(row!.totals.totalCents).toBe(17500);
    expect(row!.totals.subtotalCents).toBe(17500);
    expect(row!.amountPaidCents).toBe(5000);
    expect(row!.amountDueCents).toBe(12500);
    expect(row!.status).toBe('partially_paid');
    // The deterministic fee-line id survives the atomic insert (idempotency).
    expect(row!.lineItems.map((li) => li.id)).toContain(lateFeeLineId(seeded.invoiceId, 'initial'));
  });

  it('apply_credit: a payment shrinking the LIVE due below the credit mid-execution refuses it (paid never exceeds total)', async () => {
    const seeded = await seedOpenInvoice(30000);
    invoiceRepo.arm(concurrentPayment(28000)); // live due drops to 2000
    const handler = new ApplyCreditExecutionHandler(invoiceRepo, auditRepo);

    const result = await handler.execute(creditProposal(seeded, 5000), {
      tenantId: seeded.tenantId,
      executedBy: seeded.userId,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds amount due/i);
    const row = await readRepo.findById(seeded.tenantId, seeded.invoiceId);
    expect(row!.totals.totalCents).toBe(30000);
    expect(row!.amountPaidCents).toBe(28000);
    expect(row!.amountDueCents).toBe(2000);
    expect(row!.lineItems).toHaveLength(1);
  });

  it.each([
    ['apply_credit', () => new ApplyCreditExecutionHandler(invoiceRepo, auditRepo), { amountCents: 5000 }],
    [
      'apply_late_fee',
      () => new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo),
      { feeCents: 2500, stepKey: 'initial' },
    ],
  ] as const)(
    '%s: a void committing mid-execution refuses the adjustment — the dead invoice is not re-priced',
    async (proposalType, makeHandler, payload) => {
      const seeded = await seedOpenInvoice(30000);
      invoiceRepo.arm(async (repo, tenantId, id) => {
        await repo.update(tenantId, id, { status: 'void', updatedAt: new Date() });
      });

      const result = await makeHandler().execute(
        {
          ...creditProposal(seeded, 0),
          proposalType,
          payload: { invoiceId: seeded.invoiceId, ...payload },
        },
        { tenantId: seeded.tenantId, executedBy: seeded.userId },
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/void/);
      const row = await readRepo.findById(seeded.tenantId, seeded.invoiceId);
      expect(row!.status).toBe('void');
      expect(row!.totals.totalCents).toBe(30000);
      expect(row!.amountDueCents).toBe(30000);
      expect(row!.lineItems).toHaveLength(1);
    },
  );
});
