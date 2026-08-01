/**
 * Unit tests for the reversal-side atomic invoice mutation
 * `InvoiceRepository.decrementAmountPaidAtomic` (the InMemory impl mirrors the
 * Pg single-UPDATE compare-and-derive; the real-Postgres arithmetic is pinned by
 * test/integration/payment-reversal-concurrent.test.ts).
 *
 * The method backs out a reversed payment's credit: it clamps paid at 0, derives
 * amount_due from the row's OWN current paid value (never a caller snapshot), and
 * recomputes the reopened status — 'open' (nothing left paid), 'paid' (still
 * fully covered), else 'partially_paid'. It is guarded to REOPENABLE statuses, so
 * a terminal invoice is left untouched (null).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryInvoiceRepository,
  Invoice,
  InvoiceStatus,
  isValidInvoiceTransition,
} from '../../src/invoices/invoice';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 'tenant-dec-1';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const totalCents = overrides.totals?.totalCents ?? 10000;
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: 'inv-dec-1',
    tenantId: TENANT,
    jobId: 'job-dec-1',
    invoiceNumber: 'INV-DEC-1',
    status: 'paid',
    lineItems,
    totals,
    amountPaidCents: totalCents,
    amountDueCents: 0,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('decrementAmountPaidAtomic (InMemory)', () => {
  let repo: InMemoryInvoiceRepository;

  beforeEach(() => {
    repo = new InMemoryInvoiceRepository();
  });

  it('full reversal (entire balance backed out) → paid 0, due full, status open', async () => {
    await repo.create(makeInvoice({ status: 'paid', amountPaidCents: 10000, amountDueCents: 0 }));
    const updated = await repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 10000, new Date());
    expect(updated).not.toBeNull();
    expect(updated!.amountPaidCents).toBe(0);
    expect(updated!.amountDueCents).toBe(10000);
    expect(updated!.status).toBe('open');
    expect(isValidInvoiceTransition('paid', updated!.status)).toBe(true);
  });

  it('partial reversal (one of two payments) → still some paid, status partially_paid', async () => {
    await repo.create(makeInvoice({ status: 'paid', amountPaidCents: 10000, amountDueCents: 0 }));
    // Back out 4000 of a 10000 total → 6000 paid, 4000 due.
    const updated = await repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 4000, new Date());
    expect(updated!.amountPaidCents).toBe(6000);
    expect(updated!.amountDueCents).toBe(4000);
    expect(updated!.status).toBe('partially_paid');
    expect(isValidInvoiceTransition('paid', updated!.status)).toBe(true);
  });

  it('reversal larger than the recorded paid amount clamps paid at 0 (never negative)', async () => {
    await repo.create(
      makeInvoice({ status: 'partially_paid', amountPaidCents: 3000, amountDueCents: 7000 }),
    );
    const updated = await repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 5000, new Date());
    expect(updated!.amountPaidCents).toBe(0);
    expect(updated!.amountDueCents).toBe(10000);
    expect(updated!.status).toBe('open');
  });

  it('reversal that still leaves the invoice fully covered keeps status paid', async () => {
    // total 10000, paid 12000 (overpay edge), reverse 1000 → 11000 paid, still >= total.
    await repo.create(makeInvoice({ status: 'paid', amountPaidCents: 12000, amountDueCents: 0 }));
    const updated = await repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 1000, new Date());
    expect(updated!.amountPaidCents).toBe(11000);
    expect(updated!.amountDueCents).toBe(0);
    expect(updated!.status).toBe('paid');
  });

  it('every derived reopen transition is permitted by the status-transition map', async () => {
    const cases: Array<{ from: InvoiceStatus; delta: number; paid: number }> = [
      { from: 'paid', delta: 10000, paid: 10000 }, // -> open
      { from: 'paid', delta: 4000, paid: 10000 }, // -> partially_paid
      { from: 'partially_paid', delta: 6000, paid: 6000 }, // -> open
    ];
    for (const c of cases) {
      const r = new InMemoryInvoiceRepository();
      await r.create(
        makeInvoice({ id: 'x', status: c.from, amountPaidCents: c.paid, amountDueCents: 10000 - c.paid }),
      );
      const updated = await r.decrementAmountPaidAtomic(TENANT, 'x', c.delta, new Date());
      expect(updated).not.toBeNull();
      if (updated!.status !== c.from) {
        expect(isValidInvoiceTransition(c.from, updated!.status)).toBe(true);
      }
    }
  });

  it('leaves a terminal (void) invoice untouched → returns null', async () => {
    await repo.create(makeInvoice({ status: 'void', amountPaidCents: 6000, amountDueCents: 4000 }));
    const updated = await repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 6000, new Date());
    expect(updated).toBeNull();
    const reloaded = await repo.findById(TENANT, 'inv-dec-1');
    expect(reloaded!.status).toBe('void');
    expect(reloaded!.amountPaidCents).toBe(6000); // unchanged
  });

  it('returns null for a missing row and for a cross-tenant row', async () => {
    await repo.create(makeInvoice({ status: 'paid', amountPaidCents: 10000, amountDueCents: 0 }));
    expect(await repo.decrementAmountPaidAtomic(TENANT, 'nope', 100, new Date())).toBeNull();
    expect(await repo.decrementAmountPaidAtomic('other', 'inv-dec-1', 100, new Date())).toBeNull();
  });

  it('two concurrent decrements both apply (no lost update)', async () => {
    await repo.create(makeInvoice({ status: 'paid', amountPaidCents: 10000, amountDueCents: 0 }));
    await Promise.all([
      repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 3000, new Date()),
      repo.decrementAmountPaidAtomic(TENANT, 'inv-dec-1', 2000, new Date()),
    ]);
    const reloaded = await repo.findById(TENANT, 'inv-dec-1');
    // 10000 - 3000 - 2000 = 5000 (a lost update would leave 7000 or 8000).
    expect(reloaded!.amountPaidCents).toBe(5000);
    expect(reloaded!.amountDueCents).toBe(5000);
    expect(reloaded!.status).toBe('partially_paid');
  });
});
