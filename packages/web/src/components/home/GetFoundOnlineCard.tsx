/**
 * D-044 / #1763 — "Get found online": the owner's web-presence checklist.
 * Every item is derived on the server (GET /api/get-found-online), so it
 * ticks itself when the fact becomes true and reopens when it stops being
 * true. Owner-only: anyone else gets a 403 and the card renders nothing.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckCircle2, Circle, Clock, AlertCircle, ChevronRight } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';

type ItemId = 'google_listing' | 'review_link' | 'call_forwarding';
type ItemStatus = 'done' | 'current' | 'pending' | 'waiting' | 'error';
type ItemReason =
  | 'not_connected'
  | 'needs_pick'
  | 'no_location'
  | 'polling_paused'
  | 'missing'
  | 'not_set_up'
  | 'not_checked';

interface ChecklistItem {
  id: ItemId;
  status: ItemStatus;
  reason?: ItemReason;
  /** call_forwarding, when done: ISO time of the last passing check. */
  checkedAt?: string;
}

interface Checklist {
  items: ChecklistItem[];
  allDone: boolean;
  visible: boolean;
}

const TITLES: Record<ItemId, string> = {
  google_listing: 'Show up on Google',
  review_link: 'Send happy customers to your Google reviews',
  call_forwarding: 'Calls reach the AI',
};

const DONE_DETAIL: Record<ItemId, string> = {
  google_listing: 'Your Google Business Profile is connected.',
  review_link: 'After each job, 4★ and up customers are sent to your review link.',
  call_forwarding: 'Your business number forwards to Rivet.',
};

const REASON_DETAIL: Record<ItemReason, string> = {
  not_connected: 'Connect your Google Business Profile so customers find you on Google Maps.',
  needs_pick: 'Pick which Google location is yours.',
  no_location: 'Waiting on Google to verify your Business Profile.',
  polling_paused: 'Google stopped accepting the connection. Reconnect it.',
  missing: 'Add your Google review link so happy customers can review you.',
  not_set_up: 'Forward your business number to Rivet so the AI answers your calls.',
  not_checked: 'Forwarding is set up. Test it to make sure calls reach the AI.',
};

/** Where the owner finishes each item. */
const ACTIONS: Record<ItemId, string> = {
  google_listing: '/settings?open=google-business',
  review_link: '/settings?open=review-links',
  call_forwarding: '/settings/phone',
};

function doneDetail(item: ChecklistItem): string {
  if (item.id === 'call_forwarding' && item.checkedAt) {
    const date = new Date(item.checkedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return `Your business number forwards to Rivet. Last checked ${date}.`;
  }
  return DONE_DETAIL[item.id];
}

function StatusIcon({ status }: { status: ItemStatus }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={18} className="shrink-0 text-emerald-600" aria-hidden />;
    case 'waiting':
      return <Clock size={18} className="shrink-0 text-amber-600" aria-hidden />;
    case 'error':
      return <AlertCircle size={18} className="shrink-0 text-red-600" aria-hidden />;
    default:
      return <Circle size={18} className="shrink-0 text-muted-foreground" aria-hidden />;
  }
}

export function GetFoundOnlineCard() {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [hiding, setHiding] = useState(false);
  const [hideError, setHideError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/get-found-online')
      .then(async (res) => {
        // 403 for non-owners, or any failure: a widget never breaks Home.
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setChecklist(body.data as Checklist);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (!checklist || !checklist.visible) return null;

  const doneCount = checklist.items.filter((i) => i.status === 'done').length;

  async function hide() {
    setHiding(true);
    setHideError('');
    try {
      const res = await apiFetch('/api/get-found-online/dismiss', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setChecklist(body.data as Checklist);
    } catch {
      setHideError('Could not hide the checklist. Try again.');
    } finally {
      setHiding(false);
    }
  }

  return (
    <section
      data-testid="get-found-online-card"
      aria-labelledby="get-found-online-title"
      className="mx-4 md:mx-6 mt-4 rounded-xl border border-border bg-card px-4 py-3.5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="get-found-online-title" className="text-base font-semibold text-foreground">
          Get found online
        </h2>
        <p className="text-xs text-muted-foreground" data-testid="get-found-online-progress">
          {doneCount} of {checklist.items.length} done
        </p>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {checklist.items.map((item) => {
          const detail =
            item.status === 'done' ? doneDetail(item) : REASON_DETAIL[item.reason ?? 'missing'];
          const body = (
            <>
              <StatusIcon status={item.status} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm break-words ${
                    item.status === 'done' ? 'text-muted-foreground' : 'text-foreground'
                  }`}
                >
                  {TITLES[item.id]}
                </span>
                <span className="block text-xs text-muted-foreground break-words">{detail}</span>
              </span>
            </>
          );
          return (
            <li key={item.id} data-testid={`get-found-online-item-${item.id}`} data-status={item.status}>
              {item.status === 'done' ? (
                <div className="flex min-h-11 items-start gap-3 py-2">{body}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => void navigate(ACTIONS[item.id])}
                  className="flex min-h-11 w-full items-start gap-3 py-2 text-left"
                >
                  {body}
                  <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {checklist.allDone && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-sm text-foreground">You're all set.</p>
          <button
            type="button"
            onClick={() => void hide()}
            disabled={hiding}
            data-testid="get-found-online-hide"
            className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            {hiding ? 'Hiding…' : 'Hide'}
          </button>
        </div>
      )}
      {hideError && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {hideError}
        </p>
      )}
    </section>
  );
}
