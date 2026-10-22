/** #1737 — pure logic: origin allow-list, embed token, limiter, bot verifier, widget script. */
import { describe, it, expect, vi } from 'vitest';
import {
  mintEmbedToken,
  normalizeOrigin,
  normalizeOrigins,
  originAllowed,
  tenantIdFromToken,
  tokenMatches,
} from '../../src/webchat/webchat-config';
import { SlidingWindowLimiter, createTurnstileVerifier } from '../../src/webchat/webchat-guard';
import { WIDGET_SCRIPT } from '../../src/webchat/widget-script';
import { buildSnippet } from '../../src/routes/webchat-settings';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('origin allow-list', () => {
  it('normalizes scheme + host and drops a trailing slash and case', () => {
    expect(normalizeOrigin('HTTPS://Example.com/')).toBe('https://example.com');
    expect(normalizeOrigin('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('rejects paths, plain http (except localhost), credentials and junk', () => {
    for (const bad of ['https://example.com/path', 'http://example.com', 'https://u:p@example.com', 'example.com', '*', 'https://*.com', 'javascript:alert(1)']) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('normalizeOrigins dedupes and reports rejects', () => {
    expect(normalizeOrigins(['https://a.com', 'https://A.com/', 'nope'])).toEqual({
      origins: ['https://a.com'],
      rejected: ['nope'],
    });
  });

  it('matches exactly; wildcard matches subdomains only; empty list denies', () => {
    expect(originAllowed('https://a.com', ['https://a.com'])).toBe(true);
    expect(originAllowed('https://a.com.evil.io', ['https://a.com'])).toBe(false);
    expect(originAllowed('https://www.a.com', ['https://*.a.com'])).toBe(true);
    expect(originAllowed('https://a.com', ['https://*.a.com'])).toBe(false);
    expect(originAllowed('https://evila.com', ['https://*.a.com'])).toBe(false);
    expect(originAllowed('https://a.com', [])).toBe(false);
    expect(originAllowed(undefined, ['https://a.com'])).toBe(false);
    expect(originAllowed('null', ['https://a.com'])).toBe(false);
  });
});

describe('embed token', () => {
  it('round-trips the tenant id and rejects malformed tokens', () => {
    const token = mintEmbedToken(TENANT);
    expect(tenantIdFromToken(token)).toBe(TENANT);
    for (const bad of [undefined, 42, '', 'abc', `${TENANT}.short`, `${TENANT}x${'a'.repeat(24)}`, `${TENANT}.${'g'.repeat(24)}`]) {
      expect(tenantIdFromToken(bad), String(bad)).toBeNull();
    }
  });

  it('compares in constant shape and rotates to a different token', () => {
    const a = mintEmbedToken(TENANT);
    expect(tokenMatches(a, a)).toBe(true);
    expect(tokenMatches(a, mintEmbedToken(TENANT))).toBe(false);
    expect(tokenMatches('short', a)).toBe(false);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows up to max in the window, then recovers', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect(l.allow('k', 0)).toBe(true);
    expect(l.allow('k', 100)).toBe(true);
    expect(l.allow('k', 200)).toBe(false);
    expect(l.allow('other', 200)).toBe(true);
    expect(l.allow('k', 1201)).toBe(true);
  });

  it('bounds memory by evicting the stalest key', () => {
    const l = new SlidingWindowLimiter(1, 10_000, 2);
    l.allow('a', 0);
    l.allow('b', 1);
    l.allow('c', 2); // evicts a
    expect(l.allow('a', 3)).toBe(true);
  });
});

describe('Turnstile verifier', () => {
  const ok = (success: boolean) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ success }) }) as unknown as Response);

  it('passes only on success:true, and posts the secret and token', async () => {
    const fetchImpl = ok(true);
    const v = createTurnstileVerifier('secret', fetchImpl as unknown as typeof fetch);
    expect(await v.verify({ token: 'tok', ip: '1.2.3.4' })).toBe(true);
    const body = (fetchImpl.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body;
    expect(body.get('secret')).toBe('secret');
    expect(body.get('response')).toBe('tok');
    expect(await createTurnstileVerifier('s', ok(false) as unknown as typeof fetch).verify({ token: 't', ip: undefined })).toBe(false);
  });

  it('fails closed with no token, a non-OK response, or a network error', async () => {
    const v = createTurnstileVerifier('s', ok(true) as unknown as typeof fetch);
    expect(await v.verify({ token: undefined, ip: undefined })).toBe(false);
    const bad = createTurnstileVerifier('s', (async () => ({ ok: false }) as Response) as unknown as typeof fetch);
    expect(await bad.verify({ token: 't', ip: undefined })).toBe(false);
    const boom = createTurnstileVerifier('s', (async () => { throw new Error('x'); }) as unknown as typeof fetch);
    expect(await boom.verify({ token: 't', ip: undefined })).toBe(false);
  });
});

describe('widget script + snippet', () => {
  it('is syntactically valid JavaScript and keeps the tap-target/mobile contract', () => {
    expect(() => new Function(WIDGET_SCRIPT)).not.toThrow();
    expect(WIDGET_SCRIPT).toContain('min-height:44px');
    expect(WIDGET_SCRIPT).toContain('font-size:16px');
    expect(WIDGET_SCRIPT).toContain('text/plain');
  });

  it('builds a snippet that points at the API-served script with the token', () => {
    const token = mintEmbedToken(TENANT);
    expect(buildSnippet('https://api.example.com/', token)).toBe(
      `<script async src="https://api.example.com/api/public/webchat/widget.js" data-token="${token}"></script>`,
    );
  });
});
