import { useEffect, useState } from 'react';
import {
  PortalEstimate,
  formatPortalCents,
  portalApi,
  PORTAL_FALLBACK_TZ,
} from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';
import { formatDateInTenantTz } from '../../utils/formatInTenantTz';

export function PortalEstimateList({ token, timezone = PORTAL_FALLBACK_TZ }: { token: string; timezone?: string }) {
  const [estimates, setEstimates] = useState<PortalEstimate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .estimates(token)
      .then((r) => {
        if (cancelled) return;
        setEstimates(r.estimates);
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

  if (!loaded) return <div className="text-muted-foreground">Loading estimates…</div>;
  if (error) return <div className="text-destructive text-sm">{error}</div>;
  if (estimates.length === 0) {
    return <div className="text-muted-foreground text-sm">No estimates yet.</div>;
  }

  return (
    <div className="space-y-3">
      {estimates.map((e) => {
        // depositPayable is true only for the accepted estimate that still
        // owes a deposit (server-gated), so the badge/CTA never bleed onto
        // sibling estimates of the same job.
        const depositRemainingCents = Math.max(
          0,
          (e.depositRequiredCents ?? 0) - (e.depositPaidCents ?? 0),
        );
        const depositPaid =
          e.status === 'accepted' && e.depositStatus === 'paid';
        return (
          <PortalCard
            key={e.id}
            title={e.estimateNumber}
            subtitle={`Status: ${e.status.replace(/_/g, ' ')}`}
            trailing={
              <div className="text-right">
                <div className="text-base font-semibold text-foreground">
                  {formatPortalCents(e.totalCents)}
                </div>
                {e.depositPayable ? (
                  <div className="text-xs text-destructive">
                    {formatPortalCents(depositRemainingCents)} deposit due
                  </div>
                ) : depositPaid ? (
                  <div className="text-xs text-success">Deposit paid</div>
                ) : null}
              </div>
            }
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-xs text-muted-foreground">
                Created {formatDateInTenantTz(e.createdAt, timezone, { withYear: true })}
                {e.validUntil
                  ? ` · valid until ${formatDateInTenantTz(e.validUntil, timezone, { withYear: true })}`
                  : ''}
              </div>
              {e.publicViewToken ? (
                <a
                  href={`/e/${e.publicViewToken}`}
                  target="_blank"
                  rel="noreferrer"
                  className={
                    e.depositPayable
                      ? 'inline-flex min-h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-white hover:bg-primary/90'
                      : 'inline-flex min-h-11 items-center text-sm font-medium text-foreground underline'
                  }
                >
                  {e.depositPayable ? 'Pay deposit' : 'View & respond'}
                </a>
              ) : null}
            </div>
          </PortalCard>
        );
      })}
    </div>
  );
}
