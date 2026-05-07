/**
 * Curated ElevenLabs voice personas exposed to tenants in the Settings UI.
 *
 * Canonical source. The web side mirrors this list inline at
 * packages/web/src/components/settings/BusinessProfileSheet.tsx — keep
 * the two in sync (cross-package import is blocked by tsconfig rootDir).
 *
 * The empty-string id represents "use the deployment default" (Rachel,
 * 21m00Tcm4TlvDq8ikWAM, baked into ElevenLabsTtsProvider's constructor).
 * Tenants who pick this option store NULL in tenant_settings.tts_voice_id
 * and inherit whatever default the deployment ships with.
 */

export interface VoicePersona {
  /** ElevenLabs voice id; empty string means "use deployment default". */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
}

export const VOICE_PERSONAS: ReadonlyArray<VoicePersona> = [
  { id: '', label: 'Rachel — warm, professional female (default)' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — calm, authoritative male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — friendly, approachable female' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — conversational male' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli — clear, young female' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte — professional, British female' },
];

/**
 * Sample line played when a tenant clicks "Preview" in the Settings UI.
 * Long enough to hear timbre/pace; covers the assistant's actual job so
 * the tenant judges fit-for-purpose, not just generic voice quality.
 */
export const VOICE_PREVIEW_SAMPLE_TEXT =
  "Hi, this is your assistant. I can help schedule appointments, draft estimates, or take payments. How can I help today?";

/** True if the given voice id is one we expose to tenants. */
export function isAllowedVoiceId(voiceId: string): boolean {
  return VOICE_PERSONAS.some((v) => v.id === voiceId);
}
