import { describe, it, expect } from 'vitest';
import {
  VOICE_PRESETS,
  resolveVoicePreset,
  autoGenerateGreeting,
  buildAssistantConfig,
} from '../../../src/integrations/vapi/assistant-config';

describe('voice presets', () => {
  it('offers exactly three ElevenLabs presets with stable ids', () => {
    expect(VOICE_PRESETS).toHaveLength(3);
    expect(VOICE_PRESETS.map((v) => v.id)).toEqual(['rachel', 'adam', 'bella']);
    for (const v of VOICE_PRESETS) expect(v.elevenLabsVoiceId).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('resolves a known preset and falls back to the default for unknown ids', () => {
    expect(resolveVoicePreset('adam').id).toBe('adam');
    expect(resolveVoicePreset('does-not-exist').id).toBe('rachel');
    expect(resolveVoicePreset(null).id).toBe('rachel');
  });
});

describe('autoGenerateGreeting', () => {
  it('builds a greeting from business name + services', () => {
    expect(autoGenerateGreeting('Acme HVAC', ['heating', 'cooling'])).toBe(
      'Thanks for calling Acme HVAC. We handle heating and cooling. How can I help you today?',
    );
  });
  it('omits the services clause when none are provided', () => {
    expect(autoGenerateGreeting('Acme HVAC')).toBe(
      'Thanks for calling Acme HVAC. How can I help you today?',
    );
  });
});

describe('buildAssistantConfig', () => {
  it('uses the auto-generated greeting and the resolved preset voice id', () => {
    const cfg = buildAssistantConfig({ businessName: 'Acme HVAC', voicePresetId: 'adam', services: ['repairs'] });
    expect(cfg.voiceId).toBe(resolveVoicePreset('adam').elevenLabsVoiceId);
    expect(cfg.firstMessage).toContain('Thanks for calling Acme HVAC');
    expect(cfg.name).toBe('Acme HVAC AI Receptionist');
  });

  // PRIV-4 (review round 1) — a number imported into Vapi greets callers with
  // firstMessage, which never passes through buildTelephonyGreeting; the
  // virtual-assistant notice must ride on it too.
  it('the auto-generated first message tells the caller they are talking to a virtual assistant', () => {
    const cfg = buildAssistantConfig({ businessName: 'Acme HVAC', services: ['repairs'] });
    expect(cfg.firstMessage).toBe(
      "Thanks for calling Acme HVAC. We handle repairs. How can I help you today? Just so you know, I'm a virtual assistant, not a live person.",
    );
  });

  it('honors an explicit greeting override, tenant words first, then the notice', () => {
    const cfg = buildAssistantConfig({ businessName: 'Acme', greeting: 'Yo, Acme here.' });
    expect(cfg.firstMessage).toBe("Yo, Acme here. Just so you know, I'm a virtual assistant, not a live person.");
  });

  it('threads the server webhook url + secret when provided', () => {
    const cfg = buildAssistantConfig({ businessName: 'Acme', serverUrl: 'https://x/webhooks/vapi/t1', serverUrlSecret: 's3cr3t' });
    expect(cfg.serverUrl).toBe('https://x/webhooks/vapi/t1');
    expect(cfg.serverUrlSecret).toBe('s3cr3t');
  });
});
