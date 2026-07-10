/**
 * Real BrandVoiceLoader backing the reputation (Google review) draft path.
 *
 * `NoopBrandVoiceLoader` was a placeholder for "P4-015 not yet in the repo"
 * (see brand-voice.ts). P4-015 has since shipped — the tenant tone lives in
 * `tenant_settings.brand_voice` and is read by the same
 * `readToneFromSettings` the composer uses. This loader is the swap the
 * placeholder's own comment described ("swaps NoopBrandVoiceLoader for the real
 * implementation — one line at the composition root"), so public + private
 * review responses finally sound like the shop and honor the owner's
 * correction-loop banned_phrases — on the most visible surface of all.
 *
 * Failure-soft: a settings read error or malformed tone degrades to the neutral
 * voice (the draft composers omit tone/signoff when null), never throws.
 */
import type { SettingsRepository } from '../settings/settings';
import {
  readToneFromSettings,
  type BrandVoiceTone,
} from '../ai/brand-voice/composer';
import {
  type BrandVoice,
  type BrandVoiceLoader,
  NEUTRAL_BRAND_VOICE,
} from './brand-voice';

/**
 * Render the structured tone into the free-form `tone` string the review-draft
 * prompts embed. Returns null when there is nothing to say (→ neutral).
 */
export function renderToneDescription(tone: BrandVoiceTone | null): string | null {
  if (!tone) return null;
  const parts: string[] = [];
  if (tone.formality) parts.push(`Speak in a ${tone.formality} register.`);
  if (tone.pronoun) {
    parts.push(`Refer to the business as "${tone.pronoun === 'i' ? 'I' : 'we'}".`);
  }
  if (tone.vibe_words && tone.vibe_words.length > 0) {
    parts.push(`Evoke these qualities: ${tone.vibe_words.join(', ')}.`);
  }
  if (tone.banned_phrases && tone.banned_phrases.length > 0) {
    const quoted = tone.banned_phrases.map((p) => `"${p}"`).join(', ');
    parts.push(`Never use these phrases or wordings: ${quoted}.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export class SettingsBrandVoiceLoader implements BrandVoiceLoader {
  constructor(private readonly settingsRepo: Pick<SettingsRepository, 'findByTenant'>) {}

  async load(tenantId: string): Promise<BrandVoice> {
    try {
      const settings = await this.settingsRepo.findByTenant(tenantId);
      const tone = readToneFromSettings(settings);
      if (!tone) return NEUTRAL_BRAND_VOICE;
      return {
        tone: renderToneDescription(tone),
        signoff: tone.business_name ? `— ${tone.business_name}` : null,
      };
    } catch {
      // Never let a settings blip break review-response drafting.
      return NEUTRAL_BRAND_VOICE;
    }
  }
}
