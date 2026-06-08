import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub posthog-js so the lazy import() inside analytics resolves to a spy
// instead of the real SDK. Hoisted by vitest above the analytics import.
const captureSpy = vi.fn();
vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    capture: captureSpy,
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

import {
  trackFunnel,
  __resetAnalyticsForTests,
  type AnalyticsEvent,
} from './analytics';

/** Every launch-funnel event emitted client-side. Each must carry the four
 * required fields. Kept in sync with FUNNEL.md. */
const WEB_FUNNEL_EVENTS: AnalyticsEvent[] = [
  'view_landing',
  'signup_started',
  'wizard_started',
  'wizard_step_business',
  'wizard_step_phone',
  'wizard_step_voice',
  'wizard_completed',
  'test_call_initiated',
  'test_call_succeeded',
  'activation_celebrated',
];

const REQUIRED_FIELDS = ['tenant_id', 'user_id', 'timestamp', 'source'] as const;

describe('trackFunnel', () => {
  beforeEach(() => {
    captureSpy.mockClear();
    __resetAnalyticsForTests();
    // Enable analytics for the duration of the test via the runtime-config
    // window hook (readBrowserRuntimeValue is checked first).
    (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__ = {
      VITE_POSTHOG_KEY: 'phc_test_key',
    };
  });

  afterEach(() => {
    delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
    __resetAnalyticsForTests();
  });

  it('fires every launch-funnel event with tenant_id, user_id, timestamp and source', async () => {
    for (const event of WEB_FUNNEL_EVENTS) {
      captureSpy.mockClear();
      __resetAnalyticsForTests();
      trackFunnel(event, { tenantId: 'tenant-1', userId: 'user-1' });
      await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
      const [firedEvent, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(firedEvent).toBe(event);
      for (const field of REQUIRED_FIELDS) {
        expect(props).toHaveProperty(field);
      }
      expect(props.tenant_id).toBe('tenant-1');
      expect(props.user_id).toBe('user-1');
      expect(props.source).toBe('web');
      expect(typeof props.timestamp).toBe('string');
    }
  });

  it('defaults tenant_id and user_id to null on pre-auth events', async () => {
    trackFunnel('view_landing');
    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
    const [, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(props.tenant_id).toBeNull();
    expect(props.user_id).toBeNull();
    expect(props.source).toBe('web');
  });

  it('merges event-specific props (e.g. step) on top of the required fields', async () => {
    trackFunnel('wizard_step_business', { tenantId: 't', userId: 'u' }, { step: 'identity' });
    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalled());
    const [, props] = captureSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(props.step).toBe('identity');
    expect(props.tenant_id).toBe('t');
    expect(props.source).toBe('web');
  });

  it('is a silent no-op when no analytics key is configured', async () => {
    delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
    __resetAnalyticsForTests();
    trackFunnel('view_landing', { tenantId: 't', userId: 'u' });
    // give the lazy loader a chance to (not) fire
    await Promise.resolve();
    await Promise.resolve();
    expect(captureSpy).not.toHaveBeenCalled();
  });
});
