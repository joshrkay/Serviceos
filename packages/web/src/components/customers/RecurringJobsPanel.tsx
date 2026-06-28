import React, { useCallback, useEffect, useState } from 'react';
import { Repeat, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select } from '../ui';
import {
  type RecurrenceFrequency,
  type RecurringJob,
  archiveRecurringJob as archiveApi,
  createRecurringJob as createApi,
  getRecurringJobOccurrences as occurrencesApi,
  listRecurringJobs as listApi,
} from '../../api/recurring-jobs';

/**
 * R-JOB (Jobber parity) — recurring job series for a customer.
 *
 * Lists the customer's recurring jobs with their schedule + next visit dates,
 * and lets the owner add or archive a series. Upcoming dates are computed
 * server-side. API fns are injectable so the panel renders in jsdom.
 */
export interface RecurringJobsPanelApi {
  list: typeof listApi;
  create: typeof createApi;
  archive: typeof archiveApi;
  occurrences: typeof occurrencesApi;
}

const DEFAULT_API: RecurringJobsPanelApi = {
  list: listApi,
  create: createApi,
  archive: archiveApi,
  occurrences: occurrencesApi,
};

const FREQUENCIES: { value: RecurrenceFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'daily', label: 'Daily' },
];

export function RecurringJobsPanel({
  customerId,
  api = DEFAULT_API,
}: {
  customerId: string;
  api?: RecurringJobsPanelApi;
}) {
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [nextDates, setNextDates] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [anchorDate, setAnchorDate] = useState('');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('monthly');
  const [interval, setIntervalValue] = useState(1);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.list(customerId);
      setJobs(list);
      const dates = await Promise.all(
        list.map((j) => api.occurrences(j.id, { limit: 3 }).then((o) => [j.id, o] as const)),
      );
      setNextDates(Object.fromEntries(dates));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recurring jobs');
    }
  }, [api, customerId]);

  useEffect(() => {
    setJobs([]);
    setNextDates({});
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (!title.trim() || !anchorDate) {
      setError('Give the recurring job a name and a first date.');
      return;
    }
    setSaving(true);
    try {
      await api.create({
        customerId,
        title: title.trim(),
        anchorDate,
        rule: { frequency, interval },
      });
      setTitle('');
      setAnchorDate('');
      setFrequency('monthly');
      setIntervalValue(1);
      setShowForm(false);
      await load();
      toast.success('Recurring job created');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create recurring job';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [api, customerId, title, anchorDate, frequency, interval, load]);

  const archive = useCallback(
    async (job: RecurringJob) => {
      try {
        await api.archive(job.id);
        await load();
        toast.success(`${job.title} stopped`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to stop recurring job');
      }
    },
    [api, load],
  );

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {jobs.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No recurring jobs. Set one up for repeat visits like maintenance or cleaning.
        </p>
      )}

      {jobs.map((job) => (
        <div key={job.id} className="rounded-lg border border-border px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-foreground font-medium truncate">{job.title}</p>
              <p className="text-xs text-muted-foreground">
                {job.scheduleSummary ?? job.rule?.frequency ?? 'Recurring'}
              </p>
              {nextDates[job.id]?.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Next: {nextDates[job.id].join(', ')}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label={`Stop ${job.title}`}
              onClick={() => archive(job)}
              className="flex items-center justify-center min-h-11 px-2 rounded-lg text-muted-foreground hover:text-destructive shrink-0"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="rounded-lg border border-border p-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              aria-label="Recurring job name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="min-h-11"
              placeholder="e.g. Monthly filter change"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">First visit</span>
              <Input
                aria-label="First visit date"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                className="min-h-11"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Repeats</span>
              <Select
                aria-label="Repeats"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
                className="min-h-11"
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Every</span>
              <Input
                aria-label="Interval"
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setIntervalValue(Math.max(1, Number(e.target.value) || 1))}
                className="min-h-11 w-20"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={add}
              disabled={saving}
              className="min-h-11 px-4 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-11 px-4 rounded-lg border border-border text-sm text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1 min-h-11 px-3 self-start rounded-lg border border-border text-sm text-primary"
        >
          <Repeat size={14} /> <Plus size={12} /> Add recurring job
        </button>
      )}
    </div>
  );
}
