import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoiceProposalEditor } from './InvoiceProposalEditor';
import { InvoiceProposalData } from './InvoiceProposalReview';

function makeProposal(overrides: Partial<InvoiceProposalData> = {}): InvoiceProposalData {
  return {
    id: 'prop-1',
    customerId: 'cust-1',
    jobId: 'job-1',
    lineItems: [
      { description: 'Labor', quantity: 2, unitPrice: 5000 },
      { description: 'Parts', quantity: 1, unitPrice: 3000 },
    ],
    discountCents: 0,
    taxRateBps: 0,
    subtotalCents: 13000,
    taxCents: 0,
    totalCents: 13000,
    status: 'pending',
    ...overrides,
  };
}

describe('P5-004B InvoiceProposalEditor', () => {
  it('renders all line item inputs', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByTestId('line-item-desc-0')).toBeDefined();
    expect(screen.getByTestId('line-item-qty-0')).toBeDefined();
    expect(screen.getByTestId('line-item-price-0')).toBeDefined();
    expect(screen.getByTestId('line-item-desc-1')).toBeDefined();
    expect(screen.getByTestId('line-item-qty-1')).toBeDefined();
    expect(screen.getByTestId('line-item-price-1')).toBeDefined();
  });

  it('updates line item description', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    const descInput = screen.getByTestId('line-item-desc-0') as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: 'Updated Labor' } });
    expect(descInput.value).toBe('Updated Labor');
  });

  it('updates line item quantity', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    const qtyInput = screen.getByTestId('line-item-qty-0') as HTMLInputElement;
    fireEvent.change(qtyInput, { target: { value: '5' } });
    expect(qtyInput.value).toBe('5');
  });

  it('updates line item price', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    const priceInput = screen.getByTestId('line-item-price-0') as HTMLInputElement;
    fireEvent.change(priceInput, { target: { value: '7500' } });
    expect(priceInput.value).toBe('7500');
  });

  it('add line item button works', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.queryByTestId('editor-line-item-2')).toBeNull();
    fireEvent.click(screen.getByTestId('add-line-item'));
    expect(screen.getByTestId('editor-line-item-2')).toBeDefined();
  });

  it('remove line item button works', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByTestId('editor-line-item-1')).toBeDefined();
    fireEvent.click(screen.getByTestId('remove-line-item-1'));
    expect(screen.queryByTestId('editor-line-item-1')).toBeNull();
  });

  it('recalculates totals on change', () => {
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={vi.fn()} />
    );
    // Initial total: (2*5000 + 1*3000) = 13000 cents = $130.00
    const totalEl = screen.getByTestId('calculated-total');
    expect(totalEl.textContent).toContain('$130.00');

    // Change qty of first item to 3: (3*5000 + 1*3000) = 18000 cents = $180.00
    fireEvent.change(screen.getByTestId('line-item-qty-0'), { target: { value: '3' } });
    expect(totalEl.textContent).toContain('$180.00');
  });

  it('save calls onSave with updated data and editedFields', () => {
    const onSave = vi.fn();
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={onSave} onCancel={vi.fn()} />
    );

    fireEvent.change(screen.getByTestId('line-item-desc-0'), {
      target: { value: 'Changed Labor' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [updatedProposal, editedFields] = onSave.mock.calls[0];
    expect(updatedProposal.lineItems[0].description).toBe('Changed Labor');
    expect(editedFields.lineItemsModified).toContain('0');
  });

  it('cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(
      <InvoiceProposalEditor proposal={makeProposal()} onSave={vi.fn()} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByTestId('cancel-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('tracks edited fields correctly', () => {
    const onSave = vi.fn();
    render(
      <InvoiceProposalEditor
        proposal={makeProposal({ customerMessage: 'Original' })}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    // Change customer message
    fireEvent.change(screen.getByTestId('customer-message-input'), {
      target: { value: 'Updated message' },
    });
    // Change discount
    fireEvent.change(screen.getByTestId('discount-input'), { target: { value: '500' } });

    fireEvent.click(screen.getByTestId('save-button'));
    const editedFields = onSave.mock.calls[0][1];
    expect(editedFields.messageChanged).toBe(true);
    expect(editedFields.discountChanged).toBe(true);
    expect(editedFields.taxChanged).toBe(false);
    expect(editedFields.lineItemsAdded).toBe(0);
    expect(editedFields.lineItemsRemoved).toBe(0);
  });
});
