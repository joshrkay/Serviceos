/**
 * DEV-ONLY drop-in replacement for `@clerk/clerk-react`.
 *
 * Activated exclusively by a vite `resolve.alias` that is only registered
 * when `VITE_AUTH_MODE=dev` (see vite.config.ts). In every real build the
 * alias is absent and the genuine Clerk SDK is used — this file is never in
 * the graph. Its purpose is to make the authenticated app boot and run
 * headlessly (CI, /verify) without reaching Clerk's hosted frontend API,
 * which is unreachable in sandboxed environments.
 *
 * It mints a static UNSIGNED JWT carrying just a `sub` (and optional `role`)
 * claim — exactly what the API's `DEV_AUTH_BYPASS` middleware decodes to
 * bootstrap a dev tenant. This is not a credential and must never ship: both
 * this shim and the server bypass are hard-gated on dev env flags.
 */
import React from 'react';

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SUB = (import.meta.env.VITE_DEV_AUTH_SUB as string) || 'dev_owner';
const ROLE = (import.meta.env.VITE_DEV_AUTH_ROLE as string) || 'owner';
const EMAIL = `${SUB}@dev.local`;

/** Unsigned `header.payload.sig` JWT the API's DEV_AUTH_BYPASS decodes. */
function devToken(): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: SUB, sid: 'dev-session', role: ROLE })}.x`;
}

export function ClerkProvider(props: { children?: React.ReactNode }): React.ReactElement {
  return <>{props.children}</>;
}

// STABLE singletons. Real Clerk returns referentially-stable getToken/signOut
// and hook results across renders; consumers put them in useCallback/useEffect
// dependency arrays (e.g. useDetailQuery → useApiClient → apiFetch). Returning
// fresh object/function identities each render would churn those deps and spin
// hooks in an infinite refetch loop. Freeze everything at module scope.
const stableGetToken = async (_opts?: { template?: string; skipCache?: boolean }): Promise<string> =>
  devToken();
const stableSignOut = async (): Promise<void> => {};

const AUTH = Object.freeze({
  isLoaded: true,
  isSignedIn: true,
  userId: SUB,
  sessionId: 'dev-session',
  orgId: null,
  orgRole: ROLE,
  actor: null,
  getToken: stableGetToken,
  signOut: stableSignOut,
});

const USER = Object.freeze({
  isLoaded: true,
  isSignedIn: true,
  user: Object.freeze({
    id: SUB,
    primaryEmailAddress: { emailAddress: EMAIL },
    emailAddresses: [{ emailAddress: EMAIL }],
    fullName: 'Dev User',
    firstName: 'Dev',
    lastName: 'User',
    imageUrl: '',
    publicMetadata: {},
  }),
});

const CLERK = Object.freeze({
  signOut: stableSignOut,
  openSignIn: (): void => {},
  openUserProfile: (): void => {},
  session: { id: 'dev-session' },
});

export function useAuth() {
  return AUTH;
}

export function useUser() {
  return USER;
}

export function useClerk() {
  return CLERK;
}

export function SignIn(): React.ReactElement {
  return <div data-testid="dev-signin">dev sign-in (test-auth mode)</div>;
}

export function SignUp(): React.ReactElement {
  return <div data-testid="dev-signup">dev sign-up (test-auth mode)</div>;
}
