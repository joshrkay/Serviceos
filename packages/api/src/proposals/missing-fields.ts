/**
 * B1 — resolution-loop foundation (see docs/plans/2026-07-17-001-feat-voice-
 * transcript-and-agent-paths-plan.md). `missingFields` gates were added this
 * branch to block approval of money proposals whose Zod schema is satisfied
 * by a free-text reference alone (e.g. `send_invoice`'s `invoiceReference`)
 * but whose execution handler requires a resolved id. Those gates need a
 * working unblock path: `editProposal` calls `clearSatisfiedMissingFields`
 * after a successful edit to lift only the entries the edit actually
 * satisfied.
 *
 * Deliberately clear-on-fill, NOT a schema recompute. A recompute via
 * `validateProposalPayload` would see that (say) a `send_invoice` payload
 * carrying only `invoiceReference` already satisfies the Zod schema (the
 * `.refine` accepts either `invoiceId` or `invoiceReference`) and would drop
 * the `invoiceId` gate even though no id was ever resolved — reopening the
 * exact doomed-approval bug (approve succeeds, execution fails on the
 * unresolved reference) the gate exists to close. Clearing only fires when
 * BOTH: the exact gated key was itself edited, AND the merged payload now
 * holds a non-empty value under that key.
 */
export function clearSatisfiedMissingFields(
  missingFields: string[],
  editedKeys: string[],
  payload: Record<string, unknown>,
): string[] {
  const editedSet = new Set(editedKeys);
  return missingFields.filter((field) => {
    // Path-shaped entries (`lineItems[0].catalogItemId`,
    // `editActions[0].lineItem.catalogItemId`) are owned by resolve-line's
    // candidate-pick flow, never by a plain field edit — keep unconditionally.
    if (field.includes('[') || field.includes('.')) return true;

    // Not touched by this edit — keep.
    if (!editedSet.has(field)) return true;

    const value = payload[field];
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && value.trim().length === 0) return true;

    // Edited flat key, now non-empty — satisfied; drop from the gate list.
    return false;
  });
}
