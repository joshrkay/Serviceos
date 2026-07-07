import { describe, it, expect, afterEach } from 'vitest';
import { PLACEHOLDER_CLERK_KEY, webAppCanBoot, hasRealClerk } from './clerk-env';

/**
 * Unit test for the CI/local gate that decides which E2E suites run. This is
 * the single branch point separating "the web app can boot" (offline/401
 * specs, any key) from "a real Clerk instance is available" (smoke-ui + mobile
 * layout specs) — an inverted sentinel check would silently drop a whole lane
 * or turn green skips into red, so it's pinned here per CLAUDE.md ("New or
 * changed pure logic requires unit tests in the same commit").
 *
 * Runs via `npm run test:e2e-helpers` (e2e/vitest.config.ts) — a standalone
 * vitest project, since e2e/ is outside the npm workspaces.
 */

const KEYS = ['E2E_BASE_URL', 'VITE_CLERK_PUBLISHABLE_KEY'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe('clerk-env gate', () => {
  it('no key and no base URL: app cannot boot, no real Clerk', () => {
    setEnv({ E2E_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: undefined });
    expect(webAppCanBoot()).toBe(false);
    expect(hasRealClerk()).toBe(false);
  });

  it('placeholder key: app boots (offline specs run) but Clerk is NOT real (real-Clerk specs skip)', () => {
    setEnv({ E2E_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: PLACEHOLDER_CLERK_KEY });
    expect(webAppCanBoot()).toBe(true);
    expect(hasRealClerk()).toBe(false);
  });

  it('real key: app boots and Clerk is real (both suites run)', () => {
    setEnv({ E2E_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_realkeyvalue123' });
    expect(webAppCanBoot()).toBe(true);
    expect(hasRealClerk()).toBe(true);
  });

  it('deployed base URL alone: app boots and Clerk is real (widget served by the deploy)', () => {
    setEnv({ E2E_BASE_URL: 'https://example.up.railway.app', VITE_CLERK_PUBLISHABLE_KEY: undefined });
    expect(webAppCanBoot()).toBe(true);
    expect(hasRealClerk()).toBe(true);
  });

  it('the placeholder is a syntactically valid pk_test_ key', () => {
    expect(PLACEHOLDER_CLERK_KEY).toMatch(/^pk_test_[A-Za-z0-9]+$/);
  });
});
