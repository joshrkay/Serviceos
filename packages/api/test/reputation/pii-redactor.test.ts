/**
 * P7-026 — Content-level PII redactor tests.
 *
 * Includes the poison-prompt case required by the dispatch addendum's
 * risk note: a draft generator is "tricked" into emitting the customer's
 * full address and phone number to "personalise" the public response.
 * The redactor MUST strip those before the draft is attached to a
 * proposal.
 *
 * Also verifies this redactor is distinct from the logging/redact.ts
 * infra redactor (different shape, different responsibilities).
 */

import { describe, it, expect } from 'vitest';
import {
  redactPublicDraft,
  assertNoPiiInPublicDraft,
} from '../../src/reputation/pii-redactor';

describe('P7-026 pii-redactor (content-level)', () => {
  it('P7-026 strips email addresses', () => {
    const { redacted, redactions } = redactPublicDraft({
      text: 'Please reach me at margaret.donovan@example.com to follow up.',
    });
    expect(redacted).not.toContain('margaret.donovan@example.com');
    expect(redacted).toContain('[redacted]');
    expect(redactions[0]?.type).toBe('email');
  });

  it('P7-026 strips phone numbers in multiple formats', () => {
    const inputs = [
      'Call me at (415) 555-1234.',
      'My number is 415-555-1234.',
      'Reach us at 415.555.1234.',
      'Cell: +1 415 555 1234.',
    ];
    for (const text of inputs) {
      const { redacted } = redactPublicDraft({ text });
      expect(redacted).not.toMatch(/415.*555.*1234/);
    }
  });

  it('P7-026 strips street addresses', () => {
    const { redacted, redactions } = redactPublicDraft({
      text: 'We came out to 1234 Oak Street last Tuesday.',
    });
    expect(redacted).not.toContain('1234 Oak Street');
    expect(redactions.some((r) => r.type === 'street_address')).toBe(true);
  });

  it('P7-026 strips disallowed last names (case-insensitive, word-bounded)', () => {
    const { redacted, redactions } = redactPublicDraft({
      text: "Hi Margaret — we're sorry. Carlos Donovan should have shown up.",
      disallowedLastNames: ['Donovan'],
    });
    expect(redacted).not.toContain('Donovan');
    expect(redacted).toContain('Margaret'); // first name allowed
    expect(redactions.some((r) => r.type === 'last_name')).toBe(true);
  });

  it('P7-026 strips internal IDs', () => {
    const { redacted } = redactPublicDraft({
      text: 'Your ticket CUST-AB12CD is now resolved.',
    });
    expect(redacted).not.toContain('CUST-AB12CD');
  });

  it('P7-026 strips SSN-shaped numbers', () => {
    const { redacted } = redactPublicDraft({
      text: 'On file: 123-45-6789.',
    });
    expect(redacted).not.toContain('123-45-6789');
  });

  it('P7-026 strips credit-card-shaped numbers', () => {
    const { redacted } = redactPublicDraft({
      text: 'Refund posted to card 4242 4242 4242 4242.',
    });
    expect(redacted).not.toMatch(/4242[\s-]?4242[\s-]?4242[\s-]?4242/);
  });

  it('P7-026 POISON PROMPT: draft tries to include full address + phone — redactor strips both', () => {
    // Simulates an LLM that was tricked into "personalising" the public
    // response with the customer's PII. The public draft must NEVER
    // ship with this data even if the prompt asked for it.
    const poisoned = `Dear Margaret Donovan, we are deeply sorry that Carlos missed your
      5:00 PM appointment yesterday. To make this right, our manager will
      call you at (415) 555-1234 and stop by 1234 Oak Street to deliver
      the service credit personally. You can also email us at
      manager@fieldlyhvac.example.com with any concerns. Reference your
      account at JOB-CARLOSDONOVAN-001.`;

    const { redacted, redactions } = redactPublicDraft({
      text: poisoned,
      disallowedLastNames: ['Donovan'],
    });

    // None of the leaks may survive.
    expect(redacted).not.toContain('(415) 555-1234');
    expect(redacted).not.toContain('1234 Oak Street');
    expect(redacted).not.toContain('manager@fieldlyhvac.example.com');
    expect(redacted).not.toContain('Donovan');
    expect(redacted).not.toContain('JOB-CARLOSDONOVAN-001');

    // First name may remain (per the redactor's first-name-allowed rule).
    expect(redacted).toContain('Margaret');

    // And we caught every category we should have caught.
    const types = new Set(redactions.map((r) => r.type));
    expect(types.has('phone')).toBe(true);
    expect(types.has('email')).toBe(true);
    expect(types.has('street_address')).toBe(true);
    expect(types.has('last_name')).toBe(true);
    expect(types.has('internal_id')).toBe(true);
  });

  it('P7-026 assertNoPiiInPublicDraft throws when leaks are detected', () => {
    expect(() =>
      assertNoPiiInPublicDraft({
        text: 'Reach me at 415-555-1234.',
      }),
    ).toThrow(/PII redaction/);
  });

  it('P7-026 assertNoPiiInPublicDraft passes for a clean draft', () => {
    const clean = 'Hi Margaret — we are sorry, and we will follow up.';
    expect(assertNoPiiInPublicDraft({ text: clean })).toBe(clean);
  });

  it('P7-026 leaves clean public-response language untouched', () => {
    const text = 'We are sorry to hear about your experience and would like to make it right.';
    const { redacted, redactions } = redactPublicDraft({ text });
    expect(redacted).toBe(text);
    expect(redactions).toEqual([]);
  });

  it('P7-026 is separate from logging/redact.ts (different shape)', async () => {
    // Cross-check: the infra redactor expects an OBJECT keyed by
    // property name; this content redactor expects a STRING. They
    // have different signatures by design (see header doc) so one
    // cannot accidentally substitute for the other.
    const logging = await import('../../src/logging/redact.js');
    // Infra redactor exposes 'isSecretKey'; content redactor does not.
    expect(typeof logging.isSecretKey).toBe('function');
    const content = await import('../../src/reputation/pii-redactor.js');
    expect('isSecretKey' in content).toBe(false);
    expect(typeof content.redactPublicDraft).toBe('function');
  });
});
