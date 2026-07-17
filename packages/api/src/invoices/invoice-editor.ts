import { randomUUID } from 'crypto';
import { Invoice } from './invoice';
import {
  LineItem,
  LineItemCategory,
  PricingSource,
  buildLineItem,
  calculateDocumentTotals,
  validateLineItem as validateBillingLineItem,
} from '../shared/billing-engine';
import { ValidationError } from '../shared/errors';

/**
 * Invoice line-item editor for voice-driven `update_invoice` proposals.
 *
 * Pure functions — caller provides the current Invoice and a list of
 * edit actions, gets back an updated Invoice. No repo access, no I/O.
 * The execution handler (UpdateInvoiceExecutionHandler) fetches,
 * applies, writes back.
 *
 * Mirrors the shape of proposals/estimate-editor.ts, scoped to
 * invoice-specific edits for Phase-2 voice flows (add_line_item,
 * remove_line_item, update_line_item). Notes/wording live on the
 * invoice today but are out of scope for voice edits in this iteration.
 */

/**
 * Shape accepted from AI task output + proposal payloads. Intentionally
 * narrower than the internal billing-engine LineItem — the editor
 * generates the id, sortOrder, and totalCents that round out the
 * stored row.
 */
export interface InvoiceEditLineItemInput {
  description: string;
  quantity: number;
  unitPrice: number; // integer cents
  category?: LineItemCategory;
  taxable?: boolean;
  /**
   * Catalog-grounding provenance stamped by
   * ai/resolution/edit-action-grounding.ts before this action reaches the
   * executor. Absent (undefined) means "no grounding signal" — persisted
   * as NULL, never defaulted to 'manual' (see billing-engine.ts
   * PricingSource doc + migration 255).
   */
  pricingSource?: PricingSource;
}

export type InvoiceEditAction =
  | { type: 'add_line_item'; lineItem: InvoiceEditLineItemInput }
  | { type: 'remove_line_item'; index: number }
  | { type: 'update_line_item'; index: number; lineItem: InvoiceEditLineItemInput };

export interface ApplyInvoiceEditsResult {
  updatedInvoice: Invoice;
  editedFields: string[];
}

function toBillingLineItem(
  input: InvoiceEditLineItemInput,
  id: string,
  sortOrder: number
): LineItem {
  return buildLineItem(
    id,
    input.description,
    input.quantity,
    input.unitPrice,
    sortOrder,
    input.taxable ?? true,
    input.category,
    input.pricingSource
  );
}

function validateInput(input: InvoiceEditLineItemInput): void {
  // billing-engine.validateLineItem expects `unitPriceCents`, so we
  // adapt our narrower input shape before handing off.
  const errors = validateBillingLineItem({
    description: input.description,
    quantity: input.quantity,
    unitPriceCents: input.unitPrice,
    category: input.category,
  });
  if (errors.length > 0) {
    throw new ValidationError(`Invalid line item: ${errors.join(', ')}`);
  }
}

export function applyInvoiceEdits(
  invoice: Invoice,
  actions: InvoiceEditAction[]
): ApplyInvoiceEditsResult {
  if (invoice.status !== 'draft') {
    throw new ValidationError(
      `Cannot edit an invoice in status '${invoice.status}'. Only draft invoices are editable.`
    );
  }
  if (actions.length === 0) {
    throw new ValidationError('applyInvoiceEdits requires at least one action');
  }

  // Immutable copy of the line items so we don't mutate the caller's array.
  const lineItems: LineItem[] = invoice.lineItems.map((l) => ({ ...l }));
  const editedFields: string[] = [];

  for (const action of actions) {
    switch (action.type) {
      case 'add_line_item': {
        validateInput(action.lineItem);
        const sortOrder = lineItems.length;
        const newItem = toBillingLineItem(action.lineItem, randomUUID(), sortOrder);
        lineItems.push(newItem);
        editedFields.push(`lineItems[${sortOrder}]`);
        break;
      }
      case 'remove_line_item': {
        if (action.index < 0 || action.index >= lineItems.length) {
          throw new ValidationError(
            `remove_line_item index ${action.index} is out of range (0..${lineItems.length - 1})`
          );
        }
        lineItems.splice(action.index, 1);
        editedFields.push('lineItems');
        break;
      }
      case 'update_line_item': {
        if (action.index < 0 || action.index >= lineItems.length) {
          throw new ValidationError(
            `update_line_item index ${action.index} is out of range (0..${lineItems.length - 1})`
          );
        }
        validateInput(action.lineItem);
        const existing = lineItems[action.index];
        const replaced = toBillingLineItem(action.lineItem, existing.id, existing.sortOrder);
        lineItems[action.index] = replaced;
        editedFields.push(`lineItems[${action.index}]`);
        break;
      }
    }
  }

  // Rebuild sort order so removed items don't leave gaps.
  const normalized = lineItems.map((l, idx) => ({ ...l, sortOrder: idx }));

  const totals = calculateDocumentTotals(
    normalized,
    invoice.totals.discountCents,
    invoice.totals.taxRateBps
  );

  const updatedInvoice: Invoice = {
    ...invoice,
    lineItems: normalized,
    totals,
    amountDueCents: Math.max(0, totals.totalCents - invoice.amountPaidCents),
    updatedAt: new Date(),
  };

  return { updatedInvoice, editedFields };
}
