import { describe, it, expect } from 'vitest';
import { detectBrandVoiceDeviation } from '../../../src/ai/brand-voice/deviation';

describe('P4-015 brand voice deviation', () => {
  it('flags banned phrases', () => {
    const result = detectBrandVoiceDeviation({
      text: 'We regret to inform you about the delay.',
      bannedPhrases: ['regret to inform'],
      tone: { formality: 'casual' },
    });
    expect(result.drift).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('passes clean casual copy', () => {
    const result = detectBrandVoiceDeviation({
      text: 'Hey — we can swing by tomorrow morning.',
      tone: { formality: 'casual' },
    });
    expect(result.drift).toBe(false);
  });
});
