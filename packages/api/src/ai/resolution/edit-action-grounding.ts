/**
 * Shared catalog grounding for voice EDIT actions (update_estimate /
 * update_invoice).
 *
 * The draft task handlers ground drafted LINE ITEMS through
 * catalog-resolver.ts `groundLineItemPricing`. Edit tasks operate on
 * edit ACTIONS (add/update/remove) whose payload wraps a line item
 * inside `action.lineItem`, so they cannot call that entry point
 * directly — but they must run the SAME money-correctness contract. This
 * module is that single grounding pass for edit actions; it reuses the
 * resolver's matching (`resolveLineItemToCatalog`) and its conflict
 * predicate (`isPriceConflict`) so an edit price is grounded EXACTLY as a
 * drafted price would be. It replaces the two near-identical
 * `groundEditActionPricing` twins that previously lived in
 * estimate-edit-task.ts / invoice-edit-task.ts and predated the resolver
 * upgrades (structural review gate + "did you mean" price conflict).
 *
 * PRICE FIELD — read
 * docs/solutions/conventions/line-item-price-field-estimate-vs-invoice.md.
 * That note's estimate=`unitPrice` / invoice=`unitPriceCents` split is
 * about DRAFT line items and the canonical billing `LineItem`. EDIT
 * ACTIONS are different: BOTH invoices/invoice-editor.ts and
 * estimates/estimate-editor.ts execute against `input.unitPrice` (see
 * their `*EditLineItemInput`), so `unitPrice` is the executable field for
 * BOTH document types on the edit path, and `unitPriceCents` is the
 * review-UI mirror. This module therefore writes `unitPrice` (executable)
 * + `unitPriceCents` (mirror) on a catalog match, and nulls ONLY the
 * mirror on an untrusted price — never the executable, which the
 * update_* Zod contract requires and the editor reads. Do NOT "fix" this
 * to write `unitPriceCents` for invoices: that would strand the resolved
 * price on a field the invoice editor never reads — the exact class of
 * bug the note documents.
 *
 * SEMANTICS PARITY with the draft path:
 * - exact/high match, no price conflict → the catalog price OVERWRITES
 *   the LLM guess; `pricingSource: 'catalog'`.
 * - exact/high match WITH a price conflict — the drafted price deviates
 *   from the catalog price by ≥ PRICE_CONFLICT_MIN_REL AND
 *   ≥ PRICE_CONFLICT_MIN_ABS_CENTS — the spoken price is KEPT, not
 *   silently snapped (the owner may have deliberately quoted a custom
 *   price), and the line is routed to review; `pricingSource: 'ambiguous'`.
 * - ambiguous / not-in-catalog / no-catalog → the LLM price is UNTRUSTED
 *   and routed to review; `pricingSource: 'ambiguous'` / `'uncatalogued'`.
 *
 * DEFERRED — one-tap resolution for edits. The draft path records
 * candidate SKUs in `sourceContext.catalogResolution` + `missingFields`
 * so proposals/resolve-line.ts lets the operator pick with one tap.
 * resolve-line.ts reads `payload.lineItems` and only `lineItems[i].catalogItemId`
 * missingFields entries — edit proposals carry `editActions`, not
 * `lineItems`, so it CANNOT resolve them, and wiring that would require a
 * NEW resolution contract for editActions (explicitly out of scope). So
 * for edits an untrusted / conflicting price is instead routed to the
 * SAME hard review gate the uncatalogued path already uses: `requiresReview`
 * (= `anyUncatalogued`) → the handler stamps `_meta.overallConfidence:'low'`
 * + caps confidence, which decideInitialStatus blocks on regardless of any
 * tenant threshold override. This is strictly safer than the old
 * unconditional overwrite, WITHOUT recording one-tap candidates that
 * nothing can consume. And because edits have no resolution path, an
 * ambiguous edit price is a PERMANENT review block — unlike the draft
 * path, where a sticky 'low' stamp would wrongly keep blocking after the
 * operator resolves the line — so treating 'ambiguous' exactly like
 * 'uncatalogued' here is the correct choice, not a shortcut.
 */
import type { CatalogItem } from '../../catalog/catalog-item';
import type { ConfidenceLevel } from '../guardrails/confidence';
import {
  CatalogLineResolution,
  isPriceConflict,
  resolveLineItemToCatalog,
  type PricingSource,
} from './catalog-resolver';

export interface EditActionGroundingResult {
  /**
   * The input payload with a grounded `editActions` array (or the input
   * unchanged when `editActions` is not an array). Same
   * `{ ...payload, editActions }` contract the local twins returned.
   */
  payload: Record<string, unknown>;
  /**
   * True when any add/update edit line carries an UNTRUSTED price —
   * uncatalogued, ambiguous, a "did you mean" price conflict, or a line
   * priced with no catalog to ground against. The handler uses this to
   * cap confidence below the auto-approve threshold and stamp
   * `_meta.overallConfidence:'low'`.
   */
  anyUncatalogued: boolean;
  /** True when at least one edit line was cleanly catalog-priced. */
  anyCatalogPriced: boolean;
  /**
   * Structural, threshold-independent review gate (mirrors
   * CatalogPricingOutcome.requiresReview). For edits this EQUALS
   * `anyUncatalogued` — there is no `missingFields` path (see module doc),
   * so any untrusted price forces review via `_meta.overallConfidence:'low'`.
   */
  requiresReview: boolean;
  /** Review markers keyed by `editActions[i].lineItem.unitPrice`. */
  markers: Array<{ path: string; reason: string }>;
  /** Per-field confidence signals for the same paths. */
  fieldConfidence: Record<string, ConfidenceLevel>;
}

