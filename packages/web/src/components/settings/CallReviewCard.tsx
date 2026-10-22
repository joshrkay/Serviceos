import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';
import { formatDateInTenantTz } from '../../utils/formatInTenantTz';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';

/** Mirrors GET /api/voice/scoring (#1736). */
type FlagKind = 'missed_opportunity' | 'ungrounded_price' | 'escalation_mishandled' | 'no_follow_up' | 'strength';
type CorrectionKind =
  | 'should_have_booked'
  | 'should_have_escalated'
  | 'should_not_have_escalated'
  | 'wrong_price'
  | 'other';
interface ScoredCall {
  sessionId: string;
  score: number;
  callEndedAt: string;
  summary: string;
  needsReview: boolean;
  items: Array<{ id: string; verdict: 'pass' | 'fail' | 'not_applicable'; rationale: string }>;
  flags: Array<{ kind: FlagKind; turnIndex: number; excerpt: string; note: string }>;
  correction: { kind: CorrectionKind; note: string; exported: boolean } | null;
}
interface Scoring {
  enabled: boolean;
  calls: ScoredCall[];
}

const FLAG_LABEL: Record<FlagKind, string> = {
  missed_opportunity: 'Missed opportunity',
  ungrounded_price: 'Price not in your catalog',
  escalation_mishandled: 'Should have handed off',
  no_follow_up: 'No next step',
  strength: 'Done well',
};

const CORRECTION_LABEL: Record<CorrectionKind, string> = {
  should_have_booked: 'It should have booked the job',
  should_have_escalated: 'It should have passed me the call',
  should_not_have_escalated: 'It should have handled this itself',
  wrong_price: 'It gave the wrong price',
  other: 'Something else',
};

function scoreTone(score: number): string {
  if (score >= 80) return 'bg-green-100 text-green-700';
  if (score >= 50) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

function CorrectionForm({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<CorrectionKind>('should_have_booked');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  async function submit() {
    setSending(true);
    try {
      const res = await apiFetch(`/api/voice/scoring/${sessionId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success('Thanks — this call will be used to test future changes');
      onDone();
    } catch {
      toast.error('Could not save the correction');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="basis-full mt-2 rounded-lg bg-slate-50 p-3 min-w-0" data-testid="correction-form">
      <label className="block text-xs text-slate-600" htmlFor={`correction-kind-${sessionId}`}>
        What should have happened?
      </label>
      <select
        id={`correction-kind-${sessionId}`}
        value={kind}
        onChange={(e) => setKind(e.target.value as CorrectionKind)}
        className="mt-1 w-full min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
      >
        {(Object.keys(CORRECTION_LABEL) as CorrectionKind[]).map((k) => (
          <option key={k} value={k}>
            {CORRECTION_LABEL[k]}
          </option>
        ))}
      </select>
      <label className="block text-xs text-slate-600 mt-2" htmlFor={`correction-note-${sessionId}`}>
        Anything else? (optional)
      </label>
      <textarea
        id={`correction-note-${sessionId}`}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => void submit()}
          className="min-h-11 rounded-xl bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send correction'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Call review on Settings (owner-only — the API behind it is `tenant:manage`,
 * so the page mounts this for owners only, #1736). Scoring is off until the
 * owner turns it on; then each answered call is scored 0-100 on four things
 * (booked, prices from the catalog, hand-offs, next step) and the calls that
 * need a look are listed with the flagged moment. "Correct this call" tells the
 * AI what it should have done; the correction becomes a regression test.
 */
export function CallReviewCard() {
  const [scoring, setScoring] = useState<Scoring | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const timezone = useTenantTimezone();

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await Promise.resolve(apiFetch('/api/voice/scoring'));
      if (!res?.ok) return;
      const body = (await res.json()) as Partial<Scoring> | null;
      if (typeof body?.enabled !== 'boolean') return;
      setScoring({ enabled: body.enabled, calls: Array.isArray(body.calls) ? body.calls : [] });
    } catch {
      // Card stays hidden.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setEnabled(enabled: boolean) {
    setToggling(true);
    try {
      const res = await apiFetch('/api/voice/scoring/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(enabled ? 'Calls will be scored from now on' : 'Call scoring is off');
      await load();
    } catch {
      toast.error('Could not change call scoring');
    } finally {
      setToggling(false);
    }
  }

  if (!scoring) return null;

  const shown = scoring.calls.filter((c) => !flaggedOnly || c.needsReview);

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-3.5" data-testid="call-review-card">
      <div className="flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
          <ClipboardCheck size={14} className="text-slate-500" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-800">Call review</p>
          <p className="text-xs text-slate-400 mt-0.5 break-words">
            {scoring.enabled
              ? 'Each answered call is scored on booking, prices, hand-offs and next steps.'
              : 'Off. Turn on to have each answered call scored, with the moments worth a look.'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={scoring.enabled}
          disabled={toggling}
          onClick={() => void setEnabled(!scoring.enabled)}
          className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
        >
          {scoring.enabled ? 'Turn off call scoring' : 'Turn on call scoring'}
        </button>
        {scoring.enabled && scoring.calls.length > 0 && (
          <button
            type="button"
            aria-pressed={flaggedOnly}
            onClick={() => setFlaggedOnly((v) => !v)}
            className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
          >
            {flaggedOnly ? 'Showing calls to review' : 'Showing all calls'}
          </button>
        )}
      </div>

      {scoring.enabled && scoring.calls.length === 0 && (
        <p className="mt-3 text-xs text-slate-500" data-testid="call-review-empty">
          No scored calls yet — new calls are scored within about 15 minutes of hanging up.
        </p>
      )}
      {scoring.enabled && scoring.calls.length > 0 && shown.length === 0 && (
        <p className="mt-3 text-xs text-slate-500" data-testid="call-review-none-flagged">
          Nothing needs a look. Switch to all calls to see every score.
        </p>
      )}

      {shown.length > 0 && (
        <ul className="mt-3 border-t border-slate-100 divide-y divide-slate-100">
          {shown.map((call) => (
            <li
              key={call.sessionId}
              data-testid="call-review-row"
              className="flex flex-wrap items-start gap-x-2 gap-y-1 min-w-0 py-2"
            >
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${scoreTone(call.score)}`}>
                {call.score}/100
              </span>
              <span className="text-xs text-slate-400 shrink-0">
                {formatDateInTenantTz(call.callEndedAt, timezone)}
              </span>
              {call.correction && (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  Corrected
                </span>
              )}
              <p className="basis-full text-xs text-slate-600 min-w-0 break-words">{call.summary}</p>
              {call.flags
                .filter((f) => f.kind !== 'strength')
                .map((f, i) => (
                  <div key={i} className="basis-full min-w-0 rounded-lg bg-amber-50 px-2 py-1.5" data-testid="call-review-flag">
                    <p className="text-xs text-amber-800 break-words">
                      <span className="font-medium">{FLAG_LABEL[f.kind]}.</span> {f.note}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 break-words">{f.excerpt}</p>
                  </div>
                ))}
              {correcting === call.sessionId ? (
                <CorrectionForm
                  sessionId={call.sessionId}
                  onDone={() => {
                    setCorrecting(null);
                    void load();
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCorrecting(call.sessionId)}
                  className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"
                >
                  {call.correction ? 'Change correction' : 'Correct this call'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
