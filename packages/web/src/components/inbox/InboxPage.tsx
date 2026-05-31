import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz } from '../../utils/formatInTenantTz';
import { ProposalChainCard } from './ProposalChainCard';
import { InboxProposalRow, URGENCY_BADGE } from './inbox-types';

/**
 * A feed item is either a standalone proposal or a chain of linked
 * proposals (sharing a chainId). Chains render as one grouped card so a
 * multi-action voice request is approved together, in order.
 */
type FeedItem =
  | { kind: 'single'; row: InboxProposalRow }
  | { kind: 'chain'; chainId: string; rows: InboxProposalRow[] };

/**
 * Group inbox rows into feed items: rows sharing a `chainId` collapse
 * into one chain item, preserving the server's urgency order via
 * first-seen insertion order. Standalone rows pass through untouched, so
 * the flag-off / single-action experience is unchanged.
 */
function groupIntoFeed(rows: InboxProposalRow[]): FeedItem[] {
  const items: FeedItem[] = [];
  const chainItemById = new Map<string, Extract<FeedItem, { kind: 'chain' }>>();

  for (const row of rows) {
    const chainId = row.proposal.chainId;
    if (!chainId) {
      items.push({ kind: 'single', row });
      continue;
    }
    const existing = chainItemById.get(chainId);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const chainItem: Extract<FeedItem, { kind: 'chain' }> = {
      kind: 'chain',
      chainId,
      rows: [row],
    };
    chainItemById.set(chainId, chainItem);
    items.push(chainItem);
  }

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
      // approve-batch returns 200 even on PARTIAL failure, with a
      // `failed: [{ id, reason }]` array. A naive res.ok check would
      // silently drop the un-approved members from the UI. Restore any
      // member that failed and surface the reason instead.
      const body = (await res.json().catch(() => null)) as
        | { approved?: string[]; failed?: { id: string; reason: string }[] }
        | null;
      const failed = body?.failed ?? [];
      if (failed.length > 0) {
        const failedIds = new Set(failed.map((f) => f.id));
        const toRestore = removed.filter((r) => failedIds.has(r.proposal.id));
        if (toRestore.length > 0) setRows((prev) => [...toRestore, ...prev]);
        setError(
          `Couldn't approve ${failed.length} of ${ids.length} linked actions: ${failed
            .map((f) => f.reason)
            .join('; ')}`,
        );
      }
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
                  rows={item.rows}
                  onApproveChain={approveChain}
                  onRejectChain={rejectChain}
                />
              );
            }
            const { row } = item;
            const badge = URGENCY_BADGE[row.urgency];
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
