import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ProposalResponse } from '@rivet/contracts';
import { api, formatDateTime } from '../lib/api';

const STATUS_STYLES: Record<string, string> = {
  ready_for_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  executing: 'bg-blue-100 text-blue-800',
  executed: 'bg-emerald-100 text-emerald-800',
  execution_failed: 'bg-red-100 text-red-800',
  rejected: 'bg-stone-200 text-stone-600',
  undone: 'bg-stone-200 text-stone-600',
};

const TYPE_LABELS: Record<string, string> = {
  create_customer: 'New customer',
  schedule_job: 'Book job',
  draft_invoice: 'Draft invoice',
  send_invoice: 'Send invoice',
};

function UndoCountdown({ proposal, onUndo }: { proposal: ProposalResponse; onUndo: () => void }) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!proposal.undoDeadlineAt) return;
    const deadline = new Date(proposal.undoDeadlineAt).getTime();
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [proposal.undoDeadlineAt]);
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onUndo}
      className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100"
    >
      Undo ({remaining}s)
    </button>
  );
}

export default function InboxPage() {
  const queryClient = useQueryClient();
  const proposals = useQuery({
    queryKey: ['proposals'],
    queryFn: async () => {
      const result = await api.proposals.list({ query: {} });
      if (result.status !== 200) throw new Error('failed to load proposals');
      return result.body.proposals;
    },
    refetchInterval: 2_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['proposals'] });

  const approve = useMutation({
    mutationFn: (id: string) => api.proposals.approve({ params: { id }, body: {} }),
    onSettled: invalidate,
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.proposals.reject({ params: { id }, body: {} }),
    onSettled: invalidate,
  });
  const undo = useMutation({
    mutationFn: (id: string) => api.proposals.undo({ params: { id }, body: {} }),
    onSettled: invalidate,
  });

  const pending = (proposals.data ?? []).filter((p) => p.status === 'ready_for_review');
  const rest = (proposals.data ?? []).filter((p) => p.status !== 'ready_for_review');

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
      <p className="mt-1 text-sm text-stone-500">
        Everything the AI wants to do. Nothing happens without your approval — here or by SMS
        (reply YES n / NO n).
      </p>

      <section className="mt-6 space-y-3">
        {proposals.isLoading && <div className="text-sm text-stone-500">Loading…</div>}
        {!proposals.isLoading && pending.length === 0 && (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            Inbox zero — no approvals waiting.
          </div>
        )}
        {pending.map((proposal) => (
          <div key={proposal.id} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-stone-900 px-2 py-0.5 text-xs font-semibold text-white">
                    #{proposal.shortCode}
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wide text-stone-500">
                    {TYPE_LABELS[proposal.type] ?? proposal.type} · via {proposal.source}
                  </span>
                  {proposal.confidenceBps !== null && (
                    <span className="text-xs text-stone-400">
                      {(proposal.confidenceBps / 100).toFixed(0)}% confident
                    </span>
                  )}
                </div>
                <div className="mt-2 font-medium">{proposal.summary}</div>
                <div className="mt-1 text-xs text-stone-400">{formatDateTime(proposal.createdAt)}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => approve.mutate(proposal.id)}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => reject.mutate(proposal.id)}
                  className="rounded-lg border border-stone-300 px-4 py-1.5 text-sm font-medium hover:bg-stone-100"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </section>

      {rest.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">History</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-white">
            {rest.map((proposal) => (
              <div
                key={proposal.id}
                className="flex items-center justify-between gap-4 border-b border-stone-100 px-5 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{proposal.summary}</div>
                  {proposal.error && <div className="text-xs text-red-600">{proposal.error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {proposal.status === 'approved' && (
                    <UndoCountdown proposal={proposal} onUndo={() => undo.mutate(proposal.id)} />
                  )}
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[proposal.status] ?? ''}`}
                  >
                    {proposal.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
