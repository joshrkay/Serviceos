import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';

/**
 * #1389 / O-2 — the owner's form for the reviewed E1 life-safety script (gas,
 * CO, fire, injury calls). O-2: a licensed trade professional AND counsel must
 * both sign the script before it replaces the placeholder, so the form takes
 * one structured sign-off of each kind and saves them with the script through
 * the owner-only PUT /api/settings/e1-script. The server re-checks all of it
 * (and refuses non-owners); this page only collects it.
 *
 * Mobile: every control is a ≥44px target and the layout is single-column
 * with no fixed widths, so nothing scrolls sideways at 320px.
 */

type ReviewerKind = 'trade_professional' | 'counsel';

interface Reviewer {
  kind: ReviewerKind;
  name: string;
  credential: string;
  reviewedAt: string;
}

interface E1ScriptStatus {
  status: 'placeholder' | 'reviewed';
  reviewedScript: string | null;
  reviewers?: Reviewer[];
  missingReviewerKinds?: ReviewerKind[];
}

interface ReviewerFields {
  name: string;
  credential: string;
  /** YYYY-MM-DD from the date input. */
  date: string;
}

const EMPTY_REVIEWER: ReviewerFields = { name: '', credential: '', date: '' };
const MAX_SCRIPT_CHARS = 2000;

const REVIEWER_COPY: Record<ReviewerKind, { heading: string; label: string; credential: string; hint: string }> = {
  trade_professional: {
    heading: 'Licensed trade professional',
    label: 'Trade professional',
    credential: 'license',
    hint: 'License number and state',
  },
  counsel: {
    heading: 'Counsel',
    label: 'Counsel',
    credential: 'bar number',
    hint: 'Bar number and state',
  },
};

const FIELD_BASE =
  'mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900';
const INPUT_CLASS = `${FIELD_BASE} min-h-11`;

/** Local calendar day → the ISO instant of its local midnight (never in the future for today). */
function dayToIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

function isoToDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayDay(): string {
  return isoToDay(new Date().toISOString());
}

function reviewerFieldsFrom(status: E1ScriptStatus, kind: ReviewerKind): ReviewerFields {
  const r = status.reviewers?.find((entry) => entry.kind === kind);
  return r ? { name: r.name, credential: r.credential, date: isoToDay(r.reviewedAt) } : EMPTY_REVIEWER;
}

const complete = (r: ReviewerFields) => r.name.trim() !== '' && r.credential.trim() !== '' && r.date !== '';

