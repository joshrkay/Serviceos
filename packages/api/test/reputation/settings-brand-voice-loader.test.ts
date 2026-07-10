import { describe, it, expect } from 'vitest';
import {
  SettingsBrandVoiceLoader,
  renderToneDescription,
} from '../../src/reputation/settings-brand-voice-loader';
import {
  InMemorySettingsRepository,
  type SettingsRepository,
  type TenantSettings,
} from '../../src/settings/settings';
import { NEUTRAL_BRAND_VOICE } from '../../src/reputation/brand-voice';

function settingsRepoWithTone(
  tenantId: string,
  brandVoice: Record<string, unknown> | undefined,
): SettingsRepository {
  const repo = new InMemorySettingsRepository();
  const row: TenantSettings & { brand_voice?: Record<string, unknown> } = {
    id: 'settings-1',
    tenantId,
    businessName: 'Test Co',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (brandVoice) row.brand_voice = brandVoice;
  void repo.create(row);
  return repo;
}

describe('SettingsBrandVoiceLoader — real tenant tone for review responses', () => {
  it('renders the tenant tone (formality, pronoun, vibe, banned phrases) and signs off with the business name', async () => {
    const repo = settingsRepoWithTone('t1', {
      formality: 'casual',
      pronoun: 'we',
      vibe_words: ['friendly', 'warm'],
      banned_phrases: ['no problemo'],
      business_name: 'Acme HVAC',
    });
    const bv = await new SettingsBrandVoiceLoader(repo).load('t1');
    expect(bv.tone).toContain('casual');
    expect(bv.tone).toContain('"we"');
    expect(bv.tone).toContain('friendly, warm');
    // Owner-banned phrases reach the public review-response prompt as guidance.
    expect(bv.tone).toContain('no problemo');
    expect(bv.signoff).toBe('— Acme HVAC');
  });

  it('returns the NEUTRAL voice when the tenant has no brand_voice configured', async () => {
    const repo = settingsRepoWithTone('t1', undefined);
    const bv = await new SettingsBrandVoiceLoader(repo).load('t1');
    expect(bv).toEqual(NEUTRAL_BRAND_VOICE);
  });

  it('is failure-soft: a settings read error degrades to the neutral voice, never throws', async () => {
    const throwingRepo: Pick<SettingsRepository, 'findByTenant'> = {
      async findByTenant() {
        throw new Error('db down');
      },
    };
    const bv = await new SettingsBrandVoiceLoader(throwingRepo).load('t1');
    expect(bv).toEqual(NEUTRAL_BRAND_VOICE);
  });

  it('renderToneDescription returns null for an empty tone (→ prompt omits it)', () => {
    expect(renderToneDescription(null)).toBeNull();
    expect(renderToneDescription({})).toBeNull();
  });
});
