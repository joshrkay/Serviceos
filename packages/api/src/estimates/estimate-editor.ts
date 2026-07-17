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

// `index` (numeric, preferred) and `description` (free-text) are BOTH
// optional at the type level because the LLM edit-task prompt
// (ai/tasks/estimate-edit-task.ts) emits description-only actions — it
// never had index in the first place, despite the (now-implemented)
// prompt comment promising description→index resolution. Exactly one of
// the two must be present at runtime; `resolveActionIndex` below enforces
// that and is the ONLY place allowed to turn either into a concrete
// array index. Mirrors invoices/invoice-editor.ts exactly.
export type EstimateEditAction =
  | { type: 'add_line_item'; lineItem: EstimateEditLineItemInput }
  | { type: 'remove_line_item'; index?: number; description?: string }
  | {
      type: 'update_line_item';
      index?: number;
      description?: string;
      lineItem: EstimateEditLineItemInput;
    };

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

/**
 * Resolve a `remove_line_item` / `update_line_item` action to a concrete
 * `lineItems` array index. Mirrors invoices/invoice-editor.ts exactly —
 * see that file's doc comment for the full corruption-bug writeup. In
 * short: `undefined < 0` and `undefined >= lineItems.length` are both
 * `false`, so the old range guard let an index-less description-based
 * action (exactly what ai/tasks/estimate-edit-task.ts's prompt emits)
 * fall through to `lineItems.splice(undefined, 1)`, which coerces to
 * `splice(0, 1)` — silently deleting the FIRST line item. This function
 * makes that impossible: a non-integer/undefined index is always
 * rejected, and a description that doesn't resolve to exactly one line
 * throws instead of guessing.
 */
function resolveActionIndex(
  lineItems: LineItem[],
  action: { index?: number; description?: string },
  actionType: 'remove_line_item' | 'update_line_item'
): number {
  if (action.index !== undefined) {
    // Hardened guard: reject any non-integer index (undefined, NaN,
    // floats, etc.) in addition to the pre-existing out-of-range check.
    // A `splice(undefined, 1)` must never silently happen.
    if (
      !Number.isInteger(action.index) ||
      action.index < 0 ||
      action.index >= lineItems.length
    ) {
      throw new ValidationError(
        `${actionType} index ${action.index} is out of range (0..${lineItems.length - 1})`
      );
    }
    return action.index;
  }

  if (typeof action.description === 'string' && action.description.trim().length > 0) {
    return resolveIndexByDescription(lineItems, action.description, actionType);
  }

  throw new ValidationError(
    `${actionType} requires either a numeric index or a description matching an existing line item`
  );
}

/**
 * Resolve a free-text description to a line-item index. Mirrors
 * invoices/invoice-editor.ts's resolveIndexByDescription exactly.
 *
 * Matching rule (documented, least-surprising): normalize both sides by
 * trimming and lowercasing, then prefer an EXACT match; only if there are
 * zero exact matches do we fall back to a substring ("contains") match.
 * At either tier, exactly one match is required — zero or 2+ matches
 * throw rather than guess, per CLAUDE.md's rule that ambiguity on a
 * free-text entity reference must surface as a clarification, never a
 * silent pick.
 */
function resolveIndexByDescription(
  lineItems: LineItem[],
  description: string,
  actionType: string
): number {
  const query = description.trim().toLowerCase();
  const normalized = lineItems.map((li, idx) => ({ idx, desc: li.description.trim().toLowerCase() }));

  const exact = normalized.filter((l) => l.desc === query);
  if (exact.length === 1) return exact[0].idx;
  if (exact.length > 1) {
    throw new ValidationError(
      `${actionType}: description "${description}" matches ${exact.length} line items — cannot determine which one to edit`
    );
  }

  const contains = normalized.filter((l) => l.desc.includes(query));
  if (contains.length === 1) return contains[0].idx;
  if (contains.length > 1) {
    throw new ValidationError(
      `${actionType}: description "${description}" matches ${contains.length} line items — cannot determine which one to edit`
    );
  }

  throw new ValidationError(`${actionType}: no line item matching "${description}"`);
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
        const idx = resolveActionIndex(lineItems, action, 'remove_line_item');
        lineItems.splice(idx, 1);
        editedFields.push('lineItems');
        break;
      }
      case 'update_line_item': {
        const idx = resolveActionIndex(lineItems, action, 'update_line_item');
        validateInput(action.lineItem);
        const existing = lineItems[idx];
        const replaced = toBillingLineItem(action.lineItem, existing.id, existing.sortOrder);
        lineItems[idx] = replaced;
        editedFields.push(`lineItems[${idx}]`);
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
