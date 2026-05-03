/**
 * P12-002 — WeeklyHours.
 *
 * Renders a per-day breakdown of the requesting tech's clock-in/out
 * hours for a given Monday-anchored week. Owner-mode (passing
 * `userIdOverride`) is supported so dispatchers can see a tech's
 * timesheet without impersonating.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  WeeklyHoursRollup,
  timeEntriesApi,
} from '../../api/time-entries';
import { useApiClient } from '../../lib/apiClient';

export interface WeeklyHoursProps {
  /** When set, view this user's hours instead of the signed-in user. */
  userIdOverride?: string;
  /** ISO date YYYY-MM-DD anchoring the start of the week (Monday). */
  weekOf?: string;
  /** Tenant tz override (defaults to America/Los_Angeles for now). */
  tz?: string;
}

function previousMondayIso(d: Date = new Date()): string {
  const dt = new Date(d);
  const day = dt.getUTCDay(); // 0 = Sun … 6 = Sat
  const diff = (day + 6) % 7; // days back to Monday
  dt.setUTCDate(dt.getUTCDate() - diff);
  return dt.toISOString().slice(0, 10);
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function buildWeekDates(weekStart: string): string[] {
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
}

export default function WeeklyHours({
  userIdOverride,
  weekOf,
  tz = 'America/Los_Angeles',
}: WeeklyHoursProps): JSX.Element {
  const fetcher = useApiClient();
  const { userId: signedInUserId } = useAuth();
  const userId = userIdOverride ?? signedInUserId ?? '';
  const week = weekOf ?? previousMondayIso();
  const [rollup, setRollup] = useState<WeeklyHoursRollup | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const result = await timeEntriesApi.weeklyHours(fetcher, {
          userId,
          weekOf: week,
          tz,
        });
        if (cancelled) return;
        setRollup(result[0] ?? { userId, weekStart: week, byDay: [], totalHours: 0 });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load hours');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetcher, userId, week, tz]);

  const dates = useMemo(() => buildWeekDates(week), [week]);

  if (!userId) {
    return <div className="p-4">Sign in to view hours.</div>;
  }
  if (loading) {
    return (
      <div className="p-4 text-slate-500" data-testid="weekly-hours-loading">
        Loading hours…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-red-600" data-testid="weekly-hours-error">
        {error}
      </div>
    );
  }

  const byDayMap = new Map<string, number>();
  rollup?.byDay.forEach((d) => byDayMap.set(d.date, d.hours));

  return (
    <div className="space-y-4 p-4" data-testid="weekly-hours">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Weekly hours</h1>
        <span className="text-sm text-slate-500">Week of {week}</span>
      </header>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-1">Day</th>
            <th className="py-1">Date</th>
            <th className="py-1 text-right">Hours</th>
          </tr>
        </thead>
        <tbody>
          {dates.map((date, i) => (
            <tr key={date} className="border-b border-slate-100">
              <td className="py-1 font-medium">{DAY_LABELS[i]}</td>
              <td className="py-1 text-slate-500">{date}</td>
              <td className="py-1 text-right font-mono" data-testid={`hours-${date}`}>
                {(byDayMap.get(date) ?? 0).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="py-2 font-semibold" colSpan={2}>
              Total
            </td>
            <td
              className="py-2 text-right font-mono font-semibold"
              data-testid="weekly-total"
            >
              {(rollup?.totalHours ?? 0).toFixed(2)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
