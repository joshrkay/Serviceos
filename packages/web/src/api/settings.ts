/**
 * P11-002 — Tenant language settings client.
 *
 * Wraps the small REST surface the API exposes for the
 * LanguageSettings page. Kept deliberately tiny — settings page
 * fetches once on mount and PATCHes on save; no live queries.
 */
import { apiFetch } from '../utils/api-fetch';

export type Language = 'en' | 'es';

export interface LanguageSettings {
  defaultLanguage: Language;
  ttsVoiceEn?: string | null;
  ttsVoiceEs?: string | null;
  autoDetectLanguage: boolean;
  spanishDispatcherUserIds: string[];
}

/**
 * GET /api/settings/language. Returns the tenant's current
 * language-stack configuration. Defaults to English-only when
 * the tenant has not configured anything yet.
 */
export async function fetchLanguageSettings(): Promise<LanguageSettings> {
  const res = await apiFetch('/api/settings/language');
  if (!res.ok) {
    throw new Error(`fetchLanguageSettings failed: ${res.status}`);
  }
  return res.json();
}

/**
 * PATCH /api/settings/language. Body shape mirrors LanguageSettings
 * with all fields optional so the UI can save just the dropdown
 * change without round-tripping every column.
 */
export async function updateLanguageSettings(
  patch: Partial<LanguageSettings>,
): Promise<LanguageSettings> {
  const res = await apiFetch('/api/settings/language', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`updateLanguageSettings failed: ${res.status}`);
  }
  return res.json();
}
