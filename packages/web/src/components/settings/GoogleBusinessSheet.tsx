/**
 * Google Business reviews — connect a Google Business Profile via OAuth,
 * view review-monitoring status, and disconnect. Mirrors
 * CalendarSyncSheet; the backend is /api/googlebusiness-integrations.
 *
 * D-044: after OAuth the owner picks which Google location is theirs
 * (several locations, or a reconnect that found none) and the location's
 * review link fills the tenant's "Public review links" setting.
 *
 * Review monitoring runs downstream: a poll worker ingests new reviews
 * every 15 minutes and drafts responses as proposals for human
 * approval. When credentials break (revoked access), the API surfaces a
 * poll-state backoff here as a visible "attention" state.
 */
import { useEffect, useState } from 'react';
import { X, Star, AlertCircle, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface GoogleBusinessIntegrationView {
  id: string;
  provider: 'google_business';
  status: string;
  accountId: string | null;
  locationId: string | null;
  locationTitle?: string | null;
  reviewUrl?: string | null;
  /** connected | needs_pick | no_location (absent on older APIs). */
  locationState?: 'connected' | 'needs_pick' | 'no_location';
  updatedAt: string;
  lastSuccessfulPollAt: string | null;
  backoffUntil: string | null;
  /** quota = Google throttling (clears on its own); auth = reconnect needed. */
  backoffReason?: 'quota' | 'auth' | null;
}

interface GoogleBusinessLocationView {
  accountId: string;
  locationId: string;
  title: string;
  address: string | null;
  reviewUrl: string | null;
}

async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.message === 'string') return body.message;
    if (typeof body?.error?.message === 'string') return body.error.message;
  } catch {
    /* non-JSON */
  }
  return fallback;
}

interface GoogleBusinessSheetProps {
  onClose: () => void;
  /** Choosing a location can fill or clear the Google review link on the
   *  server; the Settings page mirrors it so a later Save can't put the
   *  stale value back. */
  onReviewUrlChange?: (url: string | null) => void;
}

