// Pure (RN-free) logic for the pending-proposals poll: mapping the list
// response, the critical-urgency test, and the baseline/diff that fires
// new/critical events exactly once. Ported from web's usePendingProposals;
// kept pure so it unit-tests without a React renderer.

export interface PendingProposalSummary {
  id: string;
  summary: string;
  proposalType: string;
  createdAt: string;
  expiresAt?: string;
}

export const CRITICAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/** True if the proposal expires within the next 2 hours. */
export function isCriticalProposal(p: PendingProposalSummary, now: number = Date.now()): boolean {
  if (!p.expiresAt) return false;
  const ms = new Date(p.expiresAt).getTime() - now;
  return ms > 0 && ms <= CRITICAL_WINDOW_MS;
}

interface RawProposal {
  id: string;
  summary: string;
  proposalType: string;
  createdAt: string | number | Date;
  expiresAt?: string | number | Date;
}

/** `GET /api/proposals/inbox` wraps each proposal in a prioritized envelope. */
interface RawInboxItem {
  proposal: RawProposal;
}

function toSummary(p: RawProposal): PendingProposalSummary {
  return {
    id: p.id,
    summary: p.summary,
    proposalType: p.proposalType,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date(p.createdAt).toISOString(),
    expiresAt:
      p.expiresAt === undefined
        ? undefined
        : typeof p.expiresAt === 'string'
          ? p.expiresAt
          : new Date(p.expiresAt).toISOString(),
  };
}

/**
 * Normalize `GET /api/proposals/inbox`'s `{ data: [{ proposal, urgency }] }`
 * to string-dated summaries. The inbox endpoint is used (not `?status=`)
 * because it merges 'draft' AND 'ready_for_review' server-side: voice
 * proposals and chained dependents land in 'draft' while still awaiting
 * operator action, so a 'ready_for_review'-only poll would hide them.
 */
export function mapInboxResponse(body: { data?: RawInboxItem[] }): PendingProposalSummary[] {
  return (body.data ?? [])
    .map((item) => item?.proposal)
    .filter((p): p is RawProposal => Boolean(p))
    .map(toSummary);
}

export interface ProposalDiff {
  /** Ids newly present vs. the prior poll (empty on the first/baseline poll). */
  newProposals: PendingProposalSummary[];
  /** Proposals that just crossed into the critical window. */
  criticalProposals: PendingProposalSummary[];
  nextIds: Set<string>;
  nextCritical: Set<string>;
}

/**
 * Diff a fresh list against the prior known-ids + already-critical sets.
 * `prevIds === null` means "no baseline yet" — the first poll seeds the
 * baseline and fires no new-proposal events (only records criticals).
 */
export function computeProposalEvents(
  prevIds: Set<string> | null,
  prevCritical: Set<string>,
  list: PendingProposalSummary[],
  now: number = Date.now(),
): ProposalDiff {
  const newProposals: PendingProposalSummary[] = [];
  const criticalProposals: PendingProposalSummary[] = [];
  const nextCritical = new Set(prevCritical);

  for (const p of list) {
    if (prevIds !== null && !prevIds.has(p.id)) {
      newProposals.push(p);
    }
    if (isCriticalProposal(p, now)) {
      if (prevIds !== null && !nextCritical.has(p.id)) {
        criticalProposals.push(p);
      }
      nextCritical.add(p.id);
    }
  }

  return {
    newProposals,
    criticalProposals,
    nextIds: new Set(list.map((p) => p.id)),
    nextCritical,
  };
}
