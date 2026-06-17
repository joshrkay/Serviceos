import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz } from '../../utils/formatInTenantTz';
import { ProposalChainCard, ChainRow } from './ProposalChainCard';
import { AmbiguityPicker, type AmbiguityCandidate } from './AmbiguityPicker';

type Urgency = 'critical' | 'high' | 'normal' | 'low';

// U2 (P2-035) — the "what I wasn't sure about" signals that already ride to the
// inbox on the serialized proposal but were never rendered.
type ConfidenceLevel = 'high' | 'medium' | 'low' | 'very_low';
type PricingSource = 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';

interface ProposalMeta {
  overallConfidence?: ConfidenceLevel;
  markers?: Array<{ path: string; reason: string }>;
}

interface LineItemView {
  id?: string;
  description?: string;
  pricingSource?: PricingSource;
}

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
    // The inbox serializes the FULL proposal, so payload (_meta + lineItems)
    // and sourceContext (ambiguous-line candidates) are already present — they
    // were just never read by the UI.
    payload?: {
      _meta?: ProposalMeta;
      lineItems?: LineItemView[];
    };
    sourceContext?: {
      catalogResolution?: Record<string, AmbiguityCandidate[]>;
      missingFields?: string[];
    } & Record<string, unknown>;
  };
  urgency: Urgency;
  reason?: string;
}

const CONFIDENCE_CONFIG: Record<
  ConfidenceLevel,
  { label: string; bar: string; track: string; width: string; labelColor: string }
> = {
  high: { label: 'High confidence', bar: 'bg-green-500', track: 'bg-green-100', width: 'w-full', labelColor: 'text-green-700' },
  medium: { label: 'Review recommended', bar: 'bg-amber-400', track: 'bg-amber-100', width: 'w-3/5', labelColor: 'text-amber-700' },
  low: { label: 'Low confidence', bar: 'bg-orange-500', track: 'bg-orange-100', width: 'w-2/5', labelColor: 'text-orange-700' },
  very_low: { label: 'Very low — needs review', bar: 'bg-red-500', track: 'bg-red-100', width: 'w-1/5', labelColor: 'text-red-700' },
};

const PRICING_SOURCE_BADGE: Record<PricingSource, { label: string; classes: string }> = {
  catalog: { label: 'Catalog price', classes: 'bg-green-50 text-green-700 border-green-200' },
  ambiguous: { label: 'Needs a pick', classes: 'bg-amber-50 text-amber-800 border-amber-200' },
  uncatalogued: { label: 'Not in catalog', classes: 'bg-orange-50 text-orange-700 border-orange-200' },
  manual: { label: 'Manual price', classes: 'bg-slate-50 text-slate-600 border-slate-200' },
};

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

/**
 * U2 (P2-035) — renders the per-proposal trust signals the backend already
 * sends: the 4-tier confidence bar, per-line pricing-source badges, free-text
 * markers, and a one-tap picker for each ambiguous catalog line. Returns null
 * when a proposal carries none of these (the common, fully-grounded case), so
 * simple proposals look exactly as before.
 */
function ProposalMarkers({
  row,
  onResolveLine,
}: {
  row: InboxProposalRow;
  onResolveLine: (proposalId: string, lineIndex: number, catalogItemId: string) => Promise<void>;
}) {
  const meta = row.proposal.payload?._meta;
  const conf = meta?.overallConfidence ? CONFIDENCE_CONFIG[meta.overallConfidence] : null;
  const lineItems = row.proposal.payload?.lineItems ?? [];
  const catalogResolution = row.proposal.sourceContext?.catalogResolution ?? {};
  const markers = meta?.markers ?? [];
  const flagged = lineItems
    .map((li, idx) => ({ li, idx }))
    .filter(({ li }) => li.pricingSource && li.pricingSource !== 'catalog');

  if (!conf && flagged.length === 0 && markers.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5" data-testid="proposal-markers">
      {conf && (
        <div className="flex items-center gap-1.5" data-testid="confidence-signal">
          <div className={`h-1.5 w-16 overflow-hidden rounded-full ${conf.track}`}>
            <div className={`h-full rounded-full ${conf.bar} ${conf.width}`} />
          </div>
          <span className={`text-xs ${conf.labelColor}`}>{conf.label}</span>
        </div>
      )}

      {flagged.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {flagged.map(({ li, idx }) => {
            const badge = PRICING_SOURCE_BADGE[li.pricingSource as PricingSource];
            return (
              <span
                key={li.id ?? idx}
                data-testid="pricing-source-badge"
                className={`inline-flex max-w-full items-center truncate rounded-full border px-1.5 py-0.5 text-[10px] ${badge.classes}`}
              >
                {badge.label}
                {li.description ? `: ${li.description}` : ''}
              </span>
            );
          })}
        </div>
      )}

      {markers.map((m, i) => (
        <p key={`${m.path}-${i}`} className="text-xs text-slate-500">
          {m.reason}
        </p>
      ))}

      {flagged
        .filter(
          ({ li, idx }) =>
            li.pricingSource === 'ambiguous' &&
            (catalogResolution[String(idx)]?.length ?? 0) > 0,
        )
        .map(({ li, idx }) => (
          <AmbiguityPicker
            key={`picker-${li.id ?? idx}`}
            lineDescription={li.description ?? `Line ${idx + 1}`}
            candidates={catalogResolution[String(idx)]}
            onPick={(catalogItemId) => onResolveLine(row.proposal.id, idx, catalogItemId)}
          />
        ))}
    </div>
  );
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
   * U2 — resolve an ambiguous catalog line to one of its candidates. POSTs to
   * the resolve-line endpoint (which patches the draft and may move it to
   * ready_for_review, but NEVER approves), then merges the returned proposal
   * back into the row so the picker disappears and the price shows as grounded.
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
    if (!res.ok) {
      setError(`Couldn't resolve that line (HTTP ${res.status})`);
      throw new Error(`HTTP ${res.status}`);
    }
    const updated = (await res.json()) as InboxProposalRow['proposal'];
    setRows((prev) =>
      prev.map((r) =>
        r.proposal.id === proposalId
          ? { ...r, proposal: { ...r.proposal, ...updated } }
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
                    <ProposalMarkers row={row} onResolveLine={resolveLine} />
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
