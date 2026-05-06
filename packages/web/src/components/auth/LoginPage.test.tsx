import { describe, it, expect } from 'vitest';
import { extractFromPath } from './LoginPage';

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
