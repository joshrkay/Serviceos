import { describe, it, expect } from 'vitest';
import { parseDeepLink, type DeepLinkConfig } from './deepLinks';

const config: DeepLinkConfig = { allowedHosts: ['app.rivet.com'], schemes: ['rivet'] };

describe('parseDeepLink', () => {
  it('maps an https universal link on our host to its in-app path', () => {
    expect(parseDeepLink('https://app.rivet.com/e/abc123', config)).toBe('/e/abc123');
  });

  it('preserves the query string (e.g. a view token)', () => {
    expect(parseDeepLink('https://app.rivet.com/pay/inv_1?token=xyz', config)).toBe('/pay/inv_1?token=xyz');
  });

  it('maps a custom-scheme link to its in-app path', () => {
    expect(parseDeepLink('rivet://e/abc', config)).toBe('/e/abc');
    expect(parseDeepLink('rivet://jobs/123', config)).toBe('/jobs/123');
  });

  it('rejects a foreign https host (no open-redirect)', () => {
    expect(parseDeepLink('https://evil.com/e/abc', config)).toBeNull();
  });

  it('matches the allowed host case-insensitively', () => {
    expect(parseDeepLink('https://APP.RIVET.COM/jobs/9', config)).toBe('/jobs/9');
  });

  it('collapses protocol-relative double slashes to a harmless in-app path', () => {
    expect(parseDeepLink('https://app.rivet.com//evil.com', config)).toBe('/evil.com');
  });

  it('strips a trailing slash (except root)', () => {
    expect(parseDeepLink('https://app.rivet.com/jobs/', config)).toBe('/jobs');
  });

  it('returns root for a bare custom-scheme link', () => {
    expect(parseDeepLink('rivet://', config)).toBe('/');
  });

  it('ignores other schemes and junk', () => {
    expect(parseDeepLink('mailto:a@b.com', config)).toBeNull();
    expect(parseDeepLink('tel:+15551234567', config)).toBeNull();
    expect(parseDeepLink('not a url', config)).toBeNull();
    expect(parseDeepLink('', config)).toBeNull();
  });
});
