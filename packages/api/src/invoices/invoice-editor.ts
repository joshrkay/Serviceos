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

// `index` (numeric, preferred) and `description` (free-text) are BOTH
// optional at the type level because the LLM edit-task prompt
// (ai/tasks/invoice-edit-task.ts) emits description-only actions — it
// never had index in the first place, despite the (now-implemented)
// prompt comment promising description→index resolution. Exactly one of
// the two must be present at runtime; `resolveActionIndex` below enforces
// that and is the ONLY place allowed to turn either into a concrete
// array index.
export type InvoiceEditAction =
  | { type: 'add_line_item'; lineItem: InvoiceEditLineItemInput }
  | { type: 'remove_line_item'; index?: number; description?: string }
  | {
      type: 'update_line_item';
      index?: number;
      description?: string;
      lineItem: InvoiceEditLineItemInput;
    };

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

/**
 * Resolve a `remove_line_item` / `update_line_item` action to a concrete
 * `lineItems` array index. This is the ONLY place that guard against the
 * data-corruption bug where an index-less description-based action
 * (which is exactly what the LLM edit-task prompt emits — see
 * ai/tasks/invoice-edit-task.ts) reached `lineItems.splice(action.index, 1)`
 * with `action.index === undefined`. Both `undefined < 0` and
 * `undefined >= lineItems.length` are `false`, so the old range guard let
 * `undefined` straight through and `splice(undefined, 1)` coerces to
 * `splice(0, 1)` — silently deleting the FIRST line item instead of the
 * one the operator actually named. This function makes that impossible:
 * a non-integer/undefined index is always rejected, and a description
 * that doesn't resolve to exactly one line throws instead of guessing.
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
 * Resolve a free-text description to a line-item index — implements the
 * description→index matching the LLM prompt has always claimed happens
 * ("The execution step will match it against the real line items in the
 * invoice by description") but which never actually existed until now.
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
