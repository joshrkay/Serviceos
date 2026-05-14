import { describe, it, expect } from 'vitest';
import { extractFromPath, resolveRedirectTarget } from './LoginPage';

describe('LoginPage — extractFromPath', () => {
  it('returns "/" when state is null', () => {
    expect(extractFromPath(null)).toBe('/');
  });

  it('returns "/" when state.from is missing', () => {
    expect(extractFromPath({})).toBe('/');
  });

  it('returns "/" when state.from has no pathname', () => {
    expect(extractFromPath({ from: {} })).toBe('/');
  });

  it('returns pathname for a simple in-app route', () => {
    expect(extractFromPath({ from: { pathname: '/estimates/abc123' } })).toBe('/estimates/abc123');
  });

  it('preserves search and hash on deep links', () => {
    expect(
      extractFromPath({ from: { pathname: '/jobs', search: '?filter=open', hash: '#section-2' } })
    ).toBe('/jobs?filter=open#section-2');
  });

  it('blocks protocol-relative URLs (open redirect)', () => {
    expect(extractFromPath({ from: { pathname: '//evil.com/path' } })).toBe('/');
  });

  it('blocks external absolute URLs (no leading slash)', () => {
    expect(extractFromPath({ from: { pathname: 'https://evil.com/steal' } })).toBe('/');
  });
});

describe('LoginPage — resolveRedirectTarget', () => {
  it('prefers the ?redirect= query param over location state', () => {
    expect(
      resolveRedirectTarget(encodeURIComponent('/jobs'), { from: { pathname: '/customers' } })
    ).toBe('/jobs');
  });

  it('decodes the param and preserves the query string (BUG-3)', () => {
    expect(
      resolveRedirectTarget(encodeURIComponent('/jobs?filter=open'), null)
    ).toBe('/jobs?filter=open');
  });

  it('falls back to location state when no param is present', () => {
    expect(
      resolveRedirectTarget(null, { from: { pathname: '/estimates/abc123' } })
    ).toBe('/estimates/abc123');
  });

  it('falls back to "/" when neither param nor state is present', () => {
    expect(resolveRedirectTarget(null, null)).toBe('/');
  });

  it('rejects a protocol-relative param and falls back to state', () => {
    expect(
      resolveRedirectTarget(encodeURIComponent('//evil.com/path'), { from: { pathname: '/safe' } })
    ).toBe('/safe');
  });

  it('rejects an external absolute param (open redirect)', () => {
    expect(resolveRedirectTarget(encodeURIComponent('https://evil.com/steal'), null)).toBe('/');
  });

  it('falls back to state when the param is malformed', () => {
    // A lone % is invalid percent-encoding — decodeURIComponent throws.
    expect(resolveRedirectTarget('%', { from: { pathname: '/leads' } })).toBe('/leads');
  });
});
