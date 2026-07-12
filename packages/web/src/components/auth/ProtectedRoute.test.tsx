/**
 * P0-031 — Protected route guards
 *
 * Verifies the <ProtectedRoute> auth guard:
 *   - Unauthenticated → redirects to /login (deep link preserved)
 *   - Authenticated   → renders the protected content
 *   - Public routes   → accessible without auth (sanity check via routes.ts)
 *   - Loading state   → spinner during Clerk init, not a login flash
 *
 * The redirect target is preserved through `location.state.from` — the
 * existing LoginPage (P0-029) consumes this via `extractFromPath` to
 * round-trip the user back to the deep link after sign-in.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mutable Clerk mock state ───────────────────────────────────────────────
const clerkState = {
  isLoaded: true,
  isSignedIn: true,
};

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn:  ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  SignIn:    () => <div data-testid="clerk-signin">Clerk SignIn</div>,
  SignUp:    () => <div data-testid="clerk-signup">Clerk SignUp</div>,
  useAuth:   () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    getToken: async () => null,
  }),
  useUser:   () => ({ isLoaded: clerkState.isLoaded, user: null }),
  useClerk:  () => ({ signOut: vi.fn() }),
}));

// Imports that depend on the mock must come AFTER vi.mock above.
import { ProtectedRoute } from './ProtectedRoute';
import { extractFromPath, type LocationState } from './LoginPage';

beforeEach(() => {
  clerkState.isLoaded = true;
  clerkState.isSignedIn = true;
});

// A simple sentinel to confirm a route's children rendered.
function ProtectedContent() {
  return <div data-testid="protected-content">SECRET DASHBOARD</div>;
}

// A LoginPage stand-in that surfaces the captured `state.from` as text so
// tests can assert deep-link preservation without depending on Clerk's UI.
function LoginRouteProbe() {
  const location = useLocation();
  const from = extractFromPath(location.state as LocationState);
  return (
    <div>
      <div data-testid="login-page">LOGIN</div>
      <div data-testid="login-from">{from}</div>
    </div>
  );
}

describe('P0-031 ProtectedRoute — unauthenticated', () => {
  it('redirects to /login when the user is not signed in', () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;

    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route path="/login" element={<LoginRouteProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/jobs" element={<ProtectedContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).toBeNull();
  });

  it('preserves the deep link through the sign-in redirect (state.from)', () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;

    render(
      <MemoryRouter initialEntries={['/estimates/abc123?tab=details']}>
        <Routes>
          <Route path="/login" element={<LoginRouteProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/estimates/:id" element={<ProtectedContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    // The captured "from" path should round-trip the deep link verbatim,
    // including the search string. This is what LoginPage consumes via
    // `extractFromPath` to redirect the user back after sign-in.
    expect(screen.getByTestId('login-from').textContent).toBe(
      '/estimates/abc123?tab=details'
    );
  });
});

describe('P0-031 ProtectedRoute — authenticated', () => {
  it('renders the protected content (Outlet) when the user is signed in', () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;

    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/jobs" element={<ProtectedContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });
});

describe('P0-031 ProtectedRoute — loading', () => {
  it('shows a loading spinner during Clerk init (NOT a login flash)', () => {
    // Clerk is not yet hydrated: useAuth() returns isLoaded=false.
    clerkState.isLoaded = false;
    clerkState.isSignedIn = false;

    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route path="/login" element={<LoginRouteProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/jobs" element={<ProtectedContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    // The protected content must NOT render…
    expect(screen.queryByTestId('protected-content')).toBeNull();
    // …and the login page must NOT flash either.
    expect(screen.queryByTestId('login-page')).toBeNull();
    // The loading state should be visible (the brand mark is the marker
    // the existing implementation renders during init).
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });
});

describe('P0-031 ProtectedRoute — public routes (sanity)', () => {
  // Public routes are unguarded by virtue of NOT being children of the
  // ProtectedRoute outlet in routes.ts. We exercise that contract here by
  // mounting a public route alongside the guard and confirming it renders
  // without auth.
  it('a public route renders without auth (no ProtectedRoute wrap)', () => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = false;

    function PaymentPage() {
      return <div data-testid="public-payment">PAY THIS INVOICE</div>;
    }

    render(
      <MemoryRouter initialEntries={['/pay/abc']}>
        <Routes>
          {/* Unguarded — sibling of the ProtectedRoute outlet. */}
          <Route path="/pay/:id" element={<PaymentPage />} />
          <Route path="/login" element={<LoginRouteProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/jobs" element={<ProtectedContent />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('public-payment')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });
});

describe('P0-031 ProtectedRoute — routes.ts wiring (source-level)', () => {
  // Defensive: the router definition file must keep public routes outside
  // the ProtectedRoute branch so the guard never short-circuits them.
  // We assert this at the source-text level to avoid pulling in transitive
  // imports (Stripe etc.) that have nothing to do with route wiring.
  it('public routes are top-level (NOT under ProtectedRoute) and internal routes are guarded', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../routes.ts'),
      'utf8'
    );

    // Find the ProtectedRoute reference. Use a regex anchored on the
    // declaration syntax so trivial reformatting doesn't break the test.
    const guardMatch = src.match(/Component:\s*ProtectedRoute/);
    const guardIdx = guardMatch?.index ?? -1;
    expect(guardIdx, 'ProtectedRoute component must be used for a route')
      .toBeGreaterThan(-1);

    // Public routes — declared BEFORE the ProtectedRoute branch (siblings,
    // not children of the guard). Gemini high follow-up: regex on
    // `path: '<value>'` is robust against whitespace + comment changes
    // and avoids false positives that bare substring matching would hit.
    const publicPaths = [
      '/login',
      '/signup',
      '/onboarding',
      '/e/:id',
      '/pay/:id',
      '/intake',
      '/feedback/:token',
    ];
    for (const p of publicPaths) {
      const m = src.match(new RegExp(`path:\\s*'${p.replace(/\//g, '\\/')}'`));
      const idx = m?.index ?? -1;
      expect(idx, `public route ${p} must be defined in routes.ts`)
        .toBeGreaterThan(-1);
      expect(idx, `public route ${p} must precede the ProtectedRoute branch`)
        .toBeLessThan(guardIdx);
    }

    // Internal routes — defined AFTER the guard (children of the guarded
    // branch). Mirror the actual route entries in routes.ts so a new
    // dispatcher route under the guard is verified, and a route that
    // accidentally moves OUT of the guarded subtree fails the test.
    const internalPaths = [
      'assistant',
      'jobs',
      'schedule',
      'customers',
      'leads',
      'estimates',
      'invoices',
      'contracts',
      'interactions',
      'settings',
      'technician/day',
    ];
    for (const p of internalPaths) {
      const m = src.match(new RegExp(`path:\\s*'${p.replace(/\//g, '\\/')}'`));
      const idx = m?.index ?? -1;
      expect(idx, `internal route '${p}' must be defined in routes.ts`)
        .toBeGreaterThan(-1);
      expect(idx, `internal route '${p}' must be guarded by ProtectedRoute`)
        .toBeGreaterThan(guardIdx);
    }
  });
});
