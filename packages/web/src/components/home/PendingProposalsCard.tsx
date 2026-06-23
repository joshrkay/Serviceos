import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell, Clock, ArrowRight } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { emitProposalsChanged } from '../../lib/proposal-events';
import {
  usePendingProposals,
  type PendingProposalSummary,
} from '../../hooks/usePendingProposals';

/**
 * Epic 12.3 — Pending proposals queue on the HomePage.
 *
 * Surfaces every proposal awaiting a decision so nothing waits unseen, with
 * inline approve/reject ("tap to act inline") and an expiry countdown for
 * time-limited proposals. Reuses `usePendingProposals` (polls every 30s and
 * pauses when the tab is hidden) so the queue updates live, and the same
 * POST /api/proposals/:id/{approve,reject} contract the Inbox uses.
 *
 * Renders nothing when the queue is empty — the HomePage "all clear" state
 * owns the empty case so this card never adds noise.
 */

const MAX_VISIBLE = 4;
const CRITICAL_WINDOW_MS = 2 * 60 * 60 * 1000;

function humanizeType(type: string): string {
  const spaced = type.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Compact "expires in …" countdown; null when there's no expiry. */
function expiryLabel(expiresAt: string | undefined, now: number): { text: string; critical: boolean } | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return { text: 'Expired', critical: true };
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  const text =
    days >= 1 ? `Expires in ${days}d` : hrs >= 1 ? `Expires in ${hrs}h ${mins % 60}m` : `Expires in ${mins}m`;
  return { text, critical: ms <= CRITICAL_WINDOW_MS };
}

export function PendingProposalsCard() {
  const navigate = useNavigate();
  const apiFetch = useApiClient();
  const { proposals, count, isLoading, refresh } = usePendingProposals();

  // Acted-on ids hide immediately for snappy feedback; the next poll/refresh
  // reconciles against the server.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const now = Date.now();
  const visible = useMemo(
    () => proposals.filter((p) => !dismissed.has(p.id)),
    [proposals, dismissed],
  );

  async function act(id: string, action: 'approve' | 'reject') {
    setActing((prev) => new Set(prev).add(id));
    setError(null);
    try {
      const res = await apiFetch(`/api/proposals/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDismissed((prev) => new Set(prev).add(id));
      emitProposalsChanged();
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // Nothing to surface (also covers the initial load) — stay silent.
  if (isLoading && count === 0) return null;
  if (visible.length === 0) return null;

  const shown = visible.slice(0, MAX_VISIBLE);
  const remaining = visible.length - shown.length;

  return (
    <section data-testid="pending-proposals" className="px-4 md:px-6 py-5 border-b border-slate-100">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell size={14} className="text-blue-500" />
          <p className="text-sm text-slate-700">Needs your approval</p>
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-xs text-blue-700">
            {visible.length}
          </span>
        </div>
        <button
          onClick={() => navigate('/inbox')}
          className="flex items-center gap-0.5 text-xs text-blue-600 transition-colors hover:text-blue-700"
        >
          View all <ArrowRight size={11} />
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <div className="flex flex-col gap-2">
        {shown.map((p: PendingProposalSummary) => {
          const expiry = expiryLabel(p.expiresAt, now);
          const isActing = acting.has(p.id);
          return (
            <div
              key={p.id}
              data-testid="pending-proposal-row"
              className="rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                  {humanizeType(p.proposalType)}
                </span>
                {expiry && (
                  <span
                    className={`flex items-center gap-1 text-[11px] ${
                      expiry.critical ? 'text-red-600' : 'text-amber-700'
                    }`}
                  >
                    <Clock size={10} /> {expiry.text}
                  </span>
                )}
              </div>
              <p className="truncate text-sm text-slate-900">{p.summary}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  disabled={isActing}
                  onClick={() => act(p.id, 'reject')}
                  className="min-h-11 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={isActing}
                  onClick={() => act(p.id, 'approve')}
                  className="min-h-11 flex-1 rounded-lg bg-slate-900 px-3 text-sm text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                >
                  Approve
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {remaining > 0 && (
        <button
          onClick={() => navigate('/inbox')}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-blue-600 transition-colors hover:border-slate-300 hover:text-blue-700"
        >
          {remaining} more awaiting decision <ArrowRight size={13} />
        </button>
      )}
    </section>
  );
}
