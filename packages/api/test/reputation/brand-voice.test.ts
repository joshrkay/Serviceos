import { describe, it, expect } from 'vitest';
import {
  BrandVoice,
  NEUTRAL_BRAND_VOICE,
  NoopBrandVoiceLoader,
} from '../../src/reputation/brand-voice';

describe('P7-026 brand-voice', () => {
  it('NEUTRAL_BRAND_VOICE has null tone + signoff', () => {
    expect(NEUTRAL_BRAND_VOICE).toEqual<BrandVoice>({
      tone: null,
      signoff: null,
    });
  });

  it('NoopBrandVoiceLoader.load returns NEUTRAL_BRAND_VOICE', async () => {
    const loader = new NoopBrandVoiceLoader();
    const result = await loader.load('any-tenant-id');
    expect(result).toEqual(NEUTRAL_BRAND_VOICE);
  });

  it('NoopBrandVoiceLoader.load returns the same value across tenants (no per-tenant state)', async () => {
    const loader = new NoopBrandVoiceLoader();
    const a = await loader.load('tenant-a');
    const b = await loader.load('tenant-b');
    expect(a).toEqual(b);
  });
});
