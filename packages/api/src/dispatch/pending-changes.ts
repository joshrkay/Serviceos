import { ProposalRepository } from '../proposals/proposal';
import { PendingChangeKind } from './board-query';

/**
 * Map appointments to any open (draft / ready_for_review) customer-initiated
 * cancel or reschedule proposal targeting them. Used by the dispatch board to
 * render a "change requested" badge before a dispatcher confirms the change.
 *
 * Only proposals whose sourceContext marks them customer-initiated count —
 * internal reschedules (e.g. technician-outage reflows) share the same
 * proposal types but must not be labeled as customer requests on the board.
 *
 * Cancel takes precedence over reschedule when both somehow exist — a pending
 * cancellation is the more consequential signal for the dispatcher.
 */
function isCustomerInitiated(sourceContext: Record<string, unknown> | undefined): boolean {
  return sourceContext?.source === 'customer_portal';
}
export async function resolvePendingChangeRequests(
  proposalRepo: ProposalRepository,
  tenantId: string,
  appointmentIds: string[],
): Promise<Map<string, PendingChangeKind>> {
  const result = new Map<string, PendingChangeKind>();
  if (appointmentIds.length === 0) return result;
  const targets = new Set(appointmentIds);

  const [drafts, ready] = await Promise.all([
    proposalRepo.findByStatus(tenantId, 'draft'),
    proposalRepo.findByStatus(tenantId, 'ready_for_review'),
  ]);

  for (const proposal of [...drafts, ...ready]) {
    const appointmentId = proposal.payload.appointmentId;
    if (typeof appointmentId !== 'string' || !targets.has(appointmentId)) continue;
    if (!isCustomerInitiated(proposal.sourceContext)) continue;

    if (proposal.proposalType === 'cancel_appointment') {
      result.set(appointmentId, 'cancel');
    } else if (
      proposal.proposalType === 'reschedule_appointment' &&
      result.get(appointmentId) !== 'cancel'
    ) {
      result.set(appointmentId, 'reschedule');
    }
  }

  return result;
}
