import React, { useCallback, useMemo, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

export interface RescheduleDialogProps {
  appointmentId: string;
  initialStart?: string;
  initialEnd?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}

function toLocalInputValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // 'YYYY-MM-DDTHH:mm' for <input type="datetime-local">.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * P11-007 — RescheduleDialog.
 *
 * Lets an operator pick a new scheduledStart/End for an appointment and
 * PUTs the change to the API.
 */
export function RescheduleDialog({
  appointmentId,
  initialStart,
  initialEnd,
  onSaved,
  onCancel,
}: RescheduleDialogProps) {
  const apiFetch = useApiClient();
  const [start, setStart] = useState(() => toLocalInputValue(initialStart));
  const [end, setEnd] = useState(() => toLocalInputValue(initialEnd));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const valid = useMemo(() => {
    if (!start || !end) return false;
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && e > s;
  }, [start, end]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!valid) {
        setError('End must be after start.');
        return;
      }

      setSubmitting(true);
      try {
        const res = await apiFetch(`/api/appointments/${appointmentId}`, {
          method: 'PUT',
          body: JSON.stringify({
            scheduledStart: new Date(start).toISOString(),
            scheduledEnd: new Date(end).toISOString(),
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reschedule');
      } finally {
        setSubmitting(false);
      }
    },
    [appointmentId, start, end, valid, onSaved]
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  return (
    <form onSubmit={handleSubmit} data-testid="reschedule-dialog" className="space-y-3">
      <h2 className="text-base text-slate-900">Reschedule Appointment</h2>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <label className="block text-xs text-slate-500">
        New start
        <input
          aria-label="scheduledStart"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="block text-xs text-slate-500">
        New end
        <input
          aria-label="scheduledEnd"
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className={inputCls}
        />
      </label>

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={submitting || !valid}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
