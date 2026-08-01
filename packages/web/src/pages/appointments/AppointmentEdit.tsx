import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { RescheduleDialog } from '../../components/appointments/RescheduleDialog';
import { CancelDialog } from '../../components/appointments/CancelDialog';
import { ReassignDialog } from '../../components/appointments/ReassignDialog';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatDateTimeInTenantTz } from '../../utils/formatInTenantTz';

const DELAY_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
type DelayMinutes = typeof DELAY_OPTIONS[number];

function NotifyDelayDialog({
  appointmentId,
  onDone,
  onCancel,
}: {
  appointmentId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [minutes, setMinutes] = useState<DelayMinutes>(20);
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function send() {
    setStatus('sending');
    setErrorMsg(null);
    try {
      const res = await apiFetch(`/api/appointments/${appointmentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'running_late', delayMinutes: minutes }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      setStatus('done');
      setTimeout(onDone, 1200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send delay notice');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        Delay notice queued — next customer will receive an SMS.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
      <p className="text-sm font-medium text-amber-900">Notify next customer of delay</p>
      <div className="flex flex-wrap gap-2">
        {DELAY_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setMinutes(opt)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              minutes === opt
                ? 'border-amber-500 bg-amber-500 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {opt} min
          </button>
        ))}
      </div>
      {errorMsg && (
        <p className="text-xs text-red-600">{errorMsg}</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={status === 'sending'}
          onClick={send}
          className="rounded-lg bg-amber-600 text-white text-sm px-4 py-2 hover:bg-amber-700 disabled:opacity-60"
        >
          {status === 'sending' ? 'Sending…' : 'Confirm delay'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Appointment {
  id: string;
  jobId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  assignedUserId?: string;
}

type DialogMode = 'reschedule' | 'cancel' | 'reassign' | 'delay' | null;

export interface AppointmentEditProps {
  appointmentId: string;
  onSaved?: () => void;
  onBack?: () => void;
}

/**
 * P11-007 — AppointmentEdit.
 *
 * Single page that loads the appointment and lets the operator choose
 * one of three actions: reschedule, cancel, or reassign. Each action
 * mounts its own dialog component which owns the PUT call.
 */
export function AppointmentEdit({ appointmentId, onSaved, onBack }: AppointmentEditProps) {
  const [data, setData] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DialogMode>(null);
  const timezone = useTenantTimezone();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/appointments/${appointmentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load appointment');
    } finally {
      setLoading(false);
    }
  }, [appointmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSaved = useCallback(() => {
    setMode(null);
    onSaved?.();
    load();
  }, [load, onSaved]);

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="appointment-edit-loading">
        Loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-6 max-w-2xl mx-auto">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error ?? 'Appointment not found.'}
        </div>
        <button
          type="button"
          onClick={onBack}
          className="mt-3 rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="appointment-edit">
      <h1 className="text-lg text-slate-900 mb-4">Edit Appointment</h1>

      <div className="rounded-lg border border-slate-200 p-4 mb-4 text-sm text-slate-700 space-y-1">
        <p>Job: {data.jobId}</p>
        <p>Status: {data.status}</p>
        <p>Start: {formatDateTimeInTenantTz(data.scheduledStart, timezone)}</p>
        <p>End: {formatDateTimeInTenantTz(data.scheduledEnd, timezone)}</p>
      </div>

      {mode === null && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode('reschedule')}
            className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800"
          >
            Reschedule
          </button>
          <button
            type="button"
            onClick={() => setMode('reassign')}
            className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
          >
            Reassign
          </button>
          <button
            type="button"
            onClick={() => setMode('delay')}
            className="rounded-lg border border-amber-400 bg-amber-50 text-amber-800 text-sm px-4 py-2 hover:bg-amber-100"
          >
            Notify delay
          </button>
          <button
            type="button"
            onClick={() => setMode('cancel')}
            className="rounded-lg bg-red-600 text-white text-sm px-4 py-2 hover:bg-red-700"
          >
            Cancel appointment
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
          >
            Back
          </button>
        </div>
      )}

      {mode === 'reschedule' && (
        <RescheduleDialog
          appointmentId={appointmentId}
          initialStart={data.scheduledStart}
          initialEnd={data.scheduledEnd}
          onSaved={handleSaved}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === 'cancel' && (
        <CancelDialog
          appointmentId={appointmentId}
          onSaved={handleSaved}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === 'reassign' && (
        <ReassignDialog
          appointmentId={appointmentId}
          jobId={data.jobId}
          initialAssignedUserId={data.assignedUserId}
          onSaved={handleSaved}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === 'delay' && (
        <NotifyDelayDialog
          appointmentId={appointmentId}
          onDone={handleSaved}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  );
}
