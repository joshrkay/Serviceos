/**
 * Payment methods — Stripe Connect onboarding so customer-facing
 * payments route into the tenant's bank. Connect lifecycle, status,
 * and manual disconnect.
 */
import { useEffect, useState } from 'react';
import { X, CreditCard, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface ConnectAccountView {
  accountId: string | null;
  status: 'pending' | 'active' | 'restricted' | 'disconnected';
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

interface PaymentMethodsSheetProps {
  onClose: () => void;
}

const STATUS_LABEL: Record<ConnectAccountView['status'], string> = {
  pending: 'Setup incomplete',
  active: 'Active',
  restricted: 'Restricted by Stripe',
  disconnected: 'Disconnected',
};

const STATUS_COLOR: Record<ConnectAccountView['status'], string> = {
  pending: 'bg-amber-100 text-amber-900',
  active: 'bg-emerald-100 text-emerald-900',
  restricted: 'bg-red-100 text-red-900',
  disconnected: 'bg-slate-100 text-slate-700',
};

export function PaymentMethodsSheet({ onClose }: PaymentMethodsSheetProps) {
  const [view, setView] = useState<ConnectAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/billing/connect');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as ConnectAccountView;
        if (!cancelled) setView(json);
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

  async function startOnboarding() {
    setBusy(true);
    setError('');
    try {
      const settingsUrl = `${window.location.origin}/settings?stripe_connect=1`;
      const res = await apiFetch('/api/billing/connect/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: settingsUrl,
          refreshUrl: settingsUrl,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Onboarding failed (${res.status})`);
      }
      const json = (await res.json()) as { url: string };
      window.location.assign(json.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not start Stripe onboarding';
      setError(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/billing/connect', { method: 'DELETE' });
      if (!res.ok) throw new Error(`Disconnect failed (${res.status})`);
      const json = (await res.json()) as { disconnected: boolean };
      if (json.disconnected && view) {
        setView({ ...view, status: 'disconnected', chargesEnabled: false, payoutsEnabled: false });
        toast.success('Stripe Connect disconnected');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not disconnect';
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const status = view?.status ?? 'pending';
  const isActive = status === 'active' && view?.chargesEnabled === true;
  const hasAccount = Boolean(view?.accountId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="payment-methods-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <CreditCard size={16} className="text-slate-700" />
          </span>
          <h2 id="payment-methods-title" className="flex-1 text-base text-slate-900">
            Payment methods
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
            Connect your Stripe account to accept card and ACH payments from
            customers. Stripe handles compliance and routes funds directly to
            your bank.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : isActive ? (
            <div
              data-testid="payment-methods-active"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"
            >
              <p className="text-sm text-emerald-900 font-medium">Stripe Connect active</p>
              <p className="text-xs text-emerald-800 mt-0.5">
                Charges and payouts enabled. Customer payments route directly to your bank.
              </p>
            </div>
          ) : hasAccount && status === 'pending' ? (
            <div
              data-testid="payment-methods-pending"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2"
            >
              <AlertCircle size={16} className="text-amber-700 mt-0.5" />
              <div>
                <p className="text-sm text-amber-900">Setup incomplete</p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Stripe needs more information before charges can be enabled.
                </p>
              </div>
            </div>
          ) : status === 'restricted' ? (
            <div
              data-testid="payment-methods-restricted"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-2"
            >
              <AlertCircle size={16} className="text-red-700 mt-0.5" />
              <div>
                <p className="text-sm text-red-900">Account restricted</p>
                <p className="text-xs text-red-800 mt-0.5">
                  Stripe has paused this account. Open Stripe to resolve.
                </p>
              </div>
            </div>
          ) : (
            <p
              data-testid="payment-methods-not-connected"
              className="text-sm text-slate-500 italic"
            >
              No payment processor connected.
            </p>
          )}

          {view && (
            <div className="text-xs text-slate-500">
              Status:{' '}
              <span
                className={`rounded-full px-2 py-0.5 ${STATUS_COLOR[status]}`}
                data-testid="payment-methods-status"
              >
                {STATUS_LABEL[status]}
              </span>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          {isActive ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              data-testid="payment-methods-disconnect"
              className="rounded-xl border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : (
            <button
              type="button"
              onClick={startOnboarding}
              disabled={busy}
              data-testid="payment-methods-connect"
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {busy
                ? 'Redirecting…'
                : hasAccount
                ? 'Continue Stripe setup'
                : 'Connect Stripe account'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
