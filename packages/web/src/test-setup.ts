import '@testing-library/jest-dom';
import { vi } from 'vitest';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * P0-030 — global Clerk mock baseline.
 *
 * The data hooks (useListQuery / useDetailQuery / useMutation) now route
 * through `useApiClient`, which reads the Clerk session token via
 * `useAuth()`. Without a `<ClerkProvider>` Clerk asserts and throws.
 * For unit tests that exercise these hooks (or components that mount
 * them) without setting up Clerk, supply a permissive default mock.
 *
 * Test files that exercise the auth machinery itself
 * (e.g. `useListQuery.test.ts`, `useMutation.test.ts`,
 * `P0-029.ClerkProvider.test.tsx`) override this with their own
 * `vi.mock('@clerk/clerk-react', …)` block.
 */
// Stable references — see comment about referential stability above. These
// must be defined at module scope so every `useAuth()` call inside the same
// test render returns the same object/function identity. Without this,
// useApiClient's useCallback would invalidate on every render, kicking off
// an effect loop in any hook that depends on it.
const __defaultClerkGetToken = async () => 'tok-test-default';
const __defaultUseAuthResult = {
  isLoaded: true,
  isSignedIn: true,
  getToken: __defaultClerkGetToken,
};

vi.mock('@clerk/clerk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/clerk-react')>();
  return {
    ...actual,
    useAuth: () => __defaultUseAuthResult,
  };
});

