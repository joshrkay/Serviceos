/**
 * D-045 — the status bubble on a job or customer: what happened to the latest
 * text sent about it (sent, held until morning, or not sent and why). Taps
 * through to the dispatch log filtered to the same job or customer.
 *
 * Hidden while loading, when nothing has been texted yet, and for a viewer
 * without `dispatch:view` (403: technicians have no comms surface). Any other
 * failure says so rather than hiding, so a broken status is never mistaken
 * for "nothing sent".
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { MessageSquare } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { summarizeMessage, TONE_CLASSES, type MessageDispatch } from './message-status';

export type LatestTextFilter = { jobId: string } | { customerId: string };

type LoadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; dispatch: MessageDispatch };

function filterQuery(filter: LatestTextFilter): string {
  return 'jobId' in filter
    ? `jobId=${encodeURIComponent(filter.jobId)}`
    : `customerId=${encodeURIComponent(filter.customerId)}`;
}

export function LatestTextStatus({ filter }: { filter: LatestTextFilter }) {
  const tz = useTenantTimezone();
  const query = filterQuery(filter);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const res = await apiFetch(`/api/interactions/dispatches?${query}&limit=1`);
        if (res.status === 403) {
          if (!cancelled) setLoad({ status: 'hidden' });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { dispatches?: MessageDispatch[] };
        const latest = body.dispatches?.[0];
        if (!cancelled) setLoad(latest ? { status: 'ready', dispatch: latest } : { status: 'hidden' });
      } catch {
        if (!cancelled) setLoad({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (load.status === 'loading' || load.status === 'hidden') return null;

  if (load.status === 'error') {
    return (
      <p role="alert" data-testid="latest-text-status-error" className="text-sm text-destructive">
        Couldn't load the latest text status.
      </p>
    );
  }

  const summary = summarizeMessage(load.dispatch, tz);
  return (
    <Link
      to={`/interactions/dispatch?${query}`}
      data-testid="latest-text-status"
      aria-label={`Latest text: ${summary.headline}. ${summary.when}. Show all texts`}
      className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm ${TONE_CLASSES[summary.tone]}`}
    >
      <MessageSquare size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium">{summary.headline}</span>
        <span className="block text-xs opacity-80">{summary.when}</span>
      </span>
    </Link>
  );
}
