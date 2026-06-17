import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz } from '../../utils/formatInTenantTz';
import { ProposalChainCard, ChainRow } from './ProposalChainCard';
import { AmbiguityPicker, AmbiguityCandidate } from './AmbiguityPicker';

type Urgency = 'critical' | 'high' | 'normal' | 'low';

interface InboxProposalRow {
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
    // P2-035 (U2) — the inbox serializes the full proposal, so the
    // payload (line items + their pricingSource) and the ambiguous-line
    // candidate map ride through without an API change.
    payload?: Record<string, unknown>;
    sourceContext?: Record<string, unknown>;
  };
  urgency: Urgency;
  reason?: string;
}

/** P2-035 (U2) — a single ambiguous line awaiting an operator's pick. */
interface AmbiguousLine {
  lineIndex: number;
  description: string;
  candidates: AmbiguityCandidate[];
}

/**
 * P2-035 (U2) — extract the ambiguous lines for a proposal from its
 * `sourceContext.catalogResolution` map (keyed by line index) joined with
 * the payload's line descriptions. Returns [] when nothing is ambiguous,
 * so non-estimate/invoice rows render exactly as before.
 */
function ambiguousLinesFor(row: InboxProposalRow): AmbiguousLine[] {
  const resolution = row.proposal.sourceContext?.catalogResolution as
    | Record<string, AmbiguityCandidate[]>
    | undefined;
  if (!resolution || typeof resolution !== 'object') return [];
  const lineItems = row.proposal.payload?.lineItems;
  const lines = Array.isArray(lineItems) ? lineItems : [];
  const out: AmbiguousLine[] = [];
  for (const [key, candidates] of Object.entries(resolution)) {
    const lineIndex = Number(key);
    if (!Number.isInteger(lineIndex) || !Array.isArray(candidates) || candidates.length === 0) {
      continue;
    }
    const line = lines[lineIndex] as Record<string, unknown> | undefined;
    out.push({
      lineIndex,
      description: typeof line?.description === 'string' ? line.description : `Line ${lineIndex + 1}`,
      candidates,
    });
  }
  return out.sort((a, b) => a.lineIndex - b.lineIndex);
}

/**
 * A feed item is either a standalone proposal or a chain of linked
 * proposals (sharing a chainId). Chains render as one grouped card so a
 * multi-action voice request is approved together, in order.
 */
type FeedItem =
  | { kind: 'single'; row: InboxProposalRow }
  | { kind: 'chain'; chainId: string; rows: InboxProposalRow[]; sortKey: number };

/**
 * Group inbox rows into feed items: rows sharing a `chainId` collapse
 * into one chain item, preserving the server's urgency order via the
 * first-seen index as the chain's sort key. Standalone rows pass through
 * untouched, so the flag-off / single-action experience is unchanged.
 */
function groupIntoFeed(rows: InboxProposalRow[]): FeedItem[] {
  const items: FeedItem[] = [];
  const chainItemByid = new Map<string, Extract<FeedItem, { kind: 'chain' }>>();

  rows.forEach((row, index) => {
    const chainId = row.proposal.chainId;
    if (!chainId) {
      items.push({ kind: 'single', row });
      return;
    }
    const existing = chainItemByid.get(chainId);
    if (existing) {
      existing.rows.push(row);
      return;
    }
    const chainItem: Extract<FeedItem, { kind: 'chain' }> = {
      kind: 'chain',
      chainId,
      rows: [row],
      sortKey: index,
    };
    chainItemByid.set(chainId, chainItem);
    items.push(chainItem);
  });

  return items;
}

