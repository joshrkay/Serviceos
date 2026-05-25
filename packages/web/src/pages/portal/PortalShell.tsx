/**
 * P10-001 — Shell for the customer self-service portal.
 *
 * Loads the customer for the active token + renders a tab nav into
 * the dashboard, estimates, invoices, jobs, and request-service pages.
 * Tenant branding (business name, etc.) flows through existing tenant
 * settings on the API side — the customer view here is intentionally
 * minimal so a tenant's brand colors show through.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { PortalCustomer, portalApi } from '../../api/portal';
import { PortalDashboard } from './PortalDashboard';
import { PortalEstimateList } from './PortalEstimateList';
import { PortalInvoiceList } from './PortalInvoiceList';
import { PortalJobList } from './PortalJobList';
import { PortalRequestService } from './PortalRequestService';
import { PortalBookAppointment } from './PortalBookAppointment';

type Tab = 'dashboard' | 'estimates' | 'invoices' | 'jobs' | 'book' | 'request';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'estimates', label: 'Estimates' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'book', label: 'Book appointment' },
  { id: 'request', label: 'Request service' },
];

export function PortalShell() {
  const { token = '' } = useParams<{ token: string }>();
  const [customer, setCustomer] = useState<PortalCustomer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('dashboard');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    portalApi
      .customer(token)
      .then((c) => {
        if (cancelled) return;
        setCustomer(c);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const greeting = useMemo(() => {
    if (!customer) return '';
    return customer.firstName || customer.companyName || customer.displayName;
  }, [customer]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500">Loading your portal…</div>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-rose-200 p-6 text-center">
          <div className="text-lg font-semibold text-slate-900">Portal unavailable</div>
          <div className="mt-2 text-sm text-slate-600">
            {error ?? 'This portal link is invalid or has expired.'}
          </div>
          <div className="mt-4 text-xs text-slate-400">
            If you received this link from your service provider, please reach out
            to them for a fresh link.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4">
          <div className="text-xs text-slate-500">Customer Portal</div>
          <div className="text-xl font-semibold text-slate-900">
            Welcome, {greeting}
          </div>
        </div>
        <nav className="max-w-3xl mx-auto px-4 sm:px-6 -mb-px overflow-x-auto">
          <div className="flex gap-2 sm:gap-4">
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={
                    'whitespace-nowrap py-2 px-1 text-sm border-b-2 ' +
                    (active
                      ? 'border-slate-900 text-slate-900 font-medium'
                      : 'border-transparent text-slate-500 hover:text-slate-700')
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {tab === 'dashboard' && <PortalDashboard token={token} customer={customer} />}
        {tab === 'estimates' && <PortalEstimateList token={token} />}
        {tab === 'invoices' && <PortalInvoiceList token={token} />}
        {tab === 'jobs' && <PortalJobList token={token} />}
        {tab === 'book' && <PortalBookAppointment token={token} />}
        {tab === 'request' && <PortalRequestService token={token} />}
      </main>
    </div>
  );
}
