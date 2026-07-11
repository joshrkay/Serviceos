/**
 * N-011 / P4-015 — Brand-Voice Configurator core.
 *
 * The six-field brand voice is captured at onboarding and edited later only via
 * an explicit web action (never SMS), behind a 15-minute cool-down, with every
 * change re-validated, version-bumped (append-only history in
 * `brand_voice_versions`), and audit-logged. This module holds the pure logic
 * (validation, cool-down math, change diffing, banned-phrase merge) and the
 * repository contract; the router (`brand-voice-router.ts`) and the Pg repo
 * (`pg-brand-voice-repository.ts`) build on it.
 */
import { z } from 'zod';
import type { BrandVoiceSettings } from '../../settings/settings';
import { readToneFromSettings } from '../../ai/brand-voice/composer';

/** The explicit-web-edit cool-down window (PRD: 15 minutes). */
export const BRAND_VOICE_COOLDOWN_MS = 15 * 60 * 1000;

/** Feature flag gating the whole configurator. Default off (dark launch). */
export const BRAND_VOICE_CONFIGURATOR_FLAG = 'brand_voice_configurator';

/** Reason recorded on a `brand_voice_versions` snapshot row. */
export type BrandVoiceChangeReason = 'onboarding' | 'web_edit' | 'rollback';

/**
 * Zod contract for the six configured fields. All optional (a tenant can
 * configure incrementally), but bounded so a runaway payload can't bloat the
 * JSONB blob or the prompt. `register` is the 3-valued PRD field; legacy
 * `formality` is never written from the new surface.
 */
export const brandVoiceSchema = z.object({
  register: z.enum(['formal', 'friendly', 'casual']).optional(),
  opening_lines: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
  signoff: z.string().trim().max(200).optional(),
  banned_phrases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  persona_name: z.string().trim().max(120).optional(),
  pronoun: z.enum(['we', 'i']).optional(),
});

export type BrandVoiceInput = z.infer<typeof brandVoiceSchema>;

/** The six fields the new UI surfaces (persisted subset of BrandVoiceSettings). */
export const BRAND_VOICE_FIELDS = [
  'register',
  'opening_lines',
  'signoff',
  'banned_phrases',
  'persona_name',
  'pronoun',
] as const;

/** Snapshot of the tenant's brand-voice state read from tenant_settings. */
export interface BrandVoiceState {
  config: BrandVoiceSettings;
  version: number;
  locked: boolean;
  updatedAt: string | null;
}

export interface BrandVoiceVersionRow {
  version: number;
  snapshot: BrandVoiceSettings;
  changedBy: string | null;
  changeReason: BrandVoiceChangeReason;
  createdAt: string;
}

/**
 * How a bump derives the next config from the CURRENT (locked) config:
 *   - `merge`  — an explicit edit: union/replace the six-field patch onto the
 *     current config. `onboarding` requests the cool-down exemption, granted
 *     only when the locked state is still the initial unconfigured write.
 *   - `replace` — a rollback: overwrite with a resolved historical snapshot
 *     (no merge, cool-down always enforced).
 */
export type BrandVoiceMutation =
  | { kind: 'merge'; patch: BrandVoiceInput; onboarding: boolean }
  | { kind: 'replace'; config: BrandVoiceSettings; changeReason: 'rollback' };

/** The version-bump result the service needs to build its audit event. */
export interface BrandVoiceBumpResult {
  state: BrandVoiceState;
  fromVersion: number;
  changedFields: string[];
  changeReason: BrandVoiceChangeReason;
}

/**
 * Thrown by `bumpVersion` when the mutation lands inside the 15-minute
 * cool-down. The decision is made UNDER the repo's row lock (re-read current
 * state), so two concurrent saves can't both pass a stale pre-lock check. The
 * service maps this to an HTTP 423 (keeping HTTP concerns out of the repo).
 */
export class BrandVoiceCooldownError extends Error {
  constructor(readonly cooldownUntil: string | null) {
    super('Brand voice is in cool-down');
    this.name = 'BrandVoiceCooldownError';
  }
}

/**
 * Resolve the version-bump decision (cool-down precondition + merge + change
 * diff) from the LOCKED current state. MUST be called by the repo while it
 * holds the `FOR UPDATE` row lock so the read → cool-down check → merge is
 * atomic with the write — otherwise concurrent saves merge on stale config and
 * both bypass the cool-down (TOCTOU). Pure and side-effect free.
 *
 * @throws BrandVoiceCooldownError when the mutation is inside the cool-down.
 * @throws Error when the merged config does not round-trip to a usable tone.
 */
