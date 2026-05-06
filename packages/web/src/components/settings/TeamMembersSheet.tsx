/**
 * Tier 4 (Team members — PR 1: read-only list).
 *
 * Closes the "Team members" stub on Settings. PR 1 surfaces the
 * tenant's roster from GET /api/users with role badges. PR 2 will
 * add inline role editing; PR 3 will add an invite flow.
 */
import { useEffect, useState } from 'react';
import { X, Users } from 'lucide-react';
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

export function TeamMembersSheet({ onClose }: TeamMembersSheetProps) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

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
              {users.map((u) => (
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
                  <span
                    className={`text-xs rounded-full px-2 py-0.5 ${ROLE_BADGE[u.role]}`}
                  >
                    {ROLE_LABEL[u.role]}
                  </span>
                </li>
              ))}
            </ul>
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
