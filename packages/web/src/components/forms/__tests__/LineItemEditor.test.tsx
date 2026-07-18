import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  LineItemEditor,
  LineItemDraft,
  emptyDraft,
  toLineItemPayload,
  totalCents,
} from '../LineItemEditor';

function Harness({ initial }: { initial: LineItemDraft[] }) {
  const [items, setItems] = useState<LineItemDraft[]>(initial);
  return <LineItemEditor items={items} onChange={setItems} />;
}

describe('LineItemEditor (P11-006)', () => {
  it('renders rows and computes the live total in dollars', () => {
    const initial: LineItemDraft[] = [
      {
        id: 'a',
        description: 'Labor',
        quantity: '2',
        unitPriceDollars: '12.50',
        taxable: true,
      },
    ];
    render(<Harness initial={initial} />);
    expect(screen.getByDisplayValue('Labor')).toBeInTheDocument();
    // 2 * 12.50 = 25.00
    expect(screen.getByTestId('line-items-total')).toHaveTextContent('$25.00');
    expect(screen.getByTestId('line-item-total-0')).toHaveTextContent('$25.00');
  });

  it('adds a new row when the add button is clicked', () => {
    render(<Harness initial={[emptyDraft()]} />);
    expect(screen.getByTestId('line-item-row-0')).toBeInTheDocument();
    fireEvent.click(screen.getByText('+ Add row'));
    expect(screen.getByTestId('line-item-row-1')).toBeInTheDocument();
  });

  it('renders kit inputs/buttons that meet the 44px tap target (U8b)', () => {
    render(<Harness initial={[emptyDraft()]} />);
    // Row controls and the add/remove actions are kit components at ≥44px.
    expect(screen.getByLabelText('description-0').className).toContain('min-h-11');
    expect(screen.getByLabelText('unit-price-0').className).toContain('min-h-11');
    expect(screen.getByText('+ Add row').className).toContain('min-h-11');
    expect(screen.getByLabelText('remove-line-0').className).toContain('min-h-11');
  });

  it('removes a row when the × button is clicked', () => {
    const initial: LineItemDraft[] = [emptyDraft(), emptyDraft()];
    render(<Harness initial={initial} />);
    expect(screen.getByTestId('line-item-row-1')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('remove-line-1'));
    expect(screen.queryByTestId('line-item-row-1')).not.toBeInTheDocument();
  });

  it('updates the live total when the user types a new unit price', () => {
    const initial: LineItemDraft[] = [
      {
        id: 'a',
        description: 'x',
        quantity: '1',
        unitPriceDollars: '0.00',
        taxable: true,
      },
    ];
    render(<Harness initial={initial} />);
    const price = screen.getByLabelText('unit-price-0');
    fireEvent.change(price, { target: { value: '99.99' } });
    expect(screen.getByTestId('line-items-total')).toHaveTextContent('$99.99');
  });

  it('toLineItemPayload converts dollars to integer cents via Math.round', () => {
    const draft: LineItemDraft = {
      id: 'x',
      description: 'Service',
      quantity: '3',
      unitPriceDollars: '12.50',
      taxable: false,
    };
    const out = toLineItemPayload(draft, 0);
    expect(out.unitPriceCents).toBe(1250);
    expect(out.totalCents).toBe(3750);
    expect(Number.isInteger(out.unitPriceCents)).toBe(true);
    expect(Number.isInteger(out.totalCents)).toBe(true);
  });

  it('totalCents handles non-numeric / negative input safely', () => {
    expect(
      totalCents([
        { id: 'a', description: '', quantity: 'abc', unitPriceDollars: '5', taxable: true },
        { id: 'b', description: '', quantity: '-1', unitPriceDollars: '5', taxable: true },
        { id: 'c', description: '', quantity: '2', unitPriceDollars: '1.00', taxable: true },
      ])
    ).toBe(200);
  });

  it('EE-4 — toLineItemPayload forwards imageFileId (and omits it when absent)', () => {
    const withImage: LineItemDraft = {
      id: 'x',
      description: 'Heater',
      quantity: '1',
      unitPriceDollars: '2500.00',
      taxable: true,
      imageFileId: 'file-hero',
    };
    expect(toLineItemPayload(withImage, 0).imageFileId).toBe('file-hero');

    const withoutImage: LineItemDraft = {
      id: 'y',
      description: 'Labor',
      quantity: '1',
      unitPriceDollars: '100.00',
      taxable: true,
    };
    expect(toLineItemPayload(withoutImage, 0).imageFileId).toBeUndefined();
  });
});
