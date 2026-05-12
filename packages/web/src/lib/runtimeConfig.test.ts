import { afterEach, describe, expect, it } from 'vitest';
import { getRuntimeConfigValue } from './runtimeConfig';

describe('runtimeConfig', () => {
  afterEach(() => {
    delete window.__APP_CONFIG__;
    delete process.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
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
    window.__APP_CONFIG__ = {
      VITE_CLERK_PUBLISHABLE_KEY: '   ',
    };
    process.env.VITE_CLERK_PUBLISHABLE_KEY = '   ';

    expect(getRuntimeConfigValue('VITE_CLERK_PUBLISHABLE_KEY')).toBeUndefined();
  });
});
