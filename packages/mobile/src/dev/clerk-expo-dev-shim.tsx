/**
 * DEV/TEST-ONLY drop-in replacement for `@clerk/clerk-expo` (PRD 3.3, #1015).
 *
 * The mobile twin of packages/web/src/dev/clerk-dev-shim.tsx. It is only in
 * the bundle when Metro aliases `@clerk/clerk-expo` here, which
 * scripts/dev-auth-guard.cjs allows solely for `EXPO_PUBLIC_AUTH_MODE=dev` in a
 * non-production build (see metro.config.js). Its purpose is to let the
 * Maestro device flows (packages/mobile/.maestro/) reach signed-in screens on
 * an emulator without a Clerk cloud instance.
 *
 * It mints a static UNSIGNED JWT carrying `sub`/`sid`/`role` — exactly what the
 * API's DEV_AUTH_BYPASS middleware decodes to bootstrap a dev tenant
 * (packages/api/src/auth/dev-auth-bypass.ts). Not a credential: the API
 * refuses the bypass outside NODE_ENV=dev, and this module refuses to load in
 * a release bundle (`__DEV__ === false`).
 */
import * as FileSystem from 'expo-file-system';
import type { ReactNode } from 'react';

declare const __DEV__: boolean;

// Absent `__DEV__` means a plain Node context (unit tests, tooling) — same
// convention as src/lib/env.ts. A shipped release bundle defines it as false.
if (typeof __DEV__ !== 'undefined' && !__DEV__) {
  throw new Error(
    'clerk-expo dev shim refused in a release bundle: EXPO_PUBLIC_AUTH_MODE=dev is for local dev and the Maestro harness only.',
  );
}

const SUB = process.env.EXPO_PUBLIC_DEV_AUTH_SUB || 'dev_owner';
const ROLE = process.env.EXPO_PUBLIC_DEV_AUTH_ROLE || 'owner';

/**
 * #1603 — runtime identity override. `EXPO_PUBLIC_*` is inlined at BUNDLE
 * time, so one Metro bundle could only ever sign in as one identity. The
 * Maestro harness (scripts/maestro-device-run.sh) instead writes
 * `files/dev-auth.json` into the app sandbox over `adb run-as` — e.g.
 * {"sub":"dev_tech","role":"technician"} — and the token picks it up here, so
 * owner and technician flows share one bundle. Absent/unreadable file → the
 * env defaults above. Read once per process (the harness `pm clear`s between
 * flows, so a stale identity cannot leak across runs).
 */
const IDENTITY_FILE = `${FileSystem.documentDirectory ?? ''}dev-auth.json`;

interface DevIdentity {
  sub: string;
  role: string;
}

async function readIdentityOverride(): Promise<Partial<DevIdentity> | null> {
  try {
    const info = await FileSystem.getInfoAsync(IDENTITY_FILE);
    if (!info.exists) return null;
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(IDENTITY_FILE));
    return parsed && typeof parsed === 'object' ? (parsed as Partial<DevIdentity>) : null;
  } catch {
    return null;
  }
}

let identityPromise: Promise<DevIdentity> | null = null;
function identity(): Promise<DevIdentity> {
  identityPromise ??= readIdentityOverride().then((o) => ({
    sub: typeof o?.sub === 'string' && o.sub ? o.sub : SUB,
    role: typeof o?.role === 'string' && o.role ? o.role : ROLE,
  }));
  return identityPromise;
}

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintToken(id: DevIdentity): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: id.sub, sid: 'dev-session', role: id.role })}.x`;
}

// Stable singletons — consumers put getToken/signOut in hook dependency
// arrays, so fresh identities per render would spin refetch loops (same
// reasoning as the web shim). `userId` below stays the bundle default: it is
// only a cache key (useMe) / session-skip key; the API reads identity from
// the token.
const getToken = async (_opts?: { template?: string; skipCache?: boolean }): Promise<string | null> =>
  mintToken(await identity());
const signOut = async (): Promise<void> => {};

const AUTH = Object.freeze({
  isLoaded: true,
  isSignedIn: true,
  userId: SUB,
  sessionId: 'dev-session',
  orgId: null,
  orgRole: ROLE,
  getToken,
  signOut,
});

export function ClerkProvider(props: { children?: ReactNode; publishableKey?: string; tokenCache?: unknown }) {
  return <>{props.children}</>;
}

export function ClerkLoaded(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}

export function useAuth() {
  return AUTH;
}

/** The sign-in screen is unreachable while signed in; present for import parity. */
export function useSignIn() {
  return { isLoaded: true, signIn: undefined, setActive: undefined };
}
