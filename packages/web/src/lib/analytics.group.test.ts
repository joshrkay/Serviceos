import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub posthog-js so the lazy import() inside analytics resolves to spies
// instead of the real SDK. Hoisted by vitest above the analytics import.
const groupSpy = vi.fn();
const identifySpy = vi.fn();
vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: identifySpy,
    group: groupSpy,
    reset: vi.fn(),
  },
}));

import { groupTenant, __resetAnalyticsForTests } from './analytics';

function enableAnalytics(): void {
  (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__ = {
    VITE_POSTHOG_KEY: 'phc_test_key',
  };
}

describe('groupTenant', () => {
  beforeEach(() => {
    groupSpy.mockClear();
    __resetAnalyticsForTests();
    enableAnalytics();
  });

  afterEach(() => {
    delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
    __resetAnalyticsForTests();
  });

  it("binds the browser session to the 'tenant' group with traits", async () => {
    groupTenant('tenant-1', { timezone: 'America/New_York' });
    await vi.waitFor(() => expect(groupSpy).toHaveBeenCalled());

    const [groupType, groupKey, traits] = groupSpy.mock.calls[0] as [
      string,
      string,
      Record<string, unknown> | undefined,
    ];
    expect(groupType).toBe('tenant');
    expect(groupKey).toBe('tenant-1');
    expect(traits).toEqual({ timezone: 'America/New_York' });
  });

  it('passes undefined traits through without throwing', async () => {
    groupTenant('tenant-2');
    await vi.waitFor(() => expect(groupSpy).toHaveBeenCalled());
    const [groupType, groupKey] = groupSpy.mock.calls[0] as [string, string, unknown];
    expect(groupType).toBe('tenant');
    expect(groupKey).toBe('tenant-2');
  });

  it('is a silent no-op when no analytics key is configured', async () => {
    delete (window as unknown as { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__;
    __resetAnalyticsForTests();

    groupTenant('tenant-3', { timezone: 'UTC' });
    // Give the lazy loader a chance to (not) fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(groupSpy).not.toHaveBeenCalled();
  });
});
