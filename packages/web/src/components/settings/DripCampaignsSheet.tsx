/**
 * #1735 — outbound drip campaign manager (owner-only).
 *
 * List sequences with their enrollment / booking counts, create a new one
 * (SMS, call or email steps with delays), pause or resume it, and enroll the
 * current targets (lapsed customers or unsold estimates). A new sequence
 * starts paused, so nothing is sent until the owner resumes it. API fns are
 * injectable for jsdom.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { Input, Select, Textarea } from '../ui';
import {
  type DripChannel,
  type DripSequence,
  type DripStep,
  type DripTargetKind,
  createDripSequence as createApi,
  enrollDripTargets as enrollApi,
  getDripStatus as statusApi,
  listDripSequences as listApi,
  setDripSequenceRunning as setRunningApi,
} from '../../api/drip-campaigns';

export interface DripCampaignsSheetApi {
  status: typeof statusApi;
  list: typeof listApi;
  create: typeof createApi;
  setRunning: typeof setRunningApi;
  enroll: typeof enrollApi;
}

const DEFAULT_API: DripCampaignsSheetApi = {
  status: statusApi,
  list: listApi,
  create: createApi,
  setRunning: setRunningApi,
  enroll: enrollApi,
};

interface StepDraft {
  channel: DripChannel;
  delayHours: string;
  text: string;
  subject: string;
  agentPhone: string;
}

const emptyStep = (channel: DripChannel = 'sms'): StepDraft => ({
  channel,
  delayHours: '0',
  text: '',
  subject: '',
  agentPhone: '',
});

const TARGET_LABEL: Record<DripTargetKind, string> = {
  lapsed_customers: 'Lapsed customers',
  unsold_estimates: 'Unsold estimates',
  membership_renewals: 'Membership renewals',
};

/** Draft rows -> API steps, or the first validation message. Pure; exported for tests. */
export function buildSteps(drafts: StepDraft[]): { steps: DripStep[] } | { error: string } {
  const steps: DripStep[] = [];
  for (const [i, d] of drafts.entries()) {
    const hours = Number(d.delayHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 720) {
      return { error: `Step ${i + 1}: wait must be between 0 and 720 hours.` };
    }
    const delayMinutes = Math.round(hours * 60);
    if (d.channel === 'sms') {
      if (!d.text.trim()) return { error: `Step ${i + 1}: write the text message.` };
      steps.push({ channel: 'sms', delayMinutes, body: d.text.trim() });
    } else if (d.channel === 'email') {
      if (!d.subject.trim() || !d.text.trim()) return { error: `Step ${i + 1}: add an email subject and message.` };
      steps.push({ channel: 'email', delayMinutes, subject: d.subject.trim(), body: d.text.trim() });
    } else {
      if (!/^\+[1-9]\d{6,14}$/.test(d.agentPhone.trim())) {
        return { error: `Step ${i + 1}: enter the number to ring, like +15125550100.` };
      }
      steps.push({ channel: 'call', delayMinutes, agentPhone: d.agentPhone.trim() });
    }
  }
  return { steps };
}

