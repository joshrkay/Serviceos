import { useEffect, useState } from 'react';
import {
  PortalInvoice,
  formatPortalCents,
  portalApi,
} from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';

export function PortalInvoiceList({ token }: { token: string }) {
  const [invoices, setInvoices] = useState<PortalInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .invoices(token)
      .then((r) => {
        if (cancelled) return;
        setInvoices(r.invoices);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!loaded) return <div className="text-slate-500">Loading invoices…</div>;
  if (error) return <div className="text-rose-600 text-sm">{error}</div>;
  if (invoices.length === 0) {
    return <div className="text-slate-500 text-sm">No invoices yet.</div>;
  }

  return (
    <div className="space-y-3">
      {invoices.map((inv) => (
        <PortalCard
          key={inv.id}
          title={inv.invoiceNumber}
          subtitle={`Status: ${inv.status.replace(/_/g, ' ')}`}
          trailing={
            <div className="text-right">
              <div className="text-base font-semibold text-slate-900">
                {formatPortalCents(inv.totalCents)}
              </div>
              {inv.amountDueCents > 0 ? (
                <div className="text-xs text-rose-600">
                  {formatPortalCents(inv.amountDueCents)} due
                </div>
              ) : (
                <div className="text-xs text-emerald-600">Paid</div>
              )}
            </div>
          }
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              {inv.dueDate
                ? `Due ${new Date(inv.dueDate).toLocaleDateString()}`
                : `Issued ${
                    inv.issuedAt
                      ? new Date(inv.issuedAt).toLocaleDateString()
                      : new Date(inv.createdAt).toLocaleDateString()
                  }`}
            </div>
            {inv.payNowUrl && inv.amountDueCents > 0 ? (
              <a
                href={inv.payNowUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                Pay now
              </a>
            ) : null}
          </div>
        </PortalCard>
      ))}
    </div>
  );
}
