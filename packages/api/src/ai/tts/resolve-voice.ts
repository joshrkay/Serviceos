import { z } from 'zod';
import {
  resolveVoicePreset,
  VOICE_PRESETS,
} from '../../integrations/vapi/assistant-config';
import type { SettingsRepository } from '../../settings/settings';
import type { TtsProvider } from './tts-provider';

/**
 * S3-1 (plan U4) — which voice `POST /api/voice/tts` speaks in.
 *
 * The owner's choice lives in `tenant_settings.voice_id` as a PRESET key
 * (`rachel` | `adam` | `bella`, migration 147, written by voice/voice-config.ts),
 * never a vendor id. The body may name a preset to override it; anything
 * else is a validation error. Raw vendor voice ids never cross the wire and
 * never reach the audit log: the route audits `presetId`, and only the
 * provider call and the clip-cache key see `providerVoiceId`.
 */

/** A voice preset key as the body may send it; unknown keys are a 400. */
export const TTS_VOICE_PRESET_SCHEMA = z.enum(
  VOICE_PRESETS.map((p) => p.id) as [string, ...string[]],
);

/** Cache-key voice for a provider that maps none of the presets. */
const DEFAULT_PROVIDER_VOICE_KEY = 'default';

export interface ResolvedTtsVoice {
  /** The preset key (for the audit row and the client). */
  presetId: string;
  /**
   * The provider's own id for that preset — passed as `voice` and used as
   * the cache key — or `'default'` when the provider has no catalogue for
   * the presets (then no `voice` is passed and it speaks its own default).
   */
  providerVoiceId: string;
}

export async function resolveTtsVoice(input: {
  tenantId: string;
  /** A preset key from the request body, already validated. */
  requestedPresetId?: string;
  settingsRepo?: Pick<SettingsRepository, 'findByTenant'>;
  provider: Pick<TtsProvider, 'voiceForPreset'>;
}): Promise<ResolvedTtsVoice> {
  const storedPresetId = input.requestedPresetId
    ? undefined
    : (await input.settingsRepo?.findByTenant(input.tenantId))?.voiceId;
  const preset = resolveVoicePreset(input.requestedPresetId ?? storedPresetId);
  const providerVoiceId = input.provider.voiceForPreset?.(preset) ?? DEFAULT_PROVIDER_VOICE_KEY;
  return { presetId: preset.id, providerVoiceId };
}
