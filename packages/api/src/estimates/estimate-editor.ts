import { randomUUID } from 'crypto';
import { Estimate, assertEstimateEditable } from './estimate';
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
 * Estimate ENTITY editor for voice-driven `update_estimate` proposals.
 *
 * Distinct from `proposals/estimate-editor.ts`, which edits the payload
 * of a `draft_estimate` PROPOSAL before execution. This file operates
 * on Estimate entities (post-execution, in an editable status). The
 * two exist side-by-side because the proposal-level editor serves the
 * review UI's pre-approval tweaks, while this one serves voice edits
 * that target existing estimates.
 *
 * Pure functions — no repo access, no I/O. UpdateEstimateExecutionHandler
 * is the persistence boundary.
 *
 * Shape matches invoices/invoice-editor.ts exactly so the AI task
 * handler and voice-action-router stay symmetric.
 */

export interface EstimateEditLineItemInput {
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

export type EstimateEditAction =
  | { type: 'add_line_item'; lineItem: EstimateEditLineItemInput }
  | { type: 'remove_line_item'; index: number }
  | { type: 'update_line_item'; index: number; lineItem: EstimateEditLineItemInput };

export interface ApplyEstimateEditsResult {
  updatedEstimate: Estimate;
  editedFields: string[];
}

function toBillingLineItem(
  input: EstimateEditLineItemInput,
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

function validateInput(input: EstimateEditLineItemInput): void {
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

export function applyEstimateEdits(
  estimate: Estimate,
  actions: EstimateEditAction[],
  // RV-042: the update_estimate execution handler edits ACCEPTED estimates
  // under acceptance-invalidation semantics (updateEstimate clears the
  // acceptance + audits it). Default false keeps the hard lock for every
  // other caller.
  opts: { allowAccepted?: boolean } = {},
): ApplyEstimateEditsResult {
  assertEstimateEditable(estimate, { allowAccepted: opts.allowAccepted ?? false });
  if (actions.length === 0) {
    throw new ValidationError('applyEstimateEdits requires at least one action');
  }

  const lineItems: LineItem[] = estimate.lineItems.map((l) => ({ ...l }));
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

  const normalized = lineItems.map((l, idx) => ({ ...l, sortOrder: idx }));
  const totals = calculateDocumentTotals(
    normalized,
    estimate.totals.discountCents,
    estimate.totals.taxRateBps
  );

  const updatedEstimate: Estimate = {
    ...estimate,
    lineItems: normalized,
    totals,
    updatedAt: new Date(),
  };

  return { updatedEstimate, editedFields };
}
