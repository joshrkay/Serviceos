/**
 * disclose_recording skill tests.
 *
 * Key invariants:
 * - in-app channel → immediate disclosed=true, no TTS call, empty text
 * - CA caller → two-party consent copy, requiresTwoPartyConsent=true
 * - TX caller → one-party copy, requiresTwoPartyConsent=false
 * - Unknown/null state → two-party copy (safer default)
 * - TTS provider present → audioBuffer populated
 * - TTS failure → still returns disclosed=true with text (graceful degradation)
 */

import { describe, it, expect, vi } from 'vitest';
import { discloseRecording, DisclosureInput } from '../../../src/ai/skills/disclose-recording';
import { TtsProvider, TtsSynthesizeResult } from '../../../src/ai/tts/tts-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTtsProvider(audioBytes: Buffer = Buffer.from('fake-audio')): TtsProvider {
  return {
    synthesize: vi.fn(async (): Promise<TtsSynthesizeResult> => ({
      audio: audioBytes,
      contentType: 'audio/mpeg',
      provider: 'mock-tts',
    })),
  };
}

function failingTtsProvider(): TtsProvider {
  return {
    synthesize: vi.fn(async () => {
      throw new Error('TTS service unavailable');
    }),
  };
}

function baseInput(overrides: Partial<DisclosureInput> = {}): DisclosureInput {
  return {
    tenantId: 'tenant-1',
    channel: 'telephony',
    businessName: 'Acme HVAC',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-app channel — bypass disclosure
// ---------------------------------------------------------------------------

describe('discloseRecording — in-app channel', () => {
  it('returns disclosed=true immediately without calling TTS', async () => {
    const ttsProvider = mockTtsProvider();
    const result = await discloseRecording(baseInput({ channel: 'inapp', ttsProvider }));

    expect(result.disclosed).toBe(true);
    expect(ttsProvider.synthesize).not.toHaveBeenCalled();
  });

  it('returns empty disclosureText for in-app channel', async () => {
    const result = await discloseRecording(baseInput({ channel: 'inapp' }));
    expect(result.disclosureText).toBe('');
  });

  it('returns requiresTwoPartyConsent=false for in-app channel', async () => {
    const result = await discloseRecording(baseInput({ channel: 'inapp' }));
    expect(result.requiresTwoPartyConsent).toBe(false);
  });

  it('does not return audioBuffer for in-app channel', async () => {
    const result = await discloseRecording(baseInput({ channel: 'inapp' }));
    expect(result.audioBuffer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Two-party consent states — CA
// ---------------------------------------------------------------------------

describe('discloseRecording — CA caller (two-party consent state)', () => {
  it('requiresTwoPartyConsent is true', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'CA' }));
    expect(result.requiresTwoPartyConsent).toBe(true);
  });

  it('disclosed is true', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'CA' }));
    expect(result.disclosed).toBe(true);
  });

  it('disclosureText contains consent language', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'CA' }));
    expect(result.disclosureText).toContain('consent to this recording');
  });

  it('lowercase "ca" is normalized correctly', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'ca' }));
    expect(result.requiresTwoPartyConsent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One-party consent states — TX
// ---------------------------------------------------------------------------

describe('discloseRecording — TX caller (one-party consent state)', () => {
  it('requiresTwoPartyConsent is false', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'TX' }));
    expect(result.requiresTwoPartyConsent).toBe(false);
  });

  it('disclosed is true', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'TX' }));
    expect(result.disclosed).toBe(true);
  });

  it('disclosureText does not contain consent language', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'TX' }));
    expect(result.disclosureText).not.toContain('consent to this recording');
  });

  it('disclosureText still mentions recording', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'TX' }));
    expect(result.disclosureText).toContain('recorded for quality and training');
  });
});

// ---------------------------------------------------------------------------
// Unknown state — defaults to two-party (safer)
// ---------------------------------------------------------------------------

