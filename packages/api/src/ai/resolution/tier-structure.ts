/**
 * Tier-structure normalizer — deterministically coerces AI-drafted line
 * items into structurally-valid good-better-best output.
 *
 * Runs in the estimate drafting pipeline AFTER catalog grounding
 * (ai/resolution/catalog-resolver.ts) and BEFORE the confidence /
 * clarification / _meta passes. It is FLAG-ONLY: it never drops, adds, or
 * reorders line items, so `lineItems[i]` indices stay aligned with the
 * confidence markers and clarification signals computed downstream (a
 * drop/reorder here would mis-index every `lineItems[i]` path).
 *
 * The drafting LLM emits grouping flags loosely — a missing default, two
 * defaults, a one-option "group", an add-on pre-checked when it should not
 * be. This pass coerces (never rejects — a hard reject would fail the whole
 * estimate over a cosmetic omission) so the output obeys the invariants the
 * customer selection UI (EstimateApprovalPage) and the proposal-contract
 * refine (draftEstimatePayloadSchema) both assume:
 *
 *   - Each tier group (>= 2 options sharing a groupKey) has EXACTLY ONE
 *     `isDefaultSelected` option. If the model flagged none, the first
 *     option in array order is defaulted (deterministic; a group is never
 *     silently dropped from the total). Extra defaults are cleared.
 *   - Tier options are marked `isOptional` (customer-selectable).
 *   - A singleton "group" (one option) is demoted — a one-option tier is
 *     not a choice — to an ALWAYS-BILLED line by clearing its
 *     `groupKey`/`groupLabel`/`isOptional`/`isDefaultSelected`. A tier
 *     implies a required selection, so the collapsed line must stay billed;
 *     leaving it `isOptional` would make it an add-on that silently drops
 *     from the default total.
 *   - Optional add-ons (`isOptional`, no `groupKey`) are NOT
 *     default-selected unless the request explicitly asked for them
 *     (`addOnsRequested`) — we never silently inflate the customer's
 *     starting total.
 *   - `isDefaultSelected` on a non-selectable (always-billed) line is
 *     cleared — the flag is meaningless there and would confuse selection.
 *
 * Pure and deterministic — no I/O. Operates on the loose `Record` shape the
 * drafting handlers carry (estimate line items use the `unitPrice` field and
 * have no `sortOrder` yet), mirroring `applyCatalogPricing` so it composes in
 * the same pipeline. Flat drafts (no grouping signal on any line) are returned
 * untouched — same array reference — so the non-tiered path is a true no-op.
 */

type DraftLine = Record<string, unknown>;

export interface NormalizeTierOptions {
  /**
   * True when the drafting request explicitly asked for optional add-ons
   * ("and offer a surge protector add-on"). Only then may an add-on keep
   * `isDefaultSelected = true`; otherwise add-ons default OFF.
   */
  addOnsRequested?: boolean;
}

/** Non-empty string `groupKey`, else undefined. */
function readGroupKey(li: DraftLine): string | undefined {
  return typeof li.groupKey === 'string' && li.groupKey.length > 0 ? li.groupKey : undefined;
}

/** Whether any line carries a grouping/selection signal at all. */
function hasTierSignal(lineItems: DraftLine[]): boolean {
  return lineItems.some(
    (li) =>
      readGroupKey(li) !== undefined ||
      li.isOptional !== undefined ||
      li.isDefaultSelected !== undefined,
  );
}

export function normalizeTierStructure(
  lineItems: DraftLine[],
  options: NormalizeTierOptions = {},
): DraftLine[] {
  // True no-op for flat drafts: nothing to coerce, keep the exact array.
  if (!hasTierSignal(lineItems)) return lineItems;

  const addOnsRequested = options.addOnsRequested === true;

  // Collect each group's member indices in array order.
  const groupIndices = new Map<string, number[]>();
  lineItems.forEach((li, i) => {
    const gk = readGroupKey(li);
    if (gk) {
      const arr = groupIndices.get(gk) ?? [];
      arr.push(i);
      groupIndices.set(gk, arr);
    }
  });

  // For each real (>= 2 option) group, the single default index: the first
  // flagged option in array order, else the first option.
  const defaultIndexByGroup = new Map<string, number>();
  for (const [gk, indices] of groupIndices) {
    if (indices.length < 2) continue; // singleton → demoted below
    const flagged = indices.find((i) => lineItems[i].isDefaultSelected === true);
    defaultIndexByGroup.set(gk, flagged ?? indices[0]);
  }

  const addOnDefault = (li: DraftLine): boolean =>
    addOnsRequested ? li.isDefaultSelected === true : false;

  return lineItems.map((li, i) => {
    const gk = readGroupKey(li);

    // Real tier-group option: mark selectable, exactly one default.
    if (gk && (groupIndices.get(gk)?.length ?? 0) >= 2) {
      return {
        ...li,
        groupKey: gk,
        isOptional: true,
        isDefaultSelected: defaultIndexByGroup.get(gk) === i,
      };
    }

    // Singleton "group" → demote to an ALWAYS-BILLED line. A one-option
    // "tier" is not a choice; a tier implies a required selection, so the
    // collapsed line must stay billed rather than becoming an optional
    // add-on that silently drops from the default total.
    if (gk) {
      const next: DraftLine = { ...li, isOptional: false, isDefaultSelected: false };
      delete next.groupKey;
      delete next.groupLabel;
      return next;
    }

    // Standalone optional add-on.
    if (li.isOptional === true) {
      return { ...li, isOptional: true, isDefaultSelected: addOnDefault(li) };
    }

    // Always-billed line — clear any stray selection flags (meaningless here).
    if (li.isOptional !== undefined || li.isDefaultSelected !== undefined) {
      return { ...li, isOptional: false, isDefaultSelected: false };
    }
    return li;
  });
}
