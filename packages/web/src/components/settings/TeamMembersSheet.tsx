/**
 * Tier 4 (Team members — PR 1 + PR 2).
 *
 * Closes the "Team members" stub on Settings. PR 1 surfaced the
 * tenant's roster (read-only); PR 2 adds inline role editing for
 * owners. PR 3 will add an invite flow.
 */
import { useEffect, useState } from 'react';
import { X, Users, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

type Role = 'owner' | 'dispatcher' | 'technician';

interface TeamUser {
  id: string;
  email: string;
  role: Role;
  firstName?: string;
  lastName?: string;
  canFieldServe: boolean;
}

interface TeamMembersSheetProps {
  onClose: () => void;
  /**
   * When false, the role select + Save button are hidden. The
   * SettingsPage caller passes the current actor's role; only owners
   * see edit affordances. The backend re-enforces this via
   * users:edit_role.
   */
  canEditRoles?: boolean;
}

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
};

const ROLE_BADGE: Record<Role, string> = {
  owner: 'bg-amber-100 text-amber-900',
  dispatcher: 'bg-blue-100 text-blue-900',
  technician: 'bg-emerald-100 text-emerald-900',
};

function displayName(u: TeamUser): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.email;
}

export function TeamMembersSheet({ onClose, canEditRoles }: TeamMembersSheetProps) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<Role>('technician');
  const [savingId, setSavingId] = useState<string | null>(null);
  /**
   * Distinct from `error` (load-time fatal). Save failures must NOT
   * blow away the list — toast shows the message, we keep the row
   * in edit mode for retry.
   */
  const [saveError, setSaveError] = useState<string>('');

  function startEdit(u: TeamUser) {
    setEditingId(u.id);
    setEditingRole(u.role);
    setSaveError('');
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveRole(u: TeamUser) {
    if (editingRole === u.role) {
      setEditingId(null);
      return;
    }
    setSavingId(u.id);
    setSaveError('');
    try {
      const res = await apiFetch(`/api/users/${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: editingRole }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      const updated = (await res.json()) as TeamUser;
      setUsers((prev) => prev.map((row) => (row.id === u.id ? { ...row, ...updated } : row)));
      setEditingId(null);
      toast.success('Role updated');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not update role';
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSavingId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/users');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as { data?: TeamUser[] } | TeamUser[];
        const list = Array.isArray(json) ? json : json?.data ?? [];
        if (!cancelled) setUsers(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load team');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="team-members-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Users size={16} className="text-slate-700" />
          </span>
          <h2 id="team-members-title" className="flex-1 text-base text-slate-900">
            Team members
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-3">
          <p className="text-xs text-slate-500">
            Everyone with access to this tenant. Role and invite editing arrive in
            a follow-up release.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : error ? (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : users.length === 0 ? (
            <p
              data-testid="team-members-empty"
              className="text-sm text-slate-500 italic"
            >
              No team members yet.
            </p>
          ) : (
            <ul data-testid="team-members-list" className="space-y-2">
              {users.map((u) => {
                const isEditing = editingId === u.id;
                const isSaving = savingId === u.id;
                return (
                  <li
                    key={u.id}
                    data-testid={`team-member-row-${u.id}`}
                    className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3"
                  >
                    <span className="flex size-9 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-600">
                      {displayName(u).charAt(0).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 truncate">{displayName(u)}</p>
                      <p className="text-xs text-slate-500 truncate">{u.email}</p>
                    </div>
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <label htmlFor={`role-select-${u.id}`} className="sr-only">
                          Role
                        </label>
                        <select
                          id={`role-select-${u.id}`}
                          data-testid={`team-member-role-select-${u.id}`}
                          value={editingRole}
                          onChange={(e) => setEditingRole(e.target.value as Role)}
                          disabled={isSaving}
                          className="text-xs rounded-lg border border-slate-200 px-2 py-1"
                        >
                          <option value="owner">Owner</option>
                          <option value="dispatcher">Dispatcher</option>
                          <option value="technician">Technician</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => saveRole(u)}
                          disabled={isSaving}
                          className="text-xs rounded-lg bg-slate-900 text-white px-2 py-1 hover:bg-slate-700 disabled:opacity-60"
                        >
                          {isSaving ? '…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={isSaving}
                          className="text-xs rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span
                          className={`text-xs rounded-full px-2 py-0.5 ${ROLE_BADGE[u.role]}`}
                        >
                          {ROLE_LABEL[u.role]}
                        </span>
                        {canEditRoles && (
                          <button
                            type="button"
                            onClick={() => startEdit(u)}
                            aria-label={`Edit role for ${displayName(u)}`}
                            data-testid={`team-member-edit-${u.id}`}
                            className="ml-1 flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {saveError && (
            <p className="text-sm text-red-600" role="alert">
              {saveError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
