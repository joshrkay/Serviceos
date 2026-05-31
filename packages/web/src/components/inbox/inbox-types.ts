/**
 * Shared inbox types + urgency presentation. Single source of truth for
 * the inbox row shape and the urgency badge styling, used by both
 * InboxPage (standalone rows) and ProposalChainCard (chain steps) so the
 * two render the same urgency identically and a new serialized field is
 * added in one place.
 */

export type Urgency = 'critical' | 'high' | 'normal' | 'low';

export interface InboxProposalRow {
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
    // Multi-action chaining: present on proposals decomposed from one
    // utterance. The inbox serializes the full proposal, so these ride
    // through without an API change.
    chainId?: string;
    sourceContext?: Record<string, unknown>;
  };
  urgency: Urgency;
  reason?: string;
}

export const URGENCY_BADGE: Record<Urgency, { label: string; classes: string }> = {
  critical: { label: 'Critical', classes: 'bg-red-100 text-red-800 border-red-200' },
  high: { label: 'High', classes: 'bg-amber-100 text-amber-800 border-amber-200' },
  normal: { label: 'Normal', classes: 'bg-slate-100 text-slate-700 border-slate-200' },
  low: { label: 'Low', classes: 'bg-slate-50 text-slate-500 border-slate-200' },
};

/** Numeric rank so the highest urgency in a group can be selected. */
export const URGENCY_RANK: Record<Urgency, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};