export function GoogleBusinessSheet({ onClose, onReviewUrlChange }: GoogleBusinessSheetProps) {
  const [integration, setIntegration] =
    useState<GoogleBusinessIntegrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Null until the picker is opened; the locations Google lists. */
  const [locations, setLocations] = useState<GoogleBusinessLocationView[] | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(false);

  async function loadLocations() {
    setLoadingLocations(true);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google/locations');
      if (!res.ok) {
        throw new Error(await errorDetail(res, `Could not load locations (${res.status})`));
      }
      const json = (await res.json()) as {
        data?: GoogleBusinessLocationView[];
        listingRemoved?: boolean;
        integration?: GoogleBusinessIntegrationView;
        reviewUrlCleared?: boolean;
      };
      setLocations(json.data ?? []);
      if (json.listingRemoved) {
        // The saved listing is no longer on this Google account; the
        // server dropped it, so the owner must pick again.
        if (json.integration) setIntegration(json.integration);
        if (json.reviewUrlCleared) onReviewUrlChange?.(null);
        toast.error(
          json.reviewUrlCleared
            ? 'Your saved Google location is no longer on this account, so its review link was removed. Pick your location again.'
            : 'Your saved Google location is no longer on this account. Pick your location again.',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load locations');
    } finally {
      setLoadingLocations(false);
    }
  }

  async function chooseLocation(location: GoogleBusinessLocationView) {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google/location', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: location.accountId,
          locationId: location.locationId,
        }),
      });
      if (!res.ok) {
        throw new Error(await errorDetail(res, `Could not save location (${res.status})`));
      }
      const json = (await res.json()) as {
        data: GoogleBusinessIntegrationView;
        reviewUrlFilled?: boolean;
        reviewUrlCleared?: boolean;
      };
      setIntegration(json.data);
      setLocations(null);
      if (json.reviewUrlFilled || json.reviewUrlCleared) {
        onReviewUrlChange?.(json.data.reviewUrl ?? null);
      }
      toast.success(
        json.reviewUrlFilled
          ? `${location.title} connected. Your Google review link is set.`
          : json.reviewUrlCleared
            ? `${location.title} connected. Google has no review link for it yet, so the old one was removed.`
            : `${location.title} connected.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save location';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/googlebusiness-integrations');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as {
          data?: GoogleBusinessIntegrationView | null;
        };
        if (cancelled) return;
        setIntegration(json?.data ?? null);
        // Several locations (or discovery failed at connect): the owner
        // picks one now.
        if (json?.data?.locationState === 'needs_pick') void loadLocations();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Connect failed (${res.status})`);
      }
      const json = (await res.json()) as { url: string };
      window.location.assign(json.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not start Google sign-in';
      setError(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!integration) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google', {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      setIntegration(null);
      toast.success('Google Business disconnected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not disconnect';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const isConnected = integration !== null;
  const locationState = integration?.locationState;
  // Backoff in the future ⇒ polling is paused (usually broken
  // credentials after the operator revoked access on Google's side).
  // Google throttling also backs off, but clears on its own and a
  // reconnect can't fix it, so it doesn't ask the owner to reconnect.
  const needsAttention =
    isConnected &&
    integration!.backoffReason !== 'quota' &&
    integration!.backoffUntil !== null &&
    new Date(integration!.backoffUntil).getTime() > Date.now();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="googlebusiness-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Star size={16} className="text-slate-700" />
          </span>
          <h2 id="googlebusiness-title" className="flex-1 text-base text-slate-900">
            Google Business reviews
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Connect your Google Business Profile so Rivet monitors new
            reviews and drafts responses for you. Every reply waits for
            your approval before anything is posted.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : needsAttention ? (
            <div
              data-testid="googlebusiness-attention"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2"
            >
              <AlertCircle size={16} className="text-amber-700 mt-0.5" />
              <div>
                <p className="text-sm text-amber-900">Review monitoring is paused</p>
                <p className="text-xs text-amber-800 mt-0.5">
                  We could not reach your Google Business account — the
                  connection may have been revoked. Reconnect to resume
                  monitoring.
                </p>
              </div>
            </div>
          ) : isConnected ? (
            <div
              data-testid="googlebusiness-connected"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"
            >
              <p className="text-sm text-emerald-900">
                <span className="font-medium">Google Business connected</span>
              </p>
              <p className="text-xs text-emerald-800 mt-0.5">
                {integration!.locationId
                  ? `Business location: ${integration!.locationTitle ?? integration!.locationId}`
                  : locationState === 'no_location'
                    ? 'No Business Profile found on this Google account yet.'
                    : 'Choose which Google location is yours.'}
              </p>
              {integration!.reviewUrl && (
                <p
                  data-testid="googlebusiness-review-link"
                  className="text-xs text-emerald-800 mt-0.5 break-all"
                >
                  Review link: {integration!.reviewUrl}
                </p>
              )}
              {integration!.lastSuccessfulPollAt && (
                <p className="text-xs text-emerald-800 mt-0.5">
                  Last checked:{' '}
                  {new Date(integration!.lastSuccessfulPollAt).toLocaleString()}
                </p>
              )}
            </div>
          ) : (
            <p
              data-testid="googlebusiness-not-connected"
              className="text-sm text-slate-500 italic"
            >
              No Google Business Profile connected.
            </p>
          )}

          {isConnected && !needsAttention && locations === null && (
            locationState === 'no_location' ? (
              <div
                data-testid="googlebusiness-no-location"
                className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
              >
                <p className="text-sm text-amber-900">
                  This Google account has no Business Profile yet.
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Once Google verifies your profile, check again to connect it.
                </p>
                <button
                  type="button"
                  onClick={() => void loadLocations()}
                  disabled={loadingLocations}
                  data-testid="googlebusiness-check-again"
                  className="mt-2 min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-sm text-amber-900 disabled:opacity-60"
                >
                  {loadingLocations ? 'Checking…' : 'Check again'}
                </button>
              </div>
            ) : locationState === 'connected' ? (
              <button
                type="button"
                onClick={() => void loadLocations()}
                disabled={loadingLocations}
                data-testid="googlebusiness-change-location"
                className="min-h-11 text-sm text-slate-700 underline disabled:opacity-60"
              >
                {loadingLocations ? 'Loading locations…' : 'Change location'}
              </button>
            ) : loadingLocations ? (
              <p className="text-sm text-slate-500">Loading your Google locations…</p>
            ) : (
              // needs_pick whose automatic load failed: the error shows
              // below, and this keeps a way to try again.
              <button
                type="button"
                onClick={() => void loadLocations()}
                data-testid="googlebusiness-load-locations"
                className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm text-slate-700"
              >
                Load my Google locations
              </button>
            )
          )}

          {locations !== null && (
            <div data-testid="googlebusiness-location-picker" className="space-y-2">
              <p className="text-sm text-slate-900">Which location is yours?</p>
              {locations.length === 0 ? (
                <div data-testid="googlebusiness-no-locations-found">
                  <p className="text-sm text-slate-500">
                    Google lists no locations on this account yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadLocations()}
                    disabled={loadingLocations}
                    data-testid="googlebusiness-recheck-locations"
                    className="mt-2 min-h-11 rounded-xl border border-slate-300 px-4 text-sm text-slate-700 disabled:opacity-60"
                  >
                    {loadingLocations ? 'Checking…' : 'Check again'}
                  </button>
                </div>
              ) : (
                <ul className="space-y-2">
                  {locations.map((loc) => {
                    const current =
                      loc.accountId === integration?.accountId &&
                      loc.locationId === integration?.locationId;
                    return (
                      <li key={`${loc.accountId}/${loc.locationId}`}>
                        <button
                          type="button"
                          onClick={() => void chooseLocation(loc)}
                          disabled={busy || current}
                          data-testid="googlebusiness-location-option"
                          className="flex min-h-11 w-full items-start gap-2 rounded-xl border border-slate-200 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-60"
                        >
                          <MapPin size={16} className="mt-0.5 shrink-0 text-slate-500" />
                          <span className="min-w-0">
                            <span className="block text-sm text-slate-900 break-words">
                              {loc.title}
                              {current ? ' (current)' : ''}
                            </span>
                            {loc.address && (
                              <span className="block text-xs text-slate-500 break-words">
                                {loc.address}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          {isConnected && !needsAttention ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              data-testid="googlebusiness-disconnect"
              className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : (
            <>
              {needsAttention && (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busy}
                  data-testid="googlebusiness-disconnect"
                  className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
                >
                  {busy ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                data-testid="googlebusiness-connect"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {busy
                  ? 'Redirecting…'
                  : needsAttention
                    ? 'Reconnect Google Business'
                    : 'Connect Google Business'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
