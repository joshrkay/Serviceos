/**
 * Tier 4 (Calendar sync — PR 1: connect lifecycle).
 *
 * Closes the "Calendar sync" stub on Settings. PR 1 lets the operator
 * connect their personal Google Calendar via OAuth, view connection
 * status, and disconnect. The actual appointment push lives behind
 * a follow-up worker hook.
 */
import { useEffect, useState } from 'react';
import { X, Calendar, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface CalendarIntegrationView {
  id: string;
  provider: 'google';
  status: 'active' | 'expired' | 'revoked';
  externalAccountEmail: string;
  calendarId: string;
  createdAt: string;
  updatedAt: string;
}

interface CalendarSyncSheetProps {
  onClose: () => void;
}

export function CalendarSyncSheet({ onClose }: CalendarSyncSheetProps) {
  const [integration, setIntegration] = useState<CalendarIntegrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/calendar-integrations');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as { data?: CalendarIntegrationView | null };
        if (!cancelled) setIntegration(json?.data ?? null);
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
      const res = await apiFetch('/api/calendar-integrations/google/connect', {
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

  async function testPush() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/calendar-integrations/google/test-push', {
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
        throw new Error(detail || `Test push failed (${res.status})`);
      }
      const json = (await res.json()) as { outcome: 'synced' | 'skipped' | 'failed' };
      if (json.outcome === 'synced') {
        toast.success('Test event added to your calendar');
      } else if (json.outcome === 'skipped') {
        toast.error('No active connection — please reconnect');
      } else {
        toast.error('Test push failed — check the connection');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not push test event';
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
      const res = await apiFetch('/api/calendar-integrations/google', { method: 'DELETE' });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      setIntegration({ ...integration, status: 'revoked' });
      toast.success('Calendar disconnected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not disconnect';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const isConnected = integration && integration.status === 'active';
  const isExpired = integration && integration.status === 'expired';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="calendar-sync-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Calendar size={16} className="text-slate-700" />
          </span>
          <h2 id="calendar-sync-title" className="flex-1 text-base text-slate-900">
            Calendar sync
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
            Connect your Google Calendar so appointments scheduled in Fieldly
            also land on your calendar. Two-way sync arrives in a follow-up
            release.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : isConnected ? (
            <div
              data-testid="calendar-sync-connected"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"
            >
              <p className="text-sm text-emerald-900">
                <span className="font-medium">Google Calendar connected</span>
              </p>
              <p className="text-xs text-emerald-800 mt-0.5">
                Account: {integration!.externalAccountEmail}
              </p>
            </div>
          ) : isExpired ? (
            <div
              data-testid="calendar-sync-expired"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2"
            >
              <AlertCircle size={16} className="text-amber-700 mt-0.5" />
              <div>
                <p className="text-sm text-amber-900">
                  Connection expired
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Reconnect to keep appointments syncing to {integration!.externalAccountEmail}.
                </p>
              </div>
            </div>
          ) : (
            <p
              data-testid="calendar-sync-not-connected"
              className="text-sm text-slate-500 italic"
            >
              No calendar connected.
            </p>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          {isConnected ? (
            <>
              <button
                type="button"
                onClick={testPush}
                disabled={busy}
                data-testid="calendar-sync-test-push"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {busy ? 'Testing…' : 'Test push'}
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                data-testid="calendar-sync-disconnect"
                className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
              >
                {busy ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              data-testid="calendar-sync-connect"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {busy ? 'Redirecting…' : isExpired ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
