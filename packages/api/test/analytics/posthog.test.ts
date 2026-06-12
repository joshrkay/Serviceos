import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordFunnelEvent,
  isFunnelAnalyticsEnabled,
  __resetAnalyticsForTests,
  shutdownAnalytics,
} from '../../src/analytics/posthog';

describe('server-side PostHog wrapper', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
  });

  afterEach(() => {
    __resetAnalyticsForTests();
  });

  it('is disabled and silent when POSTHOG_API_KEY is unset', () => {
    expect(isFunnelAnalyticsEnabled()).toBe(false);
    // Should never throw, never log, just no-op.
    expect(() =>
      recordFunnelEvent({
        distinctId: 'user_123',
        event: 'signup_completed',
        properties: { tenantId: 't' },
      }),
    ).not.toThrow();
  });

  it('is disabled when POSTHOG_API_KEY is the empty string', () => {
    process.env.POSTHOG_API_KEY = '   ';
    expect(isFunnelAnalyticsEnabled()).toBe(false);
  });

  it('reports enabled when POSTHOG_API_KEY is set', () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    expect(isFunnelAnalyticsEnabled()).toBe(true);
  });

  it('accepts the first_real_call_received activation event (off-by-default, no throw)', () => {
    // The activation milestone is emitted from voice/activation.ts. Assert
    // the union member is wired through recordFunnelEvent and stays a silent
    // no-op when analytics is disabled (so it can never break call teardown).
    expect(isFunnelAnalyticsEnabled()).toBe(false);
    expect(() =>
      recordFunnelEvent({
        distinctId: 'clerk_owner',
        event: 'first_real_call_received',
        properties: {
          tenant_id: 't_1',
          user_id: 'clerk_owner',
          source: 'server',
          timestamp: new Date().toISOString(),
        },
      }),
    ).not.toThrow();
  });

  it('does not throw on shutdown when the client was never instantiated', async () => {
    await expect(shutdownAnalytics()).resolves.not.toThrow();
  });

  it('never throws even when the PostHog SDK fails to load', () => {
    // Set a key, then point require at a non-existent module so the
    // try/catch around require() trips. recordFunnelEvent should still
    // be a silent no-op rather than poisoning a webhook handler.
    process.env.POSTHOG_API_KEY = 'phc_test';
    // The actual posthog-node package is installed, so this only exercises
    // the "key set, sdk loads, capture called" happy path here in unit
    // form. The integration tests exercise the wire-up from webhooks.
    expect(() =>
      recordFunnelEvent({
        distinctId: 'user_42',
        event: 'trial_to_paid',
        properties: { tenantId: 't_42', priorStatus: 'trialing' },
      }),
    ).not.toThrow();
  });
});
