/**
 * Google Business reviews — connect a Google Business Profile via OAuth,
 * view review-monitoring status, and disconnect. Mirrors
 * CalendarSyncSheet; the backend is /api/googlebusiness-integrations.
 *
 * Review monitoring runs downstream: a poll worker ingests new reviews
 * every 15 minutes and drafts responses as proposals for human
 * approval. When credentials break (revoked access), the API surfaces a
 * poll-state backoff here as a visible "attention" state.
 */
import { useEffect, useState } from 'react';
import { X, Star, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface GoogleBusinessIntegrationView {
  id: string;
  provider: 'google_business';
  status: string;
  accountId: string | null;
  locationId: string | null;
  locationTitle: string | null;
  placeId: string | null;
  reviewUrl: string | null;
  locationStatus: 'connected' | 'needs_selection' | 'no_location';
  updatedAt: string;
  lastSuccessfulPollAt: string | null;
  backoffUntil: string | null;
}

interface GoogleLocationOption {
  locationId: string;
  title: string | null;
  placeId: string | null;
  reviewUrl: string | null;
}

interface GoogleBusinessSheetProps {
  onClose: () => void;
}

export function GoogleBusinessSheet({ onClose }: GoogleBusinessSheetProps) {
  const [integration, setIntegration] =
    useState<GoogleBusinessIntegrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Location picker: shown straight after connect when the account has
  // several locations, and on demand from "Change location".
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<GoogleLocationOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/googlebusiness-integrations');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as {
          data?: GoogleBusinessIntegrationView | null;
        };
        if (!cancelled) {
          setIntegration(json?.data ?? null);
          if (json?.data?.locationStatus === 'needs_selection') void openPicker();
        }
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

  async function openPicker() {
    setPickerOpen(true);
    setOptions(null);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google/locations');
      if (!res.ok) throw new Error(`Could not load your locations (${res.status})`);
      const json = (await res.json()) as { data?: GoogleLocationOption[] };
      setOptions(json.data ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load your locations';
      setError(msg);
      setPickerOpen(false);
    }
  }

  async function pickLocation(locationId: string) {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/googlebusiness-integrations/google/location', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId }),
      });
      if (!res.ok) throw new Error(`Could not save the location (${res.status})`);
      const json = (await res.json()) as {
        data: Pick<
          GoogleBusinessIntegrationView,
          'locationId' | 'locationTitle' | 'placeId' | 'reviewUrl' | 'locationStatus'
        >;
      };
      setIntegration((prev) => (prev ? { ...prev, ...json.data } : prev));
      setPickerOpen(false);
      toast.success('Google location saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save the location';
      setError(msg);
      toast.error(msg);
    } finally {
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
  const locationStatus = integration?.locationStatus ?? 'connected';
  // Backoff in the future ⇒ polling is paused (usually broken
  // credentials after the operator revoked access on Google's side).
  const needsAttention =
    isConnected &&
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
          ) : isConnected && pickerOpen ? (
            <div data-testid="googlebusiness-picker" className="space-y-2">
              <p className="text-sm text-slate-900">Which business location is yours?</p>
              {options === null ? (
                <p className="text-sm text-slate-500">Loading your locations…</p>
              ) : options.length === 0 ? (
                <p className="text-sm text-slate-500">No locations found on this Google account.</p>
              ) : (
                <ul className="space-y-2">
                  {options.map((o) => (
                    <li key={o.locationId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void pickLocation(o.locationId)}
                        data-testid={`googlebusiness-pick-${o.locationId}`}
                        className="flex min-h-11 w-full items-center rounded-xl border border-slate-200 px-4 py-2 text-left text-sm text-slate-900 hover:bg-slate-50 disabled:opacity-60"
                      >
                        {o.title ?? `Location ${o.locationId}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : isConnected && locationStatus === 'no_location' ? (
            <div
              data-testid="googlebusiness-no-location"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
            >
              <p className="text-sm text-amber-900">No business profile found</p>
              <p className="text-xs text-amber-800 mt-0.5">
                Google is connected, but this account has no business location
                yet. Create and verify your profile on Google, then reconnect.
              </p>
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
                {integration!.locationTitle
                  ? `Business location: ${integration!.locationTitle}`
                  : integration!.locationId
                    ? `Business location: ${integration!.locationId}`
                    : 'No business location chosen yet.'}
              </p>
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

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          {isConnected && !needsAttention ? (
            <>
            {locationStatus !== 'no_location' && !pickerOpen && (
              <button
                type="button"
                onClick={() => void openPicker()}
                disabled={busy}
                data-testid="googlebusiness-change-location"
                className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Change location
              </button>
            )}
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              data-testid="googlebusiness-disconnect"
              className="min-h-11 rounded-xl border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
            {locationStatus === 'no_location' && (
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                data-testid="googlebusiness-connect"
                className="min-h-11 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {busy ? 'Redirecting…' : 'Reconnect Google Business'}
              </button>
            )}
            </>
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
