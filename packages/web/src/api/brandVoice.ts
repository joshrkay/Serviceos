/**
 * N-011 — Brand-Voice Configurator client.
 *
 * Wraps GET/PUT/versions/rollback on /api/settings/brand-voice. Mirrors the
 * small settings client style (util-based apiFetch, one fn per endpoint). The
 * PUT is the "explicit web action"; a 423 surfaces the cool-down.
 */
import { apiFetch } from '../utils/api-fetch';

export type BrandVoiceRegister = 'formal' | 'friendly' | 'casual';
export type BrandVoicePronoun = 'we' | 'i';

/** The six configured fields the UI edits. */
export interface BrandVoiceFields {
  register?: BrandVoiceRegister;
  opening_lines?: string[];
  signoff?: string;
  banned_phrases?: string[];
  persona_name?: string;
  pronoun?: BrandVoicePronoun;
}

/** GET response — the six fields plus version/lock/cool-down bookkeeping. */
export interface BrandVoiceState extends BrandVoiceFields {
  opening_lines: string[];
  banned_phrases: string[];
  version: number;
  locked: boolean;
  updated_at: string | null;
  cooldown_until: string | null;
}

export interface BrandVoiceVersionEntry {
  version: number;
  snapshot: BrandVoiceFields;
  changedBy: string | null;
  changeReason: 'onboarding' | 'web_edit' | 'rollback';
  createdAt: string;
}

async function readOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as {
      message?: string;
      details?: { cooldownUntil?: string };
    };
    const err = new Error(json?.message ?? `Failed to ${action}: ${res.status}`) as Error & {
      status?: number;
      cooldownUntil?: string;
    };
    err.status = res.status;
    err.cooldownUntil = json?.details?.cooldownUntil;
    throw err;
  }
  return (await res.json()) as T;
}

/** GET /api/settings/brand-voice */
export async function fetchBrandVoice(): Promise<BrandVoiceState> {
  return readOrThrow(await apiFetch('/api/settings/brand-voice'), 'load brand voice');
}

/**
 * PUT /api/settings/brand-voice — the explicit web edit (or, with
 * `onboarding: true`, the first cool-down-exempt capture). Throws with
 * `.status === 423` and `.cooldownUntil` when inside the cool-down.
 */
export async function saveBrandVoice(
  fields: BrandVoiceFields & { onboarding?: boolean },
): Promise<BrandVoiceState> {
  const res = await apiFetch('/api/settings/brand-voice', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return readOrThrow(res, 'save brand voice');
}

/** GET /api/settings/brand-voice/versions */
export async function fetchBrandVoiceVersions(): Promise<BrandVoiceVersionEntry[]> {
  const data = await readOrThrow<{ versions: BrandVoiceVersionEntry[] }>(
    await apiFetch('/api/settings/brand-voice/versions'),
    'load brand voice history',
  );
  return data.versions;
}

/** POST /api/settings/brand-voice/rollback */
export async function rollbackBrandVoice(version: number): Promise<BrandVoiceState> {
  const res = await apiFetch('/api/settings/brand-voice/rollback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  return readOrThrow(res, 'roll back brand voice');
}
