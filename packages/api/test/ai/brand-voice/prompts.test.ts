import { describe, it, expect } from 'vitest';
import {
  BRAND_VOICE_INTENTS,
  buildBrandVoicePrompt,
  isBrandVoiceIntent,
  DEFAULT_BRAND_VOICE_TONE,
} from '../../../src/ai/brand-voice/prompts';
import {
  isRegisteredBrandVoiceIntent,
  listBrandVoicePromptIntents,
  BRAND_VOICE_TASK_TYPE,
} from '../../../src/ai/prompt-registry';

describe('P4-015 — brand-voice prompt templates', () => {
  it('P4-015/RV-061 — exposes exactly the registered intents (four V1 + digest narrative)', () => {
    expect([...BRAND_VOICE_INTENTS].sort()).toEqual(
      [
        'dropped_call_recovery_sms',
        'review_private_followup',
        'review_public_response',
        'tech_reschedule_customer_sms',
        // RV-061 — owner-facing end-of-day digest narrative.
        'digest_narrative',
      ].sort(),
    );
  });

  it('P4-015 — registry and prompt module agree on the intent list', () => {
    const fromRegistry = listBrandVoicePromptIntents()
      .map((i) => i.intent)
      .sort();
    expect(fromRegistry).toEqual([...BRAND_VOICE_INTENTS].sort());
    for (const intent of BRAND_VOICE_INTENTS) {
      expect(isRegisteredBrandVoiceIntent(intent)).toBe(true);
    }
    expect(isRegisteredBrandVoiceIntent('bogus')).toBe(false);
    expect(BRAND_VOICE_TASK_TYPE).toBe('brand_voice_v1');
  });

  // Smoke test: one assertion per intent that the prompt assembles non-empty
  // system + user messages and threads the intent guidance through.
  for (const intent of BRAND_VOICE_INTENTS) {
    it(`P4-015 — buildBrandVoicePrompt assembles a non-empty prompt for ${intent}`, () => {
      const { system, user } = buildBrandVoicePrompt({
        intent,
        tone: { formality: 'casual', vibe_words: ['friendly'] },
        context: { customer_first_name: 'Pat' },
        maxChars: 160,
      });
      expect(system.length).toBeGreaterThan(0);
      expect(user.length).toBeGreaterThan(0);
      // Tone authority appears in the system slot, not the user slot.
      expect(system.toLowerCase()).toContain('brand voice');
      expect(system).toContain('casual');
      expect(system).toContain('friendly');
      // The maxChars hint is threaded into the user message.
      expect(user).toContain('160');
      // Opted-in context field is present.
      expect(user).toContain('customer_first_name');
    });
  }

  it('P4-015 — falls back to neutral default tone when none provided', () => {
    const { system } = buildBrandVoicePrompt({
      intent: 'review_public_response',
      tone: null,
      context: {},
      maxChars: 200,
    });
    expect(system).toContain(DEFAULT_BRAND_VOICE_TONE.formality);
  });

  it('P4-015 — isBrandVoiceIntent narrows correctly', () => {
    expect(isBrandVoiceIntent('review_public_response')).toBe(true);
    expect(isBrandVoiceIntent('nope')).toBe(false);
    expect(isBrandVoiceIntent(42)).toBe(false);
  });

  it('N-009 — banned_phrases render as a non-overridable "never use" instruction', () => {
    const { system } = buildBrandVoicePrompt({
      intent: 'review_public_response',
      tone: { banned_phrases: ['cheapest in town', 'no refunds'] },
      context: {},
      maxChars: 200,
    });
    expect(system).toContain('NEVER use these phrases');
    expect(system).toContain('"cheapest in town"');
    expect(system).toContain('"no refunds"');
  });

  it('N-009 — no negative-prompt line when no banned_phrases configured', () => {
    const { system } = buildBrandVoicePrompt({
      intent: 'review_public_response',
      tone: { formality: 'casual' },
      context: {},
      maxChars: 200,
    });
    expect(system).not.toContain('NEVER use these phrases');
  });
});
