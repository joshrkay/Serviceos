import { useEffect, useState } from 'react';
import { PortalJob, portalApi, PORTAL_FALLBACK_TZ } from '../../api/portal';
import { PortalCard } from '../../components/portal/PortalCard';
import { formatDateInTenantTz } from '../../utils/formatInTenantTz';

export function PortalJobList({ token, timezone = PORTAL_FALLBACK_TZ }: { token: string; timezone?: string }) {
  const [jobs, setJobs] = useState<PortalJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .jobs(token)
      .then((r) => {
        if (cancelled) return;
        setJobs(r.jobs);
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

  if (!loaded) return <div className="text-muted-foreground">Loading jobs…</div>;
  if (error) return <div className="text-destructive text-sm">{error}</div>;
  if (jobs.length === 0) {
    return <div className="text-muted-foreground text-sm">No service jobs yet.</div>;
  }

  return (
    <div className="space-y-3">
      {jobs.map((j) => (
        <PortalCard
          key={j.id}
          title={`${j.jobNumber} · ${j.summary}`}
          subtitle={`Priority: ${j.priority}`}
          trailing={
            <span className="text-sm font-medium text-foreground">
              {j.status.replace(/_/g, ' ')}
            </span>
          }
        >
          <div className="text-xs text-muted-foreground">
            Opened {formatDateInTenantTz(j.createdAt, timezone, { withYear: true })}
          </div>
        </PortalCard>
      ))}
    </div>
  );
}
