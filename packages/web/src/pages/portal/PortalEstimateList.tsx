import { useEffect, useState } from 'react';
import {
  PortalEstimate,
  formatPortalCents,
  portalApi,
} from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';

export function PortalEstimateList({ token }: { token: string }) {
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

  if (!loaded) return <div className="text-slate-500">Loading estimates…</div>;
  if (error) return <div className="text-rose-600 text-sm">{error}</div>;
  if (estimates.length === 0) {
    return <div className="text-slate-500 text-sm">No estimates yet.</div>;
  }

  return (
    <div className="space-y-3">
      {estimates.map((e) => (
        <PortalCard
          key={e.id}
          title={e.estimateNumber}
          subtitle={`Status: ${e.status.replace(/_/g, ' ')}`}
          trailing={
            <span className="text-base font-semibold text-slate-900">
              {formatPortalCents(e.totalCents)}
            </span>
          }
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-slate-500">
              Created {new Date(e.createdAt).toLocaleDateString()}
              {e.validUntil
                ? ` · valid until ${new Date(e.validUntil).toLocaleDateString()}`
                : ''}
            </div>
            {e.publicViewToken ? (
              <a
                href={`/e/${e.publicViewToken}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-slate-900 underline"
              >
                View &amp; respond
              </a>
            ) : null}
          </div>
        </PortalCard>
      ))}
    </div>
  );
}
