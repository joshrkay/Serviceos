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
 *   price), and the line is routed to review with TWO recorded
 *   candidates (the catalog item and a synthetic "keep spoken price"
 *   choice); `pricingSource: 'ambiguous'`.
 * - ambiguous (multiple plausible catalog items) → the LLM price is kept,
 *   the candidates `resolveLineItemToCatalog` already computed are
 *   recorded, and the line is routed to review; `pricingSource:
 *   'ambiguous'`.
 * - not-in-catalog / no-catalog → the LLM price is UNTRUSTED, no
 *   candidates exist to resolve against, and the line is routed to a
 *   PERMANENT review block; `pricingSource: 'uncatalogued'`.
 *
 * ONE-TAP RESOLUTION FOR EDITS (B3). Both the 'ambiguous' tier and the
 * exact/high price-conflict carve-out now record their candidate SKUs in
 * the returned `catalogResolution` (keyed by edit-action index) and emit
 * an `editActions[i].lineItem.catalogItemId` `missingFields` entry —
 * mirroring the draft path's `sourceContext.catalogResolution` +
 * `missingFields` contract exactly. The task handlers merge these into
 * `sourceContext`, and `proposals/resolve-line.ts` reads `payload.
 * editActions` (branching on `Array.isArray(payload.editActions)`) so the
 * operator gets the SAME one-tap AmbiguityPicker draft lines already have.
 * Previously this candidate set was computed by `resolveLineItemToCatalog`
 * and then discarded, and every untrusted edit price — resolvable or not —
 * was routed to the SAME permanent hard-review gate the uncatalogued path
 * uses. That collapse ("ambiguous == uncatalogued") was only correct
 * because no resolution path existed for edits; now that one does, keeping
 * it would need lessly deadlock a resolvable ambiguity behind a gate
 * nothing can clear.
 *
 * SPLIT REVIEW SIGNAL. `anyAmbiguousWithCandidates` (ambiguous tier +
 * price-conflict carve-out) and `anyUncatalogued` (genuinely not in the
 * tenant catalog, or no catalog to ground against) are now DISTINCT:
 * - `anyAmbiguousWithCandidates` drives ONLY the resolvable `missingFields`
 *   gate. It must NEVER drive the persisted `payload._meta.
 *   overallConfidence = 'low'` stamp — that stamp is never lifted by line
 *   resolution (resolve-line.ts clears `missingFields` and the line's own
 *   markers, not the top-level `_meta.overallConfidence`), so stamping an
 *   ambiguous-only outcome 'low' would keep blocking chain-set/SMS
 *   approval forever, even after the operator resolves the line. This
 *   mirrors `CatalogPricingOutcome.requiresReview`'s doc in
 *   catalog-resolver.ts verbatim — same bug class, same fix.
 * - `anyUncatalogued` is a line with NOTHING to resolve to (no catalog
 *   match, or no catalog at all) — its block is rightly permanent, so it
 *   alone drives the sticky `_meta.overallConfidence:'low'` cap AND the
 *   confidence-score cap (`UNCATALOGUED_CONFIDENCE_CAP`) in the task
 *   handlers.
 * `requiresReview` (the structural, threshold-independent hard gate,
 * mirroring `CatalogPricingOutcome.requiresReview`) is `true` whenever
 * EITHER signal fires: `anyUncatalogued || missingFields.length > 0`.
 *
 * CRITICAL INVARIANT: an ambiguous-only edit action (no uncatalogued line
 * anywhere in the same proposal) must still NOT be able to auto-approve.
 * It doesn't rely on the confidence cap for that — `missingFields` alone
 * forces `decideInitialStatus` (proposals/proposal.ts) to return 'draft',
 * and `approveProposal` (proposals/actions.ts) independently re-checks
 * `missingFieldsFor(proposal).length > 0` and rejects. Both gates are
 * pinned by tests.
 */
import type { CatalogItem } from '../../catalog/catalog-item';
import type { ConfidenceLevel } from '../guardrails/confidence';
import {
  CatalogLineResolution,
  isPriceConflict,
  resolveLineItemToCatalog,
  type PricingSource,
} from './catalog-resolver';

/** One resolvable candidate for an ambiguous/price-conflict edit-action line. */
export interface EditActionCatalogCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
  /**
   * Contract category ('labor' | 'material') of the catalog item this
   * candidate represents. Absent on the synthetic `spoken:{i}` "keep
   * spoken price" choice — it has no catalog identity, so picking it
   * must leave the line's own category untouched (resolve-line.ts).
   */
  category?: string;
}

