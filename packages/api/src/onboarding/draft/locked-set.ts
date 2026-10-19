/**
 * The approved draft's proposal set, read under lock — shared by every writer
 * that decides on the WHOLE set before it changes any of it: the whole-draft
 * undo (undo.ts), the retry's safety check and re-queue (retry.ts), and the
 * whole-draft reset (S4-5).
 *
 * The caller already holds the draft row lock (inside `updateLocked`'s
 * `compute`, or after `getForTenantForUpdate`), so the draft's `proposal_ids`
 * cannot change under it. This read then takes `SELECT ... FOR UPDATE` on the
 * listed proposal rows, in id order (`findByIdsForUpdate`), so two such writers
 * cannot deadlock, and nothing else can move a member between the decision and
 * the write: the worker's `claimForExecution` and the inbox's per-proposal undo
 * both wait on these row locks and then see the committed outcome.
 */
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import { MISSING_PROPOSAL, type DraftProposalsFact } from '../derive-status';

export interface LockedDraftSet {
  /** How many proposals the draft lists. */
  expected: number;
  /** The listed rows that still exist, locked, ascending id. */
  members: Proposal[];
}

export async function lockDraftProposalSet(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalIds: readonly string[],
): Promise<LockedDraftSet> {
  const members = await proposalRepo.findByIdsForUpdate(tenantId, [...proposalIds].sort());
  return { expected: proposalIds.length, members };
}

/** The set as the status derivations read it (derive-status.ts), so a guard and its hint share one shape. */
export function lockedSetFact(set: LockedDraftSet): DraftProposalsFact {
  return {
    expected: set.expected,
    members: set.members.map((p) => ({ status: p.status, approvedAt: p.approvedAt ?? null })),
  };
}

/** Every member's status, plus one `missing` per listed proposal with no row: what a refusal reports in `details`. */
export function lockedSetStatuses(set: LockedDraftSet): string[] {
  const missing = Math.max(0, set.expected - set.members.length);
  return [...set.members.map((p) => p.status), ...Array<string>(missing).fill(MISSING_PROPOSAL)];
}
