import React, { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { useCreateCrewProposal } from './useCreateCrewProposal';

interface UserOption {
  id: string;
  name?: string;
  email?: string;
}

export interface AddCrewDialogProps {
  appointmentId: string;
  /** Optimistic-concurrency token (appointment.updatedAt ISO string). */
  appointmentVersion?: string;
  /** Technician ids already on the appointment (primary + crew) — excluded from the picker. */
  excludeTechnicianIds?: string[];
  onCreated?: () => void;
  onCancel?: () => void;
}

/**
 * Adds a co-technician (crew member) to an appointment by creating an
 * add_crew_member proposal. Mirrors ReassignDialog's roster loading but
 * submits through the proposal pipeline rather than mutating directly.
 */
export function AddCrewDialog({
  appointmentId,
  appointmentVersion,
  excludeTechnicianIds = [],
  onCreated,
  onCancel,
}: AddCrewDialogProps) {
  const apiFetch = useApiClient();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { addCrew, isSubmitting } = useCreateCrewProposal();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/users?role=technician');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const list: UserOption[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        if (!cancelled) setUsers(list);
      } catch (err) {
        if (!cancelled) setUsersError(err instanceof Error ? err.message : 'Failed to load users');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const exclude = new Set(excludeTechnicianIds);
  const selectable = users.filter((u) => !exclude.has(u.id));

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!selectedId.trim()) {
        setError('Pick a technician to add.');
        return;
      }
      const result = await addCrew({
        appointmentId,
        technicianId: selectedId.trim(),
        appointmentVersion,
      });
      if (result.success) {
        onCreated?.();
        return;
      }
      if (result.error === 'STALE') {
        setError('This appointment changed — refresh and try again.');
      } else if (result.error === 'INFEASIBLE') {
        setError(result.blocking?.[0]?.message ?? 'That technician is not available for this slot.');
      } else {
        setError(typeof result.error === 'string' ? result.error : 'Could not add crew member.');
      }
    },
    [addCrew, appointmentId, appointmentVersion, selectedId, onCreated],
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  return (
    <form onSubmit={handleSubmit} data-testid="add-crew-dialog" className="space-y-3">
      <h2 className="text-base text-slate-900">Add crew member</h2>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {usersError ? (
        <label className="block text-xs text-slate-500">
          Technician ID (roster failed to load — enter manually)
          <input
            aria-label="crewTechnicianId"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className={inputCls}
          />
        </label>
      ) : (
        <label className="block text-xs text-slate-500">
          Add technician
          <select
            aria-label="crewTechnicianId"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className={inputCls}
          >
            <option value="">— pick a technician —</option>
            {selectable.map((u) => (
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
          disabled={isSubmitting}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {isSubmitting ? 'Adding…' : 'Add to crew'}
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