export function DripCampaignsSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: DripCampaignsSheetApi;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [sequences, setSequences] = useState<DripSequence[]>([]);
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<DripTargetKind>('lapsed_customers');
  const [drafts, setDrafts] = useState<StepDraft[]>([emptyStep()]);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { enabled: on } = await api.status();
      setEnabled(on);
      if (on) setSequences(await api.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drip campaigns');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchDraft = (i: number, patch: Partial<StepDraft>) =>
    setDrafts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const create = async () => {
    setError('');
    if (!name.trim()) {
      setError('Give the campaign a name.');
      return;
    }
    const built = buildSteps(drafts);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setSaving(true);
    try {
      await api.create({ name: name.trim(), targetKind, steps: built.steps });
      setName('');
      setDrafts([emptyStep()]);
      await load();
      toast.success('Drip campaign created (paused)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create drip campaign';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (s: DripSequence) => {
    setBusyId(s.id);
    try {
      await api.setRunning(s.id, s.status !== 'active');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update drip campaign');
    } finally {
      setBusyId(null);
    }
  };

  const enroll = async (s: DripSequence) => {
    setBusyId(s.id);
    try {
      const { enrolled } = await api.enroll(s.id);
      await load();
      toast.success(`Added ${enrolled} customer${enrolled === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add customers');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="drip-title"
      aria-modal="true"
    >
      <div
        data-testid="drip-sheet"
        className="w-full min-w-0 max-w-lg rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Repeat size={16} className="text-slate-700" />
          </span>
          <h2 id="drip-title" className="flex-1 text-base text-slate-900">
            Follow-up campaigns
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 min-w-0">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {enabled === false && (
            <p className="text-sm text-slate-500">
              Follow-up campaigns are not turned on for your account yet. Ask us to enable them.
            </p>
          )}

          {enabled && (
            <>
              <div className="flex flex-col gap-3">
                {sequences.length === 0 && <p className="text-sm text-slate-400 italic">No campaigns yet.</p>}
                {sequences.map((s) => (
                  <div key={s.id} className="rounded-lg border border-border px-3 py-2 min-w-0">
                    <p className="text-sm text-slate-900 break-words">{s.name}</p>
                    <p className="text-xs text-slate-500">
                      {TARGET_LABEL[s.targetKind]} · {s.steps.length} step{s.steps.length === 1 ? '' : 's'} ·{' '}
                      {s.status === 'active' ? 'Running' : 'Paused'}
                    </p>
                    {s.stats && (
                      <p className="text-xs text-slate-400 mt-1">
                        {s.stats.enrolled} enrolled · {s.stats.active} in progress · {s.stats.booked} booked
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void toggle(s)}
                        disabled={busyId === s.id}
                        className="min-h-11 px-3 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50"
                      >
                        {s.status === 'active' ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void enroll(s)}
                        disabled={busyId === s.id}
                        className="min-h-11 px-3 rounded-lg border border-border text-xs text-slate-700 disabled:opacity-50"
                      >
                        Add matching customers
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-border p-3 flex flex-col gap-2 min-w-0">
                <span className="text-xs font-medium text-slate-600">New follow-up campaign</span>
                <Input
                  aria-label="Campaign name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="min-h-11"
                  placeholder="Name (e.g. Win back lapsed customers)"
                />
                <Select
                  aria-label="Who to follow up with"
                  value={targetKind}
                  onChange={(e) => setTargetKind(e.target.value as DripTargetKind)}
                  className="min-h-11"
                >
                  <option value="lapsed_customers">Lapsed customers (no job in 6 months)</option>
                  <option value="unsold_estimates">Unsold estimates (sent, not accepted)</option>
                  <option value="membership_renewals">Memberships ending in the next 30 days</option>
                </Select>

                {drafts.map((d, i) => (
                  <div key={i} className="rounded-lg bg-slate-50 p-2 flex flex-col gap-2 min-w-0">
                    <Select
                      aria-label={`Step ${i + 1} type`}
                      value={d.channel}
                      onChange={(e) => patchDraft(i, { channel: e.target.value as DripChannel })}
                      className="min-h-11"
                    >
                      <option value="sms">Text message</option>
                      <option value="email">Email</option>
                      <option value="call">Call (rings you, then connects)</option>
                    </Select>
                    <Input
                      aria-label={`Step ${i + 1} wait (hours)`}
                      inputMode="numeric"
                      value={d.delayHours}
                      onChange={(e) => patchDraft(i, { delayHours: e.target.value })}
                      className="min-h-11"
                      placeholder="Wait before this step (hours)"
                    />
                    {d.channel === 'email' && (
                      <Input
                        aria-label={`Step ${i + 1} subject`}
                        value={d.subject}
                        onChange={(e) => patchDraft(i, { subject: e.target.value })}
                        className="min-h-11"
                        placeholder="Email subject"
                      />
                    )}
                    {d.channel === 'call' ? (
                      <Input
                        aria-label={`Step ${i + 1} number to ring`}
                        value={d.agentPhone}
                        onChange={(e) => patchDraft(i, { agentPhone: e.target.value })}
                        className="min-h-11"
                        placeholder="Your number, e.g. +15125550100"
                      />
                    ) : (
                      <Textarea
                        aria-label={`Step ${i + 1} message`}
                        value={d.text}
                        onChange={(e) => patchDraft(i, { text: e.target.value })}
                        placeholder="Message (use {{firstName}} for their name)"
                      />
                    )}
                    {drafts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}
                        className="min-h-11 px-3 self-start rounded-lg text-xs text-slate-600 border border-border"
                      >
                        Remove step {i + 1}
                      </button>
                    )}
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => setDrafts((rows) => [...rows, emptyStep()])}
                  disabled={drafts.length >= 8}
                  className="min-h-11 px-3 self-start rounded-lg border border-border text-xs text-slate-700 disabled:opacity-50"
                >
                  Add step
                </button>
                <button
                  type="button"
                  onClick={() => void create()}
                  disabled={saving}
                  className="min-h-11 px-4 self-start rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Create campaign'}
                </button>
                <p className="text-xs text-slate-400">
                  Texts and calls only go to customers who have agreed to be contacted, never during quiet hours,
                  and stop as soon as the customer books, replies or opts out.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
