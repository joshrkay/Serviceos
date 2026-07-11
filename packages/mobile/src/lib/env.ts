/**
 * Public runtime config. `EXPO_PUBLIC_*` vars are inlined by Expo at build
 * time (see .env / app config), so they are safe to read from `process.env`
 * in the bundle.
 */

// React Native / Expo global: true in a dev bundle, false in a production
// export. Declared here because the mobile package has no other __DEV__ usage.
declare const __DEV__: boolean;

/**
 * MOB-01 — resolve the API base URL, failing fast in a production build when
 * `EXPO_PUBLIC_API_URL` is missing. Expo inlines `EXPO_PUBLIC_*` at BUILD time,
 * so an export that forgot the var would otherwise silently ship a bundle
 * pointed at `http://localhost:3000` over plaintext HTTP. In dev we keep the
 * localhost default for convenience. Pure function so it is trivially testable.
 */
export function resolveApiBaseUrl(rawUrl: string | undefined, isDev: boolean): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    if (!isDev) {
      throw new Error(
        'EXPO_PUBLIC_API_URL is required for a production build (it is inlined at ' +
          'build time — set it before running `expo export`/EAS build).',
      );
    }
    return 'http://localhost:3000';
  }
  return trimmed.replace(/\/$/, '');
}

// `__DEV__` is always defined in a shipped RN bundle (true in the dev client,
// false in a production export). It is NOT defined in plain Node contexts
// (unit tests, tooling), where evaluating this module must not throw — treat an
// absent `__DEV__` as dev so the localhost default applies. The production
// fail-fast therefore fires exactly where it matters: a real production export,
// where `__DEV__` is defined as false.
const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

/** Absolute base URL of the ServiceOS API (the RN app is not same-origin). */
export const API_BASE_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL, IS_DEV);

/** Clerk publishable key for `@clerk/clerk-expo`. */
export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';
