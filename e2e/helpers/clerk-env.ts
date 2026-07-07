/**
 * Clerk env gating — distinguishes two things the specs used to conflate:
 *
 *   1. "The web app can BOOT" — the Vite dev server needs *any* syntactically
 *      valid VITE_CLERK_PUBLISHABLE_KEY (main.tsx throws without one). Offline
 *      specs (offline/*, no-401-storm) only need this: they stub window.Clerk,
 *      so the key never reaches a real Clerk instance.
 *
 *   2. "A REAL Clerk instance is available" — smoke-ui + the public mobile
 *      layout specs drive the actual Clerk widget / real backend, so they need
 *      a real key (from secrets) or a deployed E2E_BASE_URL.
 *
 * PR CI sets VITE_CLERK_PUBLISHABLE_KEY to PLACEHOLDER_CLERK_KEY when no Clerk
 * secret is configured (see .github/workflows/e2e.yml), so offline specs run
 * on every PR. Real-Clerk specs must skip in that mode — hence the sentinel
 * check below rather than a bare presence check.
 */

/**
 * Syntactically valid `pk_test_` key whose base64 payload decodes to
 * `offline-stub.clerk.accounts.dev$`. clerk-react parses the key at provider
 * mount, so it must be well-formed; the stub short-circuits the loader before
 * any request to that (nonexistent) instance is made. Keep this BYTE-IDENTICAL
 * to the fallback literal in .github/workflows/e2e.yml.
 */
export const PLACEHOLDER_CLERK_KEY =
  'pk_test_b2ZmbGluZS1zdHViLmNsZXJrLmFjY291bnRzLmRldiQ';

/** True when the Vite web app can boot (any key, including the placeholder). */
export function webAppCanBoot(): boolean {
  return !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

/**
 * True when a REAL Clerk instance (or a deployed base URL that has one) is
 * available — i.e. the key is present AND is not the offline placeholder.
 * Specs that drive the live Clerk widget or a real backend gate on this.
 */
export function hasRealClerk(): boolean {
  if (process.env.E2E_BASE_URL) return true;
  const key = process.env.VITE_CLERK_PUBLISHABLE_KEY;
  return !!key && key !== PLACEHOLDER_CLERK_KEY;
}
