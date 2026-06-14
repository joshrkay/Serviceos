import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ScheduleEntry } from '@rivet/contracts';
import { api } from '../lib/api';

const APPT_STYLES: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-stone-200 text-stone-500',
};

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function groupByDay(entries: ScheduleEntry[]): Array<[string, ScheduleEntry[]]> {
  const groups = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    const key = dayLabel(entry.startsAt);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()];
}

function ScheduleJobForm({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const [date, setDate] = useState(tomorrow.toISOString().slice(0, 10));
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const schedule = useMutation({
    mutationFn: () =>
      api.jobs.schedule({
        params: { id: jobId },
        body: {
          startsAt: new Date(`${date}T${time}:00`).toISOString(),
          durationMinutes: duration,
        },
      }),
    onSuccess: onDone,
  });
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        className="rounded-lg border border-stone-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
      />
      <input
        type="time"
        value={time}
        onChange={(event) => setTime(event.target.value)}
        className="rounded-lg border border-stone-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
      />
      <select
        value={duration}
        onChange={(event) => setDuration(Number(event.target.value))}
        className="rounded-lg border border-stone-300 px-2 py-1 text-xs focus:border-amber-500 focus:outline-none"
      >
        {[30, 60, 90, 120, 180, 240].map((minutes) => (
          <option key={minutes} value={minutes}>
            {minutes} min
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={schedule.isPending}
        onClick={() => schedule.mutate()}
        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-700 disabled:opacity-50"
      >
        Schedule
      </button>
    </div>
  );
}

export default function SchedulePage() {
  const queryClient = useQueryClient();
  const schedule = useQuery({
    queryKey: ['schedule'],
    queryFn: async () => {
      const result = await api.appointments.list({ query: {} });
      if (result.status !== 200) throw new Error('failed');
      return result.body.appointments;
    },
    refetchInterval: 5_000,
  });
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: async () => {
      const result = await api.jobs.list();
      if (result.status !== 200) throw new Error('failed');
      return result.body.jobs;
    },
    refetchInterval: 5_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };
  const complete = useMutation({
    mutationFn: (id: string) => api.appointments.complete({ params: { id }, body: {} }),
    onSettled: invalidate,
  });

  const unscheduled = (jobs.data ?? []).filter((job) => job.status === 'unscheduled');

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Schedule</h1>
      <p className="mt-1 text-sm text-stone-500">
        Your day, as booked by you or the AI (every AI booking arrived here through an approved
        proposal).
      </p>

      {unscheduled.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-700">
            Needs scheduling
          </h2>
          <div className="mt-3 space-y-2">
            {unscheduled.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3"
              >
                <div>
                  <div className="font-medium">{job.title}</div>
                  <div className="text-xs text-stone-500">{job.customerName}</div>
                </div>
                <ScheduleJobForm jobId={job.id} onDone={invalidate} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Upcoming</h2>
        {schedule.isLoading && <div className="mt-3 text-sm text-stone-500">Loading…</div>}
        {!schedule.isLoading && (schedule.data ?? []).length === 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            Nothing on the books yet.
          </div>
        )}
        <div className="mt-3 space-y-6">
          {groupByDay(schedule.data ?? []).map(([day, entries]) => (
            <div key={day}>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-400">{day}</div>
              <div className="mt-2 overflow-hidden rounded-xl border border-stone-200 bg-white">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-5 py-3 last:border-b-0"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-28 shrink-0 text-sm font-semibold">
                        {new Date(entry.startsAt).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        {' – '}
                        {new Date(entry.endsAt).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{entry.jobTitle}</div>
                        <div className="text-xs text-stone-500">
                          {entry.customerName} · {entry.customerPhone}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${APPT_STYLES[entry.status] ?? ''}`}
                      >
                        {entry.status}
                      </span>
                      {entry.status === 'scheduled' && (
                        <button
                          type="button"
                          onClick={() => complete.mutate(entry.id)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                        >
                          Mark done
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