function holdExpiryLine(row: InboxProposalRow, timezone: string): string | null {
  if (row.proposal.proposalType !== 'create_booking' || !row.proposal.expiresAt) {
    return null;
  }
  const at = new Date(row.proposal.expiresAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Hold expires ${formatInTenantTz(at, timezone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

interface InboxSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  lowCount: number;
  truncated: boolean;
}

interface InboxResponse {
  data: InboxProposalRow[];
  summary: InboxSummary;
}

const URGENCY_BADGE: Record<Urgency, { label: string; classes: string }> = {
  critical: { label: 'Critical', classes: 'bg-red-100 text-red-800 border-red-200' },
  high: { label: 'High', classes: 'bg-amber-100 text-amber-800 border-amber-200' },
  normal: { label: 'Normal', classes: 'bg-slate-100 text-slate-700 border-slate-200' },
  low: { label: 'Low', classes: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export function InboxPage() {
  const apiFetch = useApiClient();
  const tz = useTenantTimezone();
  const [rows, setRows] = useState<InboxProposalRow[]>([]);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch('/api/proposals/inbox')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as InboxResponse;
        if (!cancelled) {
          setRows(body.data);
          setSummary(body.summary);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  async function actOnProposal(id: string, action: 'approve' | 'reject'): Promise<void> {
    const removed = rows.find((r) => r.proposal.id === id);
    setRows((prev) => prev.filter((r) => r.proposal.id !== id));
    try {
      const res = await apiFetch(`/api/proposals/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      emitProposalsChanged();
    } catch (err) {
      if (removed) setRows((prev) => [removed, ...prev]);
      setError(err instanceof Error ? err.message : `${action} failed`);
    }
  }

  /**
   * P2-035 (U2) — resolve one ambiguous catalog line by POSTing the
   * operator's pick to the resolve-line endpoint. On success the server
   * returns the patched proposal, so we splice its new payload +
   * sourceContext back into the row (the resolved line drops out of the
   * candidate map, removing its picker). On failure we throw so the
   * AmbiguityPicker reverts its optimistic chip — the row is left
   * untouched. Same optimistic-update + revert posture as actOnProposal.
   */
  async function resolveLine(
    proposalId: string,
    lineIndex: number,
    catalogItemId: string,
  ): Promise<void> {
    const res = await apiFetch(`/api/proposals/${proposalId}/resolve-line`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineIndex, catalogItemId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const updated = (await res.json()) as {
      payload?: Record<string, unknown>;
      sourceContext?: Record<string, unknown>;
      status?: string;
    } | null;
    setRows((prev) =>
      prev.map((r) =>
        r.proposal.id === proposalId
          ? {
              ...r,
              proposal: {
                ...r.proposal,
                payload: updated?.payload ?? r.proposal.payload,
                sourceContext: updated?.sourceContext ?? r.proposal.sourceContext,
                status: updated?.status ?? r.proposal.status,
              },
            }
          : r,
      ),
    );
    emitProposalsChanged();
  }

  /**
   * Approve a whole chain in one tap via the batch-approve endpoint.
   * Optimistically removes every member; restores them on failure. The
   * backend executes them in dependency order (a dependent can't run
   * until its parent has), so a single batch approval is safe.
   */
  async function approveChain(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const removed = rows.filter((r) => idSet.has(r.proposal.id));
    setRows((prev) => prev.filter((r) => !idSet.has(r.proposal.id)));
    try {
      const res = await apiFetch('/api/proposals/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalIds: ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      emitProposalsChanged();
    } catch (err) {
      if (removed.length > 0) setRows((prev) => [...removed, ...prev]);
      setError(err instanceof Error ? err.message : 'Approve all failed');
    }
  }

  /**
   * Reject every member of a chain. There is no batch-reject endpoint —
   * a chain that shouldn't proceed is rejected member-by-member. Done
   * sequentially so a mid-chain failure surfaces and the rest are still
   * attempted.
   */
  async function rejectChain(ids: string[]): Promise<void> {
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await actOnProposal(id, 'reject');
    }
  }

  const feed = groupIntoFeed(rows);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>
          <p className="text-sm text-slate-500">
            Proposals waiting for your approval, urgency-sorted.
          </p>
          {summary && summary.totalCount > 0 && (
            <p className="text-xs text-slate-500 mt-1">
              {summary.totalCount} waiting
              {summary.criticalCount > 0 && ` · ${summary.criticalCount} urgent`}
              {summary.truncated && ' (showing first 100)'}
            </p>
          )}
        </div>

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!isLoading && !error && rows.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-slate-700 font-medium">Nothing waiting.</p>
            <p className="text-xs text-slate-500 mt-1">
              When the voice agent or the system needs your approval, it'll show up here.
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {feed.map((item) => {
            if (item.kind === 'chain') {
              return (
                <ProposalChainCard
                  key={`chain-${item.chainId}`}
                  rows={item.rows as ChainRow[]}
                  onApproveChain={approveChain}
                  onRejectChain={rejectChain}
                />
              );
            }
            const { row } = item;
            const badge = URGENCY_BADGE[row.urgency];
            const ambiguousLines = ambiguousLinesFor(row);
            return (
              <li
                key={row.proposal.id}
                data-testid="inbox-row"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.classes}`}>
                        {badge.label}
                      </span>
                      <span className="text-xs text-slate-500">{row.proposal.proposalType}</span>
                    </div>
                    <p className="text-sm text-slate-900 font-medium truncate">{row.proposal.summary}</p>
                    {holdExpiryLine(row, tz) && (
                      <p className="text-xs text-amber-700 mt-0.5">{holdExpiryLine(row, tz)}</p>
                    )}
                    {row.reason && <p className="text-xs text-slate-500 mt-0.5">{row.reason}</p>}
                    {/* P2-035 (U2) — one-tap picker per ambiguous catalog line.
                        Resolving stamps the chosen price and (when nothing
                        else is missing) moves the proposal to ready_for_review;
                        it never approves. */}
                    {ambiguousLines.length > 0 && (
                      <div className="mt-2 flex flex-col gap-2">
                        {ambiguousLines.map((line) => (
                          <AmbiguityPicker
                            key={`${row.proposal.id}-${line.lineIndex}`}
                            lineIndex={line.lineIndex}
                            description={line.description}
                            candidates={line.candidates}
                            onResolve={(lineIndex, catalogItemId) =>
                              resolveLine(row.proposal.id, lineIndex, catalogItemId)
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'reject')}
                      className="rounded-lg border border-slate-200 bg-white text-slate-700 text-sm px-3 py-1.5 hover:bg-slate-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'approve')}
                      className="rounded-lg bg-slate-900 text-white text-sm px-3 py-1.5 hover:bg-slate-700"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
