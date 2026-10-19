/**
 * RV-042 / OVAS-01 — the review-time marker an `update_estimate` proposal
 * carries when it targets an estimate the customer has ALREADY ACCEPTED.
 *
 * Executing such an edit voids the acceptance: the signature data is deleted,
 * the estimate returns to 'sent', and the reminder budget resets (so the
 * reminder sweep re-sends the link). The marker is how every surface knows a
 * proposal is that kind of edit:
 *
 *   - the drafter (ai/tasks/estimate-edit-task.ts) stamps it and omits the
 *     autonomous trust tier, so the proposal is born 'draft' and can never
 *     auto-approve;
 *   - UpdateEstimateExecutionHandler voids an acceptance ONLY for a marked
 *     payload, so an estimate accepted after the draft was made fails closed;
 *   - the SMS renderer always prints the marker's reason, and the digest's
 *     one-tap / APPROVE ALL affordances and the unsupervised one-tap link
 *     exclude marked proposals — a human reads the warning first.
 *
 * Lives in proposals/ (not ai/tasks/) so the execution, digest and SMS layers
 * can read it without importing an AI task module.
 */
export const ACCEPTANCE_VOID_MARKER = {
  path: '_acceptance',
  reason: "approving voids the customer's prior acceptance",
} as const;

/**
 * True when `payload._meta.markers` carries the acceptance-void marker. Pure
 * observer — tolerates any payload shape (absent / malformed `_meta` → false).
 */
export function voidsCustomerAcceptance(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const meta = (payload as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const markers = (meta as Record<string, unknown>).markers;
  return (
    Array.isArray(markers) &&
    markers.some(
      (m) =>
        m !== null &&
        typeof m === 'object' &&
        (m as Record<string, unknown>).path === ACCEPTANCE_VOID_MARKER.path,
    )
  );
}
