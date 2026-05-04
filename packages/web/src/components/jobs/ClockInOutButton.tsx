/**
 * P12-002 — ClockInOutButton.
 *
 * Single-active-entry UX: on mount we fetch the user's currently-open
 * time entry. The button label flips between "Clock In" and
 * "Clock Out (Xh Ym)" based on whether an entry is active for THIS job.
 *
 * The component takes its `fetcher` as a prop so the parent (which
 * already pulls `useApiClient()`) controls auth wiring AND tests can
 * inject a mock without standing up Clerk.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ClockInBody,
  EntryType,
  TimeEntry,
  timeEntriesApi,
} from '../../api/time-entries';
import type { ApiFetch } from '../../lib/apiClient';

export interface ClockInOutButtonProps {
  fetcher: ApiFetch;
  jobId: string;
  userId: string;
  entryType?: EntryType;
  /** When supplied, called after a clock-in or clock-out completes. */
  onChange?: (entry: TimeEntry | null) => void;
}

function formatElapsed(active: TimeEntry, now: Date): string {
  const start = new Date(active.clockedInAt).getTime();
  const ms = Math.max(0, now.getTime() - start);
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function ClockInOutButton({
  fetcher,
  jobId,
  userId,
  entryType = 'job',
  onChange,
}: ClockInOutButtonProps): JSX.Element {
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());

  // Re-render once a minute while a shift is open so the elapsed-time
  // label stays current. Cleaned up on unmount.
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, [active]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { active: a } = await timeEntriesApi.getActive(fetcher, userId);
      setActive(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, [fetcher, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleClockIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ClockInBody = { userId, jobId, entryType };
      const entry = await timeEntriesApi.clockIn(fetcher, body);
      setActive(entry);
      onChange?.(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock in');
    } finally {
      setBusy(false);
    }
  };

  const handleClockOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const closed = await timeEntriesApi.clockOut(fetcher, { userId });
      setActive(null);
      onChange?.(closed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock out');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <button
        type="button"
        disabled
        className="rounded bg-slate-200 px-4 py-2 text-slate-500"
        data-testid="clock-loading"
      >
        Loading…
      </button>
    );
  }

  // Active entry exists but for a DIFFERENT job — render disabled
  // ClockIn so the tech doesn't accidentally start two shifts at once.
  if (active && active.jobId && active.jobId !== jobId) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          className="rounded bg-amber-200 px-4 py-2 text-amber-900"
          data-testid="clock-busy-elsewhere"
          title={`Active on another job (${active.jobId.slice(0, 8)}…)`}
        >
          Clocked in on another job
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    );
  }

  if (active) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={handleClockOut}
          disabled={busy}
          className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
          data-testid="clock-out-button"
        >
          Clock Out ({formatElapsed(active, now)})
        </button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleClockIn}
        disabled={busy}
        className="rounded bg-emerald-600 px-4 py-2 text-white disabled:opacity-50"
        data-testid="clock-in-button"
      >
        Clock In
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
