import { describe, it, expect } from 'vitest';
import {
  requiresAiDisclosure,
  buildAiDisclosureText,
  resolveAiDisclosure,
  DEFAULT_AI_DISCLOSURE_TEMPLATE_EN,
} from '../../../src/ai/skills/disclose-ai-identity';

describe('requiresAiDisclosure', () => {
  it('true for AI-disclosure states (CA/FL), case/space-insensitive', () => {
    expect(requiresAiDisclosure('CA')).toBe(true);
    expect(requiresAiDisclosure(' ca ')).toBe(true);
    expect(requiresAiDisclosure('FL')).toBe(true);
  });

  it('false for non-listed states and unknown/null', () => {
    expect(requiresAiDisclosure('TX')).toBe(false);
    expect(requiresAiDisclosure(null)).toBe(false);
    expect(requiresAiDisclosure(undefined)).toBe(false);
  });
});

describe('buildAiDisclosureText', () => {
  it('default EN copy with business-name substitution', () => {
    const out = buildAiDisclosureText({ businessName: "Bob's Plumbing" });
    expect(out).toBe("Just so you know, you're speaking with Bob's Plumbing's AI virtual assistant.");
  });

  it('default ES copy when language is es', () => {
    const out = buildAiDisclosureText({ businessName: 'Ace', language: 'es' });
    expect(out).toContain('asistente virtual de inteligencia artificial de Ace');
  });

  it('custom tenant text overrides the default (with {business_name})', () => {
    const out = buildAiDisclosureText({ businessName: 'Ace', customText: 'Heads up — {business_name} uses an AI assistant.' });
    expect(out).toBe('Heads up — Ace uses an AI assistant.');
  });

  it('blank business name falls back to "our team"', () => {
    expect(buildAiDisclosureText({ businessName: '   ' })).toBe(
      DEFAULT_AI_DISCLOSURE_TEMPLATE_EN.replace('{business_name}', 'our team'),
    );
  });
});

describe('resolveAiDisclosure', () => {
  it('in-app callers get no spoken disclosure', () => {
    expect(resolveAiDisclosure({ channel: 'inapp', businessName: 'Ace', callerState: 'CA' })).toEqual({
      shouldDisclose: false,
      text: '',
      reason: 'none',
    });
  });

  it('telephony in a required state discloses (state_required), regardless of opt-in', () => {
    const r = resolveAiDisclosure({ channel: 'telephony', businessName: 'Ace', callerState: 'CA', tenantEnabled: false });
    expect(r.shouldDisclose).toBe(true);
    expect(r.reason).toBe('state_required');
    expect(r.text).toContain('AI virtual assistant');
  });

  it('telephony in a non-required state discloses only when the tenant opts in (tenant_enabled)', () => {
    expect(
      resolveAiDisclosure({ channel: 'telephony', businessName: 'Ace', callerState: 'TX', tenantEnabled: true }).reason,
    ).toBe('tenant_enabled');
    expect(
      resolveAiDisclosure({ channel: 'telephony', businessName: 'Ace', callerState: 'TX', tenantEnabled: false }),
    ).toEqual({ shouldDisclose: false, text: '', reason: 'none' });
  });

  it('honors a tenant custom text when disclosing', () => {
    const r = resolveAiDisclosure({
      channel: 'telephony',
      businessName: 'Ace',
      callerState: 'CA',
      customText: '{business_name} AI here.',
    });
    expect(r.text).toBe('Ace AI here.');
  });
});
