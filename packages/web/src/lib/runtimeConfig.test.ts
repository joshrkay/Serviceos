import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeConfigValue, isOnboardingV2Enabled } from './runtimeConfig';

describe('runtimeConfig', () => {
  afterEach(() => {
    delete window.__APP_CONFIG__;
    delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
    delete process.env.VITE_ONBOARDING_V2_ENABLED;
    vi.unstubAllEnvs();
  });

  it('prefers browser runtime config over process env', () => {
    window.__APP_CONFIG__ = {
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_runtime',
    };
    process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_process';

    expect(getRuntimeConfigValue('VITE_CLERK_PUBLISHABLE_KEY')).toBe(
      'pk_live_runtime'
    );
  });

  it('falls back to process env when runtime config is absent', () => {
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = 'pk_test_process';

    expect(getRuntimeConfigValue('VITE_STRIPE_PUBLISHABLE_KEY')).toBe(
      'pk_test_process'
    );
  });

  it('treats blank values as missing', () => {
    const key = 'VITE_RUNTIME_CONFIG_BLANK_PROBE';
    vi.stubEnv(key, '   ');
    window.__APP_CONFIG__ = { [key]: '   ' };
    process.env[key] = '   ';

    expect(getRuntimeConfigValue(key)).toBeUndefined();
  });

  it('isOnboardingV2Enabled is true only when flag is exactly "true"', () => {
    window.__APP_CONFIG__ = { VITE_ONBOARDING_V2_ENABLED: 'true' };
    expect(isOnboardingV2Enabled()).toBe(true);

    window.__APP_CONFIG__ = { VITE_ONBOARDING_V2_ENABLED: 'false' };
    expect(isOnboardingV2Enabled()).toBe(false);
  });
});
