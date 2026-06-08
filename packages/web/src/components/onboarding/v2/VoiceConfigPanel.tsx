import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { Button } from '../../ui';

interface Preset {
  id: string;
  label: string;
  description: string;
}

/**
 * Feature 4 — voice agent configuration. Lets the operator pick one of the
 * three ElevenLabs preset voices and (optionally) override the auto-generated
 * greeting. Saves via PUT /api/onboarding/voice, which persists the choice and
 * pushes it onto the tenant's Vapi assistant.
 *
 * Self-contained so it can sit inside the AI-check (voice) step without
 * touching that step's verification logic.
 */
export function VoiceConfigPanel() {
  const apiFetch = useApiClient();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [voiceId, setVoiceId] = useState('rachel');
  const [greeting, setGreeting] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/onboarding/voice/presets');
        if (!res.ok) return;
        const body = (await res.json()) as { presets?: Preset[] };
        if (active && body.presets) setPresets(body.presets);
      } catch {
        // presets are non-critical; the picker just stays on the default
      }
    })();
    return () => {
      active = false;
    };
  }, [apiFetch]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch('/api/onboarding/voice', {
        method: 'PUT',
        body: JSON.stringify({ voiceId, ...(greeting.trim() ? { greeting: greeting.trim() } : {}) }),
      });
      if (!res.ok) {
        setError(`Couldn't save your voice (HTTP ${res.status}).`);
        return;
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Choose your agent&apos;s voice</h2>
        <p className="text-xs text-slate-500 mt-1">
          Pick a voice and tweak the greeting. You can change this anytime.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {(presets.length > 0 ? presets : [{ id: 'rachel', label: 'Rachel', description: '' }]).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setVoiceId(p.id)}
            aria-pressed={voiceId === p.id}
            className={`rounded-xl border p-3 text-left transition ${
              voiceId === p.id
                ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <span className="block text-sm font-medium text-slate-900">{p.label}</span>
            {p.description && <span className="block text-xs text-slate-500 mt-0.5">{p.description}</span>}
          </button>
        ))}
      </div>

      <div>
        <label htmlFor="voice-greeting" className="block text-xs font-medium text-slate-700">
          Greeting (optional — leave blank to auto-generate)
        </label>
        <textarea
          id="voice-greeting"
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Thanks for calling — how can I help you today?"
          className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save voice'}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
            <Check size={14} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
