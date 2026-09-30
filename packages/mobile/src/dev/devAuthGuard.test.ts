import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The guard is CommonJS because metro.config.js (CJS, loaded by the Expo CLI)
// requires it; load it the same way Node/Metro does.
const require = createRequire(__filename);
const { resolveDevAuth } = require('../../scripts/dev-auth-guard.cjs') as {
  resolveDevAuth: (env: Record<string, string | undefined>) => { shimPath: string | null };
};

describe('resolveDevAuth — PRD 3.3 mobile dev-auth path (bundle-time guard)', () => {
  it('leaves the real Clerk SDK in place when no auth mode is requested', () => {
    expect(resolveDevAuth({}).shimPath).toBeNull();
    expect(resolveDevAuth({ EXPO_PUBLIC_AUTH_MODE: 'clerk' }).shimPath).toBeNull();
  });

  it('swaps in the dev shim for a local/e2e dev bundle that asks for it', () => {
    const shim = path.resolve(__dirname, 'clerk-expo-dev-shim.tsx');
    expect(resolveDevAuth({ EXPO_PUBLIC_AUTH_MODE: 'dev', NODE_ENV: 'development' }).shimPath).toBe(shim);
    expect(
      resolveDevAuth({ EXPO_PUBLIC_AUTH_MODE: 'dev', EAS_BUILD_PROFILE: 'development' }).shimPath,
    ).toBe(shim);
  });

  // The owner requirement: impossible to enable in a production build.
  it.each([
    ['EAS production profile', { EAS_BUILD_PROFILE: 'production' }],
    ['EAS preview (store/internal) profile', { EAS_BUILD_PROFILE: 'preview' }],
    ['release export (NODE_ENV=production)', { NODE_ENV: 'production' }],
  ])('refuses the dev auth mode in a %s', (_label, ctx) => {
    expect(() => resolveDevAuth({ EXPO_PUBLIC_AUTH_MODE: 'dev', ...ctx })).toThrow(
      /EXPO_PUBLIC_AUTH_MODE=dev is refused/,
    );
  });

  it('does not throw for a production build that never asked for dev auth', () => {
    expect(resolveDevAuth({ EAS_BUILD_PROFILE: 'production', NODE_ENV: 'production' }).shimPath).toBeNull();
  });
});
