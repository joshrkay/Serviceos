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

type ItemId = 'google_listing' | 'review_link' | 'call_forwarding' | 'website' | 'google_website';
type ItemStatus = 'done' | 'current' | 'pending' | 'waiting' | 'error';
type ItemReason =
  | 'not_connected'
  | 'needs_pick'
  | 'no_location'
  | 'polling_paused'
  | 'missing'
  | 'not_set_up'
  | 'not_checked'
  | 'no_website'
  | 'not_published'
  | 'failed';

interface ChecklistItem {
  id: ItemId;
  status: ItemStatus;
  reason?: ItemReason;
  /** call_forwarding, when done: ISO time of the last passing check. */
  checkedAt?: string;
  /** google_website, when failed: why Google refused the write. */
  failureReason?: string;
}

/** The approval card for putting the website and booking link on Google (#1771). */
interface GoogleWebsiteDraft {
  proposalId: string;
  websiteUri: string;
  bookingUri?: string;
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
  website: 'Have a website',
  google_website: 'Google shows your site',
};

const DONE_DETAIL: Record<ItemId, string> = {
  google_listing: 'Your Google Business Profile is connected.',
  review_link: 'After each job, 4★ and up customers are sent to your review link.',
  call_forwarding: 'Your business number forwards to Rivet.',
  website: 'Customers who search for you have a site to land on.',
  google_website: 'Your Google listing links to your website and online booking.',
};

/** Shown when an item is open for the plain reason that it is not done yet. */
const MISSING_DETAIL: Record<ItemId, string> = {
  google_listing: 'Connect your Google Business Profile so customers find you on Google Maps.',
  review_link: 'Add your Google review link so happy customers can review you.',
  call_forwarding: 'Forward your business number to Rivet so the AI answers your calls.',
  website: 'Add your website, or let us make you one.',
  google_website: 'Show your website and booking link on your Google listing.',
};

const REASON_DETAIL: Record<Exclude<ItemReason, 'missing'>, string> = {
  not_connected: 'Connect your Google Business Profile so customers find you on Google Maps.',
  needs_pick: 'Pick which Google location is yours.',
  no_location: 'Waiting on Google to verify your Business Profile.',
  polling_paused: 'Google stopped accepting the connection. Reconnect it.',
  not_set_up: 'Forward your business number to Rivet so the AI answers your calls.',
  not_checked: 'Forwarding is set up. Test it to make sure calls reach the AI.',
  no_website: 'Add your website first, then show it on Google.',
  not_published: 'Show your website and booking link on your Google listing.',
  failed: 'Google did not accept the change. Tap to try again.',
};

/** Where the owner finishes each item. */
const ACTIONS: Record<ItemId, string> = {
  google_listing: '/settings?open=google-business',
  review_link: '/settings?open=review-links',
  call_forwarding: '/settings/phone',
  website: '/settings?open=website',
  // Overridden while the item is ready for the approval card (see onItemTap).
  google_website: '/settings?open=google-business',
};

function doneDetail(item: ChecklistItem): string {
  if (item.id === 'call_forwarding' && item.checkedAt) {
    const date = new Date(item.checkedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    return `Your business number forwards to Rivet. Last checked ${date}. Tap to check again.`;
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
  const [gwDraft, setGwDraft] = useState<GoogleWebsiteDraft | null>(null);
  const [gwBusy, setGwBusy] = useState(false);
  const [gwMessage, setGwMessage] = useState('');
  const [gwError, setGwError] = useState('');

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

  /** Builds the approval card; nothing reaches Google until the owner approves it. */
  async function openGoogleWebsiteCard() {
    setGwBusy(true);
    setGwError('');
    setGwMessage('');
    try {
      const res = await apiFetch('/api/get-found-online/google-website/draft', {
        method: 'POST',
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { message?: string }).message || `HTTP ${res.status}`);
      setGwDraft((body as { data: GoogleWebsiteDraft }).data);
    } catch (err) {
      setGwError(err instanceof Error && err.message ? err.message : 'Could not prepare this. Try again.');
    } finally {
      setGwBusy(false);
    }
  }

  async function decideGoogleWebsite(decision: 'approve' | 'reject') {
    if (!gwDraft) return;
    setGwBusy(true);
    setGwError('');
    try {
      const res = await apiFetch(`/api/proposals/${gwDraft.proposalId}/${decision}`, {
        method: 'POST',
        body: decision === 'reject' ? JSON.stringify({ reason: 'not_right' }) : '{}',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGwDraft(null);
      if (decision === 'approve') {
        setGwMessage('Approved. Your Google listing updates in a few seconds.');
      }
    } catch {
      setGwError(
        decision === 'approve' ? 'Could not approve this. Try again.' : 'Could not discard this. Try again.',
      );
    } finally {
      setGwBusy(false);
    }
  }

  function onItemTap(item: ChecklistItem) {
    if (item.id === 'google_website' && (item.reason === 'not_published' || item.reason === 'failed')) {
      void openGoogleWebsiteCard();
      return;
    }
    void navigate(
      item.id === 'google_website' && item.reason === 'no_website' ? ACTIONS.website : ACTIONS[item.id],
    );
  }

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
            item.status === 'done'
              ? doneDetail(item)
              : item.reason === 'failed' && item.failureReason
                ? `${item.failureReason} Tap to try again.`
                : item.reason && item.reason !== 'missing'
                  ? REASON_DETAIL[item.reason]
                  : MISSING_DETAIL[item.id];
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
              {item.status === 'done' && item.id !== 'call_forwarding' ? (
                <div className="flex min-h-11 items-start gap-3 py-2">{body}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => onItemTap(item)}
                  disabled={item.id === 'google_website' && gwBusy}
                  className="flex min-h-11 w-full items-start gap-3 py-2 text-left disabled:opacity-60"
                >
                  {body}
                  <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              )}
              {item.id === 'google_website' && gwDraft && (
                <div
                  data-testid="google-website-approval"
                  className="mb-3 rounded-lg border border-border bg-secondary/40 p-3"
                >
                  <p className="text-sm font-medium text-foreground">Change your Google listing?</p>
                  <p className="mt-1 text-xs text-muted-foreground break-words">
                    Your website: {gwDraft.websiteUri}
                  </p>
                  {gwDraft.bookingUri && (
                    <p className="mt-1 text-xs text-muted-foreground break-words">
                      Book online link: {gwDraft.bookingUri}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    This is public. Customers will see it on Google.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void decideGoogleWebsite('approve')}
                      disabled={gwBusy}
                      data-testid="google-website-approve"
                      className="min-h-11 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
                    >
                      {gwBusy ? 'Working…' : 'Show on Google'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decideGoogleWebsite('reject')}
                      disabled={gwBusy}
                      data-testid="google-website-discard"
                      className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground hover:bg-secondary disabled:opacity-60"
                    >
                      Not now
                    </button>
                  </div>
                </div>
              )}
              {item.id === 'google_website' && gwMessage && (
                <p className="mb-2 text-xs text-muted-foreground" role="status">
                  {gwMessage}
                </p>
              )}
              {item.id === 'google_website' && gwError && (
                <p className="mb-2 text-xs text-red-600" role="alert">
                  {gwError}
                </p>
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
