/**
 * P0-2 — the server never persists a client-computed line total.
 *
 * The web write path computes money in float dollars (`rate = cents / 100`,
 * `round(qty * rate * 100)`), which diverges from the server formula
 * (`round(qty * unitPriceCents)`) by one cent on fractional quantities. The
 * table below is the empirically confirmed divergence set from the money
 * extraction findings; these tests pin that the REST create/update paths for
 * invoices AND estimates discard the client's number and recompute.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeLineItemTotals,
  calculateLineItemTotal,
  LineItem,
} from '../../src/shared/billing-engine';
import {
  createInvoice,
  updateInvoice,
  InMemoryInvoiceRepository,
} from '../../src/invoices/invoice';
import {
  createEstimate,
  updateEstimate,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';

/** A line as the float-dollar web client would send it (wrong totalCents). */
function clientLine(
  id: string,
  quantity: number,
  unitPriceCents: number,
  clientTotalCents: number,
): LineItem {
  return {
    id,
    description: `Line ${id}`,
    quantity,
    unitPriceCents,
    totalCents: clientTotalCents,
    sortOrder: 0,
    taxable: true,
  };
}

// unitPriceCents / qty / server round(q*upc) / client round(q*(upc/100)*100)
const DIVERGENT_CASES: Array<[number, number, number, number]> = [
  [29, 0.5, 15, 14],
  [45, 0.7, 31, 32],
  [9, 2.5, 23, 22],
];

describe('P0-2 — normalizeLineItemTotals', () => {
  it('recomputes each divergent case to the server formula', () => {
    for (const [unitPriceCents, quantity, serverTotal, clientTotal] of DIVERGENT_CASES) {
      expect(calculateLineItemTotal(quantity, unitPriceCents)).toBe(serverTotal);
      const [normalized] = normalizeLineItemTotals([
        clientLine('1', quantity, unitPriceCents, clientTotal),
      ]);
      expect(normalized.totalCents).toBe(serverTotal);
    }
  });

  it('is idempotent on already-correct lines and preserves other fields', () => {
    const line: LineItem = {
      ...clientLine('1', 2, 5000, 10000),
      pricingSource: 'catalog',
      groupKey: 'tier',
      taxable: false,
    };
    const [normalized] = normalizeLineItemTotals([line]);
    expect(normalized).toEqual(line);
  });
});

describe('P0-2 — invoice REST paths recompute line totals', () => {
  it('createInvoice persists the server total, not the client total', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: 't1',
        jobId: 'j1',
        invoiceNumber: 'INV-P02',
        // Client says 14¢ (float path); the truth is 15¢.
        lineItems: [clientLine('1', 0.5, 29, 14)],
        createdBy: 'u1',
      },
      repo,
    );
    expect(invoice.lineItems[0].totalCents).toBe(15);
    expect(invoice.totals.subtotalCents).toBe(15);
    expect(invoice.totals.totalCents).toBe(15);
    expect(invoice.amountDueCents).toBe(15);
  });

  it('updateInvoice recomputes replaced lines', async () => {
    const repo = new InMemoryInvoiceRepository();
    const invoice = await createInvoice(
      {
        tenantId: 't1',
        jobId: 'j1',
        invoiceNumber: 'INV-P02b',
        lineItems: [clientLine('1', 1, 1000, 1000)],
        createdBy: 'u1',
      },
      repo,
    );
    const updated = await updateInvoice(
      't1',
      invoice.id,
      { lineItems: [clientLine('2', 0.7, 45, 32)] }, // truth: 31
      repo,
    );
    expect(updated!.lineItems[0].totalCents).toBe(31);
    expect(updated!.totals.totalCents).toBe(31);
  });
});

describe('P0-2 — estimate REST paths recompute line totals', () => {
  it('createEstimate persists the server total, not the client total', async () => {
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate(
      {
        tenantId: 't1',
        jobId: 'j1',
        estimateNumber: 'EST-P02',
        lineItems: [clientLine('1', 2.5, 9, 22)], // truth: 23
        createdBy: 'u1',
      },
      repo,
    );
    expect(estimate.lineItems[0].totalCents).toBe(23);
    expect(estimate.totals.subtotalCents).toBe(23);
  });

  it('updateEstimate recomputes replaced lines', async () => {
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate(
      {
        tenantId: 't1',
        jobId: 'j1',
        estimateNumber: 'EST-P02b',
        lineItems: [clientLine('1', 1, 1000, 1000)],
        createdBy: 'u1',
      },
      repo,
    );
    const updated = await updateEstimate(
      't1',
      estimate.id,
      { lineItems: [clientLine('2', 0.5, 29, 14)], expectedVersion: 1 }, // truth: 15
      repo,
    );
    expect(updated!.lineItems[0].totalCents).toBe(15);
    expect(updated!.totals.subtotalCents).toBe(15);
  });
});

describe('R5 — metadata-only updates never rewrite persisted line totals', () => {
  it('an estimate customerMessage edit leaves legacy line totals untouched', async () => {
    const repo = new InMemoryEstimateRepository();
    const estimate = await createEstimate(
      {
        tenantId: 't1',
        jobId: 'j1',
        estimateNumber: 'EST-R5',
        lineItems: [clientLine('1', 1, 1000, 1000)],
        createdBy: 'u1',
      },
      repo,
    );
    // Simulate a legacy pre-fix row whose persisted total is the client's
    // wrong number (0.5 × 29¢ stored as 14¢).
    await repo.update('t1', estimate.id, {
      lineItems: [clientLine('legacy', 0.5, 29, 14)],
    });

    const updated = await updateEstimate(
      't1',
      estimate.id,
      { customerMessage: 'See you Tuesday', expectedVersion: 1 },
      repo,
    );

    // The customer-visible total must not shift under a metadata edit.
    expect(updated!.lineItems[0].totalCents).toBe(14);
  });
});
