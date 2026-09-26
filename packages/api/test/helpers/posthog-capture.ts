import { vi } from 'vitest';
import { __setClientForTests, __resetAnalyticsForTests } from '../../src/analytics/posthog';

/**
 * Installs a fake PostHog client (and sets POSTHOG_API_KEY so funnel events
 * are captured) for asserting server-side analytics. Call `restore()` in a
 * finally block.
 */
export function capturePostHog() {
  const capture = vi.fn();
  process.env.POSTHOG_API_KEY = 'phc_test';
  __setClientForTests({ capture, groupIdentify: vi.fn(), shutdown: vi.fn() } as never);
  return {
    capture,
    events: () =>
      capture.mock.calls.map((c) => c[0] as { event: string; distinctId: string; properties: Record<string, unknown> }),
    restore: () => {
      __resetAnalyticsForTests();
      delete process.env.POSTHOG_API_KEY;
    },
  };
}
