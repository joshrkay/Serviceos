import Module from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads the REAL packages/mobile/metro.config.js the way the Expo CLI does
 * (CommonJS require), with only its two toolchain imports faked — Expo and
 * NativeWind are not installed in the root-hoisted CI lane. What is under
 * test is this repo's resolveRequest wiring, not Metro itself.
 */
const METRO_CONFIG = path.resolve(__dirname, '../../metro.config.js');
const SHIM = path.resolve(__dirname, 'clerk-expo-dev-shim.tsx');

type Resolved = { type: string; filePath?: string };
type MetroConfig = {
  resolver: {
    resolveRequest: (ctx: unknown, name: string, platform: string) => Resolved;
  };
};

function loadMetroConfig(env: Record<string, string | undefined>): MetroConfig {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const req = Module.createRequire(METRO_CONFIG);
  delete req.cache[METRO_CONFIG];
  const mod = Module as unknown as { _load: (r: string, ...rest: unknown[]) => unknown };
  const realLoad = mod._load;
  mod._load = (request: string, ...rest: unknown[]) => {
    if (request === 'expo/metro-config') {
      return { getDefaultConfig: () => ({ resolver: {} }) };
    }
    if (request === 'nativewind/metro') return { withNativeWind: (c: unknown) => c };
    return realLoad(request, ...rest);
  };
  try {
    return req(METRO_CONFIG) as MetroConfig;
  } finally {
    mod._load = realLoad;
  }
}

const fallthrough = (): Resolved => ({ type: 'fallthrough' });
const ctx = { resolveRequest: fallthrough, originModulePath: '/app/_layout.tsx' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('metro.config.js — dev-auth alias wiring (PRD 3.3)', () => {
  it('resolves @clerk/clerk-expo to the dev shim only when EXPO_PUBLIC_AUTH_MODE=dev', () => {
    const dev = loadMetroConfig({ EXPO_PUBLIC_AUTH_MODE: 'dev', NODE_ENV: 'development', EAS_BUILD_PROFILE: undefined });
    expect(dev.resolver.resolveRequest(ctx, '@clerk/clerk-expo', 'android')).toEqual({
      type: 'sourceFile',
      filePath: SHIM,
    });

    const real = loadMetroConfig({ EXPO_PUBLIC_AUTH_MODE: undefined, NODE_ENV: 'development' });
    expect(real.resolver.resolveRequest(ctx, '@clerk/clerk-expo', 'android')).toEqual({ type: 'fallthrough' });
  });

  it('refuses to load at all for a production EAS build that asks for dev auth', () => {
    expect(() =>
      loadMetroConfig({ EXPO_PUBLIC_AUTH_MODE: 'dev', EAS_BUILD_PROFILE: 'production', NODE_ENV: 'production' }),
    ).toThrow(/EXPO_PUBLIC_AUTH_MODE=dev is refused/);
  });
});