describe('discloseRecording — unknown/null state defaults to two-party', () => {
  it('undefined callerState → two-party copy', async () => {
    const result = await discloseRecording(baseInput({ callerState: undefined }));
    expect(result.requiresTwoPartyConsent).toBe(true);
    expect(result.disclosureText).toContain('consent to this recording');
  });

  it('null callerState → two-party copy', async () => {
    const result = await discloseRecording(baseInput({ callerState: null }));
    expect(result.requiresTwoPartyConsent).toBe(true);
    expect(result.disclosureText).toContain('consent to this recording');
  });

  it('empty string callerState → two-party copy', async () => {
    const result = await discloseRecording(baseInput({ callerState: '' }));
    expect(result.requiresTwoPartyConsent).toBe(true);
  });

  it('whitespace-only callerState → two-party copy', async () => {
    const result = await discloseRecording(baseInput({ callerState: '   ' }));
    expect(result.requiresTwoPartyConsent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All two-party consent states produce consistent output
// ---------------------------------------------------------------------------

describe('discloseRecording — all two-party states', () => {
  const twoPartyStates = ['CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MT', 'NV', 'NH', 'OR', 'PA', 'WA'];

  for (const state of twoPartyStates) {
    it(`${state} → requiresTwoPartyConsent=true`, async () => {
      const result = await discloseRecording(baseInput({ callerState: state }));
      expect(result.requiresTwoPartyConsent).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// TTS provider present → audioBuffer populated
// ---------------------------------------------------------------------------

describe('discloseRecording — TTS integration', () => {
  it('when ttsProvider is provided, audioBuffer is populated', async () => {
    const audioBytes = Buffer.from('mp3-bytes');
    const ttsProvider = mockTtsProvider(audioBytes);

    const result = await discloseRecording(baseInput({ ttsProvider, callerState: 'TX' }));

    expect(result.audioBuffer).toBeDefined();
    expect(result.audioBuffer).toEqual(audioBytes);
  });

  it('TTS is called with the spoken disclosure text', async () => {
    const ttsProvider = mockTtsProvider();

    await discloseRecording(baseInput({ ttsProvider, callerState: 'TX' }));

    expect(ttsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('recorded for quality and training'),
        tenantId: 'tenant-1',
      })
    );
  });

  it('TTS is called with the tenantId for cost accounting', async () => {
    const ttsProvider = mockTtsProvider();

    await discloseRecording(baseInput({ ttsProvider, tenantId: 'tenant-xyz', callerState: 'CA' }));

    expect(ttsProvider.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-xyz' })
    );
  });

  it('when ttsProvider is absent, audioBuffer is undefined', async () => {
    const result = await discloseRecording(baseInput({ callerState: 'TX' }));
    expect(result.audioBuffer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TTS failure — graceful degradation
// ---------------------------------------------------------------------------

describe('discloseRecording — TTS failure graceful degradation', () => {
  it('TTS failure still returns disclosed=true', async () => {
    const result = await discloseRecording(baseInput({
      ttsProvider: failingTtsProvider(),
      callerState: 'CA',
    }));

    expect(result.disclosed).toBe(true);
  });

  it('TTS failure still returns disclosureText', async () => {
    const result = await discloseRecording(baseInput({
      ttsProvider: failingTtsProvider(),
      callerState: 'CA',
    }));

    expect(result.disclosureText).toContain('consent to this recording');
  });

  it('TTS failure returns undefined audioBuffer', async () => {
    const result = await discloseRecording(baseInput({
      ttsProvider: failingTtsProvider(),
      callerState: 'TX',
    }));

    expect(result.audioBuffer).toBeUndefined();
  });

  it('TTS failure does not affect requiresTwoPartyConsent classification', async () => {
    const caResult = await discloseRecording(baseInput({
      ttsProvider: failingTtsProvider(),
      callerState: 'CA',
    }));
    expect(caResult.requiresTwoPartyConsent).toBe(true);

    const txResult = await discloseRecording(baseInput({
      ttsProvider: failingTtsProvider(),
      callerState: 'TX',
    }));
    expect(txResult.requiresTwoPartyConsent).toBe(false);
  });
});
