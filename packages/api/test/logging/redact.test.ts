/**
 * P0-006 AC#2 — secrets never appear in logs or error responses.
 *
 * Proves that redactSecrets masks values keyed by common secret names at any
 * nesting depth and leaves non-secret values untouched.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, isSecretKey } from '../../src/logging/redact';

describe('redactSecrets', () => {
  it('redacts top-level secret-like keys', () => {
    const out = redactSecrets({
      apiKey: 'sk_live_abc',
      password: 'hunter2',
      username: 'alice',
    });
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.username).toBe('alice');
  });

  it('redacts nested secret keys inside objects', () => {
    const out = redactSecrets({
      request: {
        headers: { authorization: 'Bearer xyz', 'content-type': 'application/json' },
      },
    });
    expect((out.request.headers as Record<string, string>).authorization).toBe('[REDACTED]');
    expect((out.request.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('redacts secret keys inside arrays', () => {
    const out = redactSecrets([{ token: 't1' }, { token: 't2' }, { name: 'foo' }]);
    expect(out[0].token).toBe('[REDACTED]');
    expect(out[1].token).toBe('[REDACTED]');
    expect(out[2].name).toBe('foo');
  });

  it('leaves primitives and non-object input untouched', () => {
    expect(redactSecrets('plain string')).toBe('plain string');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it('leaves empty-string secrets untouched (no leak to redact)', () => {
    const out = redactSecrets({ apiKey: '' });
    expect(out.apiKey).toBe('');
  });

  it('isSecretKey matches common secret patterns', () => {
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('api_key')).toBe(true);
    expect(isSecretKey('API-KEY')).toBe(true);
    expect(isSecretKey('clerkSecretKey')).toBe(true);
    expect(isSecretKey('stripeWebhookSecret')).toBe(true);
    expect(isSecretKey('bearerToken')).toBe(true);
    expect(isSecretKey('privateKey')).toBe(true);
    expect(isSecretKey('username')).toBe(false);
    expect(isSecretKey('tenantId')).toBe(false);
  });
});
