/**
 * P12-002 — Per-job time-entry page.
 *
 * Shows the user's current ClockInOutButton for this job and the
 * recent entries on the same job_id. Mounted at
 * /jobs/:jobId/time. Wiring at the route layer happens in a follow-up;
 * this page is reachable directly when a tech links to it.
 */
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '@clerk/clerk-react';
import { ClockInOutButton } from '../../components/jobs/ClockInOutButton';
import { TimeEntry, timeEntriesApi } from '../../api/time-entries';
import { useApiClient } from '../../lib/apiClient';

export default function JobTimeEntry(): JSX.Element {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId ?? '';
  const fetcher = useApiClient();
  const { userId } = useAuth();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const data = (await timeEntriesApi.list(fetcher, {
        userId: userId ?? undefined,
        limit: 25,
      })) as TimeEntry[];
      const forJob = data.filter((e) => e.jobId === jobId);
      setEntries(forJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load entries');
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, userId]);

  if (!userId) {
    return <div className="p-4">Sign in to track time.</div>;
  }

  return (
    <div className="space-y-4 p-4" data-testid="job-time-entry">
      <h1 className="text-xl font-semibold">Time on this job</h1>
      <ClockInOutButton
        fetcher={fetcher}
        jobId={jobId}
        userId={userId}
        onChange={() => void refresh()}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div>
        <h2 className="mb-2 text-lg font-medium">Recent entries</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet for this job.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex justify-between rounded border border-border px-3 py-2"
              >
                <span>
                  {new Date(e.clockedInAt).toLocaleString()} —{' '}
                  {e.clockedOutAt
                    ? new Date(e.clockedOutAt).toLocaleString()
                    : 'in progress'}
                </span>
                <span className="font-mono">
                  {e.durationMinutes !== undefined
                    ? `${(e.durationMinutes / 60).toFixed(2)}h`
                    : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
