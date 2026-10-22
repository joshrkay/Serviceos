/**
 * D-045 — the owner's own wording for customer texts.
 *
 * Wraps GET / PUT / DELETE on /api/settings/text-wording. A refused save
 * throws with `.problems`, the API's reasons in words the owner can act on.
 */
import { apiFetch } from '../utils/api-fetch';

export type WordingPurpose = 'estimate_text' | 'invoice_text' | 'portal_link_text' | 'thank_you_text';

export type WordingLanguage = 'en' | 'es';

export interface SavedWording {
  body: string;
  updatedAt: string;
}

/** One text in one language: customers who read that language get it. */
export interface WordingVersion {
  /** Our wording, with the sample values, in this language. */
  ours: string;
  /** Lines every send adds after the owner's wording (e.g. "we collect payment in person"). */
  addedLines: string[];
  saved: SavedWording | null;
}

export interface WordingText {
  purpose: WordingPurpose;
  fillIns: string[];
  sampleValues: Record<string, string>;
  byLanguage: Record<WordingLanguage, WordingVersion>;
}

export interface TextWordingState {
  /** The business's own language: the one the screen opens on. */
  language: WordingLanguage;
  languages: WordingLanguage[];
  maxLength: number;
  texts: WordingText[];
}

async function readOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string; problems?: string[] };
    const err = new Error(json?.message ?? `Failed to ${action}: ${res.status}`) as Error & {
      problems?: string[];
    };
    err.problems = json?.problems;
    throw err;
  }
  return (await res.json()) as T;
}

/** What the API sent before wording was per language: one version per text, in the business's language. */
interface SingleLanguageText {
  purpose: WordingPurpose;
  fillIns: string[];
  sampleValues: Record<string, string>;
  ours: string;
  addedLines: string[];
  saved: SavedWording | null;
}

/**
 * During a deploy the web can be ahead of the API. An API still on the
 * one-language shape gets the business's language only: its save and reset
 * act on that language, so the screen offers nothing it can't do.
 */
export function normalizeTextWording(
  raw: TextWordingState | (Omit<TextWordingState, 'languages' | 'texts'> & { texts: SingleLanguageText[] }),
): TextWordingState {
  if ('languages' in raw && Array.isArray(raw.languages)) return raw as TextWordingState;
  const { language, maxLength } = raw;
  return {
    language,
    languages: [language],
    maxLength,
    texts: (raw.texts as SingleLanguageText[]).map(({ purpose, fillIns, sampleValues, ours, addedLines, saved }) => ({
      purpose,
      fillIns,
      sampleValues,
      byLanguage: {
        [language]: { ours, addedLines, saved: saved && { body: saved.body, updatedAt: saved.updatedAt } },
      } as Record<WordingLanguage, WordingVersion>,
    })),
  };
}

/** GET /api/settings/text-wording */
export async function fetchTextWording(): Promise<TextWordingState> {
  return normalizeTextWording(await readOrThrow(await apiFetch('/api/settings/text-wording'), 'load text wording'));
}

/** PUT /api/settings/text-wording/:purpose */
export async function saveTextWording(
  purpose: WordingPurpose,
  body: string,
  language: WordingLanguage,
): Promise<SavedWording> {
  const res = await apiFetch(`/api/settings/text-wording/${purpose}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, language }),
  });
  const json = await readOrThrow<{ saved: SavedWording }>(res, 'save the wording');
  return json.saved;
}

/** DELETE /api/settings/text-wording/:purpose?language= — back to our wording in that language. */
export async function resetTextWording(purpose: WordingPurpose, language: WordingLanguage): Promise<void> {
  await readOrThrow(
    await apiFetch(`/api/settings/text-wording/${purpose}?language=${language}`, { method: 'DELETE' }),
    'reset the wording',
  );
}
