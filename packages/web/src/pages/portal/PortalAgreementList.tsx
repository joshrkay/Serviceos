/**
 * P10-001 — Customer-facing list of recurring service agreements.
 *
 * Mirrors PortalEstimateList / PortalInvoiceList: load-on-mount, loading /
 * error / empty states, one PortalCard per agreement. We surface the
 * human-friendly next-service date rather than the raw RRULE recurrence.
 */
import { useEffect, useState } from 'react';
import { PortalAgreement, formatPortalCents, portalApi } from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';

export function PortalAgreementList({ token }: { token: string }) {
  const [agreements, setAgreements] = useState<PortalAgreement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .agreements(token)
      .then((r) => {
        if (cancelled) return;
        setAgreements(r.agreements);
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

  if (!loaded) return <div className="text-slate-500">Loading agreements…</div>;
  if (error) return <div className="text-rose-600 text-sm">{error}</div>;
  if (agreements.length === 0) {
    return <div className="text-slate-500 text-sm">No agreements yet.</div>;
  }

  return (
    <div className="space-y-3">
      {agreements.map((a) => (
        <PortalCard
          key={a.id}
          title={a.name}
          subtitle={`Status: ${a.status.replace(/_/g, ' ')}`}
          trailing={
            <span className="text-base font-semibold text-slate-900">
              {formatPortalCents(a.priceCents)}
            </span>
          }
        >
          {a.description ? (
            <div className="text-sm text-slate-700">{a.description}</div>
          ) : null}
          <div className="mt-2 text-xs text-slate-500">
            Next service {new Date(a.nextRunAt).toLocaleDateString()}
            {' · '}
            {new Date(a.startsOn).toLocaleDateString()} →{' '}
            {a.endsOn ? new Date(a.endsOn).toLocaleDateString() : 'ongoing'}
          </div>
        </PortalCard>
      ))}
    </div>
  );
}
