/**
 * InvoiceRepository.applyNonTaxableAdjustmentAtomic — InMemory contract
 * (the Pg twin is pinned in test/integration/invoice-adjustment-atomic).
 *
 * The InMemory repo is the fake every handler unit test runs on, so it must
 * refuse exactly what Postgres refuses:
 *   - a TAXABLE line (review L2): the write moves subtotal/total but never
 *     the taxable subtotal or tax, so a taxable line would silently leave
 *     tax stale — a programming error, refused before any write;
 *   - a line id already on an invoice (review L5): invoice_line_items.id is a
 *     global primary key, so Pg raises 23505 and rolls the adjustment back.
 *     A fake that double-appends instead would hide the concurrent duplicate
 *     late-fee path from every unit test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 't-adj';
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeInvoice(): Invoice {
  const lineItems = [buildLineItem('li-1', 'Labor', 1, 10000, 0, true, 'labor')];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-adj',
    invoiceNumber: 'INV-ADJ',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('InMemoryInvoiceRepository.applyNonTaxableAdjustmentAtomic', () => {
  let repo: InMemoryInvoiceRepository;

  beforeEach(async () => {
    repo = new InMemoryInvoiceRepository();
    await repo.create(makeInvoice());
  });

  it('refuses a taxable line before writing anything (tax would silently go stale)', async () => {
    const taxable = buildLineItem('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Fee', 1, 500, 1, true, 'other');

    await expect(repo.applyNonTaxableAdjustmentAtomic(TENANT, INVOICE_ID, taxable, new Date())).rejects.toThrow(
      /non-taxable/,
    );
    const row = await repo.findById(TENANT, INVOICE_ID);
    expect(row!.lineItems).toHaveLength(1);
    expect(row!.totals.totalCents).toBe(10000);
  });

  it('refuses a line id that already exists, like the Pg primary key (23505), leaving the invoice untouched', async () => {
    const fee = buildLineItem('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Late fee', 1, 2500, 1, false, 'other');
    await repo.applyNonTaxableAdjustmentAtomic(TENANT, INVOICE_ID, fee, new Date());

    await expect(repo.applyNonTaxableAdjustmentAtomic(TENANT, INVOICE_ID, fee, new Date())).rejects.toMatchObject({
      code: '23505',
    });
    const row = await repo.findById(TENANT, INVOICE_ID);
    expect(row!.lineItems.map((li) => li.totalCents)).toEqual([10000, 2500]);
    expect(row!.totals.totalCents).toBe(12500);
  });
});
