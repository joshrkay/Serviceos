import { useTenantTimezone } from '../../hooks/useTenantTimezone';

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

type Urgency = 'critical' | 'high' | 'normal' | 'low';

export interface ChainRow {
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
    chainId?: string;
    sourceContext?: Record<string, unknown>;
  };
  urgency: Urgency;
  reason?: string;
}

const URGENCY_BADGE: Record<Urgency, { label: string; classes: string }> = {
  critical: { label: 'Critical', classes: 'bg-destructive/10 text-destructive border-destructive/30' },
  high: { label: 'High', classes: 'bg-warning/10 text-warning border-warning/30' },
  normal: { label: 'Normal', classes: 'bg-secondary text-foreground border-border' },
  low: { label: 'Low', classes: 'bg-secondary text-muted-foreground border-border' },
};

function chainIndexOf(row: ChainRow): number {
  const idx = row.proposal.sourceContext?.chainIndex;
  return typeof idx === 'number' ? idx : 0;
}

function dependsOnIndices(row: ChainRow): number[] {
  const deps = row.proposal.sourceContext?.dependsOnChainIndices;
  if (!Array.isArray(deps)) return [];
  return deps.filter((n): n is number => typeof n === 'number');
}

/** Highest urgency in the chain drives the group badge. */
const URGENCY_RANK: Record<Urgency, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export interface ProposalChainCardProps {
  rows: ChainRow[];
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
      className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.classes}`}>
              {badge.label}
            </span>
            <span className="text-xs font-medium text-primary">
              {ordered.length} linked actions
            </span>
          </div>
          <p className="text-xs text-muted-foreground">One request, approved together in order.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onRejectChain(ids)}
            className="rounded-lg border border-border bg-card text-foreground text-sm px-3 py-1.5 hover:bg-secondary"
          >
            Reject all
          </button>
          <button
            type="button"
            onClick={() => onApproveChain(ids)}
            className="rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:bg-primary/90"
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
              className="rounded-lg border border-border bg-card px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {i + 1}
                </span>
                <span className="text-xs text-muted-foreground">{row.proposal.proposalType}</span>
              </div>
              <p className="text-sm text-foreground mt-0.5 truncate">{row.proposal.summary}</p>
              {deps.length > 0 && (
                <p className="text-xs text-primary mt-0.5">
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
