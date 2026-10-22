/**
 * D-045 — the owner's own wording for customer texts.
 *
 * Wraps GET / PUT / DELETE on /api/settings/text-wording. A refused save
 * throws with `.problems`, the API's reasons in words the owner can act on.
 */
import { apiFetch } from '../utils/api-fetch';

export type WordingPurpose = 'estimate_text' | 'invoice_text' | 'portal_link_text' | 'thank_you_text';

export interface SavedWording {
  body: string;
  /** The language it was written in: only customers who read it get it. */
  language: string;
  updatedAt: string;
}

export interface WordingText {
  purpose: WordingPurpose;
  fillIns: string[];
  sampleValues: Record<string, string>;
  /** Our wording, with the sample values, in the business's language. */
  ours: string;
  saved: SavedWording | null;
}

export interface TextWordingState {
  language: string;
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

/** GET /api/settings/text-wording */
export async function fetchTextWording(): Promise<TextWordingState> {
  return readOrThrow(await apiFetch('/api/settings/text-wording'), 'load text wording');
}

/** PUT /api/settings/text-wording/:purpose */
export async function saveTextWording(purpose: WordingPurpose, body: string): Promise<SavedWording> {
  const res = await apiFetch(`/api/settings/text-wording/${purpose}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const json = await readOrThrow<{ saved: SavedWording }>(res, 'save the wording');
  return json.saved;
}

/** DELETE /api/settings/text-wording/:purpose — back to our wording. */
export async function resetTextWording(purpose: WordingPurpose): Promise<void> {
  await readOrThrow(
    await apiFetch(`/api/settings/text-wording/${purpose}`, { method: 'DELETE' }),
    'reset the wording',
  );
}
