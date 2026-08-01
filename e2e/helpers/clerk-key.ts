/**
 * Clerk publishable-key gates for Playwright specs.
 *
 * CI sets VITE_CLERK_PUBLISHABLE_KEY to a syntactically valid placeholder when
 * the real E2E_CLERK_PUBLISHABLE_KEY secret is absent, so hermetic offline
 * specs (clerk-stub) can boot the SPA on every PR. Specs that need the real
 * Clerk CDN / SignIn widget must use `hasRealClerkPublishableKey()` so the
 * placeholder does not turn green skips into red failures.
 */

/** pk_test_ + base64("dummy.clerk.accounts.dev$") — matches e2e.yml fallback. */
export const PLACEHOLDER_CLERK_PK =
  'pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA==';

/** Any key (or deployed base URL) — enough for clerk-stub / public-bundle boot. */
export function hasViteClerkKey(): boolean {
  return !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

/**
 * Real Clerk testing publishable key (or deployed env). False for the CI
 * placeholder so smoke-ui / marketing specs that load clerk-js stay skipped.
 */
export function hasRealClerkPublishableKey(): boolean {
  if (process.env.E2E_BASE_URL) return true;
  if (process.env.E2E_HAS_REAL_CLERK_PK === 'true') return true;
  const key = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  return !!key && key !== PLACEHOLDER_CLERK_PK;
}
