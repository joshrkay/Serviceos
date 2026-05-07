/**
 * Tier 4 (Settings stubs) — Business Profile editor.
 *
 * Closes the first of the 13 `action: () => {}` stubs in SettingsPage:
 * Business profile (Name, phone, email, timezone). The fields here
 * mirror what the backend already accepts at PUT /api/settings — name,
 * phone, email, timezone. Address + logo are tracked as a follow-up
 * because they need a backend schema extension first.
 *
 * Pattern: GET on open, PUT on save, Sonner toast on success/failure.
 */
import { useEffect, useRef, useState } from 'react';
import { X, Building2, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface BusinessProfileFields {
  businessName: string;
  businessPhone: string;
  businessEmail: string;
  timezone: string;
  ttsVoiceId: string;
}

const EMPTY: BusinessProfileFields = {
  businessName: '',
  businessPhone: '',
  businessEmail: '',
  timezone: '',
  ttsVoiceId: '',
};

// Mirror of packages/api/src/voice/voice-personas.ts — keep in sync.
// (Cross-package imports are blocked by tsconfig rootDir; the API enforces
// this exact list when validating /api/settings/voice-preview requests.)
const VOICE_OPTIONS = [
  { id: '', label: 'Rachel — warm, professional female (default)' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — calm, authoritative male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — friendly, approachable female' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — conversational male' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli — clear, young female' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte — professional, British female' },
];

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

interface BusinessProfileSheetProps {
  onClose: () => void;
}

export function BusinessProfileSheet({ onClose }: BusinessProfileSheetProps) {
  const [fields, setFields] = useState<BusinessProfileFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>('');
  const previewUrlRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  async function previewVoice() {
    if (previewing) return;
    setPreviewing(true);
    try {
      const res = await apiFetch('/api/settings/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: fields.ttsVoiceId }),
      });
      if (!res.ok) {
        let msg = `Preview failed (${res.status})`;
        try {
          const body = await res.json();
          if (typeof body?.message === 'string') msg = body.message;
        } catch {
          /* non-JSON */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      if (previewAudioRef.current) previewAudioRef.current.pause();
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => setPreviewing(false);
      audio.onerror = () => setPreviewing(false);
      await audio.play();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not play preview';
      toast.error(msg);
      setPreviewing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as Partial<BusinessProfileFields>;
        if (cancelled) return;
        setFields({
          businessName: data.businessName ?? '',
          businessPhone: data.businessPhone ?? '',
          businessEmail: data.businessEmail ?? '',
          timezone: data.timezone ?? '',
          ttsVoiceId: (data as { ttsVoiceId?: string | null }).ttsVoiceId ?? '',
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setError('');
    if (!fields.businessName.trim()) {
      setError('Business name is required.');
      return;
    }
    setSaving(true);
    try {
      // Codex P2 (PR #316): send explicit `null` for cleared optional
      // fields. Sending `undefined` causes JSON.stringify to drop the
      // key, and the PUT /api/settings update treats omitted keys as
      // no-op — so a user couldn't actually delete a previously-saved
      // phone/email/timezone. Null lets the repo write NULL to the DB.
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: fields.businessName.trim(),
          businessPhone: fields.businessPhone.trim() || null,
          businessEmail: fields.businessEmail.trim() || null,
          timezone: fields.timezone || null,
          ttsVoiceId: fields.ttsVoiceId || null,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      toast.success('Business profile saved');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="business-profile-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Building2 size={16} className="text-slate-700" />
          </span>
          <h2 id="business-profile-title" className="flex-1 text-base text-slate-900">
            Business profile
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <label htmlFor="bp-name" className="block">
                <span className="text-sm text-slate-700">Business name</span>
                <input
                  id="bp-name"
                  type="text"
                  value={fields.businessName}
                  onChange={(e) => setFields((f) => ({ ...f, businessName: e.target.value }))}
                  placeholder="Ortega HVAC & Services"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                  required
                />
              </label>

              <label htmlFor="bp-phone" className="block">
                <span className="text-sm text-slate-700">Phone</span>
                <input
                  id="bp-phone"
                  type="tel"
                  value={fields.businessPhone}
                  onChange={(e) => setFields((f) => ({ ...f, businessPhone: e.target.value }))}
                  placeholder="+1 (555) 123-4567"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
              </label>

              <label htmlFor="bp-email" className="block">
                <span className="text-sm text-slate-700">Email</span>
                <input
                  id="bp-email"
                  type="email"
                  value={fields.businessEmail}
                  onChange={(e) => setFields((f) => ({ ...f, businessEmail: e.target.value }))}
                  placeholder="hello@ortega-hvac.com"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                />
              </label>

              <label htmlFor="bp-timezone" className="block">
                <span className="text-sm text-slate-700">Timezone</span>
                <select
                  id="bp-timezone"
                  value={fields.timezone}
                  onChange={(e) => setFields((f) => ({ ...f, timezone: e.target.value }))}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors bg-white"
                >
                  <option value="">Select a timezone…</option>
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </label>

              <div className="block">
                <label htmlFor="bp-voice" className="text-sm text-slate-700">
                  AI calling voice
                </label>
                <div className="mt-1.5 flex items-stretch gap-2">
                  <select
                    id="bp-voice"
                    value={fields.ttsVoiceId}
                    onChange={(e) => setFields((f) => ({ ...f, ttsVoiceId: e.target.value }))}
                    className="min-w-0 flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors bg-white"
                  >
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={previewVoice}
                    disabled={previewing}
                    aria-label="Preview voice"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {previewing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    <span>{previewing ? 'Playing…' : 'Preview'}</span>
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
