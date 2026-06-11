import React, { useCallback, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

export interface CancelDialogProps {
  appointmentId: string;
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * P11-007 — CancelDialog.
 *
 * Confirms cancellation of an appointment and captures a free-form reason.
 * PUTs status='cancelled' + cancelReason to the API.
 */
export function CancelDialog({ appointmentId, onSaved, onCancel }: CancelDialogProps) {
  const apiFetch = useApiClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!reason.trim()) {
        setError('Reason is required.');
        return;
      }

      setSubmitting(true);
      try {
        const res = await apiFetch(`/api/appointments/${appointmentId}`, {
          method: 'PUT',
          body: JSON.stringify({
            status: 'cancelled',
            cancelReason: reason.trim(),
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to cancel appointment');
      } finally {
        setSubmitting(false);
      }
    },
    [appointmentId, reason, onSaved]
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  return (
    <form onSubmit={handleSubmit} data-testid="cancel-dialog" className="space-y-3">
      <h2 className="text-base text-slate-900">Cancel Appointment</h2>
      <p className="text-sm text-slate-600">
        This will mark the appointment as cancelled. The customer may receive a notification.
      </p>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <label className="block text-xs text-slate-500">
        Cancellation reason
        <textarea
          aria-label="cancelReason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className={inputCls}
        />
      </label>

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-red-600 text-white text-sm px-4 py-2 hover:bg-red-700 disabled:opacity-50"
        >
          {submitting ? 'Cancelling…' : 'Confirm cancellation'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Back
        </button>
      </div>
    </form>
  );
}
