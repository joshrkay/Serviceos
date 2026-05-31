import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { InboxProposalRow, Urgency, URGENCY_BADGE, URGENCY_RANK } from './inbox-types';

/**
 * ProposalChainCard — renders a multi-action chain (several proposals
 * decomposed from one voice utterance, sharing a `chainId`) as a single
 * grouped card in the inbox.
 *
 * The backend links these proposals with symbolic reference tokens
 * resolved at execution time (a later action uses an entity an earlier
 * action creates). The operator approves the whole chain at once via the
 * batch-approve endpoint; dependents can't execute until their parent
 * has, so approving in one tap is safe and matches how the request was
 * spoken.
 */

function chainIndexOf(row: InboxProposalRow): number {
  const idx = row.proposal.sourceContext?.chainIndex;
  return typeof idx === 'number' ? idx : 0;
}

function dependsOnIndices(row: InboxProposalRow): number[] {
  const deps = row.proposal.sourceContext?.dependsOnChainIndices;
  if (!Array.isArray(deps)) return [];
  return deps.filter((n): n is number => typeof n === 'number');
}

export interface ProposalChainCardProps {
  rows: InboxProposalRow[];
  onApproveChain: (ids: string[]) => void | Promise<void>;
  onRejectChain: (ids: string[]) => void | Promise<void>;
}

export function ProposalChainCard({ rows, onApproveChain, onRejectChain }: ProposalChainCardProps) {
  // Tenant timezone is read for parity with the rest of the inbox even
  // though chains don't yet surface a time-bound line; keeps the hook
  // order stable if a hold-expiry line is added later.
  useTenantTimezone();

  const ordered = [...rows].sort((a, b) => chainIndexOf(a) - chainIndexOf(b));
  const ids = ordered.map((r) => r.proposal.id);
  const topUrgency = ordered.reduce<Urgency>(
    (acc, r) => (URGENCY_RANK[r.urgency] < URGENCY_RANK[acc] ? r.urgency : acc),
    'low',
  );
  const badge = URGENCY_BADGE[topUrgency];

  return (
    <li
      data-testid="inbox-chain"
      className="rounded-xl border border-indigo-200 bg-indigo-50/40 px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.classes}`}>
              {badge.label}
            </span>
            <span className="text-xs font-medium text-indigo-700">
              {ordered.length} linked actions
            </span>
          </div>
          <p className="text-xs text-slate-500">One request, approved together in order.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onRejectChain(ids)}
            className="rounded-lg border border-slate-200 bg-white text-slate-700 text-sm px-3 py-1.5 hover:bg-slate-50"
          >
            Reject all
          </button>
          <button
            type="button"
            onClick={() => onApproveChain(ids)}
            className="rounded-lg bg-slate-900 text-white text-sm px-3 py-1.5 hover:bg-slate-700"
          >
            Approve all
          </button>
        </div>
      </div>

      <ol className="space-y-1.5">
        {ordered.map((row, i) => {
          const deps = dependsOnIndices(row);
          return (
            <li
              key={row.proposal.id}
              data-testid="inbox-chain-step"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">
                  {i + 1}
                </span>
                <span className="text-xs text-slate-500">{row.proposal.proposalType}</span>
              </div>
              <p className="text-sm text-slate-900 mt-0.5 truncate">{row.proposal.summary}</p>
              {deps.length > 0 && (
                <p className="text-xs text-indigo-600 mt-0.5">
                  Uses what step {deps.map((d) => d + 1).join(', ')} creates
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </li>
  );
}
