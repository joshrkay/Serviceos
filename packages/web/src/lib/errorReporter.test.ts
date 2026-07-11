/**
 * ARCH-31 / OBS-43 — errorReporter unit tests.
 *
 * Mirrors the posthog-js stubbing pattern in `analytics.funnel.test.ts`:
 * the lazy `import('posthog-js')` inside `lib/analytics.ts` resolves to a
 * spy so we can assert on the captured event without a network call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const captureSpy = vi.fn();
vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    capture: captureSpy,
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

import { __resetAnalyticsForTests } from './analytics';
import {
  initErrorReporting,
  __resetErrorReportingForTests,
  reportError,
  toSafeErrorShape,
} from './errorReporter';

function enablePosthog() {
  (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__ = {
    VITE_POSTHOG_KEY: 'phc_test_key',
  };
}

beforeEach(() => {
  captureSpy.mockClear();
  __resetAnalyticsForTests();
  __resetErrorReportingForTests();
  enablePosthog();
});

afterEach(() => {
  delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
  __resetAnalyticsForTests();
  __resetErrorReportingForTests();
});

describe('toSafeErrorShape', () => {
  it('extracts name + message from an Error instance', () => {
    const err = new TypeError('boom');
    expect(toSafeErrorShape(err)).toEqual({ name: 'TypeError', message: 'boom' });
  });

  it('treats a plain string as an Error-shaped message', () => {
    expect(toSafeErrorShape('plain failure')).toEqual({ name: 'Error', message: 'plain failure' });
  });

  it('degrades unknown thrown values to an empty-message UnknownError', () => {
    expect(toSafeErrorShape({ some: 'object' })).toEqual({ name: 'UnknownError', message: '' });
    expect(toSafeErrorShape(undefined)).toEqual({ name: 'UnknownError', message: '' });
  });

  it('redacts a bearer token embedded in the message', () => {
    const err = new Error('request failed: Authorization: Bearer abc123.def456-ghi_789 rejected');
    const { message } = toSafeErrorShape(err);
    expect(message).not.toContain('abc123.def456-ghi_789');
    expect(message).toContain('Bearer [redacted]');
  });

  it('redacts a bare JWT-shaped string in the message', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const err = new Error(`session token ${jwt} was rejected`);
    const { message } = toSafeErrorShape(err);
    expect(message).not.toContain(jwt);
    expect(message).toContain('[redacted]');
  });

  it('truncates an overly long message', () => {
    const longMessage = 'x'.repeat(1000);
    const { message } = toSafeErrorShape(new Error(longMessage));
    expect(message.length).toBeLessThan(1000);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('reportError', () => {
  it('captures an app_error event via PostHog with only name/message/source', async () => {
    reportError(new Error('assistant chat failed'), 'assistant-chat');
    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());

    const [event, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('app_error');
    expect(props).toEqual({
      name: 'Error',
      message: 'assistant chat failed',
      source: 'assistant-chat',
    });
  });

  it('degrades gracefully (never throws) when PostHog is not configured', async () => {
    delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
    __resetAnalyticsForTests();

    expect(() => reportError(new Error('no key configured'), 'unhandledrejection')).not.toThrow();
    await Promise.resolve();
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe('initErrorReporting', () => {
  it('reports an unhandledrejection through PostHog with a safe shape', async () => {
    initErrorReporting();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent & {
      reason?: unknown;
    };
    Object.defineProperty(event, 'reason', { value: new Error('unawaited promise blew up') });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
    const [evtName, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(evtName).toBe('app_error');
    expect(props.source).toBe('unhandledrejection');
    expect(props.message).toBe('unawaited promise blew up');
  });

  it('reports a window error event through PostHog', async () => {
    initErrorReporting();

    const event = new Event('error') as ErrorEvent & { error?: unknown };
    Object.defineProperty(event, 'error', { value: new RangeError('out of range') });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
    const [, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(props).toMatchObject({ name: 'RangeError', message: 'out of range', source: 'window.error' });
  });

  it('is idempotent — a second init does not double-register listeners', async () => {
    initErrorReporting();
    initErrorReporting();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent & {
      reason?: unknown;
    };
    Object.defineProperty(event, 'reason', { value: new Error('once only') });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});
