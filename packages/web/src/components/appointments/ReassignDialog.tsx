import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';

interface UserOption {
  id: string;
  name?: string;
  email?: string;
}

export interface ReassignDialogProps {
  appointmentId: string;
  /**
   * The appointment's parent job. Assignment is persisted on the job's
   * `assignedTechnicianId` — the appointment PUT has no assignment field,
   * so the previous `PUT /api/appointments/:id { assignedUserId }` was a
   * silent no-op that faked success.
   */
  jobId: string;
  initialAssignedUserId?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * P11-007 — ReassignDialog.
 *
 * Loads the technician roster from /api/users?role=technician (when
 * available) and assigns the chosen technician to the appointment's job
 * via PUT /api/jobs/:id { assignedTechnicianId }. If the users endpoint
 * isn't reachable, we fall back to a manual ID input so the operator
 * is never blocked.
 */
export function ReassignDialog({
  appointmentId,
  jobId,
  initialAssignedUserId,
  onSaved,
  onCancel,
}: ReassignDialogProps) {
  const [users, setUsers] = useState<UserOption[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(initialAssignedUserId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/users?role=technician');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        const list: UserOption[] = Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json)
          ? json
          : [];
        if (!cancelled) setUsers(list);
      } catch (err) {
        if (!cancelled) {
          setUsersError(err instanceof Error ? err.message : 'Failed to load users');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!selectedId.trim()) {
        setError('Pick a user to reassign to.');
        return;
      }

      setSubmitting(true);
      try {
        // Assignment lives on the job, not the appointment — the appointment
        // update endpoint ignores assignment fields entirely.
        const res = await apiFetch(`/api/jobs/${jobId}`, {
          method: 'PUT',
          body: JSON.stringify({ assignedTechnicianId: selectedId.trim() }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reassign');
      } finally {
        setSubmitting(false);
      }
    },
    [jobId, selectedId, onSaved]
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  return (
    <form onSubmit={handleSubmit} data-testid="reassign-dialog" className="space-y-3">
      <h2 className="text-base text-slate-900">Reassign Appointment</h2>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {usersError ? (
        <label className="block text-xs text-slate-500">
          User ID (roster failed to load — enter manually)
          <input
            aria-label="assignedUserId"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className={inputCls}
          />
        </label>
      ) : (
        <label className="block text-xs text-slate-500">
          Assign to
          <select
            aria-label="assignedUserId"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className={inputCls}
          >
            <option value="">— pick a technician —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email || u.id}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={submitting}
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
