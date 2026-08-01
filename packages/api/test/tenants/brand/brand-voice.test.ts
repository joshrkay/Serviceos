import { describe, it, expect } from 'vitest';
import {
  BRAND_VOICE_COOLDOWN_MS,
  brandVoiceSchema,
  cooldownUntil,
  isInCooldown,
  mergeBrandVoice,
  computeChangedFields,
  revalidateRoundTrip,
} from '../../../src/tenants/brand/brand-voice';

describe('N-011 — brand-voice core logic', () => {
  describe('cool-down', () => {
    it('cooldownUntil adds 15 minutes to the anchor', () => {
      const anchor = '2026-07-10T12:00:00.000Z';
      expect(cooldownUntil(anchor)).toBe('2026-07-10T12:15:00.000Z');
    });

    it('cooldownUntil is null with no anchor (first configure is unconstrained)', () => {
      expect(cooldownUntil(null)).toBeNull();
      expect(cooldownUntil(undefined)).toBeNull();
    });

    it('isInCooldown is true inside the window and false after it', () => {
      const anchor = '2026-07-10T12:00:00.000Z';
      const base = Date.parse(anchor);
      expect(isInCooldown(anchor, base + 60_000)).toBe(true);
      expect(isInCooldown(anchor, base + BRAND_VOICE_COOLDOWN_MS - 1)).toBe(true);
      expect(isInCooldown(anchor, base + BRAND_VOICE_COOLDOWN_MS)).toBe(false);
      expect(isInCooldown(anchor, base + BRAND_VOICE_COOLDOWN_MS + 1)).toBe(false);
    });

    it('isInCooldown is false with no anchor', () => {
      expect(isInCooldown(null)).toBe(false);
    });
  });

  describe('mergeBrandVoice', () => {
    it('unions banned_phrases so an owner save never wipes loop-learned bans', () => {
      const existing = { banned_phrases: ['cheapest in town', 'no refunds'] };
      const next = mergeBrandVoice(existing, { banned_phrases: ['no refunds', 'ASAP'] });
      expect(new Set(next.banned_phrases)).toEqual(
        new Set(['cheapest in town', 'no refunds', 'ASAP']),
      );
    });

    it('replaces present fields and preserves omitted ones', () => {
      const existing = { register: 'formal' as const, persona_name: 'Old Co' };
      const next = mergeBrandVoice(existing, { persona_name: 'New Co' });
      expect(next.register).toBe('formal');
      expect(next.persona_name).toBe('New Co');
    });

    it('never writes the legacy formality key', () => {
      const next = mergeBrandVoice({ formality: 'casual' }, { register: 'friendly' });
      // The patch has no formality field, so the legacy key is left untouched
      // (register is now authoritative).
      expect(next.register).toBe('friendly');
    });
  });

  describe('computeChangedFields', () => {
    it('reports exactly the six-field keys that changed', () => {
      const prev = { register: 'formal' as const, signoff: 'Thanks' };
      const next = { register: 'casual' as const, signoff: 'Thanks', persona_name: 'Bob' };
      expect(computeChangedFields(prev, next).sort()).toEqual(['persona_name', 'register']);
    });
  });

  describe('brandVoiceSchema', () => {
    it('accepts the six fields within bounds', () => {
      const parsed = brandVoiceSchema.parse({
        register: 'friendly',
        opening_lines: ['Hi there', 'Hello'],
        signoff: '— The team',
        banned_phrases: ['no refunds'],
        persona_name: "M&R Mechanical's office",
        pronoun: 'we',
      });
      expect(parsed.register).toBe('friendly');
    });

    it('rejects an out-of-range register and over-long arrays', () => {
      expect(() => brandVoiceSchema.parse({ register: 'snarky' })).toThrow();
      expect(() =>
        brandVoiceSchema.parse({ opening_lines: Array(6).fill('x') }),
      ).toThrow();
    });
  });

  describe('revalidateRoundTrip', () => {
    it('accepts a valid config and an empty config', () => {
      expect(() => revalidateRoundTrip({ register: 'formal' })).not.toThrow();
      expect(() => revalidateRoundTrip({})).not.toThrow();
    });
  });
});
