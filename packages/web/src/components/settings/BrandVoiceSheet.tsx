/**
 * N-011 — Brand-Voice Configurator settings sheet.
 *
 * Edits the six brand-voice fields (register, opening lines, sign-off, banned
 * phrases, persona name, pronoun). The tone is LOCKED after onboarding: fields
 * render read-only until the owner takes the explicit "Edit brand voice" action
 * (the PRD "explicit web action" gate). Saving bumps the version and starts a
 * 15-minute cool-down, surfaced as a countdown. Mirrors StandingInstructionsSheet.
 */
import { useCallback, useEffect, useState } from 'react';
import { X, MessageSquareQuote, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '../ui';
import {
  type BrandVoiceState,
  type BrandVoiceFields,
  type BrandVoiceRegister,
  type BrandVoicePronoun,
  fetchBrandVoice as fetchApi,
  saveBrandVoice as saveApi,
} from '../../api/brandVoice';

export interface BrandVoiceSheetApi {
  fetch: typeof fetchApi;
  save: typeof saveApi;
}

const DEFAULT_API: BrandVoiceSheetApi = { fetch: fetchApi, save: saveApi };

const REGISTERS: { id: BrandVoiceRegister; label: string; hint: string }[] = [
  { id: 'formal', label: 'Formal', hint: 'Polished, professional' },
  { id: 'friendly', label: 'Friendly', hint: 'Warm, approachable' },
  { id: 'casual', label: 'Casual', hint: 'Relaxed, plain-spoken' },
];

const PRONOUNS: { id: BrandVoicePronoun; label: string }[] = [
  { id: 'we', label: 'We' },
  { id: 'i', label: 'I' },
];

function linesToText(list: string[] | undefined): string {
  return (list ?? []).join('\n');
}
function textToLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Minutes remaining on the cool-down, or 0 when clear. */
export function cooldownMinutesRemaining(
  cooldownUntil: string | null,
  now: number = Date.now(),
): number {
  if (!cooldownUntil) return 0;
  const ms = Date.parse(cooldownUntil) - now;
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export function BrandVoiceSheet({
  onClose,
  api = DEFAULT_API,
}: {
  onClose: () => void;
  api?: BrandVoiceSheetApi;
}) {
  const [state, setState] = useState<BrandVoiceState | null>(null);
  const [fields, setFields] = useState<BrandVoiceFields>({});
  const [openingText, setOpeningText] = useState('');
  const [bannedText, setBannedText] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const hydrate = useCallback((s: BrandVoiceState) => {
    setState(s);
    setFields({
      register: s.register,
      signoff: s.signoff,
      persona_name: s.persona_name,
      pronoun: s.pronoun,
    });
    setOpeningText(linesToText(s.opening_lines));
    setBannedText(linesToText(s.banned_phrases));
    // A never-configured tone (version 0) opens straight into edit mode.
    setEditing(!s.locked);
  }, []);

  const load = useCallback(async () => {
    try {
      hydrate(await api.fetch());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load brand voice');
    }
  }, [api, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tick once a minute so the cool-down countdown stays fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const cooldownMins = cooldownMinutesRemaining(state?.cooldown_until ?? null, now);
  const coolingDown = cooldownMins > 0;

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      const next = await api.save({
        ...fields,
        opening_lines: textToLines(openingText),
        banned_phrases: textToLines(bannedText),
      });
      hydrate(next);
      setEditing(false);
      toast.success(`Brand voice saved (v${next.version})`);
    } catch (err) {
      const e = err as Error & { status?: number };
      const message =
        e.status === 423
          ? 'Brand voice was changed recently — try again after the cool-down.'
          : e.message || 'Could not save brand voice';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const readOnly = !editing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="brand-voice-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
              <MessageSquareQuote size={16} />
            </span>
            <h2 id="brand-voice-title" className="text-base font-semibold">
              Brand voice
            </h2>
            {state && state.version > 0 && (
              <span
                data-testid="brand-voice-version-badge"
                className="inline-flex items-center rounded-full border border-border bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                v{state.version}
              </span>
            )}
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-slate-400 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            How the AI sounds in every customer message. Locked after setup — edit
            it here, and changes take a few minutes to settle.
          </p>

          {/* Register */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Register</label>
            <div className="grid gap-2 sm:grid-cols-3">
              {REGISTERS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={fields.register === r.id}
                  onClick={() => setFields((f) => ({ ...f, register: r.id }))}
                  className={`min-h-11 rounded-xl border p-2 text-left transition disabled:opacity-60 ${
                    fields.register === r.id
                      ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <span className="block text-sm font-medium">{r.label}</span>
                  <span className="block text-xs text-slate-500">{r.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Pronoun */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Refers to the business as</label>
            <div className="grid grid-cols-2 gap-2">
              {PRONOUNS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={fields.pronoun === p.id}
                  onClick={() => setFields((f) => ({ ...f, pronoun: p.id }))}
                  className={`min-h-11 rounded-xl border p-2 text-center transition disabled:opacity-60 ${
                    fields.pronoun === p.id
                      ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Persona name */}
          <div>
            <label htmlFor="bv-persona" className="block text-sm font-medium mb-1.5">
              Shop persona name
            </label>
            <Input
              id="bv-persona"
              className="min-h-11 w-full"
              disabled={readOnly}
              value={fields.persona_name ?? ''}
              onChange={(e) => setFields((f) => ({ ...f, persona_name: e.target.value }))}
              placeholder="e.g. M&R Mechanical's office"
            />
          </div>

          {/* Sign-off */}
          <div>
            <label htmlFor="bv-signoff" className="block text-sm font-medium mb-1.5">
              Sign-off
            </label>
            <Input
              id="bv-signoff"
              className="min-h-11 w-full"
              disabled={readOnly}
              value={fields.signoff ?? ''}
              onChange={(e) => setFields((f) => ({ ...f, signoff: e.target.value }))}
              placeholder="e.g. — The M&R team"
            />
          </div>

          {/* Opening lines */}
          <div>
            <label htmlFor="bv-opening" className="block text-sm font-medium mb-1.5">
              Preferred opening lines
            </label>
            <textarea
              id="bv-opening"
              className="min-h-11 w-full rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-60"
              rows={3}
              disabled={readOnly}
              value={openingText}
              onChange={(e) => setOpeningText(e.target.value)}
              placeholder={'One per line\nThanks for reaching out'}
            />
          </div>

          {/* Banned phrases */}
          <div>
            <label htmlFor="bv-banned" className="block text-sm font-medium mb-1.5">
              Never say
            </label>
            <textarea
              id="bv-banned"
              className="min-h-11 w-full rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-60"
              rows={2}
              disabled={readOnly}
              value={bannedText}
              onChange={(e) => setBannedText(e.target.value)}
              placeholder={'One per line\ncheapest in town'}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {readOnly ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="min-h-11 px-4 rounded-lg border border-border text-sm font-medium hover:bg-slate-50"
              >
                Edit brand voice
              </button>
            ) : (
              <>
                {coolingDown && (
                  <span data-testid="brand-voice-cooldown" className="text-xs text-slate-500">
                    You can edit again in ~{cooldownMins} min
                  </span>
                )}
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || coolingDown}
                  className="flex items-center gap-1 min-h-11 px-4 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
                >
                  <Check size={14} /> {saving ? 'Saving…' : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
