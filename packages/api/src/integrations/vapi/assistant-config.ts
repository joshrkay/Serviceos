/**
 * Voice presets + Vapi assistant config builder.
 *
 * The onboarding voice step offers three ElevenLabs preset voices. The
 * greeting is auto-generated from the business name (+ services) and can be
 * overridden by the operator; both the chosen voice and greeting are
 * persisted onto the tenant's Vapi assistant and mirrored to tenant_settings.
 */

export interface VoicePreset {
  /** Stable key stored in tenant_settings.voice_id. */
  id: string;
  /** Display label for the picker. */
  label: string;
  /** ElevenLabs voice id sent to Vapi (`voice.voiceId`). */
  elevenLabsVoiceId: string;
  description: string;
}

/** The three preset voices offered in onboarding. */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: 'rachel', label: 'Rachel', elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM', description: 'Warm, professional — female' },
  { id: 'adam', label: 'Adam', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', description: 'Calm, confident — male' },
  { id: 'bella', label: 'Bella', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', description: 'Friendly, upbeat — female' },
] as const;

export const DEFAULT_VOICE_PRESET_ID = 'rachel';

/** Resolve a preset by id, falling back to the default (never throws). */
export function resolveVoicePreset(id: string | null | undefined): VoicePreset {
  return VOICE_PRESETS.find((v) => v.id === id) ?? VOICE_PRESETS[0];
}

function formatList(items: string[]): string {
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`;
}

/**
 * Auto-generate the agent's opening line from the business name and the
 * services the tenant offers. Deterministic so tests can assert it.
 */
export function autoGenerateGreeting(businessName: string, services: string[] = []): string {
  const name = businessName?.trim() || 'our team';
  const svc = services.length > 0 ? ` We handle ${formatList(services)}.` : '';
  return `Thanks for calling ${name}.${svc} How can I help you today?`;
}

export interface VapiAssistantConfig {
  name: string;
  firstMessage: string;
  /** ElevenLabs voice id. */
  voiceId: string;
  /** Where Vapi POSTs call events (the tenant-scoped /webhooks/vapi route). */
  serverUrl?: string;
  /** Shared secret Vapi echoes back so the webhook can authenticate it. */
  serverUrlSecret?: string;
}

/**
 * Build the Vapi assistant config for a tenant. Greeting precedence: explicit
 * override → auto-generated from business name + services.
 */
export function buildAssistantConfig(input: {
  businessName: string;
  greeting?: string | null;
  voicePresetId?: string | null;
  services?: string[];
  serverUrl?: string;
  serverUrlSecret?: string;
}): VapiAssistantConfig {
  const preset = resolveVoicePreset(input.voicePresetId);
  const firstMessage =
    input.greeting && input.greeting.trim()
      ? input.greeting.trim()
      : autoGenerateGreeting(input.businessName, input.services ?? []);
  return {
    name: `${(input.businessName || 'ServiceOS').trim()} AI Receptionist`,
    firstMessage,
    voiceId: preset.elevenLabsVoiceId,
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    ...(input.serverUrlSecret ? { serverUrlSecret: input.serverUrlSecret } : {}),
  };
}
