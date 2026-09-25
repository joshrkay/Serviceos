/**
 * publicUrl(role, path, query) — the one way to build a URL a human opens
 * (web) or a machine calls back (api) or the marketing site. Origins come
 * from config.publicOrigins (see config.public-origins.test.ts); this seam
 * is where the joining and query encoding that every call site used to
 * hand-roll now lives.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';
import { publicUrl } from '../../src/shared/public-origins';

describe('publicUrl', () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({
      NODE_ENV: 'dev',
      WEB_URL: 'https://app.example.com',
      PUBLIC_API_URL: 'https://api.example.com',
      MARKETING_SITE_URL: 'https://www.example.com',
    });
  });

  it('joins the role origin, the path and an encoded query', () => {
    expect(publicUrl('web', '/onboarding', { billing: 'ok' })).toBe(
      'https://app.example.com/onboarding?billing=ok',
    );
    expect(publicUrl('api', '/api/telephony/voice')).toBe(
      'https://api.example.com/api/telephony/voice',
    );
    expect(publicUrl('marketing', '/pricing')).toBe('https://www.example.com/pricing');
  });

  it('refuses a path that is not absolute on the origin (relative, or protocol-relative //host)', () => {
    expect(() => publicUrl('web', 'onboarding')).toThrow(/path must start with "\/"/);
    // `new URL('//evil.example/x', origin)` would resolve to evil.example —
    // a way to smuggle a foreign host into an emailed link.
    expect(() => publicUrl('web', '//evil.example/x')).toThrow(/path must start with "\/"/);
  });

  it('encodes query values, keeps an existing query on the path, and drops undefined / null', () => {
    expect(
      publicUrl('web', '/feedback/tok en?v=1', { redirect: '/jobs?x=1&y=2', n: 3, ok: true, skip: undefined, gone: null }),
    ).toBe('https://app.example.com/feedback/tok%20en?v=1&redirect=%2Fjobs%3Fx%3D1%26y%3D2&n=3&ok=true');
  });
});
