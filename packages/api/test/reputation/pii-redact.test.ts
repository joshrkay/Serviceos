import { describe, it, expect } from 'vitest';
import { redactPii } from '../../src/reputation/pii-redact';

describe('P7-026 redactPii — emails', () => {
  it('redacts a simple email', () => {
    expect(redactPii('Contact me at foo@example.com please')).toBe(
      'Contact me at [email] please',
    );
  });

  it('redacts multiple emails in one string', () => {
    expect(redactPii('foo@a.com or bar.baz+tag@sub.example.co')).toBe(
      '[email] or [email]',
    );
  });

  it('respects redactEmails=false', () => {
    expect(redactPii('foo@example.com', { redactEmails: false })).toBe(
      'foo@example.com',
    );
  });
});

describe('P7-026 redactPii — phones', () => {
  it('redacts a US phone in (xxx) xxx-xxxx format', () => {
    expect(redactPii('Call me at (415) 555-1234 anytime')).toBe(
      'Call me at [phone] anytime',
    );
  });

  it('redacts a US phone in xxx-xxx-xxxx format', () => {
    expect(redactPii('My number is 415-555-1234.')).toBe('My number is [phone].');
  });

  it('redacts a US phone with country code', () => {
    expect(redactPii('+1 415 555 1234 works')).toBe('[phone] works');
  });

  it('redacts an international phone', () => {
    expect(redactPii('Call +442071234567 from London')).toBe(
      'Call [phone] from London',
    );
  });

  it('respects redactPhones=false', () => {
    expect(redactPii('(415) 555-1234', { redactPhones: false })).toBe(
      '(415) 555-1234',
    );
  });
});

describe('P7-026 redactPii — addresses', () => {
  it('redacts a US street address (Street)', () => {
    expect(redactPii('I live at 123 Main Street')).toBe('I live at [address]');
  });

  it('redacts a US street address (Ave with multi-word name)', () => {
    expect(redactPii('Located at 456 North Park Ave today')).toBe(
      'Located at [address] today',
    );
  });

  it('redacts a US street address (Boulevard)', () => {
    expect(redactPii('Drove down 789 Sunset Boulevard')).toBe(
      'Drove down [address]',
    );
  });

  it('respects redactAddresses=false', () => {
    expect(redactPii('123 Main Street', { redactAddresses: false })).toBe(
      '123 Main Street',
    );
  });

  it('does not redact a numbered list item', () => {
    // "1." is not a street address — has no street-type suffix.
    expect(redactPii('1. Buy milk')).toBe('1. Buy milk');
  });
});

describe('P7-026 redactPii — last names', () => {
  it('redacts last name after a salutation (Mr.)', () => {
    expect(redactPii('I spoke to Mr. Smith yesterday')).toBe(
      'I spoke to Mr. [name] yesterday',
    );
  });

  it('redacts last name after a salutation without period (Ms)', () => {
    expect(redactPii('Ms Johnson was helpful')).toBe('Ms [name] was helpful');
  });

  it('redacts last name when preceded by a known first name', () => {
    expect(redactPii('Bob Smith was my tech')).toBe(
      'Bob [name] was my tech',
    );
  });

  it('preserves an unknown first name + last name (no overreach)', () => {
    // "Xyzzy" is not a known first name → don't guess.
    expect(redactPii('Xyzzy Plover was here')).toBe('Xyzzy Plover was here');
  });

  it('redacts last name when caller provides extra first-name allowlist', () => {
    expect(
      redactPii('Xyzzy Smith was here', {
        preserveKnownFirstNames: ['Xyzzy'],
      }),
    ).toBe('Xyzzy [name] was here');
  });

  it('respects redactLastNames=false', () => {
    expect(redactPii('Bob Smith', { redactLastNames: false })).toBe(
      'Bob Smith',
    );
  });
});

describe('P7-026 redactPii — idempotency', () => {
  it('is a no-op on already-redacted text (emails)', () => {
    const once = redactPii('Email me at foo@bar.com today');
    const twice = redactPii(once);
    expect(twice).toBe(once);
  });

  it('is a no-op on already-redacted text (phones)', () => {
    const once = redactPii('Call (415) 555-1234');
    const twice = redactPii(once);
    expect(twice).toBe(once);
  });

  it('is a no-op on already-redacted text (mixed PII)', () => {
    const input =
      'Mr. Smith at 123 Main Street, call (415) 555-1234 or foo@bar.com';
    const once = redactPii(input);
    const twice = redactPii(once);
    const thrice = redactPii(twice);
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });
});

describe('P7-026 redactPii — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(redactPii('')).toBe('');
  });

  it('passes through text with no PII unchanged', () => {
    expect(redactPii('Great service overall')).toBe('Great service overall');
  });
});
