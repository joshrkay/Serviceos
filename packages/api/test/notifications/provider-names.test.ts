import { describe, expect, it } from 'vitest';
import { normalizeDispatchProvider } from '../../src/notifications/provider-names';

describe('normalizeDispatchProvider', () => {
  it('maps legacy provider names to canonical gateway names', () => {
    expect(normalizeDispatchProvider('twilio-sms')).toBe('sms-gateway');
    expect(normalizeDispatchProvider('twilio-sendgrid')).toBe('email-gateway');
  });

  it('keeps canonical and unknown provider names as-is', () => {
    expect(normalizeDispatchProvider('sms-gateway')).toBe('sms-gateway');
    expect(normalizeDispatchProvider('email-gateway')).toBe('email-gateway');
    expect(normalizeDispatchProvider('in-memory')).toBe('in-memory');
  });
});
