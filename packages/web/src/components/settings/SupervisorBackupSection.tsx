/**
 * P12-005-fe — Supervisor backup + unsupervised routing settings section.
 *
 * Self-contained section appended to `SettingsPage`. Visible only to
 * owners — the gating happens in the parent so the parent can decide
 * whether to mount the section at all (avoids rendering disabled UI
 * for non-owners). The section renders only when mounted.
 *
 * Save is optimistic (matching the AIProposalCard pattern): the chosen
 * values stick immediately; a failed PATCH reverts the controls to the
 * last-saved values and surfaces an error toast.
 */
import { useEffect, useRef, useState } from 'react';
import { Shield } from 'lucide-react';
import { toast } from 'sonner';
import { useApiClient } from '../../lib/apiClient';
import {
  updateTenantModeSettings,
  type AuthedFetch,
  type UnsupervisedProposalRouting,
} from '../../api/tenant-settings';

interface SupervisorBackupSectionProps {
  /** Initial value from `me.backup_supervisor_user_id`. */
  initialBackupUserId: string | null;
  /** Initial value from `me.unsupervised_proposal_routing`. */
  initialRouting: UnsupervisedProposalRouting;
}

/** Shape returned by GET /api/users (Tier-4 team roster route). */
interface RosterUser {
  id: string;
  email: string;
  role: 'owner' | 'dispatcher' | 'technician';
  firstName?: string;
  lastName?: string;
}

/** Roles that can act as a supervisor. Technicians cannot. */
const SUPERVISE_CAPABLE_ROLES: ReadonlyArray<RosterUser['role']> = [
  'owner',
  'dispatcher',
];

const ROUTING_OPTIONS: ReadonlyArray<{
  value: UnsupervisedProposalRouting;
  label: string;
  description: string;
}> = [
  {
    value: 'queue_and_sms',
    label: 'Text me a one-tap approve link',
    description:
      "Customer hears 'let me check and text you right back'. Proposal queues. You get an SMS with a one-tap approve link.",
  },
  {
    value: 'queue_only',
    label: 'Queue silently',
    description:
      "Customer hears 'we'll call you back within an hour'. Proposal queues. No SMS.",
  },
  {
    value: 'escalate_to_oncall',
    label: 'Route call to on-call',
    description:
      'AI does not book unsupervised. Inbound call rings the on-call rotation directly.',
  },
];

function displayName(u: RosterUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name ? `${name} (${u.email})` : u.email;
}

export function SupervisorBackupSection({
  initialBackupUserId,
  initialRouting,
}: SupervisorBackupSectionProps): JSX.Element {
  const apiClient = useApiClient() as AuthedFetch;
  const [backupUserId, setBackupUserId] = useState<string>(
    initialBackupUserId ?? '',
  );
  const [routing, setRouting] =
    useState<UnsupervisedProposalRouting>(initialRouting);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [usersError, setUsersError] = useState(false);

  // Last value known to be persisted — the revert target for a failed
  // optimistic save.
  const lastSavedRef = useRef<{
    backupUserId: string;
    routing: UnsupervisedProposalRouting;
  }>({ backupUserId: initialBackupUserId ?? '', routing: initialRouting });

  // Re-sync when the parent re-fetches /api/me (e.g. after a mode switch).
  useEffect(() => {
    setBackupUserId(initialBackupUserId ?? '');
    lastSavedRef.current.backupUserId = initialBackupUserId ?? '';
  }, [initialBackupUserId]);
  useEffect(() => {
    setRouting(initialRouting);
    lastSavedRef.current.routing = initialRouting;
  }, [initialRouting]);

  // Load the tenant roster for the picker; only supervise-capable
  // roles (owner, dispatcher) are offered as backup supervisors.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient('/api/users');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const json = (await res.json()) as { data?: RosterUser[] } | RosterUser[];
        const list = Array.isArray(json) ? json : (json?.data ?? []);
        if (!cancelled) {
          setUsers(
            list.filter((u) => SUPERVISE_CAPABLE_ROLES.includes(u.role)),
          );
          setUsersError(false);
        }
      } catch {
        if (!cancelled) setUsersError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  async function handleSave() {
    const prior = { ...lastSavedRef.current };
    const next = { backupUserId, routing };
    // Optimistic: the chosen values stick immediately.
    lastSavedRef.current = next;
    setSaving(true);
    try {
      await updateTenantModeSettings(apiClient, {
        backupSupervisorUserId: backupUserId === '' ? null : backupUserId,
        unsupervisedProposalRouting: routing,
      });
      toast.success('Supervisor backup saved');
    } catch (err) {
      // Revert to the last persisted values + toast (AIProposalCard pattern).
      lastSavedRef.current = prior;
      setBackupUserId(prior.backupUserId);
      setRouting(prior.routing);
      const message = err instanceof Error ? err.message : 'Save failed';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-testid="supervisor-backup-section"
      aria-labelledby="supervisor-backup-heading"
      className="rounded-lg border border-slate-200 bg-white p-5"
    >
      <div className="flex items-center gap-2 mb-1">
        <Shield size={16} className="text-slate-600" />
        <h2 id="supervisor-backup-heading" className="text-sm text-slate-900">
          Supervisor backup
        </h2>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        When the active supervisor switches to Tech mode and no one else is
        watching the wall, AI proposals route per the rule below. The backup
        user gets the live wall on their device when they're signed in.
      </p>

      <div className="mb-5">
        <label
          htmlFor="backup-supervisor-select"
          className="block text-xs text-slate-700 mb-1"
        >
          Backup supervisor (used when active supervisor switches to tech)
        </label>
        <select
          id="backup-supervisor-select"
          data-testid="backup-supervisor-select"
          value={backupUserId}
          onChange={(e) => setBackupUserId(e.target.value)}
          className="w-full min-h-[44px] text-sm px-3 py-2 rounded-md border border-slate-200 bg-white focus:border-slate-400"
        >
          <option value="">None</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {displayName(u)}
            </option>
          ))}
        </select>
        {usersError && (
          <p className="text-xs text-amber-600 mt-1" role="alert">
            Couldn't load the team list — try reloading the page.
          </p>
        )}
      </div>

      <fieldset className="mb-4">
        <legend className="text-xs text-slate-700 mb-2">
          When unsupervised, low-confidence proposals should:
        </legend>
        <div className="space-y-2">
          {ROUTING_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              data-testid={`routing-option-${opt.value}`}
              className="flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-md border border-slate-200 cursor-pointer hover:border-slate-300"
            >
              <input
                type="radio"
                name="unsupervised-routing"
                value={opt.value}
                checked={routing === opt.value}
                onChange={() => setRouting(opt.value)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-slate-900">{opt.label}</div>
                <div className="text-xs text-slate-500">{opt.description}</div>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        data-testid="supervisor-backup-save"
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-4 min-h-[44px] rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
}
