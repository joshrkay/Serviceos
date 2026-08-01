import { describe, it, expect } from 'vitest';
import {
  composeBrandVoiceMessage,
  readBrandVoiceVersion,
  applyBrandVoiceDeviationToMeta,
  type BrandVoiceDeviation,
} from '../../../src/ai/brand-voice/composer';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import type { SettingsRepository, TenantSettings } from '../../../src/settings/settings';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';

function settingsRepo(
  tenantId: string,
  brandVoice: Record<string, unknown> | undefined,
  brandVoiceVersion = 0,
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
    brandVoiceVersion,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (brandVoice) row.brand_voice = brandVoice;
  void repo.create(row);
  return repo;
}

describe('N-011 — utterance tagging', () => {
  it('readBrandVoiceVersion reads the bookkeeping column, defaulting to 0', () => {
    expect(readBrandVoiceVersion({ brandVoiceVersion: 4 })).toBe(4);
    expect(readBrandVoiceVersion({ brandVoiceVersion: 0 })).toBe(0);
    expect(readBrandVoiceVersion({})).toBe(0);
    expect(readBrandVoiceVersion(null)).toBe(0);
  });

  it('composeBrandVoiceMessage tags every message with the tenant brand-voice version', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('Thanks — see you soon!');
    const result = await composeBrandVoiceMessage(
      { tenantId: 't1', intent: 'review_public_response', context: {}, maxChars: 200 },
      { gateway, settingsRepo: settingsRepo('t1', { register: 'friendly' }, 3) },
    );
    expect(result.brandVoiceVersion).toBe(3);
    expect(result.deviation).toBeUndefined();
  });
});

describe('N-011 — deviation detection → N-002 confidence marker', () => {
  it('populates a structured deviation when a banned phrase is stripped', async () => {
    const { gateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('We are the cheapest in town, call now!');
    const result = await composeBrandVoiceMessage(
      { tenantId: 't1', intent: 'review_public_response', context: {}, maxChars: 200 },
      {
        gateway,
        settingsRepo: settingsRepo('t1', { banned_phrases: ['cheapest in town'] }, 2),
      },
    );
    expect(result.deviation?.kind).toBe('banned_phrase_stripped');
    expect(result.deviation?.detail).toContain('cheapest in town');
    expect(result.text).not.toContain('cheapest in town');
  });

  it('applyBrandVoiceDeviationToMeta downgrades confidence to no higher than low and stamps the version', () => {
    const deviation: BrandVoiceDeviation = {
      kind: 'banned_phrase_stripped',
      detail: ['cheapest in town'],
    };
    const meta = applyBrandVoiceDeviationToMeta({ overallConfidence: 'high' }, 2, deviation);
    expect(meta.overallConfidence).toBe('low');
    expect(meta.brandVoiceVersion).toBe(2);
    expect(meta.markers?.[0].reason).toContain('cheapest in town');
  });

  it('keeps an already-lower confidence and only tags the version when there is no deviation', () => {
    expect(applyBrandVoiceDeviationToMeta({ overallConfidence: 'very_low' }, 1, {
      kind: 'banned_phrase_stripped',
      detail: ['x'],
    }).overallConfidence).toBe('very_low');

    const noDev = applyBrandVoiceDeviationToMeta({ overallConfidence: 'high' }, 5, undefined);
    expect(noDev.overallConfidence).toBe('high');
    expect(noDev.brandVoiceVersion).toBe(5);
    expect(noDev.markers).toBeUndefined();
  });
});
