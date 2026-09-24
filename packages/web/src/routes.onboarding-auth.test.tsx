/**
 * /onboarding is the landing page after Clerk sign-up, so it must sit behind
 * the same auth guard as every other product page. A signed-out visit (an
 * expired session, a stale link, a Stripe checkout return on a different
 * browser) must bounce to /login with the return path preserved — not render
 * the shell, whose status fetch then fails and shows "We couldn't load your
 * setup" with no way forward.
 *
 * Exercises the real route table (routes.ts) through a memory router so the
 * test pins where the route is mounted, not how any one component behaves.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const clerkState = { isLoaded: true, isSignedIn: true };

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  SignIn: () => <div data-testid="clerk-signin">Clerk SignIn</div>,
  SignUp: () => <div data-testid="clerk-signup">Clerk SignUp</div>,
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    userId: clerkState.isSignedIn ? 'user-1' : null,
    getToken: async () => null,
  }),
  useUser: () => ({ isLoaded: clerkState.isLoaded, user: null }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock('./hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => ({ data: null, isLoading: true, error: null, refetch: async () => undefined }),
}));
vi.mock('./lib/analytics', () => ({ track: vi.fn(), trackFunnel: vi.fn(), initAnalytics: vi.fn() }));
vi.mock('./components/onboarding/v2/OnboardingShell', () => ({
  OnboardingShell: () => <div data-testid="onboarding-shell">Onboarding shell</div>,
}));

import { router } from './routes';

function renderAt(path: string) {
  const memoryRouter = createMemoryRouter(router.routes, { initialEntries: [path] });
  render(<RouterProvider router={memoryRouter} />);
  return memoryRouter;
}

describe('/onboarding auth gate', () => {
  beforeEach(() => {
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
  });

  it('signed-out visit redirects to /login and preserves the return path', async () => {
    clerkState.isSignedIn = false;
    const memoryRouter = renderAt('/onboarding?billing=ok');

    await waitFor(() => {
      expect(memoryRouter.state.location.pathname).toBe('/login');
    });
    expect(screen.queryByTestId('onboarding-shell')).toBeNull();
    const from = (memoryRouter.state.location.state as { from?: { pathname: string; search: string } })?.from;
    expect(from?.pathname).toBe('/onboarding');
    expect(from?.search).toBe('?billing=ok');
  });

  it('signed-in visit renders the onboarding shell', async () => {
    const memoryRouter = renderAt('/onboarding');

    expect(await screen.findByTestId('onboarding-shell')).toBeInTheDocument();
    expect(memoryRouter.state.location.pathname).toBe('/onboarding');
  });
});
