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
import {
  Proposal,
  ProposalRepository,
  ProposalType,
  createProposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { ExecutionHandler } from '../../src/proposals/execution/handlers';

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

  // H1 — apply_credit calls Stripe (stale link / PI cleanup). Through the REAL
  // executor + PgIdempotencyLockProvider (production wiring) that cleanup must
  // run AFTER the credit committed and released its row lock — never inside
  // the executor's transaction — and the executor's crash-retry must not
  // credit twice.
  describe('through the ProposalExecutor (production lock provider)', () => {
    let proposalRepo: PgProposalRepository;
    let executionRepo: PgProposalExecutionRepository;

    beforeAll(() => {
      proposalRepo = new PgProposalRepository(pool);
      executionRepo = new PgProposalExecutionRepository(pool);
    });

    /** What a Stripe call observed about the invoice row, from a SEPARATE connection. */
    interface StripeCallObservation {
      committedTotalCents: number;
      rowLockedByAnotherTx: boolean;
    }

    async function observeInvoiceRow(tenantId: string, invoiceId: string): Promise<StripeCallObservation> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        const { rows } = await client.query<{ total_cents: string }>(
          'SELECT total_cents FROM invoices WHERE id = $1 AND tenant_id = $2',
          [invoiceId, tenantId],
        );
        let rowLockedByAnotherTx = false;
        try {
          await client.query('SAVEPOINT probe_lock');
          await client.query('SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE NOWAIT', [
            invoiceId,
            tenantId,
          ]);
        } catch (err) {
          if ((err as { code?: string }).code !== '55P03') throw err;
          rowLockedByAnotherTx = true;
          await client.query('ROLLBACK TO SAVEPOINT probe_lock');
        }
        return { committedTotalCents: Number(rows[0].total_cents), rowLockedByAnotherTx };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }

    function probingStripeProvider(tenantId: string, invoiceId: string) {
      const observations: StripeCallObservation[] = [];
      const provider = {
        generateLink: async () => {
          throw new Error('not used');
        },
        deactivateLink: async () => {
          observations.push(await observeInvoiceRow(tenantId, invoiceId));
        },
        listInvoicePaymentIntents: async () => {
          observations.push(await observeInvoiceRow(tenantId, invoiceId));
          return [];
        },
        cancelPaymentIntent: async () => undefined,
      };
      return { provider, observations };
    }

    async function approvedCreditProposal(seeded: Seeded, amountCents: number): Promise<Proposal> {
      let proposal = createProposal({
        tenantId: seeded.tenantId,
        proposalType: 'apply_credit',
        payload: { invoiceId: seeded.invoiceId, amountCents },
        summary: 'Apply credit (executor path)',
        createdBy: seeded.userId,
        idempotencyKey: `apply-credit-h1-${uuidv4()}`,
      });
      proposal = transitionProposal(proposal, 'ready_for_review', 'test');
      proposal = transitionProposal(proposal, 'approved', 'test');
      // Past the undo window so the executor runs immediately.
      proposal = { ...proposal, approvedAt: new Date(Date.now() - 10_000) };
      return proposalRepo.create(proposal);
    }

    function executorWith(handler: ExecutionHandler, repo: ProposalRepository = proposalRepo): ProposalExecutor {
      const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
      return new ProposalExecutor(
        new Map<ProposalType, ExecutionHandler>([['apply_credit', handler]]),
        repo,
        guard,
        auditRepo,
        { executionRepo },
      );
    }

    async function seedWithStoredLink(amountCents: number): Promise<Seeded> {
      const seeded = await seedOpenInvoice(amountCents);
      await readRepo.update(seeded.tenantId, seeded.invoiceId, {
        stripePaymentLinkId: 'plink_old_balance',
        stripePaymentLinkUrl: 'https://buy.stripe.test/plink_old_balance',
      });
      return seeded;
    }

    it('runs the Stripe cleanup only after the credit committed and released the invoice row lock', async () => {
      const seeded = await seedWithStoredLink(30000);
      const { provider, observations } = probingStripeProvider(seeded.tenantId, seeded.invoiceId);
      const handler = new ApplyCreditExecutionHandler(readRepo, auditRepo, undefined, { provider });
      const proposal = await approvedCreditProposal(seeded, 5000);

      const { proposal: after } = await executorWith(handler).execute(proposal, {
        tenantId: seeded.tenantId,
        executedBy: seeded.userId,
      });

      expect(after.status).toBe('executed');
      expect(observations.length).toBeGreaterThan(0);
      for (const seen of observations) {
        // Inside the executor's transaction a separate connection would still
        // read 30000 and find the row locked for the whole Stripe round trip.
        expect(seen).toEqual({ committedTotalCents: 25000, rowLockedByAnotherTx: false });
      }
    });

    it('a crash after the credit committed but before the idempotency marker does not credit twice on retry', async () => {
      const seeded = await seedOpenInvoice(30000);
      const handler = new ApplyCreditExecutionHandler(readRepo, auditRepo);
      let failStatusWrite = true;
      const flakyProposalRepo = new Proxy(proposalRepo, {
        get(target, prop, receiver) {
          if (prop === 'updateStatus' && failStatusWrite) {
            return async () => {
              throw new Error('injected updateStatus failure (crash after commit)');
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ProposalRepository;
      const executor = executorWith(handler, flakyProposalRepo);
      const proposal = await approvedCreditProposal(seeded, 5000);
      const ctx = { tenantId: seeded.tenantId, executedBy: seeded.userId };

      await expect(executor.execute(proposal, ctx)).rejects.toThrow(/crash after commit/);

      failStatusWrite = false;
      const reloaded = (await proposalRepo.findById(seeded.tenantId, proposal.id)) ?? proposal;
      const { proposal: after } = await executor.execute(
        { ...reloaded, approvedAt: new Date(Date.now() - 10_000) },
        ctx,
      );

      expect(after.status).toBe('executed');
      const row = await readRepo.findById(seeded.tenantId, seeded.invoiceId);
      expect(row!.lineItems.map((li) => li.totalCents)).toEqual([30000, -5000]);
      expect(row!.totals.totalCents).toBe(25000);
      expect(row!.amountDueCents).toBe(25000);
    });
  });
});
