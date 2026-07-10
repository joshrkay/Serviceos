import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { apiFetch } from '../utils/api-fetch';
import { fetchMeShared } from './useMe';

/**
 * Tenant timezone context.
 *
 * Read from `/api/me`. Provider fetches once on mount; consumers call
 * `useTenantTimezone()` to get the IANA tz string for formatting dates.
 *
 * Why this is a context rather than just calling /api/me everywhere it's
 * needed: dates render in many places (lists, detail pages, dashboards,
 * inboxes) and most of those calls would otherwise duplicate the fetch.
 * Centralizing it once per app lifetime keeps it cheap and consistent.
 *
 * Fallback: `America/New_York` matches the DB DEFAULT in tenant_settings
 * (migration 013). If `/api/me` errors or the field is missing, we render
 * with the fallback rather than blowing up the page — wrong but readable
 * beats white screen.
 */

const FALLBACK_TZ = 'America/New_York';

interface TenantTimezoneContextValue {
  /** IANA timezone identifier, e.g. `America/Los_Angeles`. */
  timezone: string;
  /** True until the first /api/me response (or error) has been observed. */
  loading: boolean;
}

const TenantTimezoneContext = createContext<TenantTimezoneContextValue>({
  timezone: FALLBACK_TZ,
  loading: true,
});

export interface TenantTimezoneProviderProps {
  children: ReactNode;
  /**
   * Test seam: when supplied, the provider uses this value instead of
   * fetching `/api/me`. Lets unit tests render in a specific tz without
   * mocking apiFetch.
   */
  overrideTimezone?: string;
}

export function TenantTimezoneProvider({
  children,
  overrideTimezone,
}: TenantTimezoneProviderProps): React.ReactElement {
  const { isLoaded, isSignedIn } = useAuth();
  const [timezone, setTimezone] = useState<string>(overrideTimezone ?? FALLBACK_TZ);
  const [loading, setLoading] = useState<boolean>(!overrideTimezone);

  useEffect(() => {
    if (overrideTimezone) {
      setTimezone(overrideTimezone);
      setLoading(false);
      return;
    }
    // This provider mounts outside the router (main.tsx), so an ungated
    // fetch fires on /login too — feeding the 401 loop when the API is
    // rejecting tokens. Wait for Clerk to settle, skip while signed out,
    // and re-run when isSignedIn flips true so a session that starts on
    // /login still picks up the tenant timezone after login (previously
    // it kept the America/New_York fallback for the whole session).
    if (!isLoaded) return;
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Piggyback on useMe's module cache — this provider previously issued
    // its own GET /api/me on every mount, duplicating the useMe fetch on
    // every page load (QA sweep 2026-07-02).
    fetchMeShared(apiFetch)
      .then((body) => {
        if (!cancelled && typeof body.timezone === 'string' && body.timezone) {
          setTimezone(body.timezone);
        }
      })
      .catch(() => {
        // Don't block render on a failed /api/me — fall back to the
        // DB default. Logging is intentionally suppressed to avoid
        // log spam on the unauthenticated entry pages where /api/me
        // legitimately rejects.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overrideTimezone, isLoaded, isSignedIn]);

  return (
    <TenantTimezoneContext.Provider value={{ timezone, loading }}>
      {children}
    </TenantTimezoneContext.Provider>
  );
}

/**
 * Returns the tenant's IANA timezone string. Always returns a usable
 * value — falls back to `America/New_York` if the provider hasn't
 * mounted (e.g. in a unit test that forgot the wrapper) or the
 * /api/me fetch hasn't completed yet.
 */
export function useTenantTimezone(): string {
  return useContext(TenantTimezoneContext).timezone;
}

/**
 * Same as `useTenantTimezone` but also exposes the loading flag for
 * callers that want to defer their first paint until /api/me settles
 * (rare — most just want the string).
 */
export function useTenantTimezoneState(): TenantTimezoneContextValue {
  return useContext(TenantTimezoneContext);
}
