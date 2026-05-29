import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatInTenantTz } from '../../utils/formatInTenantTz';

type Urgency = 'critical' | 'high' | 'normal' | 'low';

interface InboxProposalRow {
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
  };
  urgency: Urgency;
  reason?: string;
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
          {rows.map((row) => {
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
