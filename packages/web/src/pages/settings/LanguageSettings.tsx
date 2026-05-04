/**
 * P11-002 — Tenant language settings page.
 *
 * Lets an operator pick the tenant's default voice language ('en' / 'es')
 * and toggle Whisper auto-detection. Voice overrides + Spanish dispatcher
 * UID assignment are placeholders — those are wired up by a follow-up
 * settings story that has the user picker available.
 */
import { useEffect, useState } from 'react';
import {
  fetchLanguageSettings,
  updateLanguageSettings,
  type Language,
  type LanguageSettings,
} from '../../api/settings';

const DEFAULTS: LanguageSettings = {
  defaultLanguage: 'en',
  ttsVoiceEn: null,
  ttsVoiceEs: null,
  autoDetectLanguage: true,
  spanishDispatcherUserIds: [],
};

export function LanguageSettingsPage() {
  const [settings, setSettings] = useState<LanguageSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLanguageSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(next: Partial<LanguageSettings>) {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateLanguageSettings(next);
      setSettings(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div data-testid="language-settings-loading">Loading…</div>;
  }

  return (
    <section className="space-y-4 p-4" aria-label="Language settings">
      <h1 className="text-xl font-semibold">Language</h1>

      <label className="block">
        <span className="block text-sm font-medium">Default language</span>
        <select
          aria-label="Default language"
          className="mt-1 block w-48 rounded border px-2 py-1"
          value={settings.defaultLanguage}
          disabled={saving}
          onChange={(e) =>
            handleSave({ defaultLanguage: e.target.value as Language })
          }
        >
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Auto-detect caller language"
          checked={settings.autoDetectLanguage}
          disabled={saving}
          onChange={(e) =>
            handleSave({ autoDetectLanguage: e.target.checked })
          }
        />
        <span>Auto-detect caller language</span>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {savedAt ? (
        <p className="text-sm text-gray-500">Saved.</p>
      ) : null}
    </section>
  );
}

export default LanguageSettingsPage;
