import { describe, expect, it } from 'vitest';
import {
  readSessionExpiredParams,
  signInExpiredHref,
  SESSION_EXPIRED_REASON,
} from './sessionExpired';

// signInExpiredHref returns an Href object; narrow it for assertions.
function asObjectHref(href: ReturnType<typeof signInExpiredHref>): {
  pathname: string;
  params: Record<string, string>;
} {
  return href as { pathname: string; params: Record<string, string> };
}

describe('signInExpiredHref', () => {
  it('routes to /sign-in with the session-expired reason', () => {
    const href = asObjectHref(signInExpiredHref('/messages/abc'));
    expect(href.pathname).toBe('/sign-in');
    expect(href.params.reason).toBe(SESSION_EXPIRED_REASON);
  });

  it('preserves a resumable current path as next', () => {
    const href = asObjectHref(signInExpiredHref('/customers/c1'));
    expect(href.params.next).toBe('/customers/c1');
  });

  it('omits next for Home (the default landing) and the auth flow', () => {
    expect(asObjectHref(signInExpiredHref('/')).params.next).toBeUndefined();
    expect(asObjectHref(signInExpiredHref('/sign-in')).params.next).toBeUndefined();
    expect(asObjectHref(signInExpiredHref('/(auth)/sign-in')).params.next).toBeUndefined();
  });

  it('omits next when there is no current path', () => {
    expect(asObjectHref(signInExpiredHref(undefined)).params.next).toBeUndefined();
  });
});

describe('readSessionExpiredParams', () => {
  it('detects the session-expired reason and returns the resume path', () => {
    const result = readSessionExpiredParams({
      reason: SESSION_EXPIRED_REASON,
      next: '/proposals/p1',
    });
    expect(result.expired).toBe(true);
    expect(result.next).toBe('/proposals/p1');
  });

  it('is not expired for a cold sign-in (no reason)', () => {
    const result = readSessionExpiredParams({});
    expect(result.expired).toBe(false);
    expect(result.next).toBeUndefined();
  });

  it('normalizes array params (expo-router can hand back string[])', () => {
    const result = readSessionExpiredParams({
      reason: [SESSION_EXPIRED_REASON],
      next: ['/messages/x'],
    });
    expect(result.expired).toBe(true);
    expect(result.next).toBe('/messages/x');
  });

  it('drops a non-resumable next (e.g. an open redirect attempt)', () => {
    const result = readSessionExpiredParams({
      reason: SESSION_EXPIRED_REASON,
      next: 'https://evil.example.com',
    });
    expect(result.expired).toBe(true);
    expect(result.next).toBeUndefined();
  });
});