/** Catalog categories → the proposal contract's line-item vocabulary. */
function contractCategory(item: CatalogItem): string {
  return item.category === 'Labor' ? 'labor' : 'material';
}

/**
 * Ground the add/update line items in `payload.editActions` against the
 * tenant's active catalog. Pure: returns a new payload with new action
 * objects; `remove_line_item` actions and malformed entries pass through
 * untouched. `catalogItems` must already be filtered to active items — an
 * EMPTY array means "no catalog to ground against", which (like the draft
 * path's markAllUncatalogued) treats every priced line as uncatalogued
 * rather than trusting the LLM price.
 */
export function groundEditActionPricing(
  payload: Record<string, unknown>,
  catalogItems: CatalogItem[],
): EditActionGroundingResult {
  const markers: Array<{ path: string; reason: string }> = [];
  const fieldConfidence: Record<string, ConfidenceLevel> = {};
  let anyUncatalogued = false;
  let anyCatalogPriced = false;

  if (!Array.isArray(payload.editActions)) {
    return {
      payload,
      anyUncatalogued,
      anyCatalogPriced,
      requiresReview: false,
      markers,
      fieldConfidence,
    };
  }

  const editActions = (payload.editActions as Array<Record<string, unknown>>).map((action, idx) => {
    if (
      !action ||
      (action.type !== 'add_line_item' && action.type !== 'update_line_item') ||
      typeof action.lineItem !== 'object' ||
      action.lineItem === null
    ) {
      return action;
    }

    const lineItem = action.lineItem as Record<string, unknown>;
    const description = typeof lineItem.description === 'string' ? lineItem.description : '';
    const path = `editActions[${idx}].lineItem.unitPrice`;

    // The line's own drafted price (integer cents). Zero is a REAL price
    // (a comped/free line), so only a non-integer / negative / absent
    // value is treated as "no price".
    const draftedRaw = lineItem.unitPrice;
    const draftedPrice =
      typeof draftedRaw === 'number' && Number.isInteger(draftedRaw) && draftedRaw >= 0
        ? draftedRaw
        : null;

    // No catalog to ground against ⇒ never trust the LLM price (tier
    // 'none'), mirroring markAllUncatalogued on the draft path.
    const resolution: CatalogLineResolution =
      catalogItems.length > 0
        ? resolveLineItemToCatalog(description, catalogItems)
        : { query: description, tier: 'none' };

    // Untrusted price: keep the spoken `unitPrice` numeric (executable +
    // required by the update_* Zod contract), null the `unitPriceCents`
    // mirror, and route the line to review.
    const untrusted = (source: PricingSource, reason: string): Record<string, unknown> => {
      anyUncatalogued = true;
      fieldConfidence[path] = 'low';
      markers.push({ path, reason });
      return {
        ...action,
        lineItem: {
          ...lineItem,
          unitPriceCents: null,
          pricingSource: source,
          needsPricing: true,
        },
      };
    };

    if ((resolution.tier === 'exact' || resolution.tier === 'high') && resolution.match) {
      const item = resolution.match;
      if (draftedPrice !== null && isPriceConflict(draftedPrice, item.unitPriceCents)) {
        // "Did you mean" — a large deviation may be a deliberate custom
        // price; never silently overwrite it. Keep spoken, route to review.
        return untrusted(
          'ambiguous',
          `"${description}" was entered at a price that differs from the catalog price for "${item.name}" — review before approving`,
        );
      }
      anyCatalogPriced = true;
      return {
        ...action,
        lineItem: {
          ...lineItem,
          description: item.name,
          // Catalog price ALWAYS overwrites the LLM guess. `unitPrice` is
          // the executable field (both editors read it); `unitPriceCents`
          // mirrors it for the approval UI.
          unitPrice: item.unitPriceCents,
          unitPriceCents: item.unitPriceCents,
          catalogItemId: item.id,
          category: contractCategory(item),
          pricingSource: 'catalog' satisfies PricingSource,
          needsPricing: false,
          // Parity with the old per-task `groundEditActionPricing` (via
          // resolveSpokenLineItems in ai/tasks/catalog-resolution.ts):
          // catalog-RESOLVED lines default an unstated/invalid quantity to
          // 1 ("add a trip fee") so the required `quantity` field the
          // editors' `validateBillingLineItem` demands is always present.
          // Uncatalogued/ambiguous lines are intentionally NOT defaulted
          // here — the old resolver only defaulted quantity on the
          // `resolved` branch; unresolved items were pushed through
          // unchanged.
          quantity:
            typeof lineItem.quantity === 'number' &&
            Number.isFinite(lineItem.quantity) &&
            lineItem.quantity > 0
              ? lineItem.quantity
              : 1,
        },
      };
    }

    if (resolution.tier === 'ambiguous') {
      return untrusted(
        'ambiguous',
        `"${description}" matched multiple catalog items — review the price before approving`,
      );
    }

    // tier 'none' — not in the catalog (or no catalog to ground against).
    return untrusted(
      'uncatalogued',
      `"${description}" is not in the tenant catalog — the price is AI-estimated and needs review`,
    );
  });

  return {
    payload: { ...payload, editActions },
    anyUncatalogued,
    anyCatalogPriced,
    requiresReview: anyUncatalogued,
    markers,
    fieldConfidence,
  };
}
