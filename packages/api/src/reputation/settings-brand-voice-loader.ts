import type { SettingsRepository } from '../settings/settings';
import type { BrandVoice, BrandVoiceLoader } from './brand-voice';

/**
 * P7-026 — Load brand voice from tenant_settings.brand_voice JSONB.
 */
export class SettingsBrandVoiceLoader implements BrandVoiceLoader {
  constructor(private readonly settingsRepo: SettingsRepository) {}

  async load(tenantId: string): Promise<BrandVoice> {
    const settings = await this.settingsRepo.findByTenant(tenantId);
    const raw = (settings as { brandVoice?: Record<string, unknown> } | null)?.brandVoice;
    if (!raw || typeof raw !== 'object') {
      return { tone: null, signoff: null };
    }
    const tone =
      typeof raw.toneDescription === 'string'
        ? raw.toneDescription
        : typeof raw.formality === 'string'
          ? `${raw.formality} tone`
          : null;
    const signoff = typeof raw.signOff === 'string' ? raw.signOff : null;
    return { tone, signoff };
  }
}
