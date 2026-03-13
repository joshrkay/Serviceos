import {
  computeInvoiceDeltas,
  summarizeInvoiceDeltas,
  createInvoiceEditDelta,
  InMemoryInvoiceEditDeltaRepository,
} from '../../../src/ai/evaluation/invoice-edit-delta';
import { buildLineItem } from '../../../src/shared/billing-engine';

describe('P5-008 — Structured invoice edit deltas', () => {
  let repo: InMemoryInvoiceEditDeltaRepository;

  const tenantId = 'tenant-1';
  const invoiceId = 'inv-1';

  beforeEach(() => {
    repo = new InMemoryInvoiceEditDeltaRepository();
  });

  it('happy path — detects added, removed, and changed line items', () => {
    const oldSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Plumbing repair', 1, 5000, 1, true),
        buildLineItem('li-2', 'Parts', 2, 1500, 2, true),
      ],
    };
    const newSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Plumbing repair updated', 1, 5000, 1, true),
        buildLineItem('li-3', 'New service', 1, 3000, 3, true),
      ],
    };

    const deltas = computeInvoiceDeltas(oldSnapshot, newSnapshot);

    const added = deltas.filter((d) => d.type === 'line_item_added');
    const removed = deltas.filter((d) => d.type === 'line_item_removed');
    const descChanged = deltas.filter((d) => d.type === 'description_changed');

    expect(added).toHaveLength(1);
    expect(added[0].lineItemId).toBe('li-3');
    expect(removed).toHaveLength(1);
    expect(removed[0].lineItemId).toBe('li-2');
    expect(descChanged).toHaveLength(1);
    expect(descChanged[0].lineItemId).toBe('li-1');
  });

  it('detects description, quantity, and price changes', () => {
    const oldSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Service A', 2, 5000, 1, true),
      ],
    };
    const newSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Service B', 3, 6000, 1, true),
      ],
    };

    const deltas = computeInvoiceDeltas(oldSnapshot, newSnapshot);

    expect(deltas.find((d) => d.type === 'description_changed')).toBeTruthy();
    expect(deltas.find((d) => d.type === 'quantity_changed')).toBeTruthy();
    expect(deltas.find((d) => d.type === 'price_changed')).toBeTruthy();
  });

  it('detects discount, tax, and message changes', () => {
    const oldSnapshot = {
      lineItems: [],
      discountCents: 100,
      taxRateBps: 500,
      customerMessage: 'Hello',
    };
    const newSnapshot = {
      lineItems: [],
      discountCents: 200,
      taxRateBps: 750,
      customerMessage: 'Updated message',
    };

    const deltas = computeInvoiceDeltas(oldSnapshot, newSnapshot);

    expect(deltas.find((d) => d.type === 'discount_changed')).toBeTruthy();
    expect(deltas.find((d) => d.type === 'tax_changed')).toBeTruthy();
    expect(deltas.find((d) => d.type === 'message_changed')).toBeTruthy();
  });

  it('no changes returns empty deltas', () => {
    const snapshot = {
      lineItems: [
        buildLineItem('li-1', 'Service', 1, 5000, 1, true),
      ],
      discountCents: 0,
      taxRateBps: 500,
      customerMessage: 'Thanks',
    };

    const deltas = computeInvoiceDeltas(snapshot, snapshot);
    expect(deltas).toHaveLength(0);
  });

  it('summary generation', () => {
    const oldSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Service A', 1, 5000, 1, true),
      ],
    };
    const newSnapshot = {
      lineItems: [
        buildLineItem('li-1', 'Service B', 1, 5000, 1, true),
        buildLineItem('li-2', 'Service C', 1, 3000, 2, true),
      ],
    };

    const deltas = computeInvoiceDeltas(oldSnapshot, newSnapshot);
    const summary = summarizeInvoiceDeltas(deltas);

    expect(summary).toContain('1 item(s) added');
    expect(summary).toContain('1 change(s)');
  });

  it('summary returns No changes for empty deltas', () => {
    const summary = summarizeInvoiceDeltas([]);
    expect(summary).toBe('No changes');
  });

  it('createInvoiceEditDelta persists via repository', async () => {
    const oldSnapshot = {
      lineItems: [buildLineItem('li-1', 'Service', 1, 5000, 1, true)],
    };
    const newSnapshot = {
      lineItems: [buildLineItem('li-1', 'Updated Service', 2, 6000, 1, true)],
    };

    const editDelta = await createInvoiceEditDelta(
      tenantId,
      invoiceId,
      'rev-1',
      'rev-2',
      oldSnapshot,
      newSnapshot,
      repo
    );

    expect(editDelta.id).toBeTruthy();
    expect(editDelta.tenantId).toBe(tenantId);
    expect(editDelta.invoiceId).toBe(invoiceId);
    expect(editDelta.deltas.length).toBeGreaterThan(0);
    expect(editDelta.summary).toBeTruthy();

    const found = await repo.findByInvoice(tenantId, invoiceId);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(editDelta.id);
  });
});
