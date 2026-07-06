/**
 * Offline window.Clerk stub for Playwright E2E tests.
 *
 * Why this exists: the 401-storm regression suite (e2e/no-401-storm.spec.ts)
 * must drive the app through a *signed-in → persistent-401 → sign-out* cycle
 * in a real browser. Real Clerk requires network egress to clerk.com, which
 * CI sandboxes and locked-down runners don't have. Instead of mocking the
 * network, we exploit clerk-react's loader contract:
 *
 *   @clerk/shared loadClerkJsScript → isClerkProperlyLoaded() returns true
 *   when `window.Clerk` already exists with a `load` function, and skips the
 *   script download entirely. IsomorphicClerk then calls `Clerk.load()`,
 *   checks `Clerk.loaded`, and hydrates from the stub.
 *
 * The stub implements the minimal surface clerk-react 5.x actually consumes:
 *
 *   - `loaded: true` + async `load()` — adoption handshake.
 *   - NO `status` property — IsomorphicClerk.hydrateClerkJS emits the
 *     "ready" status itself when `clerkjs.status` is undefined, which is
 *     what resolves useAuth's getToken/signOut `clerkLoaded` gate.
 *   - `addListener(fn)` — must invoke fn immediately with the resources
 *     snapshot ({ client, session, user, organization }) and return an
 *     unsubscribe; ClerkContextProvider derives all auth state from these
 *     emissions (deriveState reads session.id / user.id / session.status).
 *   - `session.getToken()` — wired through AuthTokenBridge → apiFetch /
 *     useApiClient as the Bearer-token source.
 *   - `signOut()` — flips the stub to signed-out and re-emits, which makes
 *     ProtectedRoute render <Navigate to="/login">. This mirrors real
 *     Clerk's afterSignOutUrl navigation closely enough for routing
 *     assertions while keeping everything in-page and countable.
 *   - widget mounts (mountSignIn etc.) — no-ops; LoginPage/SignupPage render
 *     Clerk components whose mount targets we don't need pixels for.
 *
 * Counters are exposed on `window.__clerkStub` so specs can assert the
 * persistent-401 latch fired signOut EXACTLY once.
 */

import type { Page } from '@playwright/test';

export interface ClerkStubCounters {
  signOutCalls: number;
  getTokenCalls: number;
}

/**
 * Install the stub before any app script runs. MUST be called before the
 * first page.goto() — addInitScript only affects subsequent documents.
 */
export async function installClerkStub(
  page: Page,
  opts: { signedIn: boolean },
): Promise<void> {
  await page.addInitScript((signedIn: boolean) => {
    const counters = { signOutCalls: 0, getTokenCalls: 0 };
    type Listener = (resources: unknown) => void;
    const listeners: Listener[] = [];

    const user = {
      id: 'user_e2e_stub',
      fullName: 'E2E Stub User',
      firstName: 'E2E',
      lastName: 'Stub',
      primaryEmailAddress: { emailAddress: 'e2e-stub@example.com' },
      organizationMemberships: [] as unknown[],
    };

    const session = {
      id: 'sess_e2e_stub',
      status: 'active',
      // deriveState reads these directly; null/absent values are guarded
      // upstream but explicit nulls keep the derived state deterministic.
      factorVerificationAge: null,
      actor: null,
      user,
      // REQUIRED: resolveAuthState's signed-in branches gate on
      // `!!sessionClaims`, and deriveState sources that from
      // session.lastActiveToken?.jwt?.claims. Without it, useAuth throws
      // "@clerk/clerk-react: Invalid state" on every render.
      lastActiveToken: {
        jwt: {
          claims: { __raw: 'e2e.stub.jwt', sub: 'user_e2e_stub' },
        },
      },
      getToken: async () => {
        counters.getTokenCalls += 1;
        return 'e2e.stub.jwt';
      },
    };

    const state = { signedIn };

    const resources = () => ({
      client: {
        sessions: state.signedIn ? [session] : [],
        signIn: {},
        signUp: {},
      },
      session: state.signedIn ? session : null,
      user: state.signedIn ? user : null,
      organization: null,
    });

    const emit = () => {
      const snapshot = resources();
      // Copy — a listener may unsubscribe (StrictMode cleanup) mid-loop.
      for (const fn of [...listeners]) fn(snapshot);
    };

    const noop = () => undefined;

    (window as unknown as Record<string, unknown>).__clerkStub = counters;

    (window as unknown as Record<string, unknown>).Clerk = {
      loaded: true,
      // Deliberately NO `status` field — see file header.
      version: 'e2e-stub',
      load: async () => undefined,

      addListener: (fn: Listener) => {
        listeners.push(fn);
        fn(resources());
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },

      signOut: async () => {
        counters.signOutCalls += 1;
        state.signedIn = false;
        emit();
      },

      get client() {
        return resources().client;
      },
      get session() {
        return state.signedIn ? session : null;
      },
      get user() {
        return state.signedIn ? user : null;
      },
      organization: null,

      setActive: async () => undefined,

      // Widget mount/open surface — safe no-ops for every component the app
      // renders (<SignIn>, <SignUp>, <UserButton>, …).
      mountSignIn: noop,
      unmountSignIn: noop,
      mountSignUp: noop,
      unmountSignUp: noop,
      mountUserButton: noop,
      unmountUserButton: noop,
      mountUserProfile: noop,
      unmountUserProfile: noop,
      openSignIn: noop,
      closeSignIn: noop,
      openSignUp: noop,
      closeSignUp: noop,
      redirectToSignIn: noop,
      redirectToSignUp: noop,
      handleRedirectCallback: async () => undefined,
      buildSignInUrl: () => '/login',
      buildSignUpUrl: () => '/signup',
      buildAfterSignOutUrl: () => '/login',
    };
  }, opts.signedIn);
}

/** Read the stub's call counters from the page. */
export async function readClerkStubCounters(page: Page): Promise<ClerkStubCounters> {
  return page.evaluate(
    () => (window as unknown as { __clerkStub: ClerkStubCounters }).__clerkStub,
  );
}
