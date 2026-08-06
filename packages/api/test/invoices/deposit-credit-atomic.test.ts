import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { applyDepositCreditToInvoice } from '../../src/invoices/deposit-credit';
import {
  Invoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';

const TENANT = 'tenant-deposit-credit-atomic';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: uuidv4(),
    locationId: uuidv4(),
    jobNumber: 'JOB-0099',
    summary: 'Water heater replacement',
    status: 'completed',
    priority: 'normal',
    depositRequiredCents: 25000,
    depositPaidCents: 25000,
    depositStatus: 'paid',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInvoice(jobId: string, totalCents: number, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    invoiceNumber: 'INV-0001',
    status: 'draft',
    lineItems: [
      {
        id: uuidv4(),
        description: 'Service',
        quantity: 1,
        unitPriceCents: totalCents,
        totalCents,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: {
      subtotalCents: totalCents,
      taxableSubtotalCents: totalCents,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents,
    },
    amountPaidCents: 0,
    amountDueCents: totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Track-5 — applyDepositCreditToInvoice was the LAST read-modify-write
 * writer of the invoice balance columns: it computed newAmountPaid from the
 * caller's earlier in-call snapshot and wrote it absolutely via the generic
 * update(), so a concurrent credit landing via incrementAmountPaidAtomic was
 * silently overwritten (lost update — the invoice under-credits the customer
 * and amount_paid falls below the active payment-ledger sum), and it bypassed
 * the payable-status / balance-cap predicates P0-3/P0-6 put in SQL. These
 * tests pin the atomic guarded replacement.
 */
describe('applyDepositCreditToInvoice — atomic guarded increment (Track-5)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let jobRepo: InMemoryJobRepository;

  beforeEach(() => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    jobRepo = new InMemoryJobRepository();
  });

  it('does NOT overwrite a concurrent atomic credit landing between the read and the write (no lost update)', async () => {
    const job = makeJob(); // deposit 25000
    await jobRepo.create(job);
    // Issued invoice: the interleave window is real for any status the
    // concurrent-credit path (incrementAmountPaidAtomic) accepts.
    const invoice = makeInvoice(job.id, 100000, { status: 'open' });
    await invoiceRepo.create(invoice);

    // `invoice` above IS the deposit-credit path's earlier in-call read.
    // A concurrent payment credit lands AFTER that read, BEFORE the write:
    const raced = await invoiceRepo.incrementAmountPaidAtomic(
      TENANT,
      invoice.id,
      30000,
      new Date(),
    );
    expect(raced?.amountPaidCents).toBe(30000);

    // Old behavior: wrote snapshot(0) + 25000 = 25000 absolutely, silently
    // dropping the 30000. Both credits must survive.
    const result = await applyDepositCreditToInvoice(
      invoice,
      job,
      invoiceRepo,
      paymentRepo,
      jobRepo,
    );

    expect(result?.creditCents).toBe(25000);
    expect(result?.invoice.amountPaidCents).toBe(55000); // 30000 + 25000
    expect(result?.invoice.amountDueCents).toBe(45000);
    expect(result?.invoice.status).toBe('partially_paid');

    const reloaded = await invoiceRepo.findById(TENANT, invoice.id);
    expect(reloaded?.amountPaidCents).toBe(55000);

    // amount_paid never falls below Σ(active payments): the deposit row is
    // completed and the concurrent 30000 is reflected in the balance.
    const payments = await paymentRepo.findByInvoice(TENANT, invoice.id);
    const activeSum = payments
      .filter((p) => p.status === 'completed' && !p.reversedAt)
      .reduce((sum, p) => sum + p.amountCents, 0);
    expect(reloaded!.amountPaidCents).toBeGreaterThanOrEqual(activeSum);
  });

  it('rejects + compensates when the invoice left the creditable set (canceled draft) — balance never moves', async () => {
    const job = makeJob();
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 100000); // snapshot reads 'draft'
    await invoiceRepo.create(invoice);
    // Operator cancels the draft after the snapshot read, before the write.
    await invoiceRepo.update(TENANT, invoice.id, { status: 'canceled', updatedAt: new Date() });

    await expect(
      applyDepositCreditToInvoice(invoice, job, invoiceRepo, paymentRepo, jobRepo),
    ).rejects.toThrow(/deposit credit .* rejected/i);

    // The dead invoice took no money.
    const reloaded = await invoiceRepo.findById(TENANT, invoice.id);
    expect(reloaded?.status).toBe('canceled');
    expect(reloaded?.amountPaidCents).toBe(0);
    expect(reloaded?.amountDueCents).toBe(100000);

    // The already-inserted deposit payment row is compensated, not orphaned
    // (mirrors recordPayment's credit-rejection path).
    const payments = await paymentRepo.findByInvoice(TENANT, invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('credit_rejected');
    expect(payments[0].reversedAt).toBeTruthy();

    // With the payment row inert, the deposit is released back to the job so
    // it can be credited to a live invoice instead of consumed by a dead one.
    const after = await jobRepo.findById(TENANT, job.id);
    expect(after?.depositCreditedToInvoiceId).toBeFalsy();
  });

  it('rejects + compensates when the credit no longer fits the remaining balance — never writes paid > total', async () => {
    const job = makeJob(); // deposit 25000
    await jobRepo.create(job);
    const invoice = makeInvoice(job.id, 30000, { status: 'open' });
    await invoiceRepo.create(invoice);

    // A concurrent 10000 payment shrinks the remaining balance to 20000 —
    // the 25000 credit no longer fits.
    await invoiceRepo.incrementAmountPaidAtomic(TENANT, invoice.id, 10000, new Date());

    await expect(
      applyDepositCreditToInvoice(invoice, job, invoiceRepo, paymentRepo, jobRepo),
    ).rejects.toThrow(/deposit credit .* rejected/i);

    const reloaded = await invoiceRepo.findById(TENANT, invoice.id);
    // Never 35000 (over-total) and never the old absolute-write's 25000
    // (which silently dropped the concurrent 10000).
    expect(reloaded?.amountPaidCents).toBe(10000);
    expect(reloaded!.amountPaidCents).toBeLessThanOrEqual(reloaded!.totals.totalCents);

    // Compensated deposit row: it contributes NOTHING to the active paid
    // ledger (the concurrent 10000 was applied via the repo method directly,
    // so the deposit row is the only ledger entry here), and the balance
    // never falls below Σ(active payments).
    const payments = await paymentRepo.findByInvoice(TENANT, invoice.id);
    const deposit = payments.find((p) => p.providerReference === 'deposit_credit');
    expect(deposit?.status).toBe('failed');
    expect(deposit?.reversalReason).toBe('credit_rejected');
    const activeSum = payments
      .filter((p) => p.status === 'completed' && !p.reversedAt)
      .reduce((sum, p) => sum + p.amountCents, 0);
    expect(activeSum).toBe(0);
    expect(reloaded!.amountPaidCents).toBeGreaterThanOrEqual(activeSum);

    // Deposit released for manual application / a valid invoice.
    const after = await jobRepo.findById(TENANT, job.id);
    expect(after?.depositCreditedToInvoiceId).toBeFalsy();
  });
});

describe('InMemoryInvoiceRepository.applyDepositCreditAtomic — mirrors the Pg guarded UPDATE', () => {
  let repo: InMemoryInvoiceRepository;

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
  });

  it('credits a draft and PRESERVES draft status on a partial credit (operator still issues)', async () => {
    const invoice = makeInvoice(uuidv4(), 100000);
    await repo.create(invoice);

    const updated = await repo.applyDepositCreditAtomic(TENANT, invoice.id, 25000, new Date());

    expect(updated?.amountPaidCents).toBe(25000);
    expect(updated?.amountDueCents).toBe(75000);
    expect(updated?.status).toBe('draft');
  });

  it('a FULL credit on a draft stays draft (issuing remains an explicit step)', async () => {
    const invoice = makeInvoice(uuidv4(), 25000);
    await repo.create(invoice);

    const updated = await repo.applyDepositCreditAtomic(TENANT, invoice.id, 25000, new Date());

    expect(updated?.amountPaidCents).toBe(25000);
    expect(updated?.amountDueCents).toBe(0);
    expect(updated?.status).toBe('draft');
  });

  it('a credit on an issued invoice follows payment semantics (partial → partially_paid, full → paid)', async () => {
    const partial = makeInvoice(uuidv4(), 100000, { status: 'open' });
    await repo.create(partial);
    const p = await repo.applyDepositCreditAtomic(TENANT, partial.id, 25000, new Date());
    expect(p?.status).toBe('partially_paid');
    expect(p?.amountDueCents).toBe(75000);

    const full = makeInvoice(uuidv4(), 25000, { status: 'open' });
    await repo.create(full);
    const f = await repo.applyDepositCreditAtomic(TENANT, full.id, 25000, new Date());
    expect(f?.status).toBe('paid');
    expect(f?.amountDueCents).toBe(0);
  });

  it('returns null for non-creditable statuses and leaves the row untouched', async () => {
    for (const status of ['paid', 'void', 'canceled'] as const) {
      const invoice = makeInvoice(uuidv4(), 50000, { status });
      await repo.create(invoice);

      const result = await repo.applyDepositCreditAtomic(TENANT, invoice.id, 10000, new Date());

      expect(result).toBeNull();
      const reloaded = await repo.findById(TENANT, invoice.id);
      expect(reloaded?.status).toBe(status);
      expect(reloaded?.amountPaidCents).toBe(0);
    }
  });

  it('returns null when the credit would exceed the total (balance cap)', async () => {
    const invoice = makeInvoice(uuidv4(), 30000, {
      status: 'partially_paid',
      amountPaidCents: 10000,
      amountDueCents: 20000,
    });
    await repo.create(invoice);

    const result = await repo.applyDepositCreditAtomic(TENANT, invoice.id, 25000, new Date());

    expect(result).toBeNull();
    const reloaded = await repo.findById(TENANT, invoice.id);
    expect(reloaded?.amountPaidCents).toBe(10000);
  });

  it('returns null for a missing invoice or wrong tenant', async () => {
    const invoice = makeInvoice(uuidv4(), 30000);
    await repo.create(invoice);

    expect(await repo.applyDepositCreditAtomic(TENANT, uuidv4(), 1000, new Date())).toBeNull();
    expect(
      await repo.applyDepositCreditAtomic('other-tenant', invoice.id, 1000, new Date()),
    ).toBeNull();
  });
});
