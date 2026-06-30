import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Input, Select, Field, Button } from '../ui';
import { useTechnicianRoster } from '../../hooks/useTechnicianRoster';

interface Appointment {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  idempotencyKey?: string | null;
}

export interface JobSchedulePanelProps {
  jobId: string;
  /** The job's denormalized primary technician id (for display + reschedule default). */
  assignedTechnicianId?: string;
  /** Fired after a successful change so the parent can refetch the job (status). */
  onChanged?: () => void;
}

/** Render an ISO instant as a `datetime-local` value in the browser's local tz. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Schedule / reschedule / reassign / unschedule a job directly from its
 * detail page. Reads the job's active appointment (GET /api/appointments)
 * and drives the POST /api/jobs/:id/{schedule,reassign,unschedule} endpoints.
 */
export function JobSchedulePanel({ jobId, assignedTechnicianId, onChanged }: JobSchedulePanelProps) {
  const { technicians } = useTechnicianRoster();
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [durationMin, setDurationMin] = useState('60');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/appointments?jobId=${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: Appointment[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      // Scope to THIS path's canonical appointment (key `job-schedule:<jobId>`),
      // not just any non-canceled one — a job may also carry an estimate
      // appointment (`from-estimate:…`), which this panel must not display or
      // mutate (the schedule/reschedule/unschedule endpoints target the
      // canonical row server-side).
      const key = `job-schedule:${jobId}`;
      const active = list.find((a) => a.idempotencyKey === key && a.status !== 'canceled') ?? null;
      setAppointment(active);
      if (active) setStart(toLocalInput(active.scheduledStart));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedule');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Mirror the job's denormalized primary tech — including clearing back to
  // "Unassigned" when it becomes undefined (e.g. after a reassign-to-null),
  // so a subsequent reschedule never re-sends a technician the user removed.
  useEffect(() => {
    setTechnicianId(assignedTechnicianId ?? '');
  }, [assignedTechnicianId]);

  const call = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/jobs/${jobId}${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j?.message ?? `HTTP ${res.status}`);
        }
        await load();
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [jobId, load, onChanged],
  );

  const submitSchedule = () => {
    if (!start) {
      setError('Start time is required.');
      return;
    }
    const dur = parseInt(durationMin, 10);
    void call('/schedule', {
      scheduledStart: new Date(start).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(Number.isFinite(dur) && dur > 0 ? { durationMin: dur } : {}),
      ...(technicianId ? { technicianId } : {}),
    });
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading schedule…</p>;
  }

  const techName = assignedTechnicianId
    ? technicians.find((t) => t.id === assignedTechnicianId)?.name ?? 'Assigned'
    : 'Unassigned';

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <p className="text-sm text-foreground" data-testid="current-schedule">
        {appointment
          ? `Scheduled for ${new Date(appointment.scheduledStart).toLocaleString()} · ${techName}`
          : 'Not scheduled.'}
      </p>

      <Field label={appointment ? 'Reschedule start' : 'Start time'}>
        <Input
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="min-h-11"
        />
      </Field>

      <Field label="Technician">
        <Select
          value={technicianId}
          onChange={(e) => setTechnicianId(e.target.value)}
          className="min-h-11"
        >
          <option value="">Unassigned</option>
          {technicians.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>

      {!appointment && (
        <Field label="Duration (minutes)">
          <Input
            type="number"
            min={1}
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
            className="min-h-11"
          />
        </Field>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={submitSchedule} disabled={busy} className="min-h-11">
          {appointment ? 'Reschedule' : 'Schedule'}
        </Button>
        {appointment && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="min-h-11"
              onClick={() => void call('/reassign', { technicianId: technicianId || null })}
            >
              Reassign
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className="min-h-11"
              onClick={() => void call('/unschedule', {})}
            >
              Unschedule
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default JobSchedulePanel;
