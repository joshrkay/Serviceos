/**
 * The /onboarding route loads the v3 conversation shell when the
 * `onboarding_v3` flag is on and the v2 shell otherwise. Reads the real route
 * table (routes.ts) and runs the route's own lazy loader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteObject } from 'react-router';

vi.mock('./components/onboarding/v2/OnboardingShell', () => ({ OnboardingShell: function V2Shell() { return null; } }));
vi.mock('./components/onboarding/v3/ConversationShell', () => ({ ConversationShell: function V3Shell() { return null; } }));

import { router } from './routes';
import { ONBOARDING_V3_FLAG } from './lib/onboardingV3Flag';

function flatten(routes: RouteObject[]): RouteObject[] {
  return routes.flatMap((r) => [r, ...(r.children ? flatten(r.children) : [])]);
}

async function loadedOnboardingComponent(): Promise<string> {
  const route = flatten(router.routes as RouteObject[]).find((r) => r.path === 'onboarding');
  expect(route, 'expected an onboarding route').toBeDefined();
  const lazy = (route as { lazy: () => Promise<{ Component: { name: string } }> }).lazy;
  return (await lazy()).Component.name;
}

describe('/onboarding shell selection', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllEnvs());

  it('loads the v2 shell by default', async () => {
    expect(await loadedOnboardingComponent()).toBe('V2Shell');
  });

  it('loads the v3 shell when the per-browser flag is on', async () => {
    window.localStorage.setItem(ONBOARDING_V3_FLAG, '1');
    expect(await loadedOnboardingComponent()).toBe('V3Shell');
  });

  it('loads the v3 shell when the env default is on, and v2 when the browser opts out', async () => {
    vi.stubEnv('VITE_ONBOARDING_V3', 'true');
    expect(await loadedOnboardingComponent()).toBe('V3Shell');
    window.localStorage.setItem(ONBOARDING_V3_FLAG, 'off');
    expect(await loadedOnboardingComponent()).toBe('V2Shell');
  });
});
