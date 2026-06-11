import {
  computeEstimateDeltas,
  summarizeDeltas,
  createEditDelta,
  InMemoryEditDeltaRepository,
} from '../../src/estimates/edit-delta';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P1-009D — Structured estimate edit deltas', () => {
  let repo: InMemoryEditDeltaRepository;

  beforeEach(() => {
    repo = new InMemoryEditDeltaRepository();
  });

  it('happy path — detects line item added', () => {
    const oldSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)],
    };
    const newSnapshot = {
      lineItems: [
        buildLineItem('1', 'Labor', 1, 5000, 1, true),
        buildLineItem('2', 'Material', 1, 3000, 2, true),
      ],
    };

    const deltas = computeEstimateDeltas(oldSnapshot, newSnapshot);
    expect(deltas.some((d) => d.type === 'line_item_added' && d.lineItemId === '2')).toBe(true);
  });

  it('happy path — detects line item removed', () => {
    const oldSnapshot = {
      lineItems: [
        buildLineItem('1', 'Labor', 1, 5000, 1, true),
        buildLineItem('2', 'Material', 1, 3000, 2, true),
      ],
    };
    const newSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)],
    };

    const deltas = computeEstimateDeltas(oldSnapshot, newSnapshot);
    expect(deltas.some((d) => d.type === 'line_item_removed' && d.lineItemId === '2')).toBe(true);
  });

  it('happy path — detects price change', () => {
    const oldSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)],
    };
    const newSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 1, 7500, 1, true)],
    };

    const deltas = computeEstimateDeltas(oldSnapshot, newSnapshot);
    expect(deltas.some((d) => d.type === 'price_changed' && d.oldValue === 5000 && d.newValue === 7500)).toBe(true);
  });

  it('happy path — detects quantity change', () => {
    const oldSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)],
    };
    const newSnapshot = {
      lineItems: [buildLineItem('1', 'Labor', 3, 5000, 1, true)],
    };

    const deltas = computeEstimateDeltas(oldSnapshot, newSnapshot);
    expect(deltas.some((d) => d.type === 'quantity_changed' && d.oldValue === 1 && d.newValue === 3)).toBe(true);
  });

  it('happy path — detects discount change', () => {
    const deltas = computeEstimateDeltas(
      { discountCents: 0 },
      { discountCents: 1000 }
    );
    expect(deltas.some((d) => d.type === 'discount_changed')).toBe(true);
  });

  it('happy path — summarizes deltas', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'A', 1, 5000, 1, true)] },
      {
        lineItems: [
          buildLineItem('1', 'A', 2, 5000, 1, true),
          buildLineItem('2', 'B', 1, 3000, 2, true),
        ],
      }
    );
    const summary = summarizeDeltas(deltas);
    expect(summary).toContain('added');
    expect(summary).toContain('change');
  });

  it('happy path — creates edit delta record', async () => {
    const delta = await createEditDelta(
      'tenant-1', 'est-1', 'rev-1', 'rev-2',
      { lineItems: [buildLineItem('1', 'A', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'A', 2, 7500, 1, true)] },
      repo
    );

    expect(delta.id).toBeTruthy();
    expect(delta.deltas.length).toBeGreaterThan(0);

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).toHaveLength(1);
  });

  it('validation — no changes produces empty deltas', () => {
    const items = [buildLineItem('1', 'Labor', 1, 5000, 1, true)];
    const deltas = computeEstimateDeltas({ lineItems: items }, { lineItems: items });
    expect(deltas).toHaveLength(0);
    expect(summarizeDeltas(deltas)).toBe('No changes');
  });

  it('edge — both snapshots empty produces no deltas', () => {
    const deltas = computeEstimateDeltas({}, {});
    expect(deltas).toHaveLength(0);
    expect(summarizeDeltas(deltas)).toBe('No changes');
  });

  it('edge — detects description change', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'Old desc', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'New desc', 1, 5000, 1, true)] }
    );
    expect(
      deltas.some(
        (d) =>
          d.type === 'description_changed' &&
          d.oldValue === 'Old desc' &&
          d.newValue === 'New desc'
      )
    ).toBe(true);
  });

  it('edge — detects sort order change', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 5, true)] }
    );
    expect(
      deltas.some((d) => d.type === 'order_changed' && d.oldValue === 1 && d.newValue === 5)
    ).toBe(true);
  });

  it('edge — detects taxable flag flip as exactly one delta', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, false)] }
    );
    const taxableDeltas = deltas.filter((d) => d.type === 'taxable_changed');
    expect(taxableDeltas).toHaveLength(1);
    expect(taxableDeltas[0].oldValue).toBe(true);
    expect(taxableDeltas[0].newValue).toBe(false);
  });

  it('edge — detects category change to undefined', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true, 'labor')] },
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] }
    );
    const categoryDeltas = deltas.filter((d) => d.type === 'category_changed');
    expect(categoryDeltas).toHaveLength(1);
    expect(categoryDeltas[0].oldValue).toBe('labor');
    expect(categoryDeltas[0].newValue).toBeUndefined();
  });

  it('edge — detects tax rate change', () => {
    const deltas = computeEstimateDeltas({ taxRateBps: 0 }, { taxRateBps: 825 });
    expect(
      deltas.some((d) => d.type === 'tax_changed' && d.oldValue === 0 && d.newValue === 825)
    ).toBe(true);
  });

  it('edge — detects customer message change', () => {
    const deltas = computeEstimateDeltas(
      { customerMessage: undefined },
      { customerMessage: 'Thanks for your business' }
    );
    expect(
      deltas.some(
        (d) => d.type === 'message_changed' && d.newValue === 'Thanks for your business'
      )
    ).toBe(true);
  });

  it('edge — summarize with only changes uses change(s) phrasing', () => {
    const deltas = computeEstimateDeltas(
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'Labor', 2, 7500, 1, true)] }
    );
    const summary = summarizeDeltas(deltas);
    expect(summary).toMatch(/^\d+ change\(s\)$/);
    expect(summary).not.toContain('added');
    expect(summary).not.toContain('removed');
  });

  it('edge — summarize with only removals omits added/changed', () => {
    const deltas = computeEstimateDeltas(
      {
        lineItems: [
          buildLineItem('1', 'Labor', 1, 5000, 1, true),
          buildLineItem('2', 'Material', 1, 3000, 2, true),
        ],
      },
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] }
    );
    const summary = summarizeDeltas(deltas);
    expect(summary).toContain('1 item(s) removed');
    expect(summary).not.toContain('added');
    expect(summary).not.toContain('change(s)');
  });

  it('edge — InMemory repo scopes findByEstimate by tenant', async () => {
    await createEditDelta(
      'tenant-1', 'est-1', 'rev-1', 'rev-2',
      { lineItems: [buildLineItem('1', 'A', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'A', 2, 5000, 1, true)] },
      repo
    );
    expect(await repo.findByEstimate('tenant-2', 'est-1')).toHaveLength(0);
    expect(await repo.findByEstimate('tenant-1', 'est-1')).toHaveLength(1);
  });
});
