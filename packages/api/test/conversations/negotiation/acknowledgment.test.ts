/**
 * Unit tests for the brand-voiced negotiation acknowledgment composer
 * (src/conversations/negotiation/acknowledgment.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  composeNegotiationAcknowledgment,
  brandVoiceNegotiationTts,
  NEGOTIATION_HOLDING_TTS_SOURCE,
} from '../../../src/conversations/negotiation/acknowledgment';

type Fx = { type: string; payload: Record<string, unknown> };

describe('composeNegotiationAcknowledgment', () => {
  it('never concedes — it defers to a person and promises a follow-up', () => {
    const line = composeNegotiationAcknowledgment();
    expect(line).toMatch(/check with the owner/i);
    expect(line).toMatch(/within the hour/i);
    // No price/discount/scope commitment language.
    expect(line).not.toMatch(/discount|\$|refund|deal/i);
  });

  it('uses the owner first name when known', () => {
    const line = composeNegotiationAcknowledgment({ ownerFirstName: 'Mike' });
    expect(line).toContain('Mike');
  });

  it('falls back to the business name when no owner name is known', () => {
    const line = composeNegotiationAcknowledgment({
      brandVoice: { business_name: 'M&R Mechanical' },
    });
    expect(line).toContain('the team at M&R Mechanical');
  });

  it('falls back to the tenant businessName when no owner name / brandVoice name is set', () => {
    // settings.businessName is a distinct field from brandVoice.business_name.
    const line = composeNegotiationAcknowledgment({ businessName: 'Rivera HVAC' });
    expect(line).toContain('the team at Rivera HVAC');
    expect(line).not.toContain('the owner');
  });

  it('prefers brandVoice.business_name over the tenant businessName', () => {
    const line = composeNegotiationAcknowledgment({
      brandVoice: { business_name: 'M&R Mechanical' },
      businessName: 'Rivera HVAC',
    });
    expect(line).toContain('the team at M&R Mechanical');
  });

  it('uses a professional register when the brand voice is professional', () => {
    const line = composeNegotiationAcknowledgment({
      ownerFirstName: 'Jenna',
      brandVoice: { formality: 'professional' },
    });
    expect(line).toMatch(/I'll need to confirm that with Jenna/);
    expect(line).toMatch(/I'll follow up within the hour/);
  });

  it('honors a custom callback window', () => {
    const line = composeNegotiationAcknowledgment({ callbackWindow: 'by end of day' });
    expect(line).toContain('by end of day');
    expect(line).not.toContain('within the hour');
  });
});

describe('brandVoiceNegotiationTts', () => {
  it('swaps the tagged holding line for the brand-voiced acknowledgment', () => {
    const effects: Fx[] = [
      { type: 'tts_play', payload: { text: 'FIXED FALLBACK', source: NEGOTIATION_HOLDING_TTS_SOURCE } },
    ];
    brandVoiceNegotiationTts(effects, { brandVoice: { business_name: 'M&R Mechanical' } });
    expect(effects[0].payload.text).not.toBe('FIXED FALLBACK');
    expect(String(effects[0].payload.text)).toContain('the team at M&R Mechanical');
    // Still a non-conceding holding line — no price/discount/deal language.
    expect(String(effects[0].payload.text)).not.toMatch(/discount|\$|deal/i);
  });

  it('honors the professional register', () => {
    const effects: Fx[] = [
      { type: 'tts_play', payload: { text: 'X', source: NEGOTIATION_HOLDING_TTS_SOURCE } },
    ];
    brandVoiceNegotiationTts(effects, {
      ownerFirstName: 'Jenna',
      brandVoice: { formality: 'professional' },
    });
    expect(String(effects[0].payload.text)).toMatch(/confirm that with Jenna/);
  });

  it('leaves untagged tts_play and non-tts effects untouched', () => {
    const effects: Fx[] = [
      { type: 'tts_play', payload: { text: 'Anything else?' } },
      { type: 'audit_log', payload: { source: NEGOTIATION_HOLDING_TTS_SOURCE } },
    ];
    brandVoiceNegotiationTts(effects, {});
    expect(effects[0].payload.text).toBe('Anything else?');
    expect(effects[1].payload.text).toBeUndefined();
  });

  it('exposes a stable source tag matching the FSM', () => {
    expect(NEGOTIATION_HOLDING_TTS_SOURCE).toBe('negotiation_holding');
  });
});
