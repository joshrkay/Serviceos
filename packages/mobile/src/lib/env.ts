/**
 * Public runtime config. `EXPO_PUBLIC_*` vars are inlined by Expo at build
 * time (see .env / app config), so they are safe to read from `process.env`
 * in the bundle.
 */

/** Absolute base URL of the ServiceOS API (the RN app is not same-origin). */
export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'
).replace(/\/$/, '');

/** Clerk publishable key for `@clerk/clerk-expo`. */
export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';
