import { describe, it, expect } from 'vitest';
import { scrubPii } from '../../../src/ai/training/scrub';

describe('scrubPii — regex layer', () => {
  it('redacts E.164 phone numbers', () => {
    const result = scrubPii('Call me back at +14155550123 tomorrow.');
    expect(result.scrubbed).toBe('Call me back at [PHONE] tomorrow.');
    expect(result.redactions.some((r) => r.kind === 'phone')).toBe(true);
  });

  it('redacts national-format US phone numbers in several stylings', () => {
    for (const phone of ['415-555-0123', '(415) 555-0123', '415.555.0123', '1-415-555-0123']) {
      const result = scrubPii(`Number: ${phone}`);
      expect(result.scrubbed).toBe('Number: [PHONE]');
    }
  });

  it('redacts email addresses', () => {
    const result = scrubPii('Send confirmation to jane.doe+filter@example.com please.');
    expect(result.scrubbed).toBe('Send confirmation to [EMAIL] please.');
    expect(result.redactions.some((r) => r.kind === 'email')).toBe(true);
  });

  it('redacts simple street addresses', () => {
    const result = scrubPii('I live at 1234 Maple Street, near the park.');
    expect(result.scrubbed.startsWith('I live at [ADDRESS],')).toBe(true);
    expect(result.redactions.some((r) => r.kind === 'address')).toBe(true);
  });

  it('handles many street suffixes', () => {
    for (const suffix of ['Ave', 'Boulevard', 'Rd', 'Drive', 'Ct', 'Lane', 'Way', 'Highway']) {
      const result = scrubPii(`Pickup at 100 Oak ${suffix}.`);
      expect(result.scrubbed).toContain('[ADDRESS]');
    }
  });
});

describe('scrubPii — entity-based layer', () => {
  it('redacts caller-known phones via exact match before the regex sweep', () => {
    const result = scrubPii('Hi, this is +14155550123 calling about my AC.', {
      knownEntities: { phones: ['+14155550123'] },
    });
    expect(result.scrubbed).toContain('[CALLER_PHONE]');
    expect(result.scrubbed).not.toContain('[PHONE]');
    expect(result.redactions.some((r) => r.kind === 'known_phone')).toBe(true);
  });

  it('redacts caller-known names case-insensitively', () => {
    const result = scrubPii('John Smith here. Need a tune-up.', {
      knownEntities: { names: ['John Smith'] },
    });
    expect(result.scrubbed).toBe('[CALLER_NAME] here. Need a tune-up.');
  });

  it('redacts caller-known emails before the generic email pass', () => {
    const result = scrubPii('It is jane@acme.com.', {
      knownEntities: { emails: ['jane@acme.com'] },
    });
    expect(result.scrubbed).toBe('It is [CALLER_EMAIL].');
    expect(result.redactions.some((r) => r.kind === 'known_email')).toBe(true);
  });

  it('redacts caller-known addresses', () => {
    const result = scrubPii('Send the tech to 1234 Maple Street.', {
      knownEntities: { addresses: ['1234 Maple Street'] },
    });
    expect(result.scrubbed).toBe('Send the tech to [CALLER_ADDRESS].');
  });
});

describe('scrubPii — fail-loud gate', () => {
  it('flags residual digit runs of 7+', () => {
    const result = scrubPii('Account number 8675309001 needs help.');
    expect(result.hasResidualPii).toBe(true);
    expect(result.residualSignals).toContain('digit_run_ge_7');
  });

  it('flags residual ALL CAPS name runs', () => {
    const result = scrubPii('My name is JOHN ANDREW SMITH.');
    expect(result.hasResidualPii).toBe(true);
    expect(result.residualSignals).toContain('all_caps_name_run');
  });

  it('does not false-positive on ordinary scrubbed text', () => {
    const result = scrubPii('I want to schedule a tune-up next Tuesday.');
    expect(result.hasResidualPii).toBe(false);
    expect(result.residualSignals).toEqual([]);
  });

  it('does not false-positive when placeholders contain digits-like patterns', () => {
    const result = scrubPii('Reach me at +14155550123', {
      knownEntities: { phones: ['+14155550123'] },
    });
    expect(result.hasResidualPii).toBe(false);
  });

  it('throws when failOnResidual is set and gate trips', () => {
    expect(() =>
      scrubPii('Account 1234567890', { failOnResidual: true }),
    ).toThrow(/residual PII/);
  });

  it('does not over-redact ordinary text (5 negatives)', () => {
    for (const text of [
      'I need a plumber.',
      'The compressor is leaking refrigerant.',
      'Schedule for next Tuesday at 2pm.',
      'Customer wants Saturday morning.',
      'Please send the standard tune-up estimate.',
    ]) {
      const result = scrubPii(text);
      expect(result.scrubbed).toBe(text);
      expect(result.redactions).toEqual([]);
      expect(result.hasResidualPii).toBe(false);
    }
  });
});

describe('scrubPii — preserves the original text on the result', () => {
  it('returns the unmodified input as `text`', () => {
    const original = 'Call +14155550123 about 1234 Maple St.';
    const result = scrubPii(original);
    expect(result.text).toBe(original);
    expect(result.scrubbed).not.toBe(original);
  });
});