export interface EditActionGroundingResult {
  /**
   * The input payload with a grounded `editActions` array (or the input
   * unchanged when `editActions` is not an array). Same
   * `{ ...payload, editActions }` contract the local twins returned.
   */
  payload: Record<string, unknown>;
  /**
   * True when at least one edit line is genuinely NOT in the tenant
   * catalog (or there is no catalog to ground against at all) — nothing
   * for the operator to pick from, so this is a PERMANENT review block.
   * The handler uses this (and ONLY this) to cap confidence below the
   * auto-approve threshold and stamp `_meta.overallConfidence:'low'`. See
   * module doc "SPLIT REVIEW SIGNAL".
   */
  anyUncatalogued: boolean;
  /** True when at least one edit line was cleanly catalog-priced. */
  anyCatalogPriced: boolean;
  /**
   * True when at least one edit line is ambiguous (multiple plausible
   * catalog items) or has a "did you mean" price conflict — EITHER way,
   * `catalogResolution` carries a resolvable candidate set for that line
   * and `missingFields` carries its gate entry. Distinct from
   * `anyUncatalogued`: this signal must drive ONLY the resolvable
   * `missingFields` gate, never the sticky `_meta.overallConfidence:'low'`
   * stamp. See module doc "SPLIT REVIEW SIGNAL".
   */
  anyAmbiguousWithCandidates: boolean;
  /**
   * Structural, threshold-independent review gate (mirrors
   * `CatalogPricingOutcome.requiresReview`): true whenever ANY edit line
   * carries an AI-invented (uncatalogued) or operator-unpicked (ambiguous
   * / price-conflict) price — `anyUncatalogued || missingFields.length >
   * 0`. `true` means this outcome must never auto-approve, full stop,
   * regardless of confidence score or any tenant `auto_approve_threshold`
   * override.
   */
  requiresReview: boolean;
  /** Review markers keyed by `editActions[i].lineItem.unitPrice`. */
  markers: Array<{ path: string; reason: string }>;
  /** Per-field confidence signals for the same paths. */
  fieldConfidence: Record<string, ConfidenceLevel>;
  /**
   * `editActions[i].lineItem.catalogItemId` per ambiguous/price-conflict
   * line — forces `decideInitialStatus` to 'draft' and blocks
   * `approveProposal` until `resolveProposalLine` (proposals/
   * resolve-line.ts) clears it.
   */
  missingFields: string[];
  /**
   * Ambiguous/price-conflict-line candidates keyed by edit-action index,
   * for the review UI's one-tap AmbiguityPicker AND for
   * `resolveProposalLine`'s grounding invariant (the operator can only
   * pick from a recorded candidate). Present only when at least one line
   * recorded candidates.
   */
  catalogResolution?: Record<number, EditActionCatalogCandidate[]>;
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
  const missingFields: string[] = [];
  const catalogResolution: Record<number, EditActionCatalogCandidate[]> = {};
  let anyUncatalogued = false;
  let anyCatalogPriced = false;
  let anyAmbiguousWithCandidates = false;

  if (!Array.isArray(payload.editActions)) {
    return {
      payload,
      anyUncatalogued,
      anyCatalogPriced,
      anyAmbiguousWithCandidates,
      requiresReview: false,
      markers,
      fieldConfidence,
      missingFields,
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
    // mirror, flag the source, and record a review marker. Callers below
    // additionally decide the resolvability signal (ambiguous-with-
    // candidates vs permanently uncatalogued).
    const markUntrusted = (source: PricingSource, reason: string): Record<string, unknown> => {
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
        // price; never silently overwrite it. Keep spoken, and record TWO
        // candidates (the real catalog item + a synthetic "keep spoken
        // price" choice) so the operator resolves it with one tap —
        // mirroring the draft path's `applyCatalogPricing` carve-out.
        anyAmbiguousWithCandidates = true;
        missingFields.push(`editActions[${idx}].lineItem.catalogItemId`);
        catalogResolution[idx] = [
          {
            id: item.id,
            name: item.name,
            unitPriceCents: item.unitPriceCents,
            score: 1,
            category: contractCategory(item),
          },
          // Synthetic "keep spoken price" choice has no catalog identity —
          // no category is stamped, so picking it leaves the line's own
          // category untouched (see resolve-line.ts).
          { id: `spoken:${idx}`, name: 'Keep spoken price', unitPriceCents: draftedPrice, score: 0 },
        ];
        return markUntrusted(
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
      // Candidates `resolveLineItemToCatalog` already computed — record
      // them (previously discarded) so the operator resolves this with
      // one tap instead of hitting a permanent review block.
      anyAmbiguousWithCandidates = true;
      missingFields.push(`editActions[${idx}].lineItem.catalogItemId`);
      if (resolution.candidates) {
        catalogResolution[idx] = resolution.candidates.map((c) => ({
          id: c.item.id,
          name: c.item.name,
          unitPriceCents: c.item.unitPriceCents,
          score: c.score,
          category: contractCategory(c.item),
        }));
      }
      return markUntrusted(
        'ambiguous',
        `"${description}" matched multiple catalog items — review the price before approving`,
      );
    }

    // tier 'none' — not in the catalog (or no catalog to ground against).
    // Nothing recorded to pick from, so this is a PERMANENT review block.
    anyUncatalogued = true;
    return markUntrusted(
      'uncatalogued',
      `"${description}" is not in the tenant catalog — the price is AI-estimated and needs review`,
    );
  });

  return {
    payload: { ...payload, editActions },
    anyUncatalogued,
    anyCatalogPriced,
    anyAmbiguousWithCandidates,
    requiresReview: anyUncatalogued || missingFields.length > 0,
    markers,
    fieldConfidence,
    missingFields,
    ...(Object.keys(catalogResolution).length > 0 ? { catalogResolution } : {}),
  };
}
