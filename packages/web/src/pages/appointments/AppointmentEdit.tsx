import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { RescheduleDialog } from '../../components/appointments/RescheduleDialog';
import { CancelDialog } from '../../components/appointments/CancelDialog';
import { ReassignDialog } from '../../components/appointments/ReassignDialog';

interface Appointment {
  id: string;
  jobId: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  assignedUserId?: string;
}

type DialogMode = 'reschedule' | 'cancel' | 'reassign' | null;

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
        <p>Start: {new Date(data.scheduledStart).toLocaleString()}</p>
        <p>End: {new Date(data.scheduledEnd).toLocaleString()}</p>
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
          initialAssignedUserId={data.assignedUserId}
          onSaved={handleSaved}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  );
}
