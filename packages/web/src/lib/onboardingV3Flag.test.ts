import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_V3_FLAG, isOnboardingV3Enabled } from './onboardingV3Flag';

describe('isOnboardingV3Enabled', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.__APP_CONFIG__;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.__APP_CONFIG__;
  });

  it('is off by default', () => {
    expect(isOnboardingV3Enabled()).toBe(false);
  });

  it('turns on from the VITE_ONBOARDING_V3 default', () => {
    vi.stubEnv('VITE_ONBOARDING_V3', 'true');
    expect(isOnboardingV3Enabled()).toBe(true);
  });

  it('reads the default from the runtime config the container renders into env.js', () => {
    window.__APP_CONFIG__ = { VITE_ONBOARDING_V3: '1' };
    expect(isOnboardingV3Enabled()).toBe(true);
  });

  it('treats other env values as off', () => {
    vi.stubEnv('VITE_ONBOARDING_V3', 'false');
    expect(isOnboardingV3Enabled()).toBe(false);
  });

  it('lets the per-browser flag turn it on without the env default', () => {
    window.localStorage.setItem(ONBOARDING_V3_FLAG, '1');
    expect(isOnboardingV3Enabled()).toBe(true);
  });

  it('lets the per-browser flag turn it off when the env default is on', () => {
    vi.stubEnv('VITE_ONBOARDING_V3', 'true');
    window.localStorage.setItem(ONBOARDING_V3_FLAG, 'off');
    expect(isOnboardingV3Enabled()).toBe(false);
  });
});