export function E1ScriptSettingsPage() {
  const apiFetch = useApiClient();
  const [status, setStatus] = useState<E1ScriptStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [script, setScript] = useState('');
  const [reviewers, setReviewers] = useState<Record<ReviewerKind, ReviewerFields>>({
    trade_professional: EMPTY_REVIEWER,
    counsel: EMPTY_REVIEWER,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function adopt(next: E1ScriptStatus) {
    setStatus(next);
    setScript(next.reviewedScript ?? '');
    setReviewers({
      trade_professional: reviewerFieldsFrom(next, 'trade_professional'),
      counsel: reviewerFieldsFrom(next, 'counsel'),
    });
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(apiFetch('/api/settings/e1-script'))
      .then(async (res) => {
        if (cancelled) return;
        if (!res?.ok) {
          setLoadError('Could not load the emergency script status.');
          return;
        }
        adopt((await res.json()) as E1ScriptStatus);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the emergency script status.');
      });
    return () => {
      cancelled = true;
    };
    // Load once on mount: adopting the status replaces form state, so a
    // re-run on a new client identity would wipe what the owner is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setReviewer = (kind: ReviewerKind, patch: Partial<ReviewerFields>) =>
    setReviewers((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));

  const canSave =
    script.trim() !== '' &&
    complete(reviewers.trade_professional) &&
    complete(reviewers.counsel) &&
    confirmed &&
    !saving;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch('/api/settings/e1-script', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: script.trim(),
          reviewers: (['trade_professional', 'counsel'] as const).map((kind) => ({
            kind,
            name: reviewers[kind].name.trim(),
            credential: reviewers[kind].credential.trim(),
            reviewedAt: dayToIso(reviewers[kind].date),
          })),
        }),
      });
      if (!res.ok) {
        setSaveError(
          res.status === 403
            ? 'Only the account owner can save the emergency script.'
            : 'The script was not saved. Check every field and try again.',
        );
        return;
      }
      adopt((await res.json()) as E1ScriptStatus);
      setConfirmed(false);
    } catch {
      setSaveError('The script was not saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="p-4 text-sm text-red-700">
        {loadError}
      </p>
    );
  }
  if (!status) {
    return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  }

  const live = status.status === 'reviewed';

  return (
    <section
      data-testid="e1-script-settings"
      aria-label="Emergency safety script"
      className="mx-auto w-full max-w-2xl min-w-0 space-y-5 p-4"
    >
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Emergency (E1) safety script</h1>
        <p className="text-sm text-slate-600">
          What the AI says on life-safety calls (gas, carbon monoxide, fire, injury). It replaces the
          placeholder only after a licensed trade professional and counsel have both signed off on
          this exact text.
        </p>
      </header>

      {live ? (
        <div
          data-testid="e1-script-status"
          className="flex items-start gap-2 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900"
        >
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">Your reviewed script is live on emergency calls.</span>
        </div>
      ) : (
        <div
          data-testid="e1-script-status"
          className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            The unreviewed placeholder script is in use on emergency calls. Save a script signed by both
            reviewers below to replace it.
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <label className="block">
          <span className="block text-sm font-medium text-slate-800">Emergency script</span>
          <textarea
            aria-label="Emergency script"
            className={`${FIELD_BASE} min-h-32 break-words`}
            maxLength={MAX_SCRIPT_CHARS}
            rows={6}
            value={script}
            disabled={saving}
            onChange={(e) => setScript(e.target.value)}
          />
          <span className="mt-1 block text-xs text-slate-500">
            {script.length}/{MAX_SCRIPT_CHARS} characters
          </span>
        </label>

        {(['trade_professional', 'counsel'] as const).map((kind) => {
          const copy = REVIEWER_COPY[kind];
          const r = reviewers[kind];
          return (
            <fieldset
              key={kind}
              data-testid={`e1-reviewer-${kind}`}
              className="min-w-0 space-y-3 rounded-lg border border-slate-200 bg-white p-3"
            >
              <legend className="px-1 text-sm font-semibold text-slate-900">{copy.heading}</legend>
              <label className="block">
                <span className="block text-sm text-slate-700">Name</span>
                <input
                  aria-label={`${copy.label} name`}
                  className={INPUT_CLASS}
                  value={r.name}
                  maxLength={200}
                  autoComplete="off"
                  disabled={saving}
                  onChange={(e) => setReviewer(kind, { name: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="block text-sm text-slate-700">{copy.hint}</span>
                <input
                  aria-label={`${copy.label} ${copy.credential}`}
                  className={INPUT_CLASS}
                  value={r.credential}
                  maxLength={200}
                  autoComplete="off"
                  disabled={saving}
                  onChange={(e) => setReviewer(kind, { credential: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="block text-sm text-slate-700">Date reviewed</span>
                <input
                  type="date"
                  aria-label={`${copy.label} review date`}
                  className={INPUT_CLASS}
                  value={r.date}
                  max={todayDay()}
                  disabled={saving}
                  onChange={(e) => setReviewer(kind, { date: e.target.value })}
                />
              </label>
            </fieldset>
          );
        })}

        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={confirmed}
            disabled={saving}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span className="min-w-0 text-sm text-slate-800">
            I confirm both reviewers signed off on exactly this script.
          </span>
        </label>

        {saveError ? (
          <p role="alert" className="text-sm text-red-700">
            {saveError}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSave}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-40 sm:w-auto"
        >
          {saving ? 'Saving…' : 'Save reviewed script'}
        </button>
      </form>
    </section>
  );
}

export default E1ScriptSettingsPage;
