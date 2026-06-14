/**
 * P2-034 — SMS one-tap proposal approval: outbound stamping.
 *
 * The OUTBOUND owner notification is owned by `routeUnsupervisedProposal`
 * (proposals/auto-approve) — it sends one SMS that offers BOTH a signed
 * tap-to-approve link (P12-004) AND a reply-APPROVE option (P2-034). This
 * module provides the one shared piece that path needs: stamp a short
 * reply code onto the proposal so an inbound `APPROVE <code>` reply can
 * resolve it even when several proposals are pending.
 *
 * Kept tiny and pure-ish (one repo write) so both the unsupervised-routing
 * caller and any future trigger reuse the exact same code-minting +
 * stamping, rather than re-implementing it (and drifting).
 */
import { Proposal, ProposalRepository } from '../../proposals/proposal';
import { generateApprovalCode, smsApprovalCodeOf } from './render';

/**
 * Ensure the proposal carries an SMS reply code, minting + persisting one
 * on `sourceContext.smsApproval` (Tier-2-safe, no migration) when absent.
 * Idempotent: returns the existing code unchanged if already stamped.
 * Returns the code so the caller can put it in the outbound SMS body.
 */
export async function stampSmsApprovalCode(
  proposalRepo: ProposalRepository,
  proposal: Proposal,
  options: { recipientUserId?: string; generateCode?: () => string } = {},
): Promise<string> {
  const existing = smsApprovalCodeOf(proposal);
  if (existing) return existing;

  const code = (options.generateCode ?? generateApprovalCode)();
  const stampedContext = {
    ...(proposal.sourceContext ?? {}),
    smsApproval: {
      code,
      ...(options.recipientUserId ? { recipientUserId: options.recipientUserId } : {}),
      sentAt: new Date().toISOString(),
    },
  };
  await proposalRepo.update(proposal.tenantId, proposal.id, { sourceContext: stampedContext });
  return code;
}
