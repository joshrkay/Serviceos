/**
 * /interactions/dispatch — Outbound message dispatch log.
 *
 * Lists `message_dispatches` rows (SMS / email) sent on behalf of the
 * tenant — appointment confirmations, delay notices, estimate sends,
 * invoice sends — backed by `GET /api/interactions`. Satisfies QA
 * checklist §9A (interactions audit).
 */

import { useState, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';

interface MessageDispatch {
  id: string;
  entityType: string;
  entityId: string;
  channel: 'sms' | 'email';
  recipient: string;
  provider: string;
  providerMessageId?: string;
  status: string;
  errorMessage?: string;
  sentAt: string;
  deliveredAt?: string;
}

const CHANNEL_BADGE: Record<string, string> = {
  sms:   'bg-blue-100 text-blue-700',
  email: 'bg-violet-100 text-violet-700',
};
const STATUS_BADGE: Record<string, string> = {
  sent:      'bg-green-100 text-green-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  failed:    'bg-red-100 text-red-700',
  bounced:   'bg-amber-100 text-amber-700',
};
const ENTITY_LABEL: Record<string, string> = {
  estimate:                 'Estimate',
  invoice:                  'Invoice',
  appointment_confirmation: 'Appt Confirmation',
  delay_notice:             'Delay Notice',
};

export function DispatchLogPage() {
  const tz = useTenantTimezone();
  const [dispatches, setDispatches] = useState<MessageDispatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/interactions/dispatches?limit=50')
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
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-5 pb-4 border-b border-slate-100 bg-white">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-slate-900 text-lg font-semibold">Dispatch log</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Outbound SMS and email — appointment confirmations, delay notices,
            estimate and invoice deliveries.
          </p>
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
            <EmptyState
              icon={<MessageSquare size={20} />}
              title="No outbound messages yet"
              description="Send an estimate or invoice and dispatch records will appear here."
            />
          )}

          {!loading && !error && dispatches.length > 0 && (
            <>
              <p className="text-xs text-slate-400">{total} total dispatch{total !== 1 ? 'es' : ''}</p>
              {dispatches.map((d) => (
                <div key={d.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${CHANNEL_BADGE[d.channel] ?? 'bg-slate-100 text-slate-600'}`}>
                        {d.channel.toUpperCase()}
                      </span>
                      <span className="text-xs text-slate-500">{ENTITY_LABEL[d.entityType] ?? d.entityType}</span>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[d.status] ?? 'bg-slate-100 text-slate-500'}`}>
                      {d.status}
                    </span>
                  </div>
                  <div className="px-4 py-3 flex flex-col gap-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{d.recipient}</p>
                    {d.providerMessageId && (
                      <p className="text-xs text-slate-400 font-mono truncate">{d.providerMessageId}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      {formatDateTimeInTenantTz(d.sentAt, tz)} · {d.provider}
                    </p>
                    {d.errorMessage && (
                      <p className="text-xs text-red-600 mt-1">{d.errorMessage}</p>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
