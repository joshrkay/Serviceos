import React, { useState, useCallback } from 'react';
import { InvoiceLineItem, InvoiceProposalData } from './InvoiceProposalReview';

export interface EditedFields {
  lineItemsModified: string[];
  lineItemsAdded: number;
  lineItemsRemoved: number;
  discountChanged: boolean;
  taxChanged: boolean;
  messageChanged: boolean;
}

export interface InvoiceProposalEditorProps {
  proposal: InvoiceProposalData;
  onSave: (updatedProposal: InvoiceProposalData, editedFields: EditedFields) => void;
  onCancel: () => void;
}

function calculateTotals(
  lineItems: InvoiceLineItem[],
  discountCents: number,
  taxRateBps: number
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lineItems.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.unitPrice),
    0
  );
  const taxableAmount = Math.max(0, subtotalCents - discountCents);
  const taxCents = Math.round((taxableAmount * taxRateBps) / 10000);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  return { subtotalCents, taxCents, totalCents };
}

export function InvoiceProposalEditor({
  proposal,
  onSave,
  onCancel,
}: InvoiceProposalEditorProps) {
  const [lineItems, setLineItems] = useState<InvoiceLineItem[]>([...proposal.lineItems]);
  const [discountCents, setDiscountCents] = useState(proposal.discountCents);
  const [taxRateBps, setTaxRateBps] = useState(proposal.taxRateBps);
  const [customerMessage, setCustomerMessage] = useState(proposal.customerMessage || '');

  const totals = calculateTotals(lineItems, discountCents, taxRateBps);

  const updateLineItem = useCallback(
    (index: number, field: keyof InvoiceLineItem, value: string | number) => {
      setLineItems((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        return updated;
      });
    },
    []
  );

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      { description: '', quantity: 1, unitPrice: 0 },
    ]);
  }, []);

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(() => {
    const editedFields: EditedFields = {
      lineItemsModified: [],
      lineItemsAdded: Math.max(0, lineItems.length - proposal.lineItems.length),
      lineItemsRemoved: Math.max(0, proposal.lineItems.length - lineItems.length),
      discountChanged: discountCents !== proposal.discountCents,
      taxChanged: taxRateBps !== proposal.taxRateBps,
      messageChanged: customerMessage !== (proposal.customerMessage || ''),
    };

    for (let i = 0; i < Math.min(lineItems.length, proposal.lineItems.length); i++) {
      const orig = proposal.lineItems[i];
      const curr = lineItems[i];
      if (
        orig.description !== curr.description ||
        orig.quantity !== curr.quantity ||
        orig.unitPrice !== curr.unitPrice
      ) {
        editedFields.lineItemsModified.push(String(i));
      }
    }

    const updated: InvoiceProposalData = {
      ...proposal,
      lineItems,
      discountCents,
      taxRateBps,
      customerMessage,
      ...totals,
    };

    onSave(updated, editedFields);
  }, [lineItems, discountCents, taxRateBps, customerMessage, proposal, totals, onSave]);

  return (
    <div className="invoice-proposal-editor" data-testid="invoice-proposal-editor">
      <div className="editor-line-items" data-testid="editor-line-items">
        {lineItems.map((item, index) => (
          <div key={index} className="editor-line-item" data-testid={`editor-line-item-${index}`}>
            <input
              data-testid={`line-item-desc-${index}`}
              value={item.description}
              onChange={(e) => updateLineItem(index, 'description', e.target.value)}
              placeholder="Description"
            />
            <input
              data-testid={`line-item-qty-${index}`}
              type="number"
              value={item.quantity}
              onChange={(e) => updateLineItem(index, 'quantity', Number(e.target.value))}
            />
            <input
              data-testid={`line-item-price-${index}`}
              type="number"
              value={item.unitPrice}
              onChange={(e) => updateLineItem(index, 'unitPrice', Number(e.target.value))}
            />
            <button
              data-testid={`remove-line-item-${index}`}
              onClick={() => removeLineItem(index)}
            >
              Remove
            </button>
          </div>
        ))}
        <button data-testid="add-line-item" onClick={addLineItem}>
          Add Line Item
        </button>
      </div>

      <div className="editor-totals" data-testid="editor-totals">
        <div>
          <label>Discount (cents):</label>
          <input
            data-testid="discount-input"
            type="number"
            value={discountCents}
            onChange={(e) => setDiscountCents(Number(e.target.value))}
          />
        </div>
        <div>
          <label>Tax Rate (bps):</label>
          <input
            data-testid="tax-rate-input"
            type="number"
            value={taxRateBps}
            onChange={(e) => setTaxRateBps(Number(e.target.value))}
          />
        </div>
        <div data-testid="calculated-total">
          Total: ${(totals.totalCents / 100).toFixed(2)}
        </div>
      </div>

      <div className="editor-message">
        <label>Customer Message:</label>
        <textarea
          data-testid="customer-message-input"
          value={customerMessage}
          onChange={(e) => setCustomerMessage(e.target.value)}
        />
      </div>

      <div className="editor-actions">
        <button data-testid="save-button" onClick={handleSave}>
          Save Changes
        </button>
        <button data-testid="cancel-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export { calculateTotals };
