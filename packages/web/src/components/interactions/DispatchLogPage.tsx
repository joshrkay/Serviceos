/**
 * /interactions/dispatch — Outbound message dispatch log.
 *
 * Lists `message_dispatches` rows (SMS / email) sent on behalf of the
 * tenant — appointment confirmations, delay notices, estimate sends,
 * invoice sends, and (D-045) texts held until morning or not sent, with the
 * reason — backed by `GET /api/interactions/dispatches`. Satisfies QA
 * checklist §9A (interactions audit). `?status=blocked` is the owner's list of
 * texts that did not go out; `?jobId=` / `?customerId=` scope it to the job or
 * customer whose status bubble was tapped.
 */

import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { summarizeMessage, TONE_CLASSES, type MessageDispatch } from './message-status';

const CHANNEL_BADGE: Record<string, string> = {
  sms:   'bg-blue-100 text-blue-700',
  email: 'bg-violet-100 text-violet-700',
};
const ENTITY_LABEL: Record<string, string> = {
  estimate:                 'Estimate',
  invoice:                  'Invoice',
  appointment_confirmation: 'Appt Confirmation',
  delay_notice:             'Delay Notice',
  thank_you:                'Thank-you',
};

/** D-045 — status filters. "Not sent" is the owner's list of blocked texts. */
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '',          label: 'All' },
  { value: 'blocked',   label: 'Not sent' },
  { value: 'scheduled', label: 'Held' },
];

export function DispatchLogPage() {
  const tz = useTenantTimezone();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const jobId = searchParams.get('jobId');
  const customerId = searchParams.get('customerId');
  const [dispatches, setDispatches] = useState<MessageDispatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ limit: '50' });
    if (status) query.set('status', status);
    if (jobId) query.set('jobId', jobId);
    if (customerId) query.set('customerId', customerId);
    apiFetch(`/api/interactions/dispatches?${query.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setDispatches(data.dispatches ?? []);
          setTotal(data.total ?? 0);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, jobId, customerId]);

  function selectStatus(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('status', value);
    else next.delete('status');
    setSearchParams(next);
  }

  const scope = jobId ? 'this job' : customerId ? 'this customer' : null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-5 pb-4 border-b border-slate-100 bg-white">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-slate-900 text-lg font-semibold">Dispatch log</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Outbound SMS and email — appointment confirmations, delay notices,
            estimate and invoice deliveries, and texts that were held or not sent.
          </p>
          {scope && (
            <p className="text-sm text-slate-600 mt-2" data-testid="dispatch-log-scope">
              Showing messages for {scope}.{' '}
              <Link to="/interactions/dispatch" className="inline-flex min-h-11 min-w-11 items-center text-primary hover:underline">
                Show all
              </Link>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value || 'all'}
                type="button"
                aria-pressed={status === f.value}
                onClick={() => selectStatus(f.value)}
                className={`min-h-11 min-w-11 rounded-full border px-4 text-sm ${
                  status === f.value
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 pb-20 flex flex-col gap-3">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="md" className="text-slate-900" label="Loading dispatch log" />
            </div>
          )}

          {error && (
            <ErrorState message="Couldn't load the dispatch log." />
          )}

          {!loading && !error && dispatches.length === 0 && (
            status === 'blocked' ? (
              <EmptyState
                icon={<MessageSquare size={20} />}
                title="Every text went out"
                description="Texts that couldn't be sent show up here with the reason."
              />
            ) : (
              <EmptyState
                icon={<MessageSquare size={20} />}
                title="No outbound messages yet"
                description="Send an estimate or invoice and dispatch records will appear here."
              />
            )
          )}

          {!loading && !error && dispatches.length > 0 && (
            <>
              <p className="text-xs text-slate-400">{total} total dispatch{total !== 1 ? 'es' : ''}</p>
              {dispatches.map((d) => {
                const summary = summarizeMessage(d, tz);
                return (
                  <div key={d.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid="dispatch-row">
                    <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${CHANNEL_BADGE[d.channel] ?? 'bg-slate-100 text-slate-600'}`}>
                          {d.channel.toUpperCase()}
                        </span>
                        <span className="truncate text-xs text-slate-500">{ENTITY_LABEL[d.entityType] ?? d.entityType}</span>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${TONE_CLASSES[summary.tone]}`}>
                        {d.status}
                      </span>
                    </div>
                    <div className="px-4 py-3 flex flex-col gap-1">
                      <p className="text-sm font-medium text-slate-800 break-words">{summary.headline}</p>
                      {d.recipient && (
                        <p className="text-sm text-slate-700 truncate">{d.recipient}</p>
                      )}
                      {d.providerMessageId && (
                        <p className="text-xs text-slate-400 font-mono truncate">{d.providerMessageId}</p>
                      )}
                      <p className="text-xs text-slate-400">
                        {summary.when}{d.provider !== 'unknown' ? ` · ${d.provider}` : ''}
                      </p>
                      {d.errorMessage && (
                        <p className="text-xs text-red-600 mt-1 break-words">{d.errorMessage}</p>
                      )}
                      {(d.jobId || d.customerId) && (
                        <div className="flex flex-wrap gap-x-4">
                          {d.jobId && (
                            <Link to={`/jobs/${d.jobId}`} className="inline-flex min-h-11 min-w-11 items-center text-sm text-primary hover:underline">
                              Open job
                            </Link>
                          )}
                          {d.customerId && (
                            <Link to={`/customers/${d.customerId}`} className="inline-flex min-h-11 min-w-11 items-center text-sm text-primary hover:underline">
                              Open customer
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
