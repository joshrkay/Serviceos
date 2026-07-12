/**
 * P0-029 — Frontend Clerk SDK integration
 *
 * Verifies the Clerk integration is wired:
 *   - Happy path — Clerk <SignIn> renders inside <LoginPage>.
 *   - Sign-out — Shell calls Clerk's signOut and redirects to /login.
 *   - Missing publishable key — main.tsx throws a clear error.
 *   - User data — Shell displays real user name + initials from useUser().
 *
 * Mocks are scoped to this file — every test re-asserts the Clerk surface
 * area that the story body promises (ClerkProvider, SignIn, SignUp, useUser,
 * useClerk, useAuth).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state — overridden per-test ─────────────────────────────────
const clerkState = {
  isLoaded: true,
  isSignedIn: true,
  user: {
    fullName: 'Ada Lovelace',
    imageUrl: 'https://example.com/ada.png',
    primaryEmailAddress: { emailAddress: 'ada@example.com' },
  } as { fullName: string | null; imageUrl: string; primaryEmailAddress: { emailAddress: string } } | null,
  signOut: vi.fn(),
};

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn:    ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut:   () => null,
  SignIn:      () => <div data-testid="clerk-signin">Clerk SignIn Component</div>,
  SignUp:      () => <div data-testid="clerk-signup">Clerk SignUp Component</div>,
  useAuth:     () => ({ isLoaded: clerkState.isLoaded, isSignedIn: clerkState.isSignedIn, getToken: async () => null }),
  useUser:     () => ({ isLoaded: clerkState.isLoaded, user: clerkState.user }),
  useClerk:    () => ({ signOut: clerkState.signOut }),
}));

// Imports that depend on the mock must come AFTER vi.mock above.
import { LoginPage } from './LoginPage';
import { SignupPage } from './SignupPage';
import { Shell } from '../layout/Shell';

beforeEach(() => {
  clerkState.isLoaded = true;
  clerkState.isSignedIn = true;
  clerkState.user = {
    fullName: 'Ada Lovelace',
    imageUrl: 'https://example.com/ada.png',
    primaryEmailAddress: { emailAddress: 'ada@example.com' },
  };
  clerkState.signOut.mockReset();
});

describe('P0-029 ClerkProvider integration — LoginPage', () => {
  it('happy path: renders the Clerk <SignIn> component', () => {
    clerkState.isSignedIn = false;
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('clerk-signin')).toBeInTheDocument();
  });

  it('does NOT use a fake setTimeout login path (Clerk owns auth)', () => {
    clerkState.isSignedIn = false;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    // The login flow itself should not schedule any timers.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('renders the Clerk <SignUp> component on the signup route', () => {
    clerkState.isSignedIn = false;
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('clerk-signup')).toBeInTheDocument();
  });
});

describe('P0-029 ClerkProvider integration — Shell user data', () => {
  it('displays real user name from useUser() (no hardcoded demo user)', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // Defensive: ensure stale demo identity strings are not rendered.
    const staleDemoName = ['Mike', 'Ortega'].join(' ');
    expect(screen.queryByText(staleDemoName)).toBeNull();
  });

  it('renders initials derived from the Clerk user (avatar fallback)', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    // "Ada Lovelace" → "AL"
    expect(screen.getAllByText('AL').length).toBeGreaterThan(0);
  });

  it('falls back to email when fullName is null', () => {
    clerkState.user = {
      fullName: null,
      imageUrl: '',
      primaryEmailAddress: { emailAddress: 'ada@example.com' },
    };
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('renders nothing while Clerk is still loading', () => {
    clerkState.isLoaded = false;
    const { container } = render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('P0-029 ClerkProvider integration — sign-out', () => {
  it('clicking the sign-out button calls Clerk signOut() and redirects to /login', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Shell />}>
            <Route index element={<div>home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    const signOutBtn = screen.getByTitle('Sign out');
    fireEvent.click(signOutBtn);
    expect(clerkState.signOut).toHaveBeenCalledTimes(1);
    expect(clerkState.signOut).toHaveBeenCalledWith({ redirectUrl: '/login' });
  });
});

describe('P0-029 ClerkProvider integration — env requirement', () => {
  it('main.tsx requires VITE_CLERK_PUBLISHABLE_KEY when no runtime or build config is present', async () => {
    // Source-level assertion: the entry file must still hard-fail when the key
    // is absent. We read the file rather than executing main.tsx (which would
    // mount the real router).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const entry = await fs.readFile(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../main.tsx'),
      'utf8'
    );
    expect(entry).toMatch(/VITE_CLERK_PUBLISHABLE_KEY/);
    expect(entry).toMatch(/getRuntimeConfigValue/);
    expect(entry).toMatch(/throw new Error/);
    expect(entry).toMatch(/ClerkProvider/);
  });
});