export function resolveBumpDecision(
  current: BrandVoiceState,
  mutation: BrandVoiceMutation,
  now: number,
): { nextConfig: BrandVoiceSettings; changeReason: BrandVoiceChangeReason; changedFields: string[]; fromVersion: number } {
  // The onboarding cool-down exemption applies ONLY to the genuine initial
  // write (no version yet). Trusting the client `onboarding` flag alone would
  // let any settings:update caller (or a stale onboarding client) skip the 423
  // on a later edit and mislabel it 'onboarding' — so gate on the real,
  // now-locked unconfigured state.
  const isInitialWrite = current.version === 0;
  const cooldownExempt =
    mutation.kind === 'merge' && mutation.onboarding && isInitialWrite;

  if (!cooldownExempt && isInCooldown(current.updatedAt, now)) {
    throw new BrandVoiceCooldownError(cooldownUntil(current.updatedAt));
  }

  let nextConfig: BrandVoiceSettings;
  let changeReason: BrandVoiceChangeReason;
  if (mutation.kind === 'merge') {
    nextConfig = mergeBrandVoice(current.config, mutation.patch);
    changeReason = cooldownExempt ? 'onboarding' : 'web_edit';
  } else {
    nextConfig = mutation.config;
    changeReason = mutation.changeReason;
  }
  revalidateRoundTrip(nextConfig);

  return {
    nextConfig,
    changeReason,
    changedFields: computeChangedFields(current.config, nextConfig),
    fromVersion: current.version,
  };
}

/**
 * Repository for the append-only history table + the tenant_settings
 * bookkeeping columns. `bumpVersion` is the single transactional write: under
 * one `FOR UPDATE` lock it re-reads current state, applies the cool-down +
 * merge precondition (`resolveBumpDecision`), inserts the next snapshot row
 * (version = current + 1), and updates the settings blob + bookkeeping columns
 * atomically. The service passes the mutation (patch/snapshot) + cool-down
 * policy + the `now` used for both the cool-down decision AND the persisted
 * anchor (no clock drift between the two).
 */
export interface BrandVoiceRepository {
  getState(tenantId: string): Promise<BrandVoiceState>;
  listVersions(tenantId: string): Promise<BrandVoiceVersionRow[]>;
  getVersionSnapshot(
    tenantId: string,
    version: number,
  ): Promise<BrandVoiceSettings | null>;
  bumpVersion(
    tenantId: string,
    args: {
      mutation: BrandVoiceMutation;
      changedBy: string | null;
      now: number;
    },
  ): Promise<BrandVoiceBumpResult>;
}

/**
 * Cool-down anchor → the ISO instant the tenant may edit again, or null when
 * there is no anchor (never edited) so the first edit is unconstrained.
 */
export function cooldownUntil(updatedAt: string | null | undefined): string | null {
  if (!updatedAt) return null;
  const anchor = Date.parse(updatedAt);
  if (Number.isNaN(anchor)) return null;
  return new Date(anchor + BRAND_VOICE_COOLDOWN_MS).toISOString();
}

/**
 * True when an explicit web edit is inside the 15-minute cool-down. Onboarding
 * writes are exempt (handled by the caller passing `onboarding=true`), and a
 * tenant with no anchor (first configure) is never in cool-down.
 */
export function isInCooldown(
  updatedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const until = cooldownUntil(updatedAt);
  if (!until) return false;
  return now < Date.parse(until);
}

/**
 * Merge the incoming six-field patch onto the existing config. `banned_phrases`
 * is UNIONed with the existing list — never overwritten — so an owner save can
 * not wipe phrases the N-009 correction loop learned (design risk mitigation).
 * Other fields are replaced when present, preserved when the key is omitted.
 */
export function mergeBrandVoice(
  existing: BrandVoiceSettings,
  patch: BrandVoiceInput,
): BrandVoiceSettings {
  const next: BrandVoiceSettings = { ...existing };
  if (patch.register !== undefined) next.register = patch.register;
  if (patch.opening_lines !== undefined) next.opening_lines = patch.opening_lines;
  if (patch.signoff !== undefined) next.signoff = patch.signoff;
  if (patch.persona_name !== undefined) next.persona_name = patch.persona_name;
  if (patch.pronoun !== undefined) next.pronoun = patch.pronoun;
  if (patch.banned_phrases !== undefined) {
    const union = new Set<string>([
      ...(existing.banned_phrases ?? []),
      ...patch.banned_phrases,
    ]);
    next.banned_phrases = Array.from(union);
  }
  return next;
}

/** The set of six-field keys whose value changed between two configs. */
export function computeChangedFields(
  prev: BrandVoiceSettings,
  next: BrandVoiceSettings,
): string[] {
  const changed: string[] = [];
  for (const key of BRAND_VOICE_FIELDS) {
    if (JSON.stringify(prev[key] ?? null) !== JSON.stringify(next[key] ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * Re-validate that the persisted blob round-trips to a usable tone (mirrors the
 * composer read). Throws a plain Error when the blob is structurally unusable;
 * a null/neutral tone is acceptable (empty config is valid).
 */
export function revalidateRoundTrip(config: BrandVoiceSettings): void {
  // readToneFromSettings expects the settings-row shape ({ brandVoice }).
  const tone = readToneFromSettings({ brandVoice: config });
  if (config && Object.keys(config).length > 0 && tone === null) {
    throw new Error('Brand voice did not round-trip to a usable tone');
  }
}
