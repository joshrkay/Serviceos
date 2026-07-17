import { useEffect, useState } from 'react';
import {
  PortalInvoice,
  formatPortalCents,
  portalApi,
  PORTAL_FALLBACK_TZ,
} from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';
import { formatDateInTenantTz } from '../../utils/formatInTenantTz';

export function PortalInvoiceList({ token, timezone = PORTAL_FALLBACK_TZ }: { token: string; timezone?: string }) {
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

  if (!loaded) return <div className="text-muted-foreground">Loading invoices…</div>;
  if (error) return <div className="text-destructive text-sm">{error}</div>;
  if (invoices.length === 0) {
    return <div className="text-muted-foreground text-sm">No invoices yet.</div>;
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
              <div className="text-base font-semibold text-foreground">
                {formatPortalCents(inv.totalCents)}
              </div>
              {inv.amountDueCents > 0 ? (
                <div className="text-xs text-destructive">
                  {formatPortalCents(inv.amountDueCents)} due
                </div>
              ) : (
                <div className="text-xs text-success">Paid</div>
              )}
            </div>
          }
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {inv.dueDate
                ? `Due ${formatDateInTenantTz(inv.dueDate, timezone, { withYear: true })}`
                : `Issued ${
                    inv.issuedAt
                      ? formatDateInTenantTz(inv.issuedAt, timezone, { withYear: true })
                      : formatDateInTenantTz(inv.createdAt, timezone, { withYear: true })
                  }`}
            </div>
            {inv.payNowUrl && inv.amountDueCents > 0 ? (
              <a
                href={inv.payNowUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-white hover:bg-primary/90"
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
