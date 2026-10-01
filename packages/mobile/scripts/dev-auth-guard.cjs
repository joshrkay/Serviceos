/**
 * DEV/TEST-ONLY mobile auth path — bundle-time guard (PRD 3.3, #1015).
 *
 * Mirrors web's `VITE_AUTH_MODE=dev` (packages/web/vite.config.ts →
 * src/dev/clerk-dev-shim.tsx): when `EXPO_PUBLIC_AUTH_MODE=dev`, Metro swaps
 * `@clerk/clerk-expo` for `src/dev/clerk-expo-dev-shim.tsx`, which mints the
 * unsigned JWT the API's `DEV_AUTH_BYPASS` middleware decodes
 * (packages/api/src/auth/dev-auth-bypass.ts). That lets the Maestro device
 * flows (.maestro/) reach signed-in screens without a Clerk cloud instance.
 *
 * Layered production refusal:
 *   1. here — throws while Metro loads its config if the dev mode is asked for
 *      in a production context (an EAS profile other than `development`, or
 *      NODE_ENV=production, which `expo export` sets for a release bundle);
 *   2. in the shim — throws at module load when `__DEV__` is false, so even a
 *      release bundle built some other way can never sign in through it;
 *   3. server side — the API's DEV_AUTH_BYPASS is refused outside NODE_ENV=dev.
 *
 * CommonJS on purpose: metro.config.js is CJS and requires this file.
 */
const path = require('path');

const SHIM_PATH = path.resolve(__dirname, '../src/dev/clerk-expo-dev-shim.tsx');

function resolveDevAuth(env) {
  if (env.EXPO_PUBLIC_AUTH_MODE !== 'dev') return { shimPath: null };
  const profile = env.EAS_BUILD_PROFILE;
  if ((profile && profile !== 'development') || env.NODE_ENV === 'production') {
    throw new Error(
      'EXPO_PUBLIC_AUTH_MODE=dev is refused in a production build ' +
        `(EAS_BUILD_PROFILE=${profile ?? '<unset>'}, NODE_ENV=${env.NODE_ENV ?? '<unset>'}). ` +
        'The mobile dev-auth shim is for local dev and the Maestro device harness only.',
    );
  }
  return { shimPath: SHIM_PATH };
}

module.exports = { resolveDevAuth };
