/**
 * P12-005-fe — Supervisor backup + unsupervised routing settings section.
 *
 * Self-contained section appended to `SettingsPage`. Visible only to
 * owners — the gating happens in the parent so the parent can decide
 * whether to mount the section at all (avoids rendering disabled UI
 * for non-owners). The section renders only when mounted.
 */
import { useEffect, useState } from 'react';
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

const ROUTING_OPTIONS: ReadonlyArray<{
  value: UnsupervisedProposalRouting;
  label: string;
  description: string;
}> = [
  {
    value: 'queue_and_sms',
    label: 'Queue + SMS owner',
    description:
      "Customer hears 'let me check and text you right back'. Proposal queues. You get an SMS with a one-tap re-approve link.",
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
      "AI does not book unsupervised. Inbound call rings the on-call rotation directly.",
  },
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SupervisorBackupSection({
  initialBackupUserId,
  initialRouting,
}: SupervisorBackupSectionProps): JSX.Element {
  const apiClient = useApiClient() as AuthedFetch;
  const [backupUserId, setBackupUserId] = useState<string>(
    initialBackupUserId ?? '',
  );
  const [routing, setRouting] = useState<UnsupervisedProposalRouting>(
    initialRouting,
  );
  const [saving, setSaving] = useState(false);

  // Re-sync when the parent re-fetches /api/me (e.g. after a mode switch).
  useEffect(() => {
    setBackupUserId(initialBackupUserId ?? '');
  }, [initialBackupUserId]);
  useEffect(() => {
    setRouting(initialRouting);
  }, [initialRouting]);

  const trimmedUserId = backupUserId.trim();
  const userIdValid = trimmedUserId === '' || UUID_RE.test(trimmedUserId);

  async function handleSave() {
    if (!userIdValid) {
      toast.error('Backup supervisor user ID must be a valid UUID');
      return;
    }
    setSaving(true);
    try {
      await updateTenantModeSettings(apiClient, {
        backupSupervisorUserId: trimmedUserId === '' ? null : trimmedUserId,
        unsupervisedProposalRouting: routing,
      });
      toast.success('Supervisor backup saved');
    } catch (err) {
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
        <h2
          id="supervisor-backup-heading"
          className="text-sm text-slate-900"
        >
          Supervisor backup
        </h2>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        When the active supervisor switches to Tech mode and no one else is
        watching the wall, AI proposals route per the rule below. The
        backup user gets the live wall on their device when they're
        signed in.
      </p>

      <div className="mb-5">
        <label
          htmlFor="backup-supervisor-user-id"
          className="block text-xs text-slate-700 mb-1"
        >
          Backup supervisor user ID
        </label>
        <input
          id="backup-supervisor-user-id"
          data-testid="backup-supervisor-input"
          type="text"
          value={backupUserId}
          onChange={(e) => setBackupUserId(e.target.value)}
          placeholder="UUID — leave blank for none"
          className={`w-full text-xs px-3 py-2 rounded-md border ${
            userIdValid
              ? 'border-slate-200 focus:border-slate-400'
              : 'border-red-300 focus:border-red-400'
          }`}
        />
        {!userIdValid && (
          <p className="text-xs text-red-600 mt-1" role="alert">
            Must be a valid UUID
          </p>
        )}
      </div>

      <fieldset className="mb-4">
        <legend className="text-xs text-slate-700 mb-2">
          Unsupervised proposal routing
        </legend>
        <div className="space-y-2">
          {ROUTING_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              data-testid={`routing-option-${opt.value}`}
              className="flex items-start gap-3 px-3 py-2 rounded-md border border-slate-200 cursor-pointer hover:border-slate-300"
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
        disabled={saving || !userIdValid}
        className="text-xs px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
}
