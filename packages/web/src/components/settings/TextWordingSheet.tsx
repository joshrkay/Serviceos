/**
 * D-045 — Settings → Text wording.
 *
 * The owner writes their own wording for the four texts customers get
 * (estimate, invoice, customer-portal link, thank-you) with `{{fill-ins}}`,
 * sees a preview with sample values, and can reset to ours. Customers who
 * read another language keep getting our wording in their language.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, MessageSquareText } from 'lucide-react';
import { toast } from 'sonner';
import {
  type TextWordingState,
  type WordingPurpose,
  type WordingText,
  fetchTextWording as fetchApi,
  saveTextWording as saveApi,
  resetTextWording as resetApi,
} from '../../api/textWording';

export interface TextWordingSheetApi {
  fetch: typeof fetchApi;
  save: typeof saveApi;
  reset: typeof resetApi;
}

const DEFAULT_API: TextWordingSheetApi = { fetch: fetchApi, save: saveApi, reset: resetApi };

const TITLES: Record<WordingPurpose, { title: string; when: string }> = {
  estimate_text: { title: 'Estimate text', when: 'Sent when you text a customer an estimate.' },
  invoice_text: {
    title: 'Invoice text',
    when: 'Sent when you text an invoice. If you collect payment in person, we add a line saying so.',
  },
  portal_link_text: { title: 'Customer portal link', when: 'Sent when you text a customer their portal link.' },
  thank_you_text: { title: 'Thank-you text', when: 'Sent about two hours after a job is marked done.' },
};

/** The wording with sample values filled in; a fill-in it can't fill stays as typed. */
export function previewWording(body: string, values: Record<string, string>): string {
  return body.trim().replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key: string) => values[key] ?? full);
}

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish' };

function WordingCard({
  text,
  maxLength,
  businessLanguage,
  api,
  onSaved,
}: {
  text: WordingText;
  maxLength: number;
  businessLanguage: string;
  api: TextWordingSheetApi;
  onSaved: (purpose: WordingPurpose, saved: WordingText['saved']) => void;
}) {
  const [draft, setDraft] = useState(text.saved?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const { title, when } = TITLES[text.purpose];
  const id = `wording-${text.purpose}`;
  const changed =
    draft.trim() !== (text.saved?.body ?? '') || (!!text.saved && text.saved.language !== businessLanguage);

  const insert = (fillIn: string) => {
    const token = `{{${fillIn}}}`;
    const el = area.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + token + draft.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const saved = await api.save(text.purpose, draft);
      setDraft(saved.body);
      onSaved(text.purpose, saved);
      toast.success(`${title} saved`);
    } catch (err) {
      const e = err as Error & { problems?: string[] };
      setProblems(e.problems?.length ? e.problems : [e.message || 'The wording could not be saved.']);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setProblems([]);
    try {
      await api.reset(text.purpose);
      setDraft('');
      onSaved(text.purpose, null);
      toast.success(`${title} is back to our wording`);
    } catch (err) {
      setProblems([err instanceof Error && err.message ? err.message : 'The wording could not be reset.']);
    } finally {
      setBusy(false);
    }
  };

  // An emptied box saves nothing: what customers get is still the saved
  // wording (or ours) until the owner saves or resets.
  const withAdded = (body: string) => [previewWording(body, text.sampleValues), ...text.addedLines].join('\n');
  const preview = draft.trim() ? withAdded(draft) : text.saved ? withAdded(text.saved.body) : text.ours;

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border border-border p-3 space-y-2 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h3>
        <span
          data-testid={`${id}-status`}
          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
        >
          {text.saved ? 'Your wording' : 'Our wording'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{when}</p>
      {text.saved && text.saved.language !== businessLanguage && (
        <p className="text-xs text-amber-700" data-testid={`${id}-language-note`}>
          You wrote this in {LANGUAGE_NAMES[text.saved.language] ?? text.saved.language}, so only customers who read{' '}
          {LANGUAGE_NAMES[text.saved.language] ?? text.saved.language} get it. Save it again to use it for{' '}
          {LANGUAGE_NAMES[businessLanguage] ?? businessLanguage}.
        </p>
      )}

      <label htmlFor={id} className="sr-only">
        {title} wording
      </label>
      <textarea
        id={id}
        ref={area}
        rows={4}
        value={draft}
        maxLength={maxLength * 2}
        // Locked while a save or reset is on its way: its answer replaces
        // the box, so anything typed meanwhile would be lost.
        readOnly={busy}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Write your own, or leave empty to use ours."
        className="w-full rounded-lg border border-border px-3 py-2 text-sm break-words"
      />
      <div className="flex flex-wrap gap-1.5" aria-label="Fill-ins">
        {text.fillIns.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => insert(f)}
            disabled={busy}
            className="min-h-11 rounded-lg border border-border px-2 text-xs font-mono break-all disabled:opacity-50"
          >
            {`{{${f}}}`}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${id}-count`}>
        {draft.trim().length} / {maxLength}
      </p>

      <div>
        <p className="text-xs font-medium mb-1">{draft.trim() ? 'Preview' : 'What customers get now'}</p>
        <p
          data-testid={`${id}-preview`}
          className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-2 text-sm"
        >
          {preview}
        </p>
        {!draft.trim() && text.saved && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`${id}-cleared-hint`}>
            Your saved wording still goes out. Tap Reset to ours to go back to our wording.
          </p>
        )}
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="text-sm text-destructive list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !changed || !draft.trim()}
          className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
        {text.saved && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="min-h-11 rounded-lg border border-border px-4 text-sm disabled:opacity-50"
          >
            Reset to ours
          </button>
        )}
      </div>
    </section>
  );
}

export function TextWordingSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: TextWordingSheetApi;
}) {
  const [state, setState] = useState<TextWordingState | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setState(await api.fetch());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The text wording could not be loaded.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = (purpose: WordingPurpose, saved: WordingText['saved']) =>
    setState((s) => s && { ...s, texts: s.texts.map((t) => (t.purpose === purpose ? { ...t, saved } : t)) });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="text-wording-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
              <MessageSquareText size={16} />
            </span>
            <h2 id="text-wording-title" className="text-base font-semibold">
              Text wording
            </h2>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-slate-400 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Write the texts customers get in your own words. Tap a fill-in to add it. Customers who read another
            language still get our wording in their language.
          </p>
          {error && (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="min-h-11 rounded-lg border border-border px-4 text-sm"
              >
                Try again
              </button>
            </div>
          )}
          {!state && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
          {state?.texts.map((t) => (
            <WordingCard
              key={t.purpose}
              text={t}
              maxLength={state.maxLength}
              businessLanguage={state.language}
              api={api}
              onSaved={onSaved}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
