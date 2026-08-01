/**
 * P0-006 AC#2 — secrets never appear in logs or error responses.
 *
 * Proves that redactSecrets masks values keyed by common secret names at any
 * nesting depth and leaves non-secret values untouched.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, isSecretKey, redactUrlValue, redactByTier } from '../../src/logging/redact';

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

  it('redacts the entire value when a secret key points to an object', () => {
    const out = redactSecrets({
      apiKey: { v1: 'sk_live_a', v2: 'sk_live_b' },
      authorization: ['Bearer 1', 'Bearer 2'],
      password: 123456,
    });
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
  });

  it('survives circular references without throwing', () => {
    type Node = { name: string; self?: Node; apiKey?: string };
    const node: Node = { name: 'root', apiKey: 'sk_live_c' };
    node.self = node;

    let out: Node;
    expect(() => {
      out = redactSecrets(node);
    }).not.toThrow();

    expect(out!.name).toBe('root');
    expect(out!.apiKey).toBe('[REDACTED]');
    expect(out!.self).toBe('[Circular]');
  });

  it('handles arrays containing circular object references', () => {
    const shared: { apiKey: string; child?: unknown } = { apiKey: 'sk_live_d' };
    shared.child = shared;
    const out = redactSecrets([shared, shared]);

    expect((out[0] as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    // The second occurrence is the already-seen shared object, replaced by
    // the circular sentinel to stop the walk.
    expect(out[1]).toBe('[Circular]');
  });
});

/**
 * SEC-20 — bearer tokens travel in the URL on public, token-gated routes
 * (`/public/estimates/:token`, `/api/public/portal/:token`, etc). Key-based
 * redaction never inspects a string VALUE for an embedded token, so a raw
 * `route`/`url` field logged verbatim leaked live session tokens.
 * redactUrlValue is the value-pattern scrub; these tests pin its behavior
 * directly, independent of the request-logging middleware that calls it.
 */
describe('redactUrlValue', () => {
  const TOKEN = 'abc123.def456-ghiJKL_verylongtoken789';

  it('masks the token path segment on /public/estimates/:token routes', () => {
    const out = redactUrlValue(`/public/estimates/${TOKEN}/approve`);
    expect(out).toBe('/public/estimates/[REDACTED]/approve');
    expect(out).not.toContain(TOKEN);
  });

  it('masks the token path segment on /api/public/portal/:token routes', () => {
    const out = redactUrlValue(`/api/public/portal/${TOKEN}/customer`);
    expect(out).toBe('/api/public/portal/[REDACTED]/customer');
    expect(out).not.toContain(TOKEN);
  });

  it('masks the token path segment on /public/invoices/:token routes', () => {
    const out = redactUrlValue(`/public/invoices/${TOKEN}/checkout`);
    expect(out).toBe('/public/invoices/[REDACTED]/checkout');
  });

  it('masks the token path segment on /public/feedback/:token routes', () => {
    const out = redactUrlValue(`/public/feedback/${TOKEN}`);
    expect(out).toBe('/public/feedback/[REDACTED]');
  });

  it('masks a ?token= query param', () => {
    const out = redactUrlValue(`/public/proposals/one-tap-approve?token=${TOKEN}`);
    expect(out).toBe('/public/proposals/one-tap-approve?token=[REDACTED]');
    expect(out).not.toContain(TOKEN);
  });

  it('masks a ?token= query param alongside other, non-sensitive params', () => {
    const out = redactUrlValue(`/public/proposals/one-tap-undo?token=${TOKEN}&source=sms`);
    expect(out).toBe('/public/proposals/one-tap-undo?token=[REDACTED]&source=sms');
  });

  it('leaves an ordinary authenticated route unchanged', () => {
    expect(redactUrlValue('/api/jobs')).toBe('/api/jobs');
    expect(redactUrlValue('/api/jobs/123')).toBe('/api/jobs/123');
    expect(redactUrlValue('/api/jobs?status=open')).toBe('/api/jobs?status=open');
  });

  it('leaves non-string / empty input untouched', () => {
    expect(redactUrlValue('')).toBe('');
    // @ts-expect-error — exercising runtime guard against non-string input
    expect(redactUrlValue(undefined)).toBe(undefined);
    // @ts-expect-error — exercising runtime guard against non-string input
    expect(redactUrlValue(null)).toBe(null);
  });

  it('is wired into redactByTier/redactSecrets for `route` and `url` keys at any nesting depth, at every tier', () => {
    const input = {
      safeRequestLog: {
        route: `/public/estimates/${TOKEN}/approve`,
        method: 'POST',
      },
    };
    const standard = redactByTier(input, 'standard') as typeof input;
    const strict = redactByTier(input, 'strict') as typeof input;

    expect(standard.safeRequestLog.route).toBe('/public/estimates/[REDACTED]/approve');
    expect(strict.safeRequestLog.route).toBe('/public/estimates/[REDACTED]/approve');
    expect(JSON.stringify(standard)).not.toContain(TOKEN);
  });

  it('does not scrub unrelated keys that happen to contain a token-looking string', () => {
    const out = redactSecrets({ notes: `see /public/estimates/${TOKEN}/approve in the ticket` });
    // `notes` is not a URL-value key, so it is left to the ordinary
    // key-based redaction path (which does not match "notes"), unchanged.
    expect(out.notes).toContain(TOKEN);
  });
});
