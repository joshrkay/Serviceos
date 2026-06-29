import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  type FinancingApplication,
  type FinancingStatus,
  listFinancing as listApi,
  offerFinancing as offerApi,
} from '../../api/financing';
import { formatCurrency as formatCents } from '../../utils/currency';

/**
 * FIN (Jobber parity) — offer consumer financing on an invoice.
 *
 * Lists existing financing offers with status + the consumer apply link, and
 * lets the owner offer financing (defaults to the invoice amount due). API fns
 * are injectable so the panel renders in jsdom without a network.
 */
export interface InvoiceFinancingPanelApi {
  list: typeof listApi;
  offer: typeof offerApi;
}

const DEFAULT_API: InvoiceFinancingPanelApi = { list: listApi, offer: offerApi };

const STATUS_LABEL: Record<FinancingStatus, string> = {
  offered: 'Offered',
  prequalified: 'Pre-qualified',
  approved: 'Approved',
  declined: 'Declined',
  funded: 'Funded',
  expired: 'Expired',
  canceled: 'Canceled',
};

export function InvoiceFinancingPanel({
  invoiceId,
  api = DEFAULT_API,
}: {
  invoiceId: string;
  api?: InvoiceFinancingPanelApi;
}) {
  const [apps, setApps] = useState<FinancingApplication[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setApps(await api.list(invoiceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load financing');
    }
  }, [api, invoiceId]);

  useEffect(() => {
    setApps([]);
    void load();
  }, [load]);

  const offer = useCallback(async () => {
    setOffering(true);
    try {
      await api.offer(invoiceId, {});
      await load();
      toast.success('Financing offered');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to offer financing');
    } finally {
      setOffering(false);
    }
  }, [api, invoiceId, load]);

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {apps.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          Let the customer pay over time. Offer financing and we'll send them an application link.
        </p>
      )}
      {apps.map((app) => (
        <div key={app.id} className="rounded-lg border border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground font-medium">{formatCents(app.amountCents)}</span>
            <span className="text-xs rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
              {STATUS_LABEL[app.status]}
            </span>
          </div>
          {app.applicationUrl ? (
            <a
              href={app.applicationUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline"
            >
              Customer application link
            </a>
          ) : (
            <p className="text-xs text-muted-foreground">
              {app.provider === 'manual'
                ? 'Arrange financing manually — no provider connected.'
                : 'Application link pending.'}
            </p>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={offer}
        disabled={offering}
        className="min-h-11 px-4 self-start rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
      >
        {offering ? 'Offering…' : 'Offer financing'}
      </button>
    </div>
  );
}
